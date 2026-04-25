// services/referralRewardService.js
//
// Revenue-sharing referral rewards.
//
// Rule: When a referee completes a Crypto → NGNZ offramp swap, their referrer
// receives 1 NGNZ for every $1 USD worth of crypto swapped.
//
//   Example: referee swaps $1000 of BTC → referrer receives 1000 NGNZ
//   Example: referee swaps $250 of ETH  → referrer receives 250 NGNZ
//
// The reward is funded from platform revenue (the offramp spread), not deducted
// from the referee's received NGNZ amount.
//
// Design principles:
//  • Non-blocking — always called via setImmediate; swap never waits on this.
//  • Idempotent   — uses a unique reward reference to prevent double-crediting.
//  • Atomic       — balance credit + transaction record in a single Mongo session.
//  • Self-logged  — every outcome (skip / credit / error) goes to the logger.

'use strict';

const mongoose = require('mongoose');
const User = require('../models/user');
const Referral = require('../models/referral');
const Transaction = require('../models/transaction');
const logger = require('../utils/logger');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Builds the deterministic reward reference for idempotency checks. */
function buildRewardReference(swapReference) {
  return `REF_REWARD_${swapReference}`;
}

/**
 * Compute the NGNZ reward from the USD value of the swapped crypto.
 * Rate: 1 NGNZ per $1 USD — rounded to 2 decimal places.
 *
 *   $1000.00 swap → 1000.00 NGNZ
 *   $250.75  swap →  250.75 NGNZ
 */
function computeRewardNGNZ(swapAmountUSD) {
  const reward = parseFloat(swapAmountUSD);
  if (!isFinite(reward) || reward <= 0) return 0;
  return Math.round(reward * 100) / 100; // 2 decimal places, no floating-point drift
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Credit the referrer of `refereeUserId` with NGNZ equal to the USD value of
 * their referee's offramp swap.
 *
 * Safe to call fire-and-forget (via setImmediate). All errors are caught and
 * logged; they will never bubble up to the calling swap route.
 *
 * @param {string|ObjectId} refereeUserId   - User who just completed the offramp.
 * @param {string}          swapReference   - Unique swap reference ("NGNZ_SWAP_...").
 * @param {number}          swapAmountUSD   - USD value of the crypto swapped (e.g. 1000).
 * @param {string}          correlationId   - Propagated from the parent swap for tracing.
 */
async function creditOfframpReferralReward(refereeUserId, swapReference, swapAmountUSD, correlationId) {
  const rewardReference = buildRewardReference(swapReference);

  // Compute reward up front so we can log it at every exit point
  const rewardNGNZ = computeRewardNGNZ(swapAmountUSD);

  logger.info('Referral reward check triggered', {
    refereeUserId, swapReference, swapAmountUSD, rewardNGNZ, correlationId
  });

  if (rewardNGNZ <= 0) {
    logger.warn('Referral reward skipped — swap USD value is zero or invalid', {
      refereeUserId, swapReference, swapAmountUSD, correlationId
    });
    return;
  }

  try {
    // ── 1. Load referee, check if they used a referral code ───────────────────
    const referee = await User.findById(refereeUserId)
      .select('referredBy')
      .lean();

    if (!referee) {
      logger.warn('Referral reward skipped — referee user not found', {
        refereeUserId, swapReference, correlationId
      });
      return;
    }

    logger.info('Referral reward — referee referredBy value', {
      refereeUserId, referredBy: referee.referredBy, swapReference, correlationId
    });

    if (!referee.referredBy) {
      logger.info('Referral reward skipped — referee has no referral code (organic signup)', {
        refereeUserId, swapReference, correlationId
      });
      return;
    }

    // ── 2. Find the referrer's Referral document ──────────────────────────────
    const referralDoc = await Referral.findOne({ referralCode: referee.referredBy });

    if (!referralDoc) {
      logger.warn('Referral reward skipped — no Referral document for code', {
        referredByCode: referee.referredBy,
        refereeUserId, swapReference, correlationId
      });
      return;
    }

    if (!referralDoc.isActive) {
      logger.info('Referral reward skipped — referral code is inactive', {
        referralCode: referee.referredBy,
        referrerId: referralDoc.userId,
        refereeUserId, swapReference, correlationId
      });
      return;
    }

    const referrerId = referralDoc.userId;

    // ── 3. Idempotency — bail if this exact swap was already rewarded ─────────
    const alreadyRewarded = await Transaction.exists({ reference: rewardReference });
    if (alreadyRewarded) {
      logger.info('Referral reward skipped — already credited for this swap', {
        rewardReference, referrerId, refereeUserId, correlationId
      });
      return;
    }

    // ── 4. Atomic: credit referrer balance + create reward transaction ─────────
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const updatedReferrer = await User.findOneAndUpdate(
        { _id: referrerId },
        {
          $inc: { ngnzBalance: rewardNGNZ },
          $set: {
            lastBalanceUpdate: new Date(),
            portfolioLastUpdated: new Date()
          }
        },
        { new: true, session }
      );

      if (!updatedReferrer) {
        throw new Error(`Referrer user not found: ${referrerId}`);
      }

      // Visible in referrer's transaction history
      await new Transaction({
        userId: referrerId,
        type: 'REFERRAL_REWARD',
        currency: 'NGNZ',
        amount: rewardNGNZ,
        status: 'SUCCESSFUL',
        source: 'REFERRAL_PROGRAM',
        reference: rewardReference,
        narration: `Referral reward: referee swapped $${swapAmountUSD.toFixed(2)} → you earned ${rewardNGNZ} NGNZ`,
        completedAt: new Date(),
        metadata: {
          refereeUserId: refereeUserId.toString(),
          originalSwapReference: swapReference,
          swapAmountUSD,
          rewardAmountNGNZ: rewardNGNZ,
          rewardRateDescription: '1 NGNZ per $1 USD swapped',
          correlationId,
          rewardType: 'OFFRAMP_REFERRAL',
        }
      }).save({ session });

      await session.commitTransaction();
      session.endSession();

      logger.info('Referral reward credited successfully', {
        referrerId,
        refereeUserId,
        swapAmountUSD,
        rewardNGNZ,
        newNgnzBalance: updatedReferrer.ngnzBalance,
        rewardReference,
        swapReference,
        correlationId
      });

    } catch (txError) {
      await session.abortTransaction();
      session.endSession();
      throw txError;
    }

    // ── 5. Update Referral doc stats (outside session — non-critical) ──────────
    try {
      await referralDoc.recordConversion(refereeUserId, rewardNGNZ);
    } catch (referralUpdateError) {
      // Balance already credited — this is just stats tracking. Log and move on.
      logger.error('Failed to update Referral document after reward credit', {
        referrerId, refereeUserId, swapReference, correlationId,
        error: referralUpdateError.message
      });
    }

  } catch (err) {
    logger.error('Referral reward credit failed', {
      refereeUserId, swapReference, swapAmountUSD, rewardNGNZ,
      rewardReference, correlationId,
      error: err.message,
      stack: err.stack
    });
  }
}

module.exports = { creditOfframpReferralReward };
