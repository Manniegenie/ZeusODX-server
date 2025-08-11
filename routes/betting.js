const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { vtuAuth } = require('../auth/billauth');
const { validateUserBalance } = require('../services/balance');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { validateTransactionLimit } = require('../services/kyccheckservice');
const logger = require('../utils/logger');

const router = express.Router();

// Valid betting service providers
const BETTING_SERVICES = [
  '1xBet', 'BangBet', 'Bet9ja', 'BetKing', 'BetLand', 'BetLion',
  'BetWay', 'CloudBet', 'LiveScoreBet', 'MerryBet', 'NaijaBet',
  'NairaBet', 'SupaBet'
];

// Supported tokens - aligned with user schema (DOGE REMOVED, NGNB changed to NGNZ)
const SUPPORTED_TOKENS = {
  BTC: { name: 'Bitcoin' },
  ETH: { name: 'Ethereum' }, 
  SOL: { name: 'Solana' },
  USDT: { name: 'Tether' },
  USDC: { name: 'USD Coin' },
  BNB: { name: 'Binance Coin' },
  MATIC: { name: 'Polygon' },
  AVAX: { name: 'Avalanche' },
  NGNZ: { name: 'NGNZ Token' }
};

// Token field mapping for balance operations (NGNB changed to NGNZ)
const TOKEN_FIELD_MAPPING = {
  BTC: 'btc',
  ETH: 'eth', 
  SOL: 'sol',
  USDT: 'usdt',
  USDC: 'usdc',
  BNB: 'bnb',
  MATIC: 'matic',
  AVAX: 'avax',
  NGNZ: 'ngnz'
};

/**
 * INTERNAL: Reserve user balance for pending transactions
 * @param {String} userId - User ID
 * @param {String} currency - Currency code  
 * @param {Number} amount - Amount to reserve
 * @returns {Promise<Object>} Updated user
 */
async function reserveUserBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number' || amount <= 0) {
    throw new Error('Invalid parameters for balance reservation');
  }
  
  try {
    const currencyUpper = currency.toUpperCase();
    
    // Validate currency is supported
    if (!SUPPORTED_TOKENS[currencyUpper]) {
      throw new Error(`Unsupported currency: ${currencyUpper}`);
    }
    
    // Map currency to correct pending balance field
    const currencyLower = TOKEN_FIELD_MAPPING[currencyUpper];
    const pendingBalanceKey = `${currencyLower}PendingBalance`;
    
    const update = { 
      $inc: { [pendingBalanceKey]: amount },
      $set: { lastBalanceUpdate: new Date() }
    };
    
    const user = await User.findByIdAndUpdate(
      userId, 
      update, 
      { new: true, runValidators: true }
    );
    
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    
    logger.info(`Reserved ${amount} ${currencyUpper} for user ${userId}`);
    return user;
  } catch (error) {
    logger.error(`Failed to reserve balance for user ${userId}`, { 
      currency, 
      amount, 
      error: error.message 
    });
    throw error;
  }
}

/**
 * INTERNAL: Release reserved user balance
 * @param {String} userId - User ID
 * @param {String} currency - Currency code
 * @param {Number} amount - Amount to release
 * @returns {Promise<Object>} Updated user
 */
async function releaseReservedBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number' || amount <= 0) {
    throw new Error('Invalid parameters for balance release');
  }
  
  try {
    const currencyUpper = currency.toUpperCase();
    
    // Validate currency is supported
    if (!SUPPORTED_TOKENS[currencyUpper]) {
      throw new Error(`Unsupported currency: ${currencyUpper}`);
    }
    
    // Map currency to correct pending balance field
    const currencyLower = TOKEN_FIELD_MAPPING[currencyUpper];
    const pendingBalanceKey = `${currencyLower}PendingBalance`;
    
    const update = { 
      $inc: { [pendingBalanceKey]: -amount },
      $set: { lastBalanceUpdate: new Date() }
    };
    
    const user = await User.findByIdAndUpdate(
      userId, 
      update, 
      { new: true, runValidators: true }
    );
    
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    
    logger.info(`Released ${amount} ${currencyUpper} for user ${userId}`);
    return user;
  } catch (error) {
    logger.error(`Failed to release reserved balance for user ${userId}`, { 
      currency, 
      amount, 
      error: error.message 
    });
    throw error;
  }
}

/**
 * INTERNAL: Update user balance directly (for completed transactions)
 * @param {String} userId - User ID
 * @param {String} currency - Currency code
 * @param {Number} amount - Amount to add/subtract (negative for deductions)
 * @returns {Promise<Object>} Updated user
 */
async function updateUserBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number') {
    throw new Error('Invalid parameters for balance update');
  }
  
  try {
    const currencyUpper = currency.toUpperCase();
    
    // Validate currency is supported
    if (!SUPPORTED_TOKENS[currencyUpper]) {
      throw new Error(`Unsupported currency: ${currencyUpper}`);
    }
    
    // Map currency to correct balance field
    const currencyLower = TOKEN_FIELD_MAPPING[currencyUpper];
    const balanceField = `${currencyLower}Balance`;
    
    // Build update object - only update token balance
    const updateFields = {
      $inc: {
        [balanceField]: amount
      },
      $set: {
        lastBalanceUpdate: new Date()
      }
    };
    
    const user = await User.findByIdAndUpdate(
      userId, 
      updateFields, 
      { new: true, runValidators: true }
    );
    
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    
    logger.info(`Updated balance for user ${userId}: ${amount > 0 ? '+' : ''}${amount} ${currencyUpper}`);
    
    return user;
  } catch (error) {
    logger.error(`Failed to update balance for user ${userId}`, { 
      currency, 
      amount, 
      error: error.message 
    });
    throw error;
  }
}

/**
 * INTERNAL: Simple portfolio balance update (just sets portfolioLastUpdated)
 * @param {String} userId - User ID
 * @returns {Promise<Object>} Updated user
 */
async function updateUserPortfolioBalance(userId) {
  if (!userId) {
    throw new Error('User ID is required');
  }
  
  try {
    const user = await User.findByIdAndUpdate(
      userId,
      { 
        $set: { 
          portfolioLastUpdated: new Date()
        }
      },
      { new: true, runValidators: true }
    );
    
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    
    logger.info(`Updated portfolio timestamp for user ${userId}`);
    return user;
  } catch (error) {
    logger.error(`Failed to update portfolio for user ${userId}`, { 
      error: error.message 
    });
    throw error;
  }
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
 * Sanitize and validate betting request body
 */
function validateBettingRequest(body) {
  const errors = [];
  const sanitized = {};
  
  // Customer ID validation
  if (!body.customer_id) {
    errors.push('Customer ID (betting account ID) is required');
  } else {
    sanitized.customer_id = String(body.customer_id).trim();
    if (sanitized.customer_id.length === 0) {
      errors.push('Customer ID must be a non-empty string');
    }
  }
  
  // Service ID validation
  if (!body.service_id) {
    errors.push('Service ID is required');
  } else {
    sanitized.service_id = String(body.service_id).trim();
    if (!BETTING_SERVICES.includes(sanitized.service_id)) {
      errors.push(`Invalid service ID. Must be one of: ${BETTING_SERVICES.join(', ')}`);
    }
  }
  
  // Amount validation - UPDATED: References NGNZ
  if (body.amount === undefined || body.amount === null || body.amount === '') {
    errors.push('Amount is required');
  } else {
    const rawAmount = Number(body.amount);
    if (!Number.isFinite(rawAmount)) {
      errors.push('Amount must be a valid number');
    } else {
      sanitized.amount = Math.abs(Math.round(rawAmount * 100) / 100);
      if (rawAmount < 0) errors.push('Amount cannot be negative');
      if (sanitized.amount <= 0) errors.push('Amount must be greater than zero');
      
      const minAmount = 1000; // Minimum for betting
      const maxAmount = 100000; // Maximum for betting
      if (sanitized.amount < minAmount) {
        errors.push(`Amount below minimum. Minimum betting funding is ${minAmount} NGNZ`);
      }
      if (sanitized.amount > maxAmount) {
        errors.push(`Amount above maximum. Maximum betting funding is ${maxAmount} NGNZ`);
      }
    }
  }
  
  // 2FA validation
  if (!body.twoFactorCode?.trim()) {
    errors.push('Two-factor authentication code is required');
  } else {
    sanitized.twoFactorCode = String(body.twoFactorCode).trim();
  }
  
  // Password PIN validation
  if (!body.passwordpin?.trim()) {
    errors.push('Password PIN is required');
  } else {
    sanitized.passwordpin = String(body.passwordpin).trim();
    if (!/^\d{6}$/.test(sanitized.passwordpin)) {
      errors.push('Password PIN must be exactly 6 numbers');
    }
  }
  
  sanitized.payment_currency = 'NGNZ';
  
  return {
    isValid: errors.length === 0,
    errors,
    sanitized
  };
}

/**
 * Call eBills API for betting funding
 */
async function callEBillsAPI({ customer_id, service_id, amount, request_id, userId }) {
  try {
    const payload = {
      request_id: request_id,
      customer_id: customer_id.trim(),
      service_id,
      amount: parseInt(amount)
    };

    logger.info('Making eBills betting funding request:', {
      customer_id, service_id, amount, request_id, endpoint: '/api/v2/betting'
    });

    const response = await vtuAuth.makeRequest('POST', '/api/v2/betting', payload, {
      timeout: 45000
    });

    logger.info(`eBills API response for ${request_id}:`, {
      code: response.code,
      message: response.message,
      status: response.data?.status,
      order_id: response.data?.order_id
    });

    if (response.code !== 'success') {
      throw new Error(`eBills API error: ${response.message || 'Unknown error'}`);
    }

    return response;

  } catch (error) {
    logger.error('❌ eBills betting funding failed:', {
      request_id, userId, error: error.message,
      status: error.response?.status,
      ebillsError: error.response?.data
    });

    if (error.message.includes('IP Address')) {
      throw new Error('IP address not whitelisted with eBills. Please contact support.');
    }
    if (error.message.includes('insufficient')) {
      throw new Error('Insufficient balance with eBills provider. Please contact support.');
    }
    if (error.response?.status === 422) {
      const validationErrors = error.response.data?.errors || {};
      const errorMessages = Object.values(validationErrors).flat();
      throw new Error(`Validation error: ${errorMessages.join(', ')}`);
    }

    throw new Error(`eBills API error: ${error.message}`);
  }
}

/**
 * Main betting funding endpoint - UPDATED WITH INTERNAL BALANCE MANAGEMENT AND NGNZ
 */
router.post('/fund', async (req, res) => {
  const startTime = Date.now();
  let balanceActionTaken = false;
  let balanceActionType = null; // 'reserved' or 'updated'
  let transactionCreated = false;
  let pendingTransaction = null;
  let ebillsResponse = null;

  try {
    const requestBody = req.body;
    const userId = req.user.id;
    
    logger.info(`🎰 Betting funding request from user ${userId}:`, {
      ...requestBody,
      passwordpin: '[REDACTED]'
    });
    
    // Step 1: Validate request
    const validation = validateBettingRequest(requestBody);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors
      });
    }
    
    const { customer_id, service_id, amount, twoFactorCode, passwordpin } = validation.sanitized;
    const currency = 'NGNZ';
    
    // Step 2: Validate user and 2FA
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!user.twoFASecret || !user.is2FAEnabled) {
      return res.status(400).json({
        success: false,
        message: 'Two-factor authentication is not set up or not enabled. Please enable 2FA first.'
      });
    }

    if (!validateTwoFactorAuth(user, twoFactorCode)) {
      logger.warn('🚫 2FA validation failed for betting funding', { 
        userId, errorType: 'INVALID_2FA'
      });
      return res.status(401).json({
        success: false,
        error: 'INVALID_2FA_CODE',
        message: 'Invalid two-factor authentication code'
      });
    }

    logger.info('✅ 2FA validation successful for betting funding', { userId });

    // Step 3: Validate password pin
    if (!user.passwordpin) {
      return res.status(400).json({
        success: false,
        message: 'Password PIN is not set up for your account. Please set up your password PIN first.'
      });
    }

    const isPasswordPinValid = await comparePasswordPin(passwordpin, user.passwordpin);
    if (!isPasswordPinValid) {
      logger.warn('🚫 Password PIN validation failed for betting funding', { 
        userId, errorType: 'INVALID_PASSWORDPIN'
      });
      return res.status(401).json({
        success: false,
        error: 'INVALID_PASSWORDPIN',
        message: 'Invalid password PIN'
      });
    }

    logger.info('✅ Password PIN validation successful for betting funding', { userId });

    // Step 4: KYC validation - Pass 'BETTING' as transaction type
    const kycValidation = await validateTransactionLimit(userId, amount, 'NGNZ', 'BETTING');
    if (!kycValidation.allowed) {
      return res.status(403).json({
        success: false,
        error: 'KYC_LIMIT_EXCEEDED',
        message: kycValidation.message,
        kycDetails: {
          kycLevel: kycValidation.data?.kycLevel,
          limitType: kycValidation.data?.limitType,
          requestedAmount: kycValidation.data?.requestedAmount,
          availableAmount: kycValidation.data?.availableAmount
        }
      });
    }

    // Step 5: Check for existing pending transactions
    const existingPending = await BillTransaction.getUserPendingTransactions(userId, 'betting', 5);
    if (existingPending.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'PENDING_TRANSACTION_EXISTS',
        message: 'You already have a pending betting funding. Please wait for it to complete.'
      });
    }
    
    // Step 6: Generate unique IDs
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const finalRequestId = `${userId}_${timestamp}_${randomSuffix}`;
    const uniqueOrderId = `pending_${userId}_${timestamp}`;
    
    // Step 7: Validate balance
    const balanceValidation = await validateUserBalance(userId, currency, amount, {
      includeBalanceDetails: true,
      logValidation: true
    });
    
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

    // Step 8: Create transaction record - UPDATED: NGNZ references
    const initialTransactionData = {
      orderId: uniqueOrderId,
      status: 'initiated-api',
      productName: 'Betting',
      billType: 'betting',
      quantity: 1,
      amount: amount,
      amountNaira: amount,
      paymentCurrency: currency,
      requestId: finalRequestId,
      metaData: {
        customer_id,
        service_id,
        betting_provider: service_id,
        user_id: userId,
        payment_currency: currency,
        ngnz_amount: amount,
        exchange_rate: 1,
        twofa_validated: true,
        passwordpin_validated: true,
        kyc_validated: true,
        is_ngnz_transaction: true
      },
      network: service_id,
      customerPhone: customer_id,
      customerInfo: {
        customer_id,
        betting_provider: service_id
      },
      userId: userId,
      timestamp: new Date(),
      balanceReserved: false,
      twoFactorValidated: true,
      passwordPinValidated: true,
      kycValidated: true
    };
    
    pendingTransaction = await BillTransaction.create(initialTransactionData);
    transactionCreated = true;
    
    logger.info(`📋 Bill transaction ${uniqueOrderId}: initiated-api | betting | ${amount} NGNZ | ✅ 2FA | ✅ PIN | ✅ KYC | ⚠️ Balance Pending`);
    
    // Step 9: Call eBills API
    try {
      ebillsResponse = await callEBillsAPI({
        customer_id, service_id, amount,
        request_id: finalRequestId,
        userId
      });
    } catch (apiError) {
      await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { 
        status: 'failed',
        processingErrors: [{
          error: apiError.message,
          timestamp: new Date(),
          phase: 'api_call'
        }]
      });
      
      return res.status(500).json({
        success: false,
        error: 'EBILLS_API_ERROR',
        message: apiError.message
      });
    }
    
    // =====================================
    // STEP 10: HANDLE BALANCE BASED ON STATUS - USING INTERNAL FUNCTIONS
    // =====================================
    const ebillsStatus = ebillsResponse.data.status;
    
    if (ebillsStatus === 'completed-api') {
      // Transaction completed immediately - UPDATE BALANCE DIRECTLY
      logger.info(`✅ Transaction completed immediately, updating balance directly for ${finalRequestId}`);
      
      try {
        // Deduct balance directly (negative amount) - USING INTERNAL FUNCTION
        await updateUserBalance(userId, currency, -amount);
        
        // Update user's portfolio timestamp - USING INTERNAL FUNCTION
        await updateUserPortfolioBalance(userId);
        
        balanceActionTaken = true;
        balanceActionType = 'updated';
        
        logger.info(`✅ Balance updated directly: -${amount} ${currency} for user ${userId}`);
        
      } catch (balanceError) {
        logger.error('CRITICAL: Balance update failed for completed transaction:', {
          request_id: finalRequestId,
          userId,
          currency,
          amount,
          error: balanceError.message,
          ebills_order_id: ebillsResponse.data?.order_id
        });
        
        await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { 
          status: 'failed',
          processingErrors: [{
            error: `Balance update failed for completed transaction: ${balanceError.message}`,
            timestamp: new Date(),
            phase: 'balance_update',
            ebills_order_id: ebillsResponse.data?.order_id
          }]
        });
        
        return res.status(500).json({
          success: false,
          error: 'BALANCE_UPDATE_FAILED',
          message: 'eBills transaction succeeded but balance update failed. Please contact support immediately.',
          details: {
            ebills_order_id: ebillsResponse.data?.order_id,
            ebills_status: ebillsResponse.data?.status,
            amount: amount,
            customer_id: customer_id
          }
        });
      }
      
    } else if (['initiated-api', 'processing-api'].includes(ebillsStatus)) {
      // Transaction pending - RESERVE BALANCE - USING INTERNAL FUNCTION
      logger.info(`⏳ Transaction pending (${ebillsStatus}), reserving balance for ${finalRequestId}`);
      
      try {
        await reserveUserBalance(userId, currency, amount);
        await pendingTransaction.markBalanceReserved();
        
        balanceActionTaken = true;
        balanceActionType = 'reserved';
        
        logger.info(`✅ Balance reserved: ${amount} ${currency} for user ${userId}`);
        
      } catch (balanceError) {
        logger.error('CRITICAL: Balance reservation failed after successful eBills API call:', {
          request_id: finalRequestId,
          userId,
          currency,
          amount,
          error: balanceError.message,
          ebills_order_id: ebillsResponse.data?.order_id
        });
        
        await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { 
          status: 'failed',
          processingErrors: [{
            error: `Balance reservation failed after eBills success: ${balanceError.message}`,
            timestamp: new Date(),
            phase: 'balance_reservation',
            ebills_order_id: ebillsResponse.data?.order_id
          }]
        });
        
        return res.status(500).json({
          success: false,
          error: 'BALANCE_RESERVATION_FAILED',
          message: 'eBills transaction succeeded but balance reservation failed. Please contact support immediately.',
          details: {
            ebills_order_id: ebillsResponse.data?.order_id,
            ebills_status: ebillsResponse.data?.status,
            amount: amount,
            customer_id: customer_id
          }
        });
      }
      
    } else {
      // Handle other statuses (refunded, failed, etc.)
      logger.warn(`Unexpected eBills status: ${ebillsStatus} for ${finalRequestId}`);
    }
    
    // Step 11: Update transaction with eBills response
    const updateData = {
      orderId: ebillsResponse.data.order_id.toString(),
      status: ebillsResponse.data.status,
      productName: ebillsResponse.data.product_name,
      metaData: {
        ...initialTransactionData.metaData,
        service_name: ebillsResponse.data.service_name,
        customer_name: ebillsResponse.data.customer_name,
        customer_username: ebillsResponse.data.customer_username,
        customer_email_address: ebillsResponse.data.customer_email_address,
        customer_phone_number: ebillsResponse.data.customer_phone_number,
        discount: ebillsResponse.data.discount,
        amount_charged: ebillsResponse.data.amount_charged,
        balance_action_taken: balanceActionTaken,
        balance_action_type: balanceActionType,
        balance_action_at: new Date(),
        ebills_initial_balance: ebillsResponse.data.initial_balance,
        ebills_final_balance: ebillsResponse.data.final_balance
      }
    };
    
    // Set balance status based on action taken
    if (balanceActionType === 'reserved') {
      updateData.balanceReserved = true;
    } else if (balanceActionType === 'updated') {
      updateData.balanceReserved = false;
      updateData.balanceCompleted = true;
    }
    
    const finalTransaction = await BillTransaction.findByIdAndUpdate(
      pendingTransaction._id,
      updateData,
      { new: true }
    );
    
    logger.info(`📋 Transaction updated: ${ebillsResponse.data.order_id} | ${ebillsResponse.data.status} | Balance: ${balanceActionType || 'none'}`);
    
    // Step 12: Return response based on status - UPDATED: NGNZ references
    if (ebillsResponse.data.status === 'completed-api') {
      return res.status(200).json({
        success: true,
        message: 'Betting account funding completed successfully',
        data: {
          order_id: ebillsResponse.data.order_id,
          status: ebillsResponse.data.status,
          service_name: ebillsResponse.data.service_name,
          customer_id: ebillsResponse.data.customer_id,
          customer_name: ebillsResponse.data.customer_name,
          amount: ebillsResponse.data.amount,
          amount_charged: ebillsResponse.data.amount_charged,
          request_id: finalRequestId,
          balance_action: 'updated_directly',
          payment_details: {
            currency: currency,
            ngnz_amount: amount,
            amount_usd: (amount * (1 / 1554.42)).toFixed(2)
          }
        }
      });
    } else if (['initiated-api', 'processing-api'].includes(ebillsResponse.data.status)) {
      return res.status(202).json({
        success: true,
        message: 'Betting account funding is being processed',
        data: {
          order_id: ebillsResponse.data.order_id,
          status: ebillsResponse.data.status,
          service_name: ebillsResponse.data.service_name,
          customer_id: ebillsResponse.data.customer_id,
          customer_name: ebillsResponse.data.customer_name,
          amount: ebillsResponse.data.amount,
          amount_charged: ebillsResponse.data.amount_charged,
          request_id: finalRequestId,
          balance_action: 'reserved',
          payment_details: {
            currency: currency,
            ngnz_amount: amount,
            amount_usd: (amount * (1 / 1554.42)).toFixed(2)
          }
        },
        note: 'You will receive a notification when the betting account is funded'
      });
    } else {
      return res.status(200).json({
        success: true,
        message: `Betting funding status: ${ebillsResponse.data.status}`,
        data: {
          ...ebillsResponse.data,
          request_id: finalRequestId,
          balance_action: balanceActionType || 'none',
          payment_details: {
            currency: currency,
            ngnz_amount: amount,
            amount_usd: (amount * (1 / 1554.42)).toFixed(2)
          }
        }
      });
    }
    
  } catch (error) {
    logger.error('Betting funding unexpected error:', {
      userId: req.user?.id,
      error: error.message,
      processingTime: Date.now() - startTime
    });

    // Cleanup based on what action was taken - USING INTERNAL FUNCTIONS
    if (balanceActionTaken && balanceActionType === 'reserved') {
      try {
        await releaseReservedBalance(req.user.id, 'NGNZ', validation?.sanitized?.amount || 0);
        logger.info('🔄 Released reserved NGNZ balance due to error');
      } catch (releaseError) {
        logger.error('❌ Failed to release reserved NGNZ balance after error:', releaseError.message);
      }
    } else if (balanceActionTaken && balanceActionType === 'updated') {
      // For direct balance updates, we'd need to reverse the transaction
      // This is more complex and should be handled manually
      logger.error('❌ CRITICAL: Direct balance update completed but transaction failed. Manual intervention required.');
    }

    if (transactionCreated && pendingTransaction) {
      try {
        await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { 
          status: 'failed',
          processingErrors: [{
            error: error.message,
            timestamp: new Date(),
            phase: 'unexpected_error'
          }]
        });
      } catch (updateError) {
        logger.error('Failed to update transaction status:', updateError);
      }
    }
    
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred while processing your betting account funding'
    });
  }
});

module.exports = router;