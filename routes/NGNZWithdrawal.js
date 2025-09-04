const express = require('express');
const mongoose = require('mongoose');
const { debitNaira } = require('../services/nairaWithdrawal');
const Transaction = require('../models/transaction');
const User = require('../models/user');
const TransactionAudit = require('../models/TransactionAudit');
const logger = require('../utils/logger');
const crypto = require('crypto');

const router = express.Router();

// Cache for user balance optimization
const userCache = new Map();
const CACHE_TTL = 30000; // 30 seconds

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
 * Validate withdrawal request data
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
  
  // Validate amount limits (adjust as needed)
  if (data.amount && data.amount < 100) {
    errors.push('Minimum withdrawal amount is ₦100');
  }
  
  if (data.amount && data.amount > 1000000) {
    errors.push('Maximum withdrawal amount is ₦1,000,000');
  }
  
  return errors;
}

/**
 * Get cached user balance
 */
async function getCachedUserBalance(userId) {
  const cacheKey = `user_balance_${userId}`;
  const cached = userCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.user;
  }
  
  const user = await User.findById(userId)
    .select('_id ngnzBalance lastBalanceUpdate')
    .lean();
  
  if (user) {
    userCache.set(cacheKey, { user, timestamp: Date.now() });
    setTimeout(() => userCache.delete(cacheKey), CACHE_TTL);
  }
  
  return user;
}

/**
 * Validate user has sufficient NGNZ balance
 */
async function validateUserBalance(userId, amount) {
  const user = await getCachedUserBalance(userId);
  if (!user) {
    return { success: false, message: 'User not found' };
  }
  
  const availableBalance = user.ngnzBalance || 0;
  if (availableBalance < amount) {
    return {
      success: false,
      message: `Insufficient NGNZ balance. Available: ₦${availableBalance.toLocaleString()}, Required: ₦${amount.toLocaleString()}`,
      availableBalance,
      requiredAmount: amount
    };
  }
  
  return { success: true, availableBalance };
}

/**
 * Execute NGNZ withdrawal with atomic balance updates and comprehensive auditing
 */
async function executeNGNZWithdrawal(userId, withdrawalData, correlationId, systemContext) {
  const session = await mongoose.startSession();
  session.startTransaction();
  const startTime = new Date();
  
  try {
    const { amount, destination, narration } = withdrawalData;
    const withdrawalReference = generateWithdrawalReference();
    
    // Get current balance for audit trail
    const userBefore = await User.findById(userId).select('ngnzBalance').lean();
    
    // 1. Deduct NGNZ balance atomically
    const updatedUser = await User.findOneAndUpdate(
      { 
        _id: userId, 
        ngnzBalance: { $gte: amount } // Ensure sufficient balance
      },
      {
        $inc: { ngnzBalance: -amount },
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
    userCache.delete(`user_balance_${userId}`);

    // 2. Create withdrawal transaction record
    const withdrawalTransaction = new Transaction({
      userId,
      type: 'WITHDRAWAL',
      currency: 'NGNZ',
      amount: -amount, // Negative for outgoing
      status: 'PENDING',
      source: 'NGNZ_WITHDRAWAL',
      reference: withdrawalReference,
      obiexTransactionId: withdrawalReference,
      narration: narration || `NGNZ withdrawal to ${destination.bankName}`,
      metadata: {
        withdrawalType: 'NGNZ_TO_BANK',
        destinationBank: destination.bankName,
        destinationAccount: maskAccountNumber(destination.accountNumber),
        destinationAccountName: destination.accountName,
        bankCode: destination.bankCode,
        correlationId,
        obiexCurrency: 'NGNX' // Note: NGNZ maps to NGNX for Obiex
      }
    });

    await withdrawalTransaction.save({ session });

    // 3. Commit balance update and transaction creation
    await session.commitTransaction();
    session.endSession();
    
    const endTime = new Date();

    logger.info('NGNZ withdrawal prepared successfully', {
      userId,
      withdrawalReference,
      correlationId,
      amount,
      destinationBank: destination.bankName,
      destinationAccount: maskAccountNumber(destination.accountNumber),
      balanceBefore: userBefore.ngnzBalance,
      balanceAfter: updatedUser.ngnzBalance,
      transactionId: withdrawalTransaction._id
    });

    // Create comprehensive audit entries
    await Promise.all([
      // Balance update audit
      createAuditEntry({
        userId,
        eventType: 'BALANCE_UPDATED',
        status: 'SUCCESS',
        source: 'NGNZ_WITHDRAWAL',
        action: 'Deduct NGNZ for Withdrawal',
        description: `Deducted ₦${amount.toLocaleString()} NGNZ for bank withdrawal`,
        beforeState: {
          ngnzBalance: userBefore.ngnzBalance
        },
        afterState: {
          ngnzBalance: updatedUser.ngnzBalance
        },
        financialImpact: {
          currency: 'NGNZ',
          amount: -amount,
          balanceBefore: userBefore.ngnzBalance,
          balanceAfter: updatedUser.ngnzBalance
        },
        swapDetails: {
          swapId: withdrawalReference,
          sourceCurrency: 'NGNZ',
          targetCurrency: 'NGN', // Bank transfer
          sourceAmount: amount,
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
        tags: ['balance-update', 'ngnz-withdrawal', 'bank-transfer']
      }),
      
      // Transaction creation audit
      createAuditEntry({
        userId,
        transactionId: withdrawalTransaction._id,
        eventType: 'TRANSACTION_CREATED',
        status: 'SUCCESS',
        source: 'NGNZ_WITHDRAWAL',
        action: 'Create NGNZ Withdrawal Transaction',
        description: `Created withdrawal transaction for ₦${amount.toLocaleString()} NGNZ`,
        financialImpact: {
          currency: 'NGNZ',
          amount: -amount,
          balanceBefore: userBefore.ngnzBalance,
          balanceAfter: updatedUser.ngnzBalance
        },
        swapDetails: {
          swapId: withdrawalReference,
          provider: 'OBIEX_WITHDRAWAL',
          swapType: 'NGNZ_TO_BANK'
        },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['transaction', 'ngnz-withdrawal', 'bank-transfer']
      })
    ]);

    return {
      user: updatedUser,
      transaction: withdrawalTransaction,
      withdrawalReference
    };

  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    
    const endTime = new Date();
    
    logger.error('NGNZ withdrawal preparation failed', {
      error: err.message,
      stack: err.stack,
      userId,
      correlationId,
      withdrawalData: {
        ...withdrawalData,
        destination: {
          ...withdrawalData.destination,
          accountNumber: maskAccountNumber(withdrawalData.destination?.accountNumber)
        }
      }
    });
    
    // Create failure audit entry
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
        stack: err.stack
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
    
    throw err;
  }
}

/**
 * Process Obiex withdrawal (NGNZ → NGNX conversion)
 */
async function processObiexWithdrawal(userId, withdrawalData, withdrawalReference, transactionId, correlationId, systemContext) {
  const startTime = new Date();
  
  try {
    const { amount, destination, narration } = withdrawalData;
    
    // Create audit for Obiex operation initiation
    await createAuditEntry({
      userId,
      eventType: 'OBIEX_SWAP_INITIATED',
      status: 'PENDING',
      source: 'OBIEX_API',
      action: 'Initiate NGNZ Bank Withdrawal',
      description: `Starting Obiex NGNX withdrawal: ₦${amount.toLocaleString()} to ${destination.bankName}`,
      swapDetails: {
        swapId: withdrawalReference,
        sourceCurrency: 'NGNZ', // User perspective
        targetCurrency: 'NGN', // Bank transfer
        sourceAmount: amount,
        provider: 'OBIEX',
        swapType: 'NGNZ_TO_BANK'
      },
      obiexDetails: {
        obiexSourceCurrency: 'NGNX', // Obiex perspective
        obiexTargetCurrency: 'NGN',
        obiexOperationType: 'FIAT_WITHDRAWAL'
      },
      relatedEntities: {
        correlationId,
        relatedTransactionIds: [transactionId]
      },
      systemContext,
      timing: {
        startTime
      },
      tags: ['obiex', 'ngnz-withdrawal', 'bank-transfer', 'initiated']
    });

    // Call Obiex service with NGNX (since NGNZ maps to NGNX for Obiex)
    const obiexPayload = {
      destination: {
        accountNumber: destination.accountNumber,
        accountName: destination.accountName,
        bankName: destination.bankName,
        bankCode: destination.bankCode,
        ...(destination.pagaBankCode && { pagaBankCode: destination.pagaBankCode }),
        ...(destination.merchantCode && { merchantCode: destination.merchantCode })
      },
      amount: amount, // Same amount, but in NGNX for Obiex
      currency: 'NGNX', // Important: Convert NGNZ to NGNX for Obiex
      narration: narration || `NGNZ withdrawal - ${withdrawalReference}`
    };

    logger.info('Initiating Obiex NGNX withdrawal', {
      withdrawalReference,
      correlationId,
      amount,
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
      // Update transaction status to SUCCESS
      await Transaction.findByIdAndUpdate(
        transactionId,
        {
          $set: {
            status: 'SUCCESSFUL',
            completedAt: new Date(),
            'metadata.obiexId': obiexResult.data?.id,
            'metadata.obiexReference': obiexResult.data?.reference,
            'metadata.obiexStatus': obiexResult.data?.status
          }
        }
      );

      logger.info('NGNZ withdrawal completed successfully via Obiex', {
        userId,
        withdrawalReference,
        correlationId,
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
        description: `Successfully completed Obiex NGNX withdrawal to ${destination.bankName}`,
        swapDetails: {
          swapId: withdrawalReference,
          sourceCurrency: 'NGNZ',
          targetCurrency: 'NGN',
          sourceAmount: amount,
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
          obiexTargetCurrency: 'NGN'
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
        tags: ['obiex', 'ngnz-withdrawal', 'bank-transfer', 'success']
      });

      return { success: true, data: obiexResult.data };

    } else {
      // Update transaction status to FAILED
      await Transaction.findByIdAndUpdate(
        transactionId,
        {
          $set: {
            status: 'FAILED',
            completedAt: new Date(),
            'metadata.obiexError': obiexResult.message,
            'metadata.obiexStatusCode': obiexResult.statusCode
          }
        }
      );

      logger.error('NGNZ withdrawal failed via Obiex', {
        userId,
        withdrawalReference,
        correlationId,
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
          sourceAmount: amount,
          provider: 'OBIEX',
          swapType: 'NGNZ_TO_BANK'
        },
        obiexDetails: {
          obiexSourceCurrency: 'NGNX',
          obiexTargetCurrency: 'NGN',
          obiexOperationType: 'FIAT_WITHDRAWAL'
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
        tags: ['obiex', 'ngnz-withdrawal', 'bank-transfer', 'failed']
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
      correlationId
    });

    // Update transaction status to FAILED
    await Transaction.findByIdAndUpdate(
      transactionId,
      {
        $set: {
          status: 'FAILED',
          completedAt: new Date(),
          'metadata.systemError': error.message
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

// NGNZ WITHDRAWAL ENDPOINT
router.post('/withdraw', async (req, res) => {
  const correlationId = generateCorrelationId();
  const systemContext = getSystemContext(req);
  const startTime = new Date();
  
  try {
    const userId = req.user.id;
    const { amount, destination, narration } = req.body;
    
    // Create audit for withdrawal request
    await createAuditEntry({
      userId,
      eventType: 'USER_ACTION',
      status: 'PENDING',
      source: 'API_ENDPOINT',
      action: 'Request NGNZ Withdrawal',
      description: `NGNZ withdrawal request: ₦${amount?.toLocaleString() || 'N/A'} to ${destination?.bankName || 'unknown bank'}`,
      requestData: {
        amount,
        destination: destination ? {
          ...destination,
          accountNumber: maskAccountNumber(destination.accountNumber)
        } : null,
        narration
      },
      relatedEntities: {
        correlationId
      },
      systemContext,
      timing: {
        startTime
      },
      tags: ['withdrawal', 'ngnz', 'request']
    });

    // Validate request data
    const validationErrors = validateWithdrawalRequest({ amount, destination });
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
        errors: validationErrors
      });
    }

    // Validate user balance
    const balanceValidation = await validateUserBalance(userId, amount);
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
          balanceBefore: balanceValidation.availableBalance
        },
        swapDetails: {
          sourceCurrency: 'NGNZ',
          targetCurrency: 'NGN',
          sourceAmount: amount,
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
        availableBalance: balanceValidation.availableBalance,
        requiredAmount: amount,
        currency: 'NGNZ'
      });
    }

    // Execute withdrawal preparation (deduct balance, create transaction)
    const withdrawalResult = await executeNGNZWithdrawal(
      userId, 
      { amount, destination, narration }, 
      correlationId, 
      systemContext
    );

    // Process Obiex withdrawal (convert NGNZ to NGNX for Obiex)
    const obiexResult = await processObiexWithdrawal(
      userId,
      { amount, destination, narration },
      withdrawalResult.withdrawalReference,
      withdrawalResult.transaction._id,
      correlationId,
      systemContext
    );

    const endTime = new Date();

    if (obiexResult.success) {
      // Create successful withdrawal audit
      await createAuditEntry({
        userId,
        transactionId: withdrawalResult.transaction._id,
        eventType: 'USER_ACTION',
        status: 'SUCCESS',
        source: 'API_ENDPOINT',
        action: 'Complete NGNZ Withdrawal',
        description: `Successfully processed NGNZ withdrawal: ₦${amount.toLocaleString()} to ${destination.bankName}`,
        swapDetails: {
          swapId: withdrawalResult.withdrawalReference,
          sourceCurrency: 'NGNZ',
          targetCurrency: 'NGN',
          sourceAmount: amount,
          provider: 'OBIEX_WITHDRAWAL',
          swapType: 'NGNZ_TO_BANK'
        },
        obiexDetails: {
          obiexTransactionId: obiexResult.data?.id,
          obiexReference: obiexResult.data?.reference,
          obiexStatus: obiexResult.data?.status
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
        tags: ['withdrawal', 'ngnz', 'success', 'completed']
      });

      return res.json({
        success: true,
        message: 'NGNZ withdrawal processed successfully',
        data: {
          withdrawalId: withdrawalResult.withdrawalReference,
          transactionId: withdrawalResult.transaction._id,
          correlationId,
          status: 'SUCCESSFUL',
          amount,
          currency: 'NGNZ',
          destination: {
            bankName: destination.bankName,
            accountName: destination.accountName,
            accountNumber: maskAccountNumber(destination.accountNumber)
          },
          obiex: {
            transactionId: obiexResult.data?.id,
            reference: obiexResult.data?.reference,
            status: obiexResult.data?.status
          },
          balanceAfter: withdrawalResult.user.ngnzBalance,
          processedAt: new Date().toISOString()
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
        tags: ['withdrawal', 'ngnz', 'failed', 'processing-error']
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
          amount,
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
      requestData: req.body,
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
        amount: Math.abs(transaction.amount), // Convert back to positive for display
        currency: transaction.currency,
        destination: {
          bankName: transaction.metadata?.destinationBank,
          accountName: transaction.metadata?.destinationAccountName,
          accountNumber: transaction.metadata?.destinationAccount // Already masked
        },
        obiex: transaction.metadata?.obiexId ? {
          transactionId: transaction.metadata.obiexId,
          reference: transaction.metadata.obiexReference,
          status: transaction.metadata.obiexStatus
        } : null,
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