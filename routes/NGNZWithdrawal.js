const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Service Imports
const { debitNaira } = require('../services/nairaWithdrawal');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { validateUserBalance: validateBalance, isTokenSupported } = require('../services/balance');
const { validateTransactionLimit } = require('../services/kyccheckservice');
const { sendWithdrawalEmail } = require('../services/EmailService');
const { sendWithdrawalNotification } = require('../services/notificationService');
const { bvnCheckService } = require('../services/bvnCheckService');

// SECURITY FIX: Import distributed lock and security service
const { withLock } = require('../utils/redisLock');
const securityService = require('../services/securityService');

// Model & Utils Imports
const Transaction = require('../models/transaction');
const User = require('../models/user');
const TransactionAudit = require('../models/TransactionAudit');
const logger = require('../utils/logger');

// IDEMPOTENCY MIDDLEWARE
// Ensure your middleware file is named 'idempotency.middleware.js' as per your recent update
const { idempotencyMiddleware } = require('../utils/Idempotency');

const router = express.Router();

// Internal Cache for Auth Optimization
const userCache = new Map();
const CACHE_TTL = 5000; 

// NGNZ Withdrawal Fee Constants
// - Operational: What is actually subtracted from the payout to the provider
// - Recorded: What is displayed to the user and stored in the transaction history
const NGNZ_WITHDRAWAL_FEE_OPERATIONAL = 30;
const NGNZ_WITHDRAWAL_FEE_RECORDED = 100;

// Obiex provider minimum: amount sent to Obiex (after our fee) must be >= 1000 NGNX
const OBIEX_NGNZ_MIN_AMOUNT = 1000;
// App minimum: reject withdrawals of 1100 or less (covers provider min + fees + buffer)
const NGNZ_WITHDRAWAL_MIN_AMOUNT = 1100;

// --- HELPER FUNCTIONS ---

async function createAuditEntry(auditData) {
  try {
    await TransactionAudit.createAudit(auditData);
  } catch (error) {
    logger.error('Failed to create audit entry', { error: error.message });
  }
}

function generateCorrelationId() {
  return `NGNZ_WD_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function generateWithdrawalReference() {
  return `NGNZ_WD_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function getSystemContext(req) {
  return {
    ipAddress: req.ip || 'unknown',
    userAgent: req.get('User-Agent') || 'unknown',
    environment: process.env.NODE_ENV || 'production'
  };
}

function maskAccountNumber(accountNumber) {
  if (!accountNumber) return '';
  const str = String(accountNumber).replace(/\s+/g, '');
  return str.length <= 4 ? str : `${str.slice(0, 2)}****${str.slice(-2)}`;
}

function formatCurrency(amount, currency = 'NGN') {
  return `₦${Math.abs(amount).toLocaleString()}`;
}

function formatDate(date) {
  return new Date(date).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

async function comparePasswordPin(candidate, hashed) {
  if (!candidate || !hashed) return false;
  return await bcrypt.compare(candidate, hashed);
}

function validateWithdrawalRequest(data) {
  const errors = [];
  if (!data.amount || data.amount <= 0) errors.push('Amount must be a positive number');
  if (!data.destination?.accountNumber) errors.push('Account number is required');
  if (!data.destination?.bankCode) errors.push('Bank code is required');

  // Reject 1100 or less (provider min 1000 + fees; we use 1100 as app minimum)
  if (data.amount <= NGNZ_WITHDRAWAL_MIN_AMOUNT) {
    errors.push(`Minimum withdrawal is ₦${(NGNZ_WITHDRAWAL_MIN_AMOUNT + 1).toLocaleString()}`);
  }
  if (!data.twoFactorCode) errors.push('2FA code is required');
  if (!data.passwordpin || !/^\d{6}$/.test(data.passwordpin)) errors.push('Valid 6-digit PIN is required');

  return errors;
}

async function getCachedUserAuth(userId) {
  const cacheKey = `user_auth_${userId}`;
  const cached = userCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) return cached.user;
  
  const user = await User.findById(userId).select('_id twoFASecret is2FAEnabled passwordpin email username firstname').lean();
  if (user) userCache.set(cacheKey, { user, timestamp: Date.now() });
  return user;
}

// --- CORE EXECUTION LOGIC ---

/**
 * Stage 1: Database deduction and local transaction creation
 */
async function executeNGNZWithdrawal(userId, withdrawalData, correlationId, systemContext, idempotencyKey) {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { amount, destination, narration } = withdrawalData;
    
    // Stable reference generation based on idempotency key
    const withdrawalReference = idempotencyKey 
        ? `NGNZ_WD_${crypto.createHash('md5').update(idempotencyKey).digest('hex').slice(0, 10).toUpperCase()}`
        : generateWithdrawalReference();
    
    const totalDeducted = amount;
    const amountToObiex = amount - NGNZ_WITHDRAWAL_FEE_OPERATIONAL;
    const amountToBankRecorded = amount - NGNZ_WITHDRAWAL_FEE_RECORDED;
    const feeAmountRecorded = NGNZ_WITHDRAWAL_FEE_RECORDED;
    
    const updatedUser = await User.findOneAndUpdate(
      { _id: userId, ngnzBalance: { $gte: totalDeducted } },
      { $inc: { ngnzBalance: -totalDeducted }, $set: { lastBalanceUpdate: new Date() } },
      { new: true, runValidators: true, session }
    );

    if (!updatedUser) throw new Error('Insufficient NGNZ balance');

    userCache.delete(`user_auth_${userId}`);

    const withdrawalTransaction = new Transaction({
      userId,
      type: 'WITHDRAWAL',
      currency: 'NGNZ',
      amount: -totalDeducted,
      status: 'PENDING',
      source: 'NGNZ_WITHDRAWAL',
      reference: withdrawalReference,
      obiexTransactionId: withdrawalReference,
      narration: narration || `NGNZ withdrawal to ${destination.bankName}`,
      isNGNZWithdrawal: true,
      bankAmount: amountToBankRecorded,
      withdrawalFee: feeAmountRecorded,
      payoutCurrency: 'NGN',
      ngnzWithdrawal: {
        withdrawalReference,
        requestedAmount: totalDeducted,
        withdrawalFee: feeAmountRecorded,
        amountSentToBank: amountToBankRecorded,
        destination: {
          ...destination,
          accountNumberMasked: maskAccountNumber(destination.accountNumber),
        },
        provider: 'OBIEX',
        idempotencyKey: `ngnz-wd-${withdrawalReference}`,
      },
      receiptDetails: {
        transactionId: withdrawalReference,
        bankName: destination.bankName,
        accountName: destination.accountName,
        accountNumber: maskAccountNumber(destination.accountNumber),
        amount: formatCurrency(totalDeducted, 'NGNZ'),
        fee: formatCurrency(feeAmountRecorded),
        date: formatDate(new Date()),
      },
      metadata: { correlationId, idempotencyKeyApplied: !!idempotencyKey }
    });

    await withdrawalTransaction.save({ session });
    await session.commitTransaction();
    session.endSession();
    
    return { 
        user: updatedUser, 
        transaction: withdrawalTransaction, 
        withdrawalReference, 
        amountToObiex, 
        feeAmount: feeAmountRecorded 
    };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

/**
 * Stage 2: External API Call to Obiex
 */
async function processObiexWithdrawal(userId, withdrawalData, amountToObiex, withdrawalReference, transactionId) {
  try {
    const { destination, narration } = withdrawalData;
    const obiexPayload = {
      destination: {
        accountNumber: destination.accountNumber,
        accountName: destination.accountName,
        bankName: destination.bankName,
        bankCode: destination.bankCode,
      },
      amount: amountToObiex,
      currency: 'NGNX',
      narration: narration || `NGNZ withdrawal - ${withdrawalReference}`
    };

    const obiexResult = await debitNaira(obiexPayload, {
      userId: userId.toString(),
      idempotencyKey: `ngnz-wd-${withdrawalReference}`
    });

    if (obiexResult.success) {
      // Store Obiex transaction ID for webhook matching
      // Keep status as PENDING - webhook will update to SUCCESSFUL when confirmed
      const obiexTransactionId = obiexResult.data?.id || obiexResult.data?.transactionId;
      await Transaction.findByIdAndUpdate(transactionId, {
        $set: { 
            status: 'PENDING',  // Keep as PENDING until webhook confirms
            'ngnzWithdrawal.obiex.id': obiexTransactionId,
            'ngnzWithdrawal.obiex.reference': obiexResult.data?.reference || null,
            'ngnzWithdrawal.obiex.status': obiexResult.data?.status || 'PROCESSING',
            'ngnzWithdrawal.sentAt': new Date(),
            obiexTransactionId: obiexTransactionId, // Store at top level for webhook lookup
            'metadata.obiexId': obiexTransactionId 
        }
      });
      return { success: true, data: obiexResult.data };
    } else {
      // Only mark as FAILED if Obiex immediately rejects (not processing)
      await Transaction.findByIdAndUpdate(transactionId, {
        $set: { 
            status: 'FAILED', 
            'ngnzWithdrawal.failureReason': obiexResult.message,
            'ngnzWithdrawal.failedAt': new Date()
        }
      });
      return { success: false, error: obiexResult.message };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// --- API ENDPOINTS ---

/**
 * POST /withdraw
 * Processes NGNZ withdrawal to Bank via Obiex
 */
router.post('/withdraw', idempotencyMiddleware, async (req, res) => {
  const correlationId = generateCorrelationId();
  const systemContext = getSystemContext(req);
  const idempotencyKey = req.headers['x-idempotency-key'];
  
  try {
    const userId = req.user.id;
    const { amount, destination, narration, twoFactorCode, passwordpin } = req.body;
    
    // 1. Validations
    const validationErrors = validateWithdrawalRequest({ amount, destination, twoFactorCode, passwordpin });
    if (validationErrors.length > 0) return res.status(400).json({ success: false, errors: validationErrors });

    const kycCheck = await validateTransactionLimit(userId, amount, 'NGNZ', 'NGNZ');
    if (!kycCheck.allowed) return res.status(400).json({ success: false, message: kycCheck.message });

    const bvnCheck = await bvnCheckService.checkBVNVerified(userId);
    if (!bvnCheck.success) return res.status(400).json({ success: false, message: bvnCheck.message });

    // 2. Authentication
    const user = await getCachedUserAuth(userId);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    // SECURITY FIX: Enforce 2FA must be enabled for withdrawals
    if (!user.is2FAEnabled) {
      logger.warn(`NGNZ withdrawal blocked: 2FA not enabled`, { userId, ip: req.ip });
      return res.status(403).json({
        success: false,
        message: 'Two-factor authentication must be enabled to perform withdrawals. Please enable 2FA in your security settings.'
      });
    }

    // SECURITY FIX: Check 2FA attempt rate limiting
    const twoFACheck = await securityService.check2FAAttempts(userId);
    if (!twoFACheck.allowed) {
      return res.status(429).json({
        success: false,
        message: twoFACheck.message,
        lockUntil: twoFACheck.lockUntil
      });
    }

    // SECURITY FIX: Check for 2FA code replay attack
    const isReplay = await securityService.check2FACodeReplay(userId, twoFactorCode);
    if (isReplay) {
      logger.warn(`NGNZ 2FA replay attack detected`, { userId, ip: req.ip });
      return res.status(401).json({
        success: false,
        message: 'This 2FA code has already been used. Please wait for a new code.'
      });
    }

    if (!validateTwoFactorAuth(user, twoFactorCode)) {
      await securityService.record2FAFailure(userId);
      const remainingAttempts = twoFACheck.attemptsRemaining - 1;

      logger.warn(`NGNZ withdrawal blocked: Invalid 2FA code`, {
        userId,
        ip: req.ip,
        attemptsRemaining: remainingAttempts
      });

      return res.status(401).json({
        success: false,
        message: remainingAttempts > 0
          ? `Invalid 2FA code. ${remainingAttempts} attempt(s) remaining.`
          : 'Invalid 2FA code.'
      });
    }

    // Reset 2FA attempts on success and mark code as used
    await securityService.reset2FAAttempts(userId);
    await securityService.mark2FACodeUsed(userId, twoFactorCode);

    // SECURITY FIX: Check PIN attempt rate limiting
    const pinCheck = await securityService.checkPINAttempts(userId);
    if (!pinCheck.allowed) {
      return res.status(423).json({
        success: false,
        message: pinCheck.message,
        accountLocked: true,
        lockUntil: pinCheck.lockUntil
      });
    }

    const isPinValid = await comparePasswordPin(passwordpin, user.passwordpin);
    if (!isPinValid) {
      const attempts = await securityService.recordPINFailure(userId);
      const remainingAttempts = Math.max(0, 5 - attempts);

      logger.warn(`NGNZ withdrawal blocked: Invalid PIN`, {
        userId,
        ip: req.ip,
        attemptsRemaining: remainingAttempts
      });

      return res.status(401).json({
        success: false,
        message: remainingAttempts > 0
          ? `Invalid PIN. ${remainingAttempts} attempt(s) remaining before account lock.`
          : 'Invalid credentials.'
      });
    }

    // Reset PIN attempts on success
    await securityService.resetPINAttempts(userId);

    if (!isTokenSupported('NGNZ')) return res.status(400).json({ success: false, message: 'Currency not supported' });

    // 3. Execution (Deduct Balance + Create Transaction) WITH DISTRIBUTED LOCK
    // SECURITY FIX: Use distributed lock to prevent race conditions
    const lockKey = `withdrawal:${userId}:NGNZ`;

    const withdrawalResult = await withLock(
      lockKey,
      async () => {
        return await executeNGNZWithdrawal(
          userId,
          { amount, destination, narration },
          correlationId,
          systemContext,
          idempotencyKey
        );
      },
      {
        ttl: 15000,        // Lock timeout: 15 seconds (longer for bank transfers)
        maxWaitTime: 5000, // Wait up to 5 seconds for lock
        retryInterval: 50  // Check every 50ms
      }
    ).catch(error => {
      logger.error(`Failed to acquire NGNZ withdrawal lock for user ${userId}:`, error.message);
      throw error; // Re-throw to be caught by outer try-catch
    });

    // 4. External Payout (Obiex)
    const obiexResult = await processObiexWithdrawal(
        userId, 
        { amount, destination, narration }, 
        withdrawalResult.amountToObiex, 
        withdrawalResult.withdrawalReference, 
        withdrawalResult.transaction._id
    );

    if (obiexResult.success) {
      // Withdrawal submitted to Obiex - status is PENDING until webhook confirms
      // Email will be sent when webhook confirms SUCCESSFUL status
      // Only send processing notification (not completed)
      sendWithdrawalNotification(userId, withdrawalResult.amountToObiex, 'NGN', 'processing', {
        reference: withdrawalResult.withdrawalReference,
        bankName: destination.bankName,
        accountNumber: maskAccountNumber(destination.accountNumber),
        fee: withdrawalResult.feeAmount,
        totalAmount: amount
      }).catch(e => logger.error('Push Error', e));

      return res.json({
        success: true,
        message: 'Withdrawal submitted successfully. Status will be updated via webhook.',
        data: {
          withdrawalId: withdrawalResult.withdrawalReference,
          totalAmount: amount,
          amountSentToBank: withdrawalResult.amountToObiex,
          fee: withdrawalResult.feeAmount,
          balanceAfter: withdrawalResult.user.ngnzBalance,
          status: 'PENDING' // Status pending webhook confirmation
        }
      });
    } else {
      // Async Failure Notification
      sendWithdrawalNotification(userId, amount, 'NGN', 'failed', {
        reason: obiexResult.error || 'Provider processing error',
        reference: withdrawalResult.withdrawalReference
      }).catch(e => logger.error('Push Error', e));

      return res.status(502).json({ 
          success: false, 
          message: 'Withdrawal failed at provider', 
          error: obiexResult.error 
      });
    }

  } catch (err) {
    logger.error('NGNZ withdrawal terminal error', { error: err.stack, correlationId });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * GET /status/:withdrawalId
 */
router.get('/status/:withdrawalId', async (req, res) => {
  try {
    const transaction = await Transaction.findOne({ 
        userId: req.user.id, 
        reference: req.params.withdrawalId, 
        currency: 'NGNZ' 
    }).lean();
    
    if (!transaction) return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    return res.json({ success: true, data: transaction });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Status retrieval error' });
  }
});

/**
 * GET /receipt/:transactionId
 */
router.get('/receipt/:transactionId', async (req, res) => {
  try {
    const transaction = await Transaction.findOne({ 
        userId: req.user.id, 
        _id: req.params.transactionId 
    });
    
    if (!transaction) return res.status(404).json({ success: false, message: 'Transaction not found' });
    return res.json({ success: true, data: transaction.getReceiptData() });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Receipt retrieval error' });
  }
});

/**
 * GET /fees
 */
router.get('/fees', (req, res) => {
  return res.json({
    success: true,
    data: {
      withdrawalFee: NGNZ_WITHDRAWAL_FEE_RECORDED,
      minimumWithdrawal: NGNZ_WITHDRAWAL_FEE_OPERATIONAL + 1
    }
  });
});

module.exports = router;