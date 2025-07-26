const express = require('express');
const bcrypt = require('bcryptjs'); // ADD: bcrypt for password pin comparison
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { vtuAuth } = require('../auth/billauth');
const { validateUserBalance } = require('../services/balance');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { validateTransactionLimit } = require('../services/kyccheckservice'); // Add KYC service import
const logger = require('../utils/logger');
const crypto = require('crypto');

const router = express.Router();
const EBILLS_BASE_URL = process.env.EBILLS_BASE_URL || 'https://ebills.africa/wp-json';

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
 * ADD: Compare password pin with user's hashed password pin
 * @param {string} candidatePasswordPin - Plain text password pin to compare
 * @param {string} hashedPasswordPin - Hashed password pin from database
 * @returns {Promise<boolean>} - True if password pin matches
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
 * Generate a unique order ID for betting
 */
function generateUniqueBettingOrderId() {
  const timestamp = Date.now();
  const randomBytes = crypto.randomBytes(4).toString('hex');
  return `betting_order_${timestamp}_${randomBytes}`;
}

/**
 * Generate a unique request ID for betting based on user ID and timestamp
 */
function generateUniqueBettingRequestId(userId) {
  const timestamp = Date.now();
  const randomSuffix = crypto.randomBytes(2).toString('hex');
  return `betting_req_${userId}_${timestamp}_${randomSuffix}`;
}

/**
 * Check for existing pending betting transactions to prevent duplicates
 */
async function checkForPendingBettingTransactions(userId, customOrderId, customRequestId) {
  const pendingTransactions = await BillTransaction.find({
    $or: [
      { userId: userId, billType: 'betting', status: { $in: ['initiated-api', 'processing-api', 'pending'] } },
      { orderId: customOrderId },
      { requestId: customRequestId }
    ],
    createdAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) } // Last 5 minutes
  });
  
  return pendingTransactions.length > 0;
}

/**
 * UPDATED: Validate betting funding request - NGNZ ONLY with 2FA and Password PIN
 */
function validateBettingRequest(body) {
  const errors = [];
  const sanitized = {};
  
  if (!body.customer_id) {
    errors.push('Customer ID (betting account ID) is required');
  } else {
    sanitized.customer_id = String(body.customer_id).trim();
    if (sanitized.customer_id.length === 0) {
      errors.push('Customer ID must be a non-empty string');
    }
  }
  
  if (!body.service_id) {
    errors.push('Service ID is required');
  } else {
    sanitized.service_id = String(body.service_id).trim();
    if (!BETTING_SERVICES.includes(sanitized.service_id)) {
      errors.push(`Invalid service ID. Must be one of: ${BETTING_SERVICES.join(', ')}`);
    }
  }
  
  if (!body.amount) {
    errors.push('Amount is required');
  } else {
    const numericAmount = Number(body.amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      errors.push('Amount must be a positive number');
    } else if (numericAmount > 100000) {
      errors.push('Amount above maximum. Maximum is ₦100,000');
    } else if (numericAmount < 1000) {
      errors.push('Amount below minimum. Minimum is ₦1,000');
    } else {
      sanitized.amount = numericAmount;
    }
  }
  
  // NGNZ is now the only accepted currency (UPDATED from NGNB)
  if (!body.payment_currency) {
    errors.push('Payment currency is required and must be NGNZ');
  } else if (body.payment_currency.toUpperCase() !== 'NGNZ') {
    errors.push('Payment currency must be NGNZ only');
  } else {
    sanitized.payment_currency = 'NGNZ';
  }
  
  // Validate 2FA code
  if (!body.twoFactorCode?.trim()) {
    errors.push('Two-factor authentication code is required');
  } else {
    sanitized.twoFactorCode = String(body.twoFactorCode).trim();
  }
  
  // ADD: Validate password pin
  if (!body.passwordpin?.trim()) {
    errors.push('Password PIN is required');
  } else {
    sanitized.passwordpin = String(body.passwordpin).trim();
    
    // Password PIN must be exactly 6 numeric digits
    if (!/^\d{6}$/.test(sanitized.passwordpin)) {
      errors.push('Password PIN must be exactly 6 numbers');
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    sanitized
  };
}

/**
 * Validate NGNZ transaction limits for betting (UPDATED from NGNB)
 */
function validateNGNZLimits(amount) {
  const MIN_NGNZ = 1000; // Higher minimum for betting funding
  const MAX_NGNZ = 100000; // Higher limit for betting funding
  
  if (amount < MIN_NGNZ) {
    return {
      isValid: false,
      error: 'NGNZ_MINIMUM_NOT_MET',
      message: `Minimum NGNZ betting funding amount is ${MIN_NGNZ} NGNZ. Your amount: ${amount} NGNZ.`,
      minimumRequired: MIN_NGNZ,
      providedAmount: amount
    };
  }
  
  if (amount > MAX_NGNZ) {
    return {
      isValid: false,
      error: 'NGNZ_MAXIMUM_EXCEEDED',
      message: `Maximum NGNZ betting funding amount is ${MAX_NGNZ} NGNZ. Your amount: ${amount} NGNZ.`,
      maximumAllowed: MAX_NGNZ,
      providedAmount: amount
    };
  }
  
  return { isValid: true };
}

/**
 * Call eBills API for betting funding - FIXED to use VTUAuth properly
 * @param {Object} params - API parameters
 * @returns {Promise<Object>} eBills API response
 */
async function callEBillsBettingAPI({ customer_id, service_id, amount, request_id, userId }) {
  try {
    const payload = {
      request_id: request_id,
      customer_id: customer_id.trim(),
      service_id,
      amount: parseInt(amount) // Ensure integer as per API spec
    };

    logger.info('Making eBills betting funding request:', {
      customer_id,
      service_id,
      amount,
      request_id,
      endpoint: '/api/v2/betting'
    });

    // 🔑 KEY FIX: Use VTUAuth to make authenticated request instead of direct axios
    const response = await vtuAuth.makeRequest('POST', '/api/v2/betting', payload, {
      timeout: 45000,
      baseURL: EBILLS_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    logger.info(`eBills Betting API response for ${request_id}:`, {
      code: response.code,
      message: response.message,
      data: response.data
    });

    // Handle eBills API response structure
    if (response.code !== 'success') {
      throw new Error(`eBills Betting API error: ${response.message || 'Unknown error'}`);
    }

    return response;

  } catch (error) {
    logger.error('❌ eBills betting funding failed:', {
      request_id,
      userId,
      error: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      ebillsError: error.response?.data
    });

    // Enhanced error messages for common issues
    if (error.message.includes('IP Address')) {
      throw new Error('IP address not whitelisted with eBills. Please contact support.');
    }

    if (error.message.includes('insufficient')) {
      throw new Error('Insufficient balance with eBills provider. Please contact support.');
    }

    if (error.message.includes('invalid service_id')) {
      throw new Error('Invalid betting service provider. Please check and try again.');
    }

    if (error.response?.status === 422) {
      const validationErrors = error.response.data?.errors || {};
      const errorMessages = Object.values(validationErrors).flat();
      throw new Error(`Validation error: ${errorMessages.join(', ')}`);
    }

    throw new Error(`eBills Betting API error: ${error.message}`);
  }
}

/**
 * UPDATED: Main betting funding endpoint - NGNZ ONLY with 2FA, Password PIN, and KYC (mirroring airtime flow)
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
      passwordpin: '[REDACTED]' // Don't log the actual password pin
    });
    
    // Step 1: Validate request and use sanitized data
    const validation = validateBettingRequest(requestBody);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors
      });
    }
    
    const { customer_id, service_id, amount, payment_currency, twoFactorCode, passwordpin } = validation.sanitized;
    const currency = 'NGNZ'; // Force NGNZ as the only currency (UPDATED from NGNB)
    
    // Step 2: Generate unique IDs
    const uniqueOrderId = generateUniqueBettingOrderId();
    const uniqueRequestId = generateUniqueBettingRequestId(userId);
    
    logger.info(`Generated unique betting IDs - OrderID: ${uniqueOrderId}, RequestID: ${uniqueRequestId}`);
    
    // Step 3: Check for duplicate/pending transactions
    const hasPendingTransactions = await checkForPendingBettingTransactions(userId, uniqueOrderId, uniqueRequestId);
    if (hasPendingTransactions) {
      return res.status(409).json({
        success: false,
        error: 'DUPLICATE_OR_PENDING_TRANSACTION',
        message: 'You have a pending betting transaction or duplicate IDs detected. Please wait before making another funding request.'
      });
    }
    
    // Step 4: Validate user and 2FA
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

    // Step 5: Validate password pin
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

    // Step 6: KYC validation - UPDATED: NGNB to NGNZ
    logger.info('Validating KYC limits for betting funding', { userId, amount, currency: 'NGNZ' });
    
    try {
      const kycValidation = await validateTransactionLimit(userId, amount, 'NGNZ', 'BETTING');
      
      if (!kycValidation.allowed) {
        logger.warn('Betting funding blocked by KYC limits', {
          userId,
          amount,
          currency: 'NGNZ',
          customer_id,
          service_id,
          kycCode: kycValidation.code,
          kycMessage: kycValidation.message,
          kycData: kycValidation.data
        });

        // Return detailed KYC error response
        return res.status(403).json({
          success: false,
          error: 'KYC_LIMIT_EXCEEDED',
          message: kycValidation.message,
          code: kycValidation.code,
          kycDetails: {
            kycLevel: kycValidation.data?.kycLevel,
            limitType: kycValidation.data?.limitType,
            requestedAmount: kycValidation.data?.requestedAmount,
            currentLimit: kycValidation.data?.currentLimit,
            currentSpent: kycValidation.data?.currentSpent,
            availableAmount: kycValidation.data?.availableAmount,
            upgradeRecommendation: kycValidation.data?.upgradeRecommendation,
            amountInNaira: kycValidation.data?.amountInNaira,
            currency: kycValidation.data?.currency,
            transactionType: 'BETTING'
          }
        });
      }

      // Log successful KYC validation with details
      logger.info('✅ KYC validation passed for betting funding', {
        userId,
        amount,
        currency: 'NGNZ',
        customer_id,
        service_id,
        kycLevel: kycValidation.data?.kycLevel,
        dailyRemaining: kycValidation.data?.dailyRemaining,
        monthlyRemaining: kycValidation.data?.monthlyRemaining,
        amountInNaira: kycValidation.data?.amountInNaira
      });

    } catch (kycError) {
      logger.error('KYC validation failed with error for betting funding', {
        userId,
        amount,
        currency: 'NGNZ',
        customer_id,
        service_id,
        error: kycError.message,
        stack: kycError.stack
      });

      return res.status(500).json({
        success: false,
        error: 'KYC_VALIDATION_ERROR',
        message: 'Unable to validate transaction limits. Please try again or contact support.',
        code: 'KYC_VALIDATION_ERROR'
      });
    }
    
    // Step 7: Calculate NGNZ amount needed (1:1 with Naira) - UPDATED from NGNB
    const ngnzAmount = amount; // NGNZ is 1:1 with Naira
    const ngnzToUsdRate = 1 / 1554.42; // Approximate NGNZ to USD rate
    
    logger.info(`NGNZ calculation: ₦${amount} = ${ngnzAmount} NGNZ (1:1 rate)`);
    
    // Step 8: Validate NGNZ limits (UPDATED from NGNB)
    const ngnzLimitValidation = validateNGNZLimits(ngnzAmount);
    if (!ngnzLimitValidation.isValid) {
      return res.status(400).json({
        success: false,
        error: ngnzLimitValidation.error,
        message: ngnzLimitValidation.message,
        details: {
          currency: currency,
          providedAmount: ngnzLimitValidation.providedAmount,
          minimumRequired: ngnzLimitValidation.minimumRequired,
          maximumAllowed: ngnzLimitValidation.maximumAllowed,
          bettingAmount: amount,
          bettingProvider: service_id
        }
      });
    }
    
    // Step 9: Validate user balance
    const balanceValidation = await validateUserBalance(userId, currency, ngnzAmount, {
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
          requiredAmount: ngnzAmount,
          currency: currency,
          shortfall: balanceValidation.shortfall,
          bettingAmount: amount,
          bettingAmountUSD: (ngnzAmount * ngnzToUsdRate).toFixed(2),
          bettingProvider: service_id
        }
      });
    }

    logger.info('✅ Betting funding NGNZ balance validation successful', {
      userId,
      customer_id,
      amount,
      payment_currency: currency,
      availableBalance: balanceValidation.availableBalance,
      requiredAmount: ngnzAmount
    });

    // Step 10: Create transaction record with unique order ID - UPDATED: NGNZ references
    const initialTransactionData = {
      orderId: uniqueOrderId, // Guaranteed unique order ID
      status: 'initiated-api',
      productName: 'Betting',
      billType: 'betting',
      quantity: 1,
      amount: amount,
      amountNaira: amount,
      amountCrypto: ngnzAmount,
      paymentCurrency: currency,
      cryptoPrice: ngnzToUsdRate,
      requestId: uniqueRequestId, // Guaranteed unique request ID
      metaData: {
        customer_id,
        service_id,
        betting_provider: service_id,
        user_id: userId,
        payment_currency: currency,
        crypto_price: ngnzToUsdRate,
        balance_reserved: false,
        betting_amount_usd: (ngnzAmount * ngnzToUsdRate).toFixed(2),
        is_ngnz_transaction: true, // UPDATED from is_ngnb_transaction
        twofa_validated: true,
        passwordpin_validated: true,
        kyc_validated: true,
        unique_order_id: uniqueOrderId,
        unique_request_id: uniqueRequestId,
        order_id_type: 'system_generated_unique'
      },
      network: service_id,
      customerPhone: customer_id, // Store customer_id in customerPhone field for consistency
      customerInfo: {
        customer_id,
        betting_provider: service_id
      },
      userId: userId,
      timestamp: new Date(),
      webhookProcessedAt: null,
      balanceReserved: false,
      twoFactorValidated: true,
      passwordPinValidated: true,
      kycValidated: true
    };
    
    pendingTransaction = await BillTransaction.create(initialTransactionData);
    transactionCreated = true;
    
    logger.info(`📋 Bill transaction ${uniqueOrderId}: initiated-api | betting | ${ngnzAmount} NGNZ | ✅ 2FA | ✅ PIN | ✅ KYC | ⚠️ Balance Pending`); // UPDATED: NGNB to NGNZ
    
    // Step 11: Call eBills API
    try {
      logger.info(`Calling eBills Betting API with unique RequestID: ${uniqueRequestId}...`);
      
      ebillsResponse = await callEBillsBettingAPI({
        customer_id,
        service_id,
        amount,
        request_id: uniqueRequestId,
        userId
      });
      
    } catch (apiError) {
      logger.error('eBills Betting API call failed:', {
        error: apiError.message,
        unique_order_id: uniqueOrderId,
        unique_request_id: uniqueRequestId,
        userId: userId,
        response: apiError.response?.data,
        status: apiError.response?.status,
        timeout: apiError.code === 'ECONNABORTED' || apiError.message.includes('timeout')
      });
      
      // Update transaction status to failed
      await BillTransaction.findByIdAndUpdate(
        pendingTransaction._id,
        { 
          status: 'failed',
          processingErrors: [{
            error: apiError.message,
            timestamp: new Date(),
            phase: 'ebills_betting_api_call'
          }]
        }
      );
      
      const errorData = apiError.response?.data;
      let statusCode = apiError.response?.status || 500;
      let errorMessage = apiError.message;
      let errorCode = 'EBILLS_BETTING_API_ERROR';
      
      if (apiError.code === 'ECONNABORTED' || apiError.message.includes('timeout')) {
        statusCode = 504;
        errorMessage = 'eBills Betting API request timed out. Please try again.';
        errorCode = 'EBILLS_TIMEOUT';
      }
      
      return res.status(statusCode).json({
        success: false,
        error: errorCode,
        message: errorMessage,
        transaction: {
          orderId: uniqueOrderId,
          requestId: uniqueRequestId,
          status: 'failed'
        },
        note: 'No balance was reserved since the eBills Betting API call failed'
      });
    }
    
    // =====================================
    // STEP 12: HANDLE BALANCE BASED ON STATUS - USING INTERNAL FUNCTIONS
    // =====================================
    const ebillsStatus = ebillsResponse.data.status;
    
    if (ebillsStatus === 'completed-api') {
      // Transaction completed immediately - UPDATE BALANCE DIRECTLY
      logger.info(`✅ Transaction completed immediately, updating balance directly for ${uniqueRequestId}`);
      
      try {
        // Deduct balance directly (negative amount) - USING INTERNAL FUNCTION
        await updateUserBalance(userId, currency, -ngnzAmount);
        
        // Update user's portfolio timestamp - USING INTERNAL FUNCTION
        await updateUserPortfolioBalance(userId);
        
        balanceActionTaken = true;
        balanceActionType = 'updated';
        
        logger.info(`✅ Balance updated directly: -${ngnzAmount} ${currency} for user ${userId}`);
        
      } catch (balanceError) {
        logger.error('CRITICAL: Balance update failed for completed transaction:', {
          request_id: uniqueRequestId,
          userId,
          currency,
          ngnzAmount,
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
          message: 'eBills betting transaction succeeded but balance update failed. Please contact support immediately.',
          details: {
            orderId: uniqueOrderId,
            requestId: uniqueRequestId,
            ebills_order_id: ebillsResponse.data?.order_id,
            ebills_status: ebillsResponse.data?.status,
            service_name: ebillsResponse.data?.service_name,
            customer_name: ebillsResponse.data?.customer_name,
            amount: amount,
            amount_usd: (ngnzAmount * ngnzToUsdRate).toFixed(2),
            customer_id: customer_id
          }
        });
      }
      
    } else if (['initiated-api', 'processing-api'].includes(ebillsStatus)) {
      // Transaction pending - RESERVE BALANCE - USING INTERNAL FUNCTION
      logger.info(`⏳ Transaction pending (${ebillsStatus}), reserving balance for ${uniqueRequestId}`);
      
      try {
        await reserveUserBalance(userId, currency, ngnzAmount);
        
        await BillTransaction.findByIdAndUpdate(
          pendingTransaction._id,
          { 
            balanceReserved: true,
            'metaData.balance_reserved': true,
            'metaData.balance_reserved_at': new Date()
          }
        );
        
        balanceActionTaken = true;
        balanceActionType = 'reserved';
        
        logger.info(`✅ Balance reserved: ${ngnzAmount} ${currency} for user ${userId}`);
        
      } catch (balanceError) {
        logger.error('CRITICAL: Balance reservation failed after successful eBills Betting API call:', {
          request_id: uniqueRequestId,
          userId,
          currency,
          ngnzAmount,
          error: balanceError.message,
          ebills_order_id: ebillsResponse.data?.order_id
        });
        
        await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { 
          status: 'failed',
          processingErrors: [{
            error: `Balance reservation failed after eBills Betting success: ${balanceError.message}`,
            timestamp: new Date(),
            phase: 'balance_reservation',
            ebills_order_id: ebillsResponse.data?.order_id
          }]
        });
        
        return res.status(500).json({
          success: false,
          error: 'BALANCE_RESERVATION_FAILED',
          message: 'eBills betting transaction succeeded but balance reservation failed. Please contact support immediately.',
          details: {
            orderId: uniqueOrderId,
            requestId: uniqueRequestId,
            ebills_order_id: ebillsResponse.data?.order_id,
            ebills_status: ebillsResponse.data?.status,
            service_name: ebillsResponse.data?.service_name,
            customer_name: ebillsResponse.data?.customer_name,
            amount: amount,
            amount_usd: (ngnzAmount * ngnzToUsdRate).toFixed(2),
            customer_id: customer_id
          }
        });
      }
      
    } else if (ebillsStatus === 'refunded') {
      // Handle refunded status - no balance action needed
      logger.info(`💰 Betting funding refunded for user ${userId}, order ${uniqueOrderId}`);
      
    } else {
      // Handle other statuses
      logger.warn(`⚠️ Unexpected status ${ebillsStatus} for betting order ${uniqueOrderId}`);
    }
    
    // Step 13: Update transaction with eBills response data
    const updatedTransactionData = {
      orderId: ebillsResponse.data.order_id.toString(), // Use eBills order ID
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
        ebills_initial_balance: ebillsResponse.data.initial_balance,
        ebills_final_balance: ebillsResponse.data.final_balance,
        ebills_request_id: ebillsResponse.data.request_id,
        balance_action_taken: balanceActionTaken,
        balance_action_type: balanceActionType,
        balance_action_at: new Date(),
        ebills_order_id: ebillsResponse.data.order_id,
        order_id_type: 'system_generated_unique'
      }
    };
    
    // Set balance status based on action taken
    if (balanceActionType === 'reserved') {
      updatedTransactionData.balanceReserved = true;
    } else if (balanceActionType === 'updated') {
      updatedTransactionData.balanceReserved = false;
      updatedTransactionData.balanceCompleted = true;
    }
    
    const finalTransaction = await BillTransaction.findByIdAndUpdate(
      pendingTransaction._id,
      { $set: updatedTransactionData },
      { new: true }
    );
    
    logger.info(`📋 Transaction updated: ${ebillsResponse.data.order_id} | ${ebillsResponse.data.status} | Balance: ${balanceActionType || 'none'}`);
    
    // Step 14: Return response based on status - UPDATED: NGNZ references
    const responseData = {
      order_id: ebillsResponse.data.order_id,
      request_id: uniqueRequestId,
      status: ebillsResponse.data.status,
      service_name: ebillsResponse.data.service_name,
      customer_id: ebillsResponse.data.customer_id,
      customer_name: ebillsResponse.data.customer_name,
      customer_username: ebillsResponse.data.customer_username,
      customer_email_address: ebillsResponse.data.customer_email_address,
      customer_phone_number: ebillsResponse.data.customer_phone_number,
      amount: ebillsResponse.data.amount,
      amount_charged: ebillsResponse.data.amount_charged,
      discount: ebillsResponse.data.discount,
      payment_details: {
        currency: currency,
        ngnz_amount: ngnzAmount, // UPDATED: ngnb_amount to ngnz_amount
        ngnz_to_usd_rate: ngnzToUsdRate, // UPDATED: ngnb_to_usd_rate to ngnz_to_usd_rate
        amount_usd: (ngnzAmount * ngnzToUsdRate).toFixed(2)
      },
      security_info: {
        twofa_validated: true,
        passwordpin_validated: true,
        kyc_validated: true,
        unique_ids_generated: true
      },
      balance_action: balanceActionType || 'none'
    };

    if (ebillsResponse.data.status === 'completed-api') {
      logger.info(`✅ Betting funding completed immediately for user ${userId}, order ${ebillsResponse.data.order_id}`);
      
      return res.status(200).json({
        success: true,
        message: 'Betting account funding completed successfully',
        data: responseData,
        transaction: finalTransaction
      });
      
    } else if (['initiated-api', 'processing-api'].includes(ebillsResponse.data.status)) {
      logger.info(`⏳ Betting funding processing for user ${userId}, order ${ebillsResponse.data.order_id}`);
      
      return res.status(202).json({
        success: true,
        message: 'Betting account funding is being processed',
        data: responseData,
        transaction: finalTransaction,
        note: 'You will receive a notification when the betting account is funded'
      });
      
    } else if (ebillsResponse.data.status === 'refunded') {
      logger.info(`💰 Betting funding refunded for user ${userId}, order ${ebillsResponse.data.order_id}`);
      
      return res.status(200).json({
        success: true,
        message: 'Betting account funding was refunded',
        data: responseData,
        transaction: finalTransaction,
        note: 'Your balance will be restored automatically'
      });
      
    } else {
      logger.warn(`⚠️ Unexpected status ${ebillsResponse.data.status} for betting order ${ebillsResponse.data.order_id}`);
      
      return res.status(200).json({
        success: true,
        message: `Betting funding status: ${ebillsResponse.data.status}`,
        data: responseData,
        transaction: finalTransaction
      });
    }
    
  } catch (error) {
    logger.error('Betting funding unexpected error:', {
      userId: req.user?.id,
      error: error.message,
      balanceActionTaken,
      balanceActionType,
      transactionCreated,
      ebillsApiCalled: !!ebillsResponse,
      processingTime: Date.now() - startTime
    });

    // Cleanup based on what action was taken - USING INTERNAL FUNCTIONS
    if (balanceActionTaken && balanceActionType === 'reserved') {
      try {
        await releaseReservedBalance(req.user.id, currency, validation?.sanitized?.amount || 0);
        logger.info('🔄 Released reserved NGNZ balance due to error'); // UPDATED: NGNB to NGNZ
      } catch (releaseError) {
        logger.error('❌ Failed to release reserved NGNZ balance after error:', releaseError.message); // UPDATED: NGNB to NGNZ
      }
    } else if (balanceActionTaken && balanceActionType === 'updated') {
      // For direct balance updates, we'd need to reverse the transaction
      // This is more complex and should be handled manually
      logger.error('❌ CRITICAL: Direct balance update completed but transaction failed. Manual intervention required.');
    }

    // Update transaction status if it was created
    if (transactionCreated && pendingTransaction) {
      try {
        await BillTransaction.findByIdAndUpdate(
          pendingTransaction._id,
          { 
            status: 'failed',
            processingErrors: [{
              error: error.message,
              timestamp: new Date(),
              phase: 'unexpected_error'
            }]
          }
        );
      } catch (updateError) {
        logger.error('Failed to update betting transaction status after error:', updateError);
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