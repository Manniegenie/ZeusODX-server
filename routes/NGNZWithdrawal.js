const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { debitNaira } = require('../services/nairaWithdrawal');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { validateUserBalance: validateBalance, getUserAvailableBalance, isTokenSupported } = require('../services/balance');
const Transaction = require('../models/transaction');
const User = require('../models/user');
const TransactionAudit = require('../models/TransactionAudit');
const logger = require('../utils/logger');
const crypto = require('crypto');

const router = express.Router();

// Cache for user balance optimization
const userCache = new Map();
const CACHE_TTL = 30000; // 30 seconds

// NGNZ withdrawal fees
// NOTE: OPERATIONAL FEE (30 NGN) vs RECORDED FEE (100 NGN)
// - The actual fee deducted operationally is 30 NGN (used in calculations)
// - The fee recorded in database for record purposes is 100 NGN
// - This creates a 70 NGN discrepancy in accounting records
const NGNZ_WITHDRAWAL_FEE_OPERATIONAL = 30; // Used for actual calculations
const NGNZ_WITHDRAWAL_FEE_RECORDED = 100;    // Used for database records

/**
 * Create audit entry with error handling
 */
async function createAuditEntry(auditData) {
  try {
    await TransactionAudit.createAudit(auditData);
  } catch (error) {
    logger.error('Failed to create audit entry', {
      error: error.message,
      auditData: { ...auditData, requestData: '[REDACTED]', responseData: '[REDACTED]' }
    });
  }
}

/**
 * Generate correlation ID for tracking related operations
 */
function generateCorrelationId() {
  return `NGNZ_WD_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generate unique withdrawal reference
 */
function generateWithdrawalReference() {
  return `NGNZ_WD_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Get system context from request
 */
function getSystemContext(req) {
  return {
    ipAddress: req.ip || req.connection?.remoteAddress || 'unknown',
    userAgent: req.get('User-Agent') || 'unknown',
    sessionId: req.sessionID || 'unknown',
    apiVersion: req.get('API-Version') || '1.0',
    platform: req.get('Platform') || 'unknown',
    environment: process.env.NODE_ENV || 'production'
  };
}

/**
 * Mask account number for security logging
 */
function maskAccountNumber(accountNumber) {
  if (!accountNumber) return '';
  const str = String(accountNumber).replace(/\s+/g, '');
  return str.length <= 4 ? str : `${str.slice(0, 2)}****${str.slice(-2)}`;
}

/**
 * Hash account number (store hash only, not raw)
 */
function hashAccountNumber(accountNumber) {
  try {
    return crypto.createHash('sha256').update(String(accountNumber || '')).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Format currency for display
 */
function formatCurrency(amount, currency = 'NGN') {
  if (!amount) return '—';
  const symbol = currency === 'NGN' ? '₦' : currency === 'NGNZ' ? '₦' : '';
  return `${symbol}${Math.abs(amount).toLocaleString()}`;
}

/**
 * Format date for display
 */
function formatDate(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Compare password pin with user's hashed password pin
 */
async function comparePasswordPin(candidatePasswordPin, hashedPasswordPin) {
  if (!candidatePasswordPin || !hashedPasswordPin) return false;
  try {
    return await bcrypt.compare(candidatePasswordPin, hashedPasswordPin);
  } catch (error) {
    logger.error('Password pin comparison failed:', error);
    return false;
  }
}

/**
 * Validate withdrawal request data including authentication
 */
function validateWithdrawalRequest(data) {
  const errors = [];
  
  if (!data.amount || typeof data.amount !== 'number' || data.amount <= 0) {
    errors.push('Amount must be a positive number');
  }
  
  if (!data.destination) {
    errors.push('Destination bank details are required');
  } else {
    if (!data.destination.accountNumber) errors.push('Account number is required');
    if (!data.destination.accountName) errors.push('Account name is required');
    if (!data.destination.bankName) errors.push('Bank name is required');
    if (!data.destination.bankCode) errors.push('Bank code is required');
  }
  
  // Validate amount limits including withdrawal fee (use operational fee for validation)
  const minimumWithdrawal = NGNZ_WITHDRAWAL_FEE_OPERATIONAL + 1; // Must be higher than operational fee
  if (data.amount && data.amount < minimumWithdrawal) {
    errors.push(`Minimum withdrawal amount is ₦${minimumWithdrawal} (includes ₦${NGNZ_WITHDRAWAL_FEE_RECORDED} fee)`);
  }
  
  if (data.amount && data.amount > 1000000) {
    errors.push('Maximum withdrawal amount is ₦1,000,000');
  }

  // Check if amount can cover the withdrawal fee (use operational fee)
  if (data.amount && data.amount <= NGNZ_WITHDRAWAL_FEE_OPERATIONAL) {
    errors.push(`Amount too small to cover ₦${NGNZ_WITHDRAWAL_FEE_RECORDED} withdrawal fee. Minimum: ₦${NGNZ_WITHDRAWAL_FEE_OPERATIONAL + 1}`);
  }

  // 2FA validation
  if (!data.twoFactorCode?.trim()) {
    errors.push('Two-factor authentication code is required');
  }

  // Password PIN validation
  if (!data.passwordpin?.trim()) {
    errors.push('Password PIN is required');
  } else {
    const passwordpin = String(data.passwordpin).trim();
    if (!/^\d{6}$/.test(passwordpin)) {
      errors.push('Password PIN must be exactly 6 numbers');
    }
  }
  
  return errors;
}

/**
 * Get cached user data with authentication fields only
 */
async function getCachedUserAuth(userId) {
  const cacheKey = `user_auth_${userId}`;
  const cached = userCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.user;
  }
  
  const user = await User.findById(userId).select(
    '_id twoFASecret is2FAEnabled passwordpin'
  ).lean(); // Include only authentication fields
  
  if (user) {
    userCache.set(cacheKey, { user, timestamp: Date.now() });
    setTimeout(() => userCache.delete(cacheKey), CACHE_TTL);
  }
  
  return user;
}

/**
 * Execute NGNZ withdrawal with atomic balance updates and comprehensive auditing
 * Deducts full amount; sends (amount - OPERATIONAL_FEE) to provider.
 * Records RECORDED_FEE (100 NGN) in database for record purposes.
 */
async function executeNGNZWithdrawal(userId, withdrawalData, correlationId, systemContext) {
  const session = await mongoose.startSession();
  session.startTransaction();
  const startTime = new Date();
  let transactionCommitted = false; // Track transaction state
  
  try {
    const { amount, destination, narration } = withdrawalData;
    const withdrawalReference = generateWithdrawalReference();
    
    // Calculate amounts using OPERATIONAL fee (30 NGN)
    const totalDeducted = amount; // Full amount deducted from user
    const amountToBank = amount - NGNZ_WITHDRAWAL_FEE_OPERATIONAL; // Amount sent to bank (minus operational fee)
    const feeAmountRecordedRecorded = NGNZ_WITHDRAWAL_FEE_RECORDED; // Fee recorded in database (100 NGN)
    
    // Get current balance for audit trail
    const userBefore = await User.findById(userId).select('ngnzBalance').lean();
    
    // 1. Deduct full NGNZ amount (including fee) atomically
    const updatedUser = await User.findOneAndUpdate(
      { 
        _id: userId, 
        ngnzBalance: { $gte: totalDeducted } // Ensure sufficient balance for total amount
      },
      {
        $inc: { ngnzBalance: -totalDeducted },
        $set: { lastBalanceUpdate: new Date() }
      },
      { 
        new: true, 
        runValidators: true, 
        session 
      }
    );

    if (!updatedUser) {
      throw new Error('Balance update failed - insufficient NGNZ balance or user not found');
    }

    // Clear user cache
    userCache.delete(`user_auth_${userId}`);

    // 2. Create withdrawal transaction record
    const last4 = String(destination.accountNumber || '').slice(-4);
    const withdrawalTransaction = new Transaction({
      userId,
      type: 'WITHDRAWAL',
      currency: 'NGNZ',
      amount: -totalDeducted, // Negative for outgoing (full amount)
      status: 'PENDING',
      source: 'NGNZ_WITHDRAWAL',
      reference: withdrawalReference,
      obiexTransactionId: withdrawalReference,
      narration: narration || `NGNZ withdrawal to ${destination.bankName} (includes ₦${feeAmountRecorded} fee)`,

      // NEW: first-class NGNZ fields (use RECORDED fee)
      isNGNZWithdrawal: true,
      bankAmount: amountToBank,        // POSITIVE amount that will hit bank
      withdrawalFee: feeAmountRecordedRecorded, // RECORDED fee (100 NGN)
      payoutCurrency: 'NGN',
      ngnzWithdrawal: {
        withdrawalReference,
        requestedAmount: totalDeducted,
        withdrawalFee: feeAmountRecorded,
        amountSentToBank: amountToBank,
        payoutCurrency: 'NGN',
        destination: {
          bankName: destination.bankName,
          bankCode: destination.bankCode,
          pagaBankCode: destination.pagaBankCode,
          merchantCode: destination.merchantCode,
          accountName: destination.accountName,
          accountNumber: destination.accountNumber,
          accountNumberMasked: maskAccountNumber(destination.accountNumber),
          accountNumberLast4: last4,
          accountNumberHash: hashAccountNumber(destination.accountNumber),
        },
        provider: 'OBIEX',
        idempotencyKey: `ngnz-wd-${withdrawalReference}`,
        preparedAt: new Date(),
      },

      // NEW: Frontend receipt details
      receiptDetails: {
        transactionId: withdrawalReference,
        reference: withdrawalReference,
        provider: 'OBIEX',
        providerStatus: 'PENDING',
        bankName: destination.bankName,
        accountName: destination.accountName,
        accountNumber: destination.accountNumber,
        currency: 'NGNZ',
        amount: formatCurrency(totalDeducted, 'NGNZ'),
        fee: formatCurrency(feeAmountRecorded),
        narration: narration || `NGNZ withdrawal to ${destination.bankName}`,
        date: formatDate(new Date()),
        category: 'withdrawal',
        additionalFields: {
          amountSentToBank: formatCurrency(amountToBank),
          totalAmountDeducted: formatCurrency(totalDeducted, 'NGNZ'),
          withdrawalFee: formatCurrency(feeAmountRecorded),
          payoutCurrency: 'NGN'
        }
      },

      // Keep metadata for backwards compatibility
      metadata: {
        withdrawalType: 'NGNZ_TO_BANK',
        destinationBank: destination.bankName,
        destinationAccount: maskAccountNumber(destination.accountNumber),
        destinationAccountName: destination.accountName,
        bankCode: destination.bankCode,
        correlationId,
        obiexCurrency: 'NGNX',
        twofa_validated: true,
        passwordpin_validated: true,
        is_ngnz_withdrawal: true,
        totalAmountDeducted: totalDeducted,
        amountSentToBank: amountToBank,
        withdrawalFee: feeAmountRecorded,
        feeApplied: true
      }
    });

    await withdrawalTransaction.save({ session });

    // 3. Commit balance update and transaction creation
    await session.commitTransaction();
    transactionCommitted = true; // Mark as committed
    session.endSession();
    
    const endTime = new Date();

    logger.info('NGNZ withdrawal prepared successfully with fee deduction', {
      userId,
      withdrawalReference,
      correlationId,
      totalDeducted,
      amountToBank,
      feeAmountRecorded,
      destinationBank: destination.bankName,
      destinationAccount: maskAccountNumber(destination.accountNumber),
      balanceBefore: userBefore.ngnzBalance,
      balanceAfter: updatedUser.ngnzBalance,
      transactionId: withdrawalTransaction._id
    });

    // Create comprehensive audit entries (outside transaction)
    // Use setImmediate to prevent blocking and avoid transaction state issues
    setImmediate(async () => {
      try {
        await Promise.all([
          // Balance update audit
          createAuditEntry({
            userId,
            eventType: 'BALANCE_UPDATED',
            status: 'SUCCESS',
            source: 'NGNZ_WITHDRAWAL',
            action: 'Deduct NGNZ for Withdrawal',
            description: `Deducted ₦${totalDeducted.toLocaleString()} NGNZ for bank withdrawal (₦${amountToBank.toLocaleString()} to bank + ₦${feeAmountRecorded} fee)`,
            beforeState: {
              ngnzBalance: userBefore.ngnzBalance
            },
            afterState: {
              ngnzBalance: updatedUser.ngnzBalance
            },
            financialImpact: {
              currency: 'NGNZ',
              amount: -totalDeducted,
              balanceBefore: userBefore.ngnzBalance,
              balanceAfter: updatedUser.ngnzBalance
            },
            swapDetails: {
              swapId: withdrawalReference,
              sourceCurrency: 'NGNZ',
              targetCurrency: 'NGN',
              sourceAmount: totalDeducted,
              transferAmount: amountToBank,
              withdrawalFee: feeAmountRecorded,
              provider: 'OBIEX_WITHDRAWAL',
              swapType: 'NGNZ_TO_BANK'
            },
            relatedEntities: {
              correlationId,
              relatedTransactionIds: [withdrawalTransaction._id]
            },
            systemContext,
            timing: {
              startTime,
              endTime,
              duration: endTime - startTime
            },
            tags: ['balance-update', 'ngnz-withdrawal', 'bank-transfer', 'fee-applied']
          }),
          
          // Transaction creation audit
          createAuditEntry({
            userId,
            transactionId: withdrawalTransaction._id,
            eventType: 'TRANSACTION_CREATED',
            status: 'SUCCESS',
            source: 'NGNZ_WITHDRAWAL',
            action: 'Create NGNZ Withdrawal Transaction',
            description: `Created withdrawal transaction for ₦${totalDeducted.toLocaleString()} NGNZ (₦${amountToBank.toLocaleString()} to bank + ₦${feeAmountRecorded} fee)`,
            financialImpact: {
              currency: 'NGNZ',
              amount: -totalDeducted,
              balanceBefore: userBefore.ngnzBalance,
              balanceAfter: updatedUser.ngnzBalance
            },
            swapDetails: {
              swapId: withdrawalReference,
              provider: 'OBIEX_WITHDRAWAL',
              swapType: 'NGNZ_TO_BANK',
              withdrawalFee: feeAmountRecorded,
              transferAmount: amountToBank
            },
            relatedEntities: {
              correlationId
            },
            systemContext,
            tags: ['transaction', 'ngnz-withdrawal', 'bank-transfer', 'fee-applied']
          })
        ]);
      } catch (auditError) {
        logger.error('Failed to create audit entries after successful withdrawal', {
          error: auditError.message,
          userId,
          withdrawalReference
        });
      }
    });

    return {
      user: updatedUser,
      transaction: withdrawalTransaction,
      withdrawalReference,
      totalDeducted,
      amountToObiex,
      feeAmount: feeAmountRecorded // Return recorded fee
    };

  } catch (err) {
    // Only abort if transaction hasn't been committed yet
    if (!transactionCommitted) {
      try {
        await session.abortTransaction();
      } catch (abortError) {
        logger.error('Failed to abort transaction', {
          error: abortError.message,
          originalError: err.message,
          userId,
          correlationId
        });
      }
    }
    
    // Ensure session is ended
    try {
      session.endSession();
    } catch (endError) {
      logger.error('Failed to end session', {
        error: endError.message,
        userId,
        correlationId
      });
    }
    
    const endTime = new Date();
    
    logger.error('NGNZ withdrawal preparation failed', {
      error: err.message,
      stack: err.stack,
      userId,
      correlationId,
      transactionCommitted,
      withdrawalData: {
        ...withdrawalData,
        destination: {
          ...withdrawalData.destination,
          accountNumber: maskAccountNumber(withdrawalData.destination?.accountNumber)
        }
      }
    });
    
    // Create failure audit entry (async, non-blocking)
    setImmediate(async () => {
      try {
        await createAuditEntry({
          userId,
          eventType: 'SWAP_FAILED',
          status: 'FAILED',
          source: 'NGNZ_WITHDRAWAL',
          action: 'Failed NGNZ Withdrawal Preparation',
          description: `NGNZ withdrawal preparation failed: ${err.message}`,
          errorDetails: {
            message: err.message,
            code: 'NGNZ_WITHDRAWAL_PREP_ERROR',
            stack: err.stack,
            transactionCommitted
          },
          swapDetails: {
            sourceCurrency: 'NGNZ',
            targetCurrency: 'NGN',
            sourceAmount: withdrawalData.amount,
            provider: 'OBIEX_WITHDRAWAL',
            swapType: 'NGNZ_TO_BANK'
          },
          relatedEntities: {
            correlationId
          },
          systemContext,
          timing: {
            startTime,
            endTime,
            duration: endTime - startTime
          },
          riskLevel: 'HIGH',
          flagged: true,
          flagReason: 'NGNZ withdrawal preparation failed',
          tags: ['withdrawal', 'ngnz', 'failed', 'critical-error']
        });
      } catch (auditError) {
        logger.error('Failed to create failure audit entry', {
          error: auditError.message,
          userId,
          correlationId
        });
      }
    });
    
    throw err;
  }
}

/**
 * Process Obiex withdrawal (NGNZ → NGNX conversion)
 * Sends reduced amount (original amount minus OPERATIONAL fee) to Obiex.
 * Records RECORDED fee (100 NGN) in database.
 */
async function processObiexWithdrawal(userId, withdrawalData, amountToObiex, withdrawalReference, transactionId, correlationId, systemContext) {
  const startTime = new Date();
  
  try {
    const { destination, narration } = withdrawalData;
    const originalAmount = withdrawalData.amount;
    const feeAmountRecorded = NGNZ_WITHDRAWAL_FEE_RECORDED; // Use recorded fee (100 NGN)
    
    // Create audit for Obiex operation initiation
    await createAuditEntry({
      userId,
      eventType: 'OBIEX_SWAP_INITIATED',
      status: 'PENDING',
      source: 'OBIEX_API',
      action: 'Initiate NGNZ Bank Withdrawal',
      description: `Starting Obiex NGNX withdrawal: ₦${amountToBank.toLocaleString()} to ${destination.bankName} (₦${originalAmount.toLocaleString()} - ₦${feeAmountRecorded} fee)`,
      swapDetails: {
        swapId: withdrawalReference,
        sourceCurrency: 'NGNZ',
        targetCurrency: 'NGN',
        sourceAmount: originalAmount,
        transferAmount: amountToBank,
        withdrawalFee: feeAmountRecorded,
        provider: 'OBIEX',
        swapType: 'NGNZ_TO_BANK'
      },
      obiexDetails: {
        obiexSourceCurrency: 'NGNX',
        obiexTargetCurrency: 'NGN',
        obiexOperationType: 'FIAT_WITHDRAWAL',
        obiexAmount: amountToBank
      },
      relatedEntities: {
        correlationId,
        relatedTransactionIds: [transactionId]
      },
      systemContext,
      timing: {
        startTime
      },
      tags: ['obiex', 'ngnz-withdrawal', 'bank-transfer', 'initiated', 'fee-applied']
    });

    // Call Obiex service with NGNX
    const obiexPayload = {
      destination: {
        accountNumber: destination.accountNumber,
        accountName: destination.accountName,
        bankName: destination.bankName,
        bankCode: destination.bankCode,
        ...(destination.pagaBankCode && { pagaBankCode: destination.pagaBankCode }),
        ...(destination.merchantCode && { merchantCode: destination.merchantCode })
      },
      amount: amountToBank, // Send amount after total fee deduction
      currency: 'NGNX',
      narration: narration || `NGNZ withdrawal - ${withdrawalReference}`
    };

    logger.info('Initiating Obiex NGNX withdrawal', {
      withdrawalReference,
      correlationId,
      originalAmount,
      amountToBank,
      feeAmountRecorded,
      currency: 'NGNX',
      bankName: destination.bankName,
      accountNumber: maskAccountNumber(destination.accountNumber)
    });

    const obiexResult = await debitNaira(obiexPayload, {
      userId: userId.toString(),
      idempotencyKey: `ngnz-wd-${withdrawalReference}`
    });

    const endTime = new Date();

    if (obiexResult.success) {
      // Update transaction status to SUCCESS + enrich subdoc + update receipt details
      await Transaction.findByIdAndUpdate(
        transactionId,
        {
          $set: {
            status: 'SUCCESSFUL',
            completedAt: new Date(),
            'metadata.obiexId': obiexResult.data?.id,
            'metadata.obiexReference': obiexResult.data?.reference,
            'metadata.obiexStatus': obiexResult.data?.status,
            'metadata.actualAmountSent': amountToBank,

            'ngnzWithdrawal.sentAt': new Date(),
            'ngnzWithdrawal.completedAt': new Date(),
            'ngnzWithdrawal.provider': 'OBIEX',
            'ngnzWithdrawal.obiex.id': obiexResult.data?.id,
            'ngnzWithdrawal.obiex.reference': obiexResult.data?.reference,
            'ngnzWithdrawal.obiex.status': obiexResult.data?.status,

            // Update receipt details with final Obiex information
            'receiptDetails.transactionId': obiexResult.data?.id || withdrawalReference,
            'receiptDetails.providerStatus': obiexResult.data?.status || 'SUCCESSFUL',
            'receiptDetails.additionalFields.obiexId': obiexResult.data?.id,
            'receiptDetails.additionalFields.obiexReference': obiexResult.data?.reference,
            'receiptDetails.additionalFields.obiexStatus': obiexResult.data?.status,
            'receiptDetails.additionalFields.completedAt': formatDate(new Date()),
          }
        }
      );

      logger.info('NGNZ withdrawal completed successfully via Obiex with fee deduction', {
        userId,
        withdrawalReference,
        correlationId,
        originalAmount,
        amountToBank,
        feeAmountRecorded,
        obiexId: obiexResult.data?.id,
        obiexReference: obiexResult.data?.reference,
        obiexStatus: obiexResult.data?.status
      });

      // Create success audit entry
      await createAuditEntry({
        userId,
        transactionId,
        eventType: 'OBIEX_SWAP_COMPLETED',
        status: 'SUCCESS',
        source: 'OBIEX_API',
        action: 'Complete NGNZ Bank Withdrawal',
        description: `Successfully completed Obiex NGNX withdrawal to ${destination.bankName}: ₦${amountToBank.toLocaleString()} (₦${originalAmount.toLocaleString()} - ₦${feeAmountRecorded} fee)`,
        swapDetails: {
          swapId: withdrawalReference,
          sourceCurrency: 'NGNZ',
          targetCurrency: 'NGN',
          sourceAmount: originalAmount,
          transferAmount: amountToBank,
          withdrawalFee: feeAmountRecorded,
          provider: 'OBIEX',
          swapType: 'NGNZ_TO_BANK'
        },
        obiexDetails: {
          obiexTransactionId: obiexResult.data?.id,
          obiexReference: obiexResult.data?.reference,
          obiexStatus: obiexResult.data?.status,
          obiexResponse: obiexResult.data,
          obiexOperationType: 'FIAT_WITHDRAWAL',
          obiexSourceCurrency: 'NGNX',
          obiexTargetCurrency: 'NGN',
          obiexAmount: amountToBank
        },
        relatedEntities: {
          correlationId,
          relatedTransactionIds: [transactionId]
        },
        responseData: obiexResult.data,
        systemContext,
        timing: {
          startTime,
          endTime,
          duration: endTime - startTime
        },
        tags: ['obiex', 'ngnz-withdrawal', 'bank-transfer', 'success', 'fee-applied']
      });

      return { success: true, data: obiexResult.data, amountSent: amountToBank, feeDeducted: feeAmountRecorded };

    } else {
      // Update transaction status to FAILED + subdoc failure fields + update receipt details
      await Transaction.findByIdAndUpdate(
        transactionId,
        {
          $set: {
            status: 'FAILED',
            completedAt: new Date(),
            'metadata.obiexError': obiexResult.message,
            'metadata.obiexStatusCode': obiexResult.statusCode,

            'ngnzWithdrawal.failedAt': new Date(),
            'ngnzWithdrawal.failureReason': obiexResult.message || 'UNKNOWN_ERROR',

            // Update receipt details for failed transaction
            'receiptDetails.providerStatus': 'FAILED',
            'receiptDetails.additionalFields.failureReason': obiexResult.message,
            'receiptDetails.additionalFields.statusCode': obiexResult.statusCode,
            'receiptDetails.additionalFields.failedAt': formatDate(new Date()),
          }
        }
      );

      logger.error('NGNZ withdrawal failed via Obiex', {
        userId,
        withdrawalReference,
        correlationId,
        originalAmount,
        amountToBank,
        feeAmountRecorded,
        error: obiexResult.message,
        statusCode: obiexResult.statusCode,
        providerError: obiexResult.providerRaw
      });

      // Create failure audit entry
      await createAuditEntry({
        userId,
        transactionId,
        eventType: 'OBIEX_SWAP_FAILED',
        status: 'FAILED',
        source: 'OBIEX_API',
        action: 'Failed NGNZ Bank Withdrawal',
        description: `Obiex NGNX withdrawal failed: ${obiexResult.message}`,
        errorDetails: {
          message: obiexResult.message,
          code: obiexResult.providerCode || 'OBIEX_WITHDRAWAL_ERROR',
          httpStatus: obiexResult.statusCode,
          providerError: obiexResult.providerRaw
        },
        swapDetails: {
          swapId: withdrawalReference,
          sourceCurrency: 'NGNZ',
          targetCurrency: 'NGN',
          sourceAmount: originalAmount,
          transferAmount: amountToBank,
          withdrawalFee: feeAmountRecorded,
          provider: 'OBIEX',
          swapType: 'NGNZ_TO_BANK'
        },
        obiexDetails: {
          obiexSourceCurrency: 'NGNX',
          obiexTargetCurrency: 'NGN',
          obiexOperationType: 'FIAT_WITHDRAWAL',
          obiexAmount: amountToBank
        },
        relatedEntities: {
          correlationId,
          relatedTransactionIds: [transactionId]
        },
        responseData: obiexResult,
        systemContext,
        timing: {
          startTime,
          endTime,
          duration: endTime - startTime
        },
        riskLevel: 'HIGH',
        flagged: true,
        flagReason: 'Obiex NGNZ withdrawal operation failed',
        tags: ['obiex', 'ngnz-withdrawal', 'bank-transfer', 'failed', 'fee-applied']
      });

      return { success: false, error: obiexResult.message, statusCode: obiexResult.statusCode };
    }

  } catch (error) {
    const endTime = new Date();
    
    logger.error('Obiex NGNZ withdrawal processing failed', {
      error: error.message,
      stack: error.stack,
      userId,
      withdrawalReference,
      correlationId,
      amountToBank
    });

    // Update transaction status to FAILED + subdoc failure fields + update receipt details
    await Transaction.findByIdAndUpdate(
      transactionId,
      {
        $set: {
          status: 'FAILED',
          completedAt: new Date(),
          'metadata.systemError': error.message,

          'ngnzWithdrawal.failedAt': new Date(),
          'ngnzWithdrawal.failureReason': error.message || 'SYSTEM_ERROR',

          // Update receipt details for system error
          'receiptDetails.providerStatus': 'FAILED',
          'receiptDetails.additionalFields.failureReason': error.message,
          'receiptDetails.additionalFields.errorType': 'SYSTEM_ERROR',
          'receiptDetails.additionalFields.failedAt': formatDate(new Date()),
        }
      }
    );

    // Create error audit entry
    await createAuditEntry({
      userId,
      transactionId,
      eventType: 'OBIEX_SWAP_FAILED',
      status: 'FAILED',
      source: 'OBIEX_API',
      action: 'NGNZ Withdrawal System Error',
      description: `NGNZ withdrawal failed with system error: ${error.message}`,
      errorDetails: {
        message: error.message,
        code: 'SYSTEM_WITHDRAWAL_ERROR',
        stack: error.stack
      },
      swapDetails: {
        swapId: withdrawalReference,
        sourceCurrency: 'NGNZ',
        targetCurrency: 'NGN',
        sourceAmount: withdrawalData.amount,
        transferAmount: amountToBank,
        withdrawalFee: NGNZ_WITHDRAWAL_FEE_RECORDED,
        provider: 'OBIEX',
        swapType: 'NGNZ_TO_BANK'
      },
      relatedEntities: {
        correlationId,
        relatedTransactionIds: [transactionId]
      },
      systemContext,
      timing: {
        startTime,
        endTime,
        duration: endTime - startTime
      },
      riskLevel: 'CRITICAL',
      flagged: true,
      flagReason: 'Critical system error in NGNZ withdrawal',
      tags: ['obiex', 'ngnz-withdrawal', 'system-error', 'critical']
    });

    return { success: false, error: error.message };
  }
}

// NGNZ WITHDRAWAL ENDPOINT WITH 2FA AND PIN AUTHENTICATION AND 100 NGN RECORDED FEE
router.post('/withdraw', async (req, res) => {
  const correlationId = generateCorrelationId();
  const systemContext = getSystemContext(req);
  const startTime = new Date();
  
  try {
    const userId = req.user.id;
    const { amount, destination, narration, twoFactorCode, passwordpin } = req.body;
    
    logger.info(`NGNZ withdrawal request from user ${userId}:`, {
      amount,
      destinationBank: destination?.bankName,
      destinationAccount: destination?.accountNumber ? maskAccountNumber(destination.accountNumber) : null,
      withdrawalFee: NGNZ_WITHDRAWAL_FEE_RECORDED,
      amountToBank: amount ? amount - NGNZ_WITHDRAWAL_FEE_OPERATIONAL : null,
      twoFactorCode: '[REDACTED]',
      passwordpin: '[REDACTED]'
    });
    
    // Create audit for withdrawal request
    await createAuditEntry({
      userId,
      eventType: 'USER_ACTION',
      status: 'PENDING',
      source: 'API_ENDPOINT',
      action: 'Request NGNZ Withdrawal',
      description: `NGNZ withdrawal request: ₦${amount?.toLocaleString() || 'N/A'} to ${destination?.bankName || 'unknown bank'} (₦${NGNZ_WITHDRAWAL_FEE_RECORDED} fee will be deducted)`,
      requestData: {
        amount,
        amountToBank: amount ? amount - NGNZ_WITHDRAWAL_FEE_OPERATIONAL : null,
        withdrawalFee: NGNZ_WITHDRAWAL_FEE_RECORDED, // RECORDED fee
        destination: destination ? {
          ...destination,
          accountNumber: maskAccountNumber(destination.accountNumber)
        } : null,
        narration,
        has2FA: !!twoFactorCode,
        hasPIN: !!passwordpin
      },
      relatedEntities: {
        correlationId
      },
      systemContext,
      timing: {
        startTime
      },
      tags: ['withdrawal', 'ngnz', 'request', 'fee-applicable']
    });

    // Validate request data (including authentication fields and fee considerations)
    const validationErrors = validateWithdrawalRequest({ amount, destination, twoFactorCode, passwordpin });
    if (validationErrors.length > 0) {
      await createAuditEntry({
        userId,
        eventType: 'USER_ACTION',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'Failed NGNZ Withdrawal Validation',
        description: 'NGNZ withdrawal request failed validation',
        errorDetails: {
          message: validationErrors.join('; '),
          code: 'VALIDATION_ERROR'
        },
        requestData: {
          amount,
          withdrawalFee: NGNZ_WITHDRAWAL_FEE_RECORDED,
          destination: destination ? {
            ...destination,
            accountNumber: maskAccountNumber(destination.accountNumber)
          } : null
        },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['withdrawal', 'ngnz', 'validation', 'failed']
      });

      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validationErrors,
        withdrawalFee: {
          amount: NGNZ_WITHDRAWAL_FEE_RECORDED,
          currency: 'NGN',
          description: 'Withdrawal processing fee'
        }
      });
    }

    // Get user data with authentication fields
    const user = await getCachedUserAuth(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Validate NGNZ is supported
    if (!isTokenSupported('NGNZ')) {
      logger.error('NGNZ token not supported in balance service', { userId });
      return res.status(400).json({
        success: false,
        message: 'NGNZ currency is not currently supported for withdrawals'
      });
    }

    // Validate 2FA setup and code
    if (!user.twoFASecret || !user.is2FAEnabled) {
      await createAuditEntry({
        userId,
        eventType: 'USER_ACTION',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'NGNZ Withdrawal 2FA Not Setup',
        description: 'NGNZ withdrawal failed - 2FA not setup or not enabled',
        errorDetails: {
          message: 'Two-factor authentication is not set up or not enabled',
          code: '2FA_NOT_SETUP'
        },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['withdrawal', 'ngnz', '2fa', 'not-setup']
      });

      return res.status(400).json({
        success: false,
        message: 'Two-factor authentication is not set up or not enabled. Please enable 2FA first.'
      });
    }

    if (!validateTwoFactorAuth(user, twoFactorCode)) {
      logger.warn('2FA validation failed for NGNZ withdrawal', { 
        userId, errorType: 'INVALID_2FA'
      });

      await createAuditEntry({
        userId,
        eventType: 'USER_ACTION',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'NGNZ Withdrawal Invalid 2FA',
        description: 'NGNZ withdrawal failed - invalid 2FA code',
        errorDetails: {
          message: 'Invalid two-factor authentication code',
          code: 'INVALID_2FA_CODE'
        },
        relatedEntities: {
          correlationId
        },
        systemContext,
        riskLevel: 'MEDIUM',
        flagged: true,
        flagReason: 'Invalid 2FA attempt for withdrawal',
        tags: ['withdrawal', 'ngnz', '2fa', 'invalid']
      });

      return res.status(401).json({
        success: false,
        error: 'INVALID_2FA_CODE',
        message: 'Invalid two-factor authentication code'
      });
    }

    logger.info('2FA validation successful for NGNZ withdrawal', { userId });

    // Validate password PIN setup and code
    if (!user.passwordpin) {
      await createAuditEntry({
        userId,
        eventType: 'USER_ACTION',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'NGNZ Withdrawal PIN Not Setup',
        description: 'NGNZ withdrawal failed - password PIN not setup',
        errorDetails: {
          message: 'Password PIN is not set up for your account',
          code: 'PIN_NOT_SETUP'
        },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['withdrawal', 'ngnz', 'pin', 'not-setup']
      });

      return res.status(400).json({
        success: false,
        message: 'Password PIN is not set up for your account. Please set up your password PIN first.'
      });
    }

    const isPasswordPinValid = await comparePasswordPin(passwordpin, user.passwordpin);
    if (!isPasswordPinValid) {
      logger.warn('Password PIN validation failed for NGNZ withdrawal', { 
        userId, errorType: 'INVALID_PASSWORDPIN'
      });

      await createAuditEntry({
        userId,
        eventType: 'USER_ACTION',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'NGNZ Withdrawal Invalid PIN',
        description: 'NGNZ withdrawal failed - invalid password PIN',
        errorDetails: {
          message: 'Invalid password PIN',
          code: 'INVALID_PASSWORDPIN'
        },
        relatedEntities: {
          correlationId
        },
        systemContext,
        riskLevel: 'MEDIUM',
        flagged: true,
        flagReason: 'Invalid PIN attempt for withdrawal',
        tags: ['withdrawal', 'ngnz', 'pin', 'invalid']
      });

      return res.status(401).json({
        success: false,
        error: 'INVALID_PASSWORDPIN',
        message: 'Invalid password PIN'
      });
    }

    logger.info('Password PIN validation successful for NGNZ withdrawal', { userId });

    // Validate user balance using balance service (for full amount including fee)
    const balanceValidation = await validateBalance(userId, 'NGNZ', amount, {
      includeBalanceDetails: true,
      logValidation: true
    });
    
    if (!balanceValidation.success) {
      await createAuditEntry({
        userId,
        eventType: 'BALANCE_SYNC',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'Insufficient NGNZ Balance',
        description: `Insufficient NGNZ balance for withdrawal: ${balanceValidation.message}`,
        errorDetails: {
          message: balanceValidation.message,
          code: 'INSUFFICIENT_BALANCE'
        },
        financialImpact: {
          currency: 'NGNZ',
          amount: amount,
          balanceBefore: balanceValidation.availableBalance || 0
        },
        swapDetails: {
          sourceCurrency: 'NGNZ',
          targetCurrency: 'NGN',
          sourceAmount: amount,
          transferAmount: amount - NGNZ_WITHDRAWAL_FEE_OPERATIONAL,
          withdrawalFee: NGNZ_WITHDRAWAL_FEE_RECORDED,
          provider: 'OBIEX_WITHDRAWAL',
          swapType: 'NGNZ_TO_BANK'
        },
        relatedEntities: {
          correlationId
        },
        systemContext,
        riskLevel: 'LOW',
        tags: ['balance', 'ngnz', 'insufficient', 'withdrawal']
      });

      return res.status(400).json({
        success: false,
        message: balanceValidation.message,
        availableBalance: balanceValidation.availableBalance || 0,
        requiredAmount: amount,
        shortfall: balanceValidation.shortfall || 0,
        currency: 'NGNZ',
        withdrawalFee: {
          amount: NGNZ_WITHDRAWAL_FEE_RECORDED,
          currency: 'NGN',
          description: 'Withdrawal processing fee'
        }
      });
    }

    logger.info('Balance validation successful for NGNZ withdrawal', {
      userId,
      amount,
      availableBalance: balanceValidation.availableBalance
    });

    // Execute withdrawal preparation (deduct full amount including fee)
    const withdrawalResult = await executeNGNZWithdrawal(
      userId, 
      { amount, destination, narration }, 
      correlationId, 
      systemContext
    );

    // Process Obiex withdrawal (send reduced amount: original - OPERATIONAL fee)
    const obiexResult = await processObiexWithdrawal(
      userId,
      { amount, destination, narration },
      withdrawalResult.amountToObiex, // This is amount - 30 NGN (operational fee)
      withdrawalResult.withdrawalReference,
      withdrawalResult.transaction._id,
      correlationId,
      systemContext
    );

    const endTime = new Date();

    if (obiexResult.success) {
      // Get the updated transaction with receipt details
      const updatedTransaction = await Transaction.findById(withdrawalResult.transaction._id);
      
      // Create successful withdrawal audit
      await createAuditEntry({
        userId,
        transactionId: withdrawalResult.transaction._id,
        eventType: 'USER_ACTION',
        status: 'SUCCESS',
        source: 'API_ENDPOINT',
        action: 'Complete NGNZ Withdrawal',
        description: `Successfully processed NGNZ withdrawal: ₦${amount.toLocaleString()} total (₦${withdrawalResult.amountToObiex.toLocaleString()} to ${destination.bankName} + ₦${withdrawalResult.feeAmount} fee)`,
        swapDetails: {
          swapId: withdrawalResult.withdrawalReference,
          sourceCurrency: 'NGNZ',
          targetCurrency: 'NGN',
          sourceAmount: amount,
          transferAmount: withdrawalResult.amountToObiex,
          withdrawalFee: withdrawalResult.feeAmount,
          provider: 'OBIEX_WITHDRAWAL',
          swapType: 'NGNZ_TO_BANK'
        },
        obiexDetails: {
          obiexTransactionId: obiexResult.data?.id,
          obiexReference: obiexResult.data?.reference,
          obiexStatus: obiexResult.data?.status,
          obiexAmount: withdrawalResult.amountToObiex
        },
        relatedEntities: {
          correlationId,
          relatedTransactionIds: [withdrawalResult.transaction._id]
        },
        systemContext,
        timing: {
          startTime,
          endTime,
          duration: endTime - startTime
        },
        tags: ['withdrawal', 'ngnz', 'success', 'completed', '2fa-verified', 'pin-verified', 'fee-applied']
      });

      return res.json({
        success: true,
        message: `NGNZ withdrawal processed successfully. ₦${withdrawalResult.feeAmount} fee deducted.`,
        data: {
          withdrawalId: withdrawalResult.withdrawalReference,
          transactionId: withdrawalResult.transaction._id,
          correlationId,
          status: 'SUCCESSFUL',
          totalAmount: amount,
          amountSentToBank: withdrawalResult.amountToObiex,
          withdrawalFee: {
            amount: withdrawalResult.feeAmount,
            currency: 'NGN',
            description: 'Withdrawal processing fee'
          },
          currency: 'NGNZ',
          destination: {
            bankName: destination.bankName,
            accountName: destination.accountName,
            accountNumber: maskAccountNumber(destination.accountNumber)
          },
          obiex: {
            transactionId: obiexResult.data?.id,
            reference: obiexResult.data?.reference,
            status: obiexResult.data?.status,
            amountSent: withdrawalResult.amountToObiex
          },
          balanceAfter: withdrawalResult.user.ngnzBalance,
          processedAt: new Date().toISOString(),
          authValidation: {
            twoFactorValidated: true,
            passwordPinValidated: true
          },
          
          // Include formatted receipt data for frontend modal
          receiptData: updatedTransaction ? updatedTransaction.getReceiptData() : null
        }
      });
    } else {
      // Create failed withdrawal audit
      await createAuditEntry({
        userId,
        transactionId: withdrawalResult.transaction._id,
        eventType: 'USER_ACTION',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'Failed NGNZ Withdrawal',
        description: `NGNZ withdrawal failed: ${obiexResult.error}`,
        errorDetails: {
          message: obiexResult.error,
          code: 'WITHDRAWAL_PROCESSING_ERROR',
          statusCode: obiexResult.statusCode
        },
        swapDetails: {
          swapId: withdrawalResult.withdrawalReference,
          sourceCurrency: 'NGNZ',
          targetCurrency: 'NGN',
          sourceAmount: amount,
          transferAmount: withdrawalResult.amountToObiex,
          withdrawalFee: withdrawalResult.feeAmount,
          provider: 'OBIEX_WITHDRAWAL',
          swapType: 'NGNZ_TO_BANK'
        },
        relatedEntities: {
          correlationId,
          relatedTransactionIds: [withdrawalResult.transaction._id]
        },
        systemContext,
        timing: {
          startTime,
          endTime,
          duration: endTime - startTime
        },
        riskLevel: 'HIGH',
        flagged: true,
        flagReason: 'NGNZ withdrawal processing failed',
        tags: ['withdrawal', 'ngnz', 'failed', 'processing-error', '2fa-verified', 'pin-verified', 'fee-applied']
      });

      return res.status(502).json({
        success: false,
        message: 'Withdrawal processing failed',
        error: obiexResult.error,
        data: {
          withdrawalId: withdrawalResult.withdrawalReference,
          transactionId: withdrawalResult.transaction._id,
          correlationId,
          status: 'FAILED',
          totalAmount: amount,
          amountSentToBank: withdrawalResult.amountToObiex,
          withdrawalFee: {
            amount: withdrawalResult.feeAmount,
            currency: 'NGN',
            description: 'Withdrawal processing fee'
          },
          currency: 'NGNZ'
        }
      });
    }

  } catch (err) {
    const endTime = new Date();
    
    logger.error('NGNZ withdrawal endpoint error', {
      error: err.stack,
      userId: req.user?.id,
      correlationId
    });

    // Create comprehensive error audit
    await createAuditEntry({
      userId: req.user?.id,
      eventType: 'SYSTEM_ERROR',
      status: 'FAILED',
      source: 'API_ENDPOINT',
      action: 'NGNZ Withdrawal System Error',
      description: `NGNZ withdrawal failed with system error: ${err.message}`,
      errorDetails: {
        message: err.message,
        code: 'SYSTEM_ERROR',
        stack: err.stack
      },
      requestData: {
        ...req.body,
        twoFactorCode: '[REDACTED]',
        passwordpin: '[REDACTED]'
      },
      relatedEntities: {
        correlationId
      },
      systemContext,
      timing: {
        startTime,
        endTime,
        duration: endTime - startTime
      },
      riskLevel: 'CRITICAL',
      flagged: true,
      flagReason: 'Critical system error in NGNZ withdrawal endpoint',
      tags: ['withdrawal', 'ngnz', 'system-error', 'critical']
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// GET WITHDRAWAL STATUS ENDPOINT
router.get('/status/:withdrawalId', async (req, res) => {
  const systemContext = getSystemContext(req);
  
  try {
    const userId = req.user.id;
    const { withdrawalId } = req.params;

    const transaction = await Transaction.findOne({
      userId,
      reference: withdrawalId,
      type: 'WITHDRAWAL',
      currency: 'NGNZ'
    }).lean();

    if (!transaction) {
      // Simple audit for not found
      setImmediate(async () => {
        await createAuditEntry({
          userId,
          eventType: 'USER_ACTION',
          status: 'FAILED',
          source: 'API_ENDPOINT',
          action: 'Withdrawal Status Not Found',
          description: `Withdrawal status request failed - withdrawal not found: ${withdrawalId}`,
          errorDetails: {
            message: 'Withdrawal not found',
            code: 'WITHDRAWAL_NOT_FOUND'
          },
          systemContext,
          tags: ['withdrawal', 'ngnz', 'status', 'not-found']
        });
      });

      return res.status(404).json({
        success: false,
        message: 'Withdrawal not found'
      });
    }

    // Prefer new fields; fall back to legacy metadata
    const totalAmount = Math.abs(transaction.amount);
    const fee =
      transaction.withdrawalFee ??
      transaction.ngnzWithdrawal?.withdrawalFee ??
      transaction.metadata?.withdrawalFee ??
      NGNZ_WITHDRAWAL_FEE_RECORDED; // Use recorded fee as default

    const amountSentToBank =
      transaction.bankAmount ??
      transaction.ngnzWithdrawal?.amountSentToBank ??
      transaction.metadata?.amountSentToObiex ??
      Math.max(totalAmount - NGNZ_WITHDRAWAL_FEE_OPERATIONAL, 0); // Use operational fee for calculation

    const dest = transaction.ngnzWithdrawal?.destination || {};
    const obiex = transaction.ngnzWithdrawal?.obiex || {};

    // Simple audit for status check
    setImmediate(async () => {
      await createAuditEntry({
        userId,
        transactionId: transaction._id,
        eventType: 'USER_ACTION',
        status: 'SUCCESS',
        source: 'API_ENDPOINT',
        action: 'Check Withdrawal Status',
        description: `Retrieved withdrawal status for ${withdrawalId}`,
        systemContext,
        tags: ['withdrawal', 'ngnz', 'status', 'check']
      });
    });

    return res.json({
      success: true,
      data: {
        withdrawalId,
        transactionId: transaction._id,
        status: transaction.status,
        totalAmount,
        amountSentToBank,
        withdrawalFee: {
          amount: fee,
          currency: transaction.payoutCurrency || transaction.ngnzWithdrawal?.payoutCurrency || 'NGN',
          description: 'Withdrawal processing fee',
          applied: true
        },
        currency: transaction.currency,
        destination: {
          bankName: dest.bankName ?? transaction.metadata?.destinationBank,
          accountName: dest.accountName ?? transaction.metadata?.destinationAccountName,
          accountNumber: dest.accountNumberMasked ?? transaction.metadata?.destinationAccount
        },
        obiex: (obiex.id || transaction.metadata?.obiexId) ? {
          transactionId: obiex.id ?? transaction.metadata?.obiexId,
          reference: obiex.reference ?? transaction.metadata?.obiexReference,
          status: obiex.status ?? transaction.metadata?.obiexStatus,
          amountSent: transaction.metadata?.actualAmountSent ?? amountSentToBank
        } : null,
        authValidation: {
          twoFactorValidated: transaction.metadata?.twofa_validated || false,
          passwordPinValidated: transaction.metadata?.passwordpin_validated || false
        },
        createdAt: transaction.createdAt,
        completedAt: transaction.completedAt,
        narration: transaction.narration
      }
    });

  } catch (err) {
    logger.error('Withdrawal status endpoint error', {
      error: err.stack,
      userId: req.user?.id,
      withdrawalId: req.params?.withdrawalId
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// GET TRANSACTION RECEIPT DATA FOR FRONTEND MODAL
router.get('/receipt/:transactionId', async (req, res) => {
  const systemContext = getSystemContext(req);
  
  try {
    const userId = req.user.id;
    const { transactionId } = req.params;

    const transaction = await Transaction.findOne({
      $or: [
        { _id: transactionId, userId },
        { reference: transactionId, userId },
        { obiexTransactionId: transactionId, userId }
      ]
    });

    if (!transaction) {
      // Simple audit for not found
      setImmediate(async () => {
        await createAuditEntry({
          userId,
          eventType: 'USER_ACTION',
          status: 'FAILED',
          source: 'API_ENDPOINT',
          action: 'Transaction Receipt Not Found',
          description: `Transaction receipt request failed - transaction not found: ${transactionId}`,
          errorDetails: {
            message: 'Transaction not found',
            code: 'TRANSACTION_NOT_FOUND'
          },
          systemContext,
          tags: ['receipt', 'transaction', 'not-found']
        });
      });

      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    // Simple audit for receipt access
    setImmediate(async () => {
      await createAuditEntry({
        userId,
        transactionId: transaction._id,
        eventType: 'USER_ACTION',
        status: 'SUCCESS',
        source: 'API_ENDPOINT',
        action: 'Access Transaction Receipt',
        description: `Retrieved transaction receipt for ${transactionId}`,
        systemContext,
        tags: ['receipt', 'transaction', 'access']
      });
    });

    return res.json({
      success: true,
      data: transaction.getReceiptData(),
      raw: {
        // Include raw transaction data that your frontend might need for fallback
        _id: transaction._id,
        transactionId: transaction.obiexTransactionId,
        reference: transaction.reference,
        status: transaction.status,
        amount: transaction.amount,
        currency: transaction.currency,
        ngnzWithdrawal: transaction.ngnzWithdrawal,
        metadata: transaction.metadata,
        createdAt: transaction.createdAt,
        completedAt: transaction.completedAt
      }
    });

  } catch (err) {
    logger.error('Transaction receipt endpoint error', {
      error: err.stack,
      userId: req.user?.id,
      transactionId: req.params?.transactionId
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// GET WITHDRAWAL FEES ENDPOINT
router.get('/fees', (req, res) => {
  const systemContext = getSystemContext(req);
  
  try {
    // Simple audit for fee inquiry
    setImmediate(async () => {
      await createAuditEntry({
        userId: req.user?.id,
        eventType: 'USER_ACTION',
        status: 'SUCCESS',
        source: 'API_ENDPOINT',
        action: 'Check Withdrawal Fees',
        description: 'Retrieved NGNZ withdrawal fee information',
        systemContext,
        tags: ['withdrawal', 'ngnz', 'fees', 'inquiry']
      });
    });

    return res.json({
      success: true,
      message: 'NGNZ withdrawal fee information',
      data: {
        withdrawalFee: {
          amount: NGNZ_WITHDRAWAL_FEE_RECORDED, // Show recorded fee to users
          currency: 'NGN',
          description: 'Fee charged for processing NGNZ bank withdrawals',
          appliesTo: 'All NGNZ withdrawals to bank accounts'
        },
        minimumWithdrawal: NGNZ_WITHDRAWAL_FEE_OPERATIONAL + 1, // Use operational fee for minimum
        maximumWithdrawal: 1000000,
        feeStructure: {
          type: 'fixed',
          calculation: 'Flat fee deducted from withdrawal amount before bank transfer'
        }
      }
    });

  } catch (err) {
    logger.error('Withdrawal fees endpoint error', {
      error: err.stack,
      userId: req.user?.id
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Clean up user cache periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of userCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL) {
      userCache.delete(key);
    }
  }
}, 60000); // Clean every minute

module.exports = router;