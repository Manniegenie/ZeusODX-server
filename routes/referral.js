// routes/referral.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Referral = require('../models/referral');
const User = require('../models/user');
const logger = require('../utils/logger');
const { generateUniqueReferralCode } = require('../utils/generateReferralCode');

/**
 * GET /referral/me
 * Returns the authenticated user's referral program data.
 * Auto-creates a Referral record for existing users who pre-date the referral system.
 */
router.get('/me', async (req, res) => {
  const userId = req.user?.id;

  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  try {
    let referral = await Referral.findOne({ userId }).lean();

    if (!referral) {
      // Existing user predates the referral system — generate a code and create the record now
      const referralCode = await generateUniqueReferralCode();

      // Persist the code on the User document as well
      await User.updateOne({ _id: userId }, { $set: { referralCode } });

      const created = await Referral.create({ userId, referralCode });
      referral = created.toObject();

      logger.info('Created missing referral record for existing user', { userId, referralCode });
    }

    return res.json({
      success: true,
      data: {
        referralCode:     referral.referralCode,
        totalReferrals:   referral.totalReferrals,
        totalConversions: referral.totalConversions,
        totalEarnings:    referral.totalEarnings,
        pendingEarnings:  referral.pendingEarnings,
        paidOutEarnings:  referral.paidOutEarnings,
        isActive:         referral.isActive,
      },
    });
  } catch (err) {
    logger.error('GET /referral/me error', { userId, error: err.message });
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
