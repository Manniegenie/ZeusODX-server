const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();

const User = require('../models/user');
const Transaction = require('../models/transaction');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { validateTransactionLimit, invalidateSpending } = require('../services/kyccheckservice');
const { sendTransferNotification } = require('../services/notificationService');
const { sendDepositEmail } = require('../services/EmailService');
const logger = require('../utils/logger');

// Supported tokens configuration
const SUPPORTED_TOKENS = {
  'BTC': { name: 'Bitcoin', symbol: 'BTC', decimals: 8 },
  'ETH': { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
  'SOL': { name: 'Solana', symbol: 'SOL', decimals: 9 },
  'USDT': { name: 'Tether USD', symbol: 'USDT', decimals: 6 },
  'USDC': { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
  'BNB': { name: 'BNB', symbol: 'BNB', decimals: 18 },
  'DOGE': { name: 'Dogecoin', symbol: 'DOGE', decimals: 8 },
  'MATIC': { name: 'Polygon', symbol: 'MATIC', decimals: 18 },
  'AVAX': { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
  'NGNZ': { name: 'Nigerian Naira Bridge', symbol: 'NGNZ', decimals: 2 }
};

// Internal transfer configuration constants
const INTERNAL_TRANSFER_CONFIG = {
  MAX_PENDING_TRANSFERS: 10,
  DUPLICATE_CHECK_WINDOW: 5 * 60 * 1000, // 5 minutes
  MIN_TRANSFER_AMOUNT: {
    BTC: 0.00001,
    ETH: 0.001,
    SOL: 0.01,
    USDT: 1,
    USDC: 1,
    BNB: 0.001,
    NGNZ: 100,
  },
};

/**
 * Compare password pin with user's hashed password pin
 */
async function comparePasswordPin(candidatePasswordPin, hashedPasswordPin) {
  if (!candidatePasswordPin || !hashedPasswordPin) {
    return false;
  }
  try {
    return await bcrypt.compare(candidatePasswordPin, hashedPasswordPin);
  } catch (error) {
    logger.error('Password pin comparison failed:', error);
    return false;
  }
}

/**
 * Get balance field name for currency
 */
function getBalanceFieldName(currency) {
  const fieldMap = {
    'BTC': 'btcBalance',
    'ETH': 'ethBalance',
    'SOL': 'solBalance',
    'USDT': 'usdtBalance',
    'USDC': 'usdcBalance',
    'BNB': 'bnbBalance',
    'DOGE': 'dogeBalance',
    'MATIC': 'maticBalance',
    'AVAX': 'avaxBalance',
    'NGNZ': 'ngnzBalance'
  };
  return fieldMap[currency.toUpperCase()];
}

/**
 * Validate user balance directly from User model
 */
async function validateUserBalanceInternal(userId, currency, amount) {
  try {
    const balanceField = getBalanceFieldName(currency);
    if (!balanceField) {
      return {
        success: false,
        message: `Unsupported currency: ${currency}`,
        availableBalance: 0
      };
    }

    const user = await User.findById(userId).select(balanceField);
    if (!user) {
      return {
        success: false,
        message: 'User not found',
        availableBalance: 0
      };
    }

    const availableBalance = user[balanceField] || 0;
    
    if (availableBalance < amount) {
      return {
        success: false,
        message: `Insufficient ${currency} balance. Available: ${availableBalance}, Required: ${amount}`,
        availableBalance
      };
    }

    return {
      success: true,
      message: 'Sufficient balance available',
      availableBalance
    };
  } catch (error) {
    logger.error('Error validating user balance', { userId, currency, amount, error: error.message });
    return {
      success: false,
      message: 'Failed to validate balance',
      availableBalance: 0
    };
  }
}

/**
 * Validates internal transfer request parameters including Password PIN
 */
function validateInternalTransferRequest(body) {
  const { recipientUsername, amount, currency, twoFactorCode, passwordpin, memo } = body;
  const errors = [];

  // Required fields validation
  if (!recipientUsername?.trim()) {
    errors.push('Recipient username is required');
  }
  if (!amount) {
    errors.push('Transfer amount is required');
  }
  if (!currency?.trim()) {
    errors.push('Currency is required');
  }
  if (!twoFactorCode?.trim()) {
    errors.push('Two-factor authentication code is required');
  }
  
  // Password PIN validation
  if (!passwordpin?.trim()) {
    errors.push('Password PIN is required');
  } else {
    const pinStr = String(passwordpin).trim();
    if (!/^\d{6}$/.test(pinStr)) {
      errors.push('Password PIN must be exactly 6 numbers');
    }
  }

  // Amount validation
  const numericAmount = Number(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) {
    errors.push('Invalid transfer amount. Amount must be a positive number.');
  }

  // Currency support validation
  const upperCurrency = currency?.toUpperCase();
  if (upperCurrency && !SUPPORTED_TOKENS[upperCurrency]) {
    errors.push(`Currency ${upperCurrency} is not supported. Supported currencies: ${Object.keys(SUPPORTED_TOKENS).join(', ')}`);
  }

  // Username format validation
  if (recipientUsername && recipientUsername.trim().length < 3) {
    errors.push('Invalid username format. Username must be at least 3 characters.');
  }

  // Check minimum transfer amount
  if (upperCurrency && numericAmount < (INTERNAL_TRANSFER_CONFIG.MIN_TRANSFER_AMOUNT[upperCurrency] || 0)) {
    errors.push(`Minimum transfer amount for ${upperCurrency} is ${INTERNAL_TRANSFER_CONFIG.MIN_TRANSFER_AMOUNT[upperCurrency]}`);
  }

  // Memo validation
  if (memo && memo.length > 200) {
    errors.push('Memo cannot exceed 200 characters');
  }

  if (errors.length > 0) {
    return {
      success: false,
      errors,
      message: errors.join('; ')
    };
  }

  return {
    success: true,
    validatedData: {
      recipientUsername: recipientUsername.trim().toLowerCase(),
      amount: numericAmount,
      currency: upperCurrency,
      twoFactorCode: twoFactorCode.trim(),
      passwordpin: String(passwordpin).trim(),
      memo: memo?.trim() || null
    }
  };
}

/**
 * Finds and validates recipient user
 */
async function findRecipientUser(username, senderUserId) {
  try {
    const recipient = await User.findOne({ 
      username: { $regex: new RegExp(`^${username}$`, 'i') },
      _id: { $ne: senderUserId }
    }).select('_id username email firstname lastname isActive');

    if (!recipient) {
      return {
        success: false,
        message: 'Recipient user not found or you cannot send to yourself'
      };
    }

    if (recipient.isActive === false) {
      return {
        success: false,
        message: 'Recipient account is inactive and cannot receive transfers'
      };
    }

    return {
      success: true,
      recipient: {
        id: recipient._id,
        username: recipient.username,
        email: recipient.email,
        fullName: `${recipient.firstname} ${recipient.lastname}`
      }
    };
  } catch (error) {
    logger.error('Error finding recipient user', { username, error: error.message });
    throw new Error('Failed to validate recipient');
  }
}

/**
 * Checks for duplicate pending internal transfers
 */
async function checkDuplicateInternalTransfer(senderUserId, recipientUserId, currency, amount) {
  try {
    const checkTime = new Date(Date.now() - INTERNAL_TRANSFER_CONFIG.DUPLICATE_CHECK_WINDOW);
    
    // Check for exact duplicate
    const existingTransaction = await Transaction.findOne({
      userId: senderUserId,
      type: 'INTERNAL_TRANSFER_SENT',
      currency: currency.toUpperCase(),
      amount: amount,
      recipientUserId: recipientUserId,
      status: { $in: ['PENDING', 'PROCESSING'] },
      createdAt: { $gte: checkTime }
    });

    if (existingTransaction) {
      return {
        isDuplicate: true,
        message: `A similar transfer request is already pending. Transaction ID: ${existingTransaction._id}`
      };
    }

    // Check for too many pending transfers
    const pendingCount = await Transaction.countDocuments({
      userId: senderUserId,
      type: 'INTERNAL_TRANSFER_SENT',
      status: { $in: ['PENDING', 'PROCESSING'] }
    });

    if (pendingCount >= INTERNAL_TRANSFER_CONFIG.MAX_PENDING_TRANSFERS) {
      return {
        isDuplicate: true,
        message: `Too many pending transfers. Maximum allowed: ${INTERNAL_TRANSFER_CONFIG.MAX_PENDING_TRANSFERS}`
      };
    }

    return { isDuplicate: false };
  } catch (error) {
    logger.error('Error checking duplicate internal transfer', { senderUserId, error: error.message });
    throw new Error('Failed to validate transfer request');
  }
}

/**
 * Creates internal transfer transaction records with security validation tracking
 */
async function createInternalTransferTransactions(transferData) {
  const {
    senderUserId,
    recipientUserId,
    currency,
    amount,
    memo,
    recipientUsername,
    senderUsername,
    senderUser,
    recipient
  } = transferData;

  try {
    const transferReference = `INT_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Create sender transaction (debit)
    const senderTransaction = await Transaction.create({
      userId: senderUserId,
      type: 'INTERNAL_TRANSFER_SENT',
      currency: currency.toUpperCase(),
      amount: -amount, // Negative for sent transfers (debit from sender)
      recipientUserId,
      recipientUsername,
      recipientFullName: recipient.fullName,
      status: 'PENDING',
      fee: 0,
      reference: transferReference,
      memo,
      narration: `Internal transfer to @${recipientUsername}`,
      metadata: {
        initiatedAt: new Date(),
        transferType: 'internal',
        twofa_validated: true,
        passwordpin_validated: true,
        kyc_validated: true,
        kyc_level: senderUser?.kycLevel,
        security_validations: {
          twofa: true,
          passwordpin: true,
          kyc: true,
          duplicate_check: true
        },
        recipientInfo: {
          userId: recipientUserId,
          username: recipientUsername,
          fullName: recipient.fullName
        }
      }
    });

    // Create recipient transaction (credit)
    const recipientTransaction = await Transaction.create({
      userId: recipientUserId,
      type: 'INTERNAL_TRANSFER_RECEIVED',
      currency: currency.toUpperCase(),
      amount: amount, // Positive for received transfers (credit to recipient)
      senderUserId,
      senderUsername,
      senderFullName: senderUser.fullName,
      status: 'PENDING',
      fee: 0,
      reference: transferReference,
      memo,
      narration: `Internal transfer from @${senderUsername}`,
      metadata: {
        initiatedAt: new Date(),
        transferType: 'internal',
        sender_security_validated: true,
        senderInfo: {
          userId: senderUserId,
          username: senderUsername,
          fullName: senderUser.fullName
        }
      }
    });

    logger.info('Internal transfer transactions created with security validations', {
      senderTransactionId: senderTransaction._id,
      recipientTransactionId: recipientTransaction._id,
      reference: transferReference,
      security_status: '2FA + PIN + KYC validated'
    });

    return {
      success: true,
      senderTransaction,
      recipientTransaction,
      transferReference
    };
  } catch (error) {
    logger.error('Failed to create internal transfer transactions', { error: error.message });
    throw error;
  }
}

/**
 * Executes the internal transfer atomically with direct User balance updates
 */
async function executeInternalTransfer(transferData) {
  const { 
    senderUserId, 
    recipientUserId, 
    currency, 
    amount,
    senderTransaction,
    recipientTransaction 
  } = transferData;
  
  try {
    // Get the balance field name for this currency
    const balanceField = getBalanceFieldName(currency);
    if (!balanceField) {
      throw new Error(`Unsupported currency: ${currency}`);
    }

    const session = await User.startSession();
    
    try {
      await session.withTransaction(async () => {
        // Update sender's balance (debit) with balance validation
        const senderUpdateResult = await User.updateOne(
          { 
            _id: senderUserId,
            [balanceField]: { $gte: amount } // Ensure sufficient balance
          },
          { 
            $inc: { [balanceField]: -amount },
            $set: { lastBalanceUpdate: new Date() }
          },
          { session }
        );

        if (senderUpdateResult.matchedCount === 0) {
          throw new Error('Insufficient balance or sender not found');
        }

        // Update recipient's balance (credit)
        const recipientUpdateResult = await User.updateOne(
          { _id: recipientUserId },
          { 
            $inc: { [balanceField]: amount },
            $set: { lastBalanceUpdate: new Date() }
          },
          { session }
        );

        if (recipientUpdateResult.matchedCount === 0) {
          throw new Error('Recipient not found');
        }
        
        // Mark transactions as completed
        await Transaction.updateOne(
          { _id: senderTransaction._id },
          { 
            status: 'COMPLETED', 
            completedAt: new Date(),
            'metadata.balance_updated_directly': true
          },
          { session }
        );
        
        await Transaction.updateOne(
          { _id: recipientTransaction._id },
          { 
            status: 'COMPLETED', 
            completedAt: new Date(),
            'metadata.balance_updated_directly': true
          },
          { session }
        );

        logger.info('✅ Direct balance updates completed successfully', {
          senderUserId,
          recipientUserId,
          currency,
          amount,
          balanceField,
          senderDeducted: -amount,
          recipientCredited: amount
        });
      });
      
      await session.endSession();
      return { success: true };
      
    } catch (sessionError) {
      await session.abortTransaction();
      await session.endSession();
      throw sessionError;
    }
  } catch (error) {
    logger.error('❌ Internal transfer execution failed', {
      senderUserId,
      recipientUserId,
      currency,
      amount,
      error: error.message
    });
    
    return {
      success: false,
      message: 'Failed to complete internal transfer: ' + error.message
    };
  }
}

/**
 * Main internal transfer endpoint with comprehensive validation
 */
router.post('/internal', async (req, res) => {
  const startTime = Date.now();
  let transactionsCreated = false;
  let senderTransaction = null;
  let recipientTransaction = null;

  try {
    const senderUserId = req.user.id;
    
    logger.info(`Internal transfer request from user ${senderUserId}:`, {
      ...req.body,
      passwordpin: '[REDACTED]'
    });
    
    // Validate request parameters
    const validation = validateInternalTransferRequest(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: validation.message,
        errors: validation.errors
      });
    }

    const { recipientUsername, amount, currency, twoFactorCode, passwordpin, memo } = validation.validatedData;

    logger.info('Processing internal transfer request', {
      senderUserId,
      recipientUsername,
      currency,
      amount
    });

    // Get and validate sender user
    const senderUser = await User.findById(senderUserId);
    if (!senderUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Validate 2FA
    if (!senderUser.twoFASecret || !senderUser.is2FAEnabled) {
      return res.status(400).json({
        success: false,
        message: 'Two-factor authentication is not set up or not enabled. Please enable 2FA first.'
      });
    }

    if (!validateTwoFactorAuth(senderUser, twoFactorCode)) {
      logger.warn('Invalid 2FA attempt for internal transfer', { senderUserId });
      return res.status(401).json({
        success: false,
        message: 'Invalid two-factor authentication code'
      });
    }

    logger.info('2FA validation successful for internal transfer', { 
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
      senderUserId 
    });

    // Validate password pin
    if (!senderUser.passwordpin) {
      return res.status(400).json({
        success: false,
        message: 'Password PIN is not set up for your account. Please set up your password PIN first.'
      });
    }

    const isPasswordPinValid = await comparePasswordPin(passwordpin, senderUser.passwordpin);
    if (!isPasswordPinValid) {
      logger.warn('Invalid password PIN attempt for internal transfer', { 
        senderUserId,
        recipientUsername,
        timestamp: new Date().toISOString().slice(0, 19).replace('T', ' ')
      });
      return res.status(401).json({
        success: false,
        message: 'Invalid password PIN'
      });
    }

    logger.info('Password PIN validation successful for internal transfer', { 
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
      senderUserId,
      recipientUsername
    });

    // Find and validate recipient
    const recipientLookup = await findRecipientUser(recipientUsername, senderUserId);
    if (!recipientLookup.success) {
      return res.status(404).json({
        success: false,
        error: 'RECIPIENT_NOT_FOUND',
        message: recipientLookup.message
      });
    }

    const recipient = recipientLookup.recipient;

    // KYC / Transaction Limit Check
    const kycCheck = await validateTransactionLimit(senderUserId, amount, currency, 'INTERNAL_TRANSFER');
    if (!kycCheck.allowed) {
      logger.warn(`KYC Limit Block: User ${senderUserId} attempted ${amount} ${currency}. Reason: ${kycCheck.message}`);
      return res.status(403).json({ success: false, message: 'Transaction exceeds your current KYC limit.' });
    }

    // Check for duplicates
    const duplicateCheck = await checkDuplicateInternalTransfer(senderUserId, recipient.id, currency, amount);
    if (duplicateCheck.isDuplicate) {
      return res.status(400).json({
        success: false,
        error: 'DUPLICATE_TRANSFER',
        message: duplicateCheck.message
      });
    }

    // CRITICAL: Validate sender balance
    const balanceValidation = await validateUserBalanceInternal(senderUserId, currency, amount);
    if (!balanceValidation.success) {
      return res.status(400).json({
        success: false,
        error: 'INSUFFICIENT_BALANCE',
        message: balanceValidation.message,
        details: {
          availableBalance: balanceValidation.availableBalance,
          requiredAmount: amount,
          currency: currency
        }
      });
    }

    logger.info('All validations passed for internal transfer', {
      senderUserId,
      recipientUsername,
      currency,
      amount,
      availableBalance: balanceValidation.availableBalance,
      security_status: '2FA + PIN + KYC + Balance validated'
    });

    // Create transaction records
    const transactionResult = await createInternalTransferTransactions({
      senderUserId,
      recipientUserId: recipient.id,
      currency,
      amount,
      memo,
      recipientUsername: recipient.username,
      senderUsername: senderUser.username,
      senderUser,
      recipient
    });

    senderTransaction = transactionResult.senderTransaction;
    recipientTransaction = transactionResult.recipientTransaction;
    transactionsCreated = true;

    // Execute the transfer with atomic balance updates
    const transferResult = await executeInternalTransfer({
      senderUserId,
      recipientUserId: recipient.id,
      currency,
      amount,
      senderTransaction,
      recipientTransaction
    });

    if (!transferResult.success) {
      return res.status(500).json({
        success: false,
        error: 'TRANSFER_EXECUTION_FAILED',
        message: transferResult.message
      });
    }

    const processingTime = Date.now() - startTime;
    logger.info('✅ Internal transfer completed successfully', {
      senderUserId,
      recipientUserId: recipient.id,
      senderTransactionId: senderTransaction._id,
      recipientTransactionId: recipientTransaction._id,
      amount,
      currency,
      processingTime,
      security_validations: 'All passed (2FA + PIN + KYC + Balance)',
      balance_update_method: 'direct_atomic'
    });

    // Invalidate KYC spending cache so next limit check uses fresh data
    try {
      invalidateSpending(senderUserId.toString(), 'INTERNAL_TRANSFER');
    } catch (invErr) {
      logger.warn('KYC spending cache invalidation failed', { userId: senderUserId, error: invErr.message });
    }

    // Send push notification to recipient (non-blocking)
    sendTransferNotification(
      recipient.id,
      amount,
      currency,
      'received',
      `@${senderUser.username}`,
      {
        transactionId: recipientTransaction._id,
        reference: transactionResult.transferReference,
        memo: memo
      }
    ).catch(error => {
      logger.error('Failed to send recipient push notification', {
        recipientUserId: recipient.id,
        error: error.message
      });
    });

    // Send email notification to recipient (non-blocking)
    sendDepositEmail(
      recipient.email,
      recipient.fullName,
      amount,
      currency,
      transactionResult.transferReference
    ).catch(error => {
      logger.error('Failed to send recipient email notification', {
        recipientEmail: recipient.email,
        error: error.message
      });
    });

    res.status(200).json({
      success: true,
      message: 'Internal transfer completed successfully',
      data: {
        transactionId: senderTransaction._id,
        transferReference: transactionResult.transferReference,
        currency,
        amount,
        recipient: {
          username: recipient.username,
          fullName: recipient.fullName
        },
        status: 'COMPLETED',
        memo,
        completedAt: new Date().toISOString(),
        security_info: {
          twofa_validated: true,
          passwordpin_validated: true,
          kyc_validated: true,
          kyc_level: senderUser.kycLevel,
          duplicate_check_passed: true,
          balance_updated_directly: true
        }
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error('❌ Internal transfer processing failed', {
      senderUserId: req.user?.id,
      error: error.message,
      stack: error.stack,
      processingTime
    });

    if (transactionsCreated && senderTransaction && recipientTransaction) {
      try {
        await Transaction.updateMany(
          { _id: { $in: [senderTransaction._id, recipientTransaction._id] } },
          { status: 'FAILED', failedAt: new Date(), failureReason: error.message }
        );
      } catch (updateError) {
        logger.error('❌ Failed to mark transactions as failed', { error: updateError.message });
      }
    }

    res.status(500).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error during transfer processing. Please contact support if this persists.'
    });
  }
});

module.exports = router;