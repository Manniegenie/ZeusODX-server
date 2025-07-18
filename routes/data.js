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

// Valid data service providers
const DATA_SERVICES = ['mtn', 'glo', 'airtel', '9mobile'];
const AIRTIME_SERVICES = ['mtn', 'glo', 'airtel', '9mobile'];

// Supported tokens - aligned with user schema (DOGE REMOVED)
const SUPPORTED_TOKENS = {
  BTC: { name: 'Bitcoin' },
  ETH: { name: 'Ethereum' }, 
  SOL: { name: 'Solana' },
  USDT: { name: 'Tether' },
  USDC: { name: 'USD Coin' },
  BNB: { name: 'Binance Coin' },
  MATIC: { name: 'Polygon' },
  AVAX: { name: 'Avalanche' },
  NGNB: { name: 'NGNB Token' }
};

// Token field mapping for balance operations
const TOKEN_FIELD_MAPPING = {
  BTC: 'btc',
  ETH: 'eth', 
  SOL: 'sol',
  USDT: 'usdt',
  USDC: 'usdc',
  BNB: 'bnb',
  MATIC: 'matic',
  AVAX: 'avax',
  NGNB: 'ngnb'
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
 * Generate a unique order ID
 */
function generateUniqueOrderId(serviceType) {
  const timestamp = Date.now();
  const randomBytes = crypto.randomBytes(4).toString('hex');
  const prefix = serviceType === 'data' ? 'data' : 'airtime';
  return `${prefix}_order_${timestamp}_${randomBytes}`;
}

/**
 * Generate a unique request ID based on user ID and timestamp
 */
function generateUniqueRequestId(userId, serviceType) {
  const timestamp = Date.now();
  const randomSuffix = crypto.randomBytes(2).toString('hex');
  const prefix = serviceType === 'data' ? 'data' : 'airtime';
  return `${prefix}_req_${userId}_${timestamp}_${randomSuffix}`;
}

/**
 * Validate phone number format
 */
function validatePhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length < 11 || cleanPhone.length > 16) return false;
  
  if (cleanPhone.startsWith('234')) {
    return cleanPhone.length >= 13 && cleanPhone.length <= 16;
  }
  if (cleanPhone.startsWith('0')) {
    return cleanPhone.length === 11;
  }
  return cleanPhone.length >= 10 && cleanPhone.length <= 13;
}

/**
 * Get data plan price from eBills variations API - FIXED to use VTUAuth properly
 */
async function getDataPlanPrice(service_id, variation_id) {
  try {
    // 🔑 KEY FIX: Use VTUAuth to make authenticated request
    const variationsResponse = await vtuAuth.makeRequest(
      'GET',
      `/api/v2/variations/data/${service_id}`,
      null,
      { 
        timeout: 15000, 
        baseURL: EBILLS_BASE_URL, 
        headers: { 'Accept': 'application/json' } 
      }
    );
    
    if (variationsResponse.code !== 'success') {
      throw new Error('Failed to fetch data plan variations');
    }
    
    const selectedPlan = variationsResponse.data.find(plan => plan.variation_id === variation_id);
    if (!selectedPlan) {
      throw new Error(`Data plan with variation_id ${variation_id} not found`);
    }
    
    return {
      price: parseFloat(selectedPlan.price),
      name: selectedPlan.name,
      description: selectedPlan.description,
      validity: selectedPlan.validity || null,
      data_allowance: selectedPlan.data_allowance || null
    };
  } catch (error) {
    logger.error('Failed to get data plan price:', error.message);
    throw error;
  }
}

/**
 * Validate customer phone and get plan details
 */
async function validateCustomerAndGetPlanPrice(phone_number, service_id, variation_id, service_type) {
  try {
    // For data purchases, get plan price from variations
    let expectedAmount = null;
    let planInfo = null;
    
    if (service_type === 'data') {
      planInfo = await getDataPlanPrice(service_id, variation_id);
      expectedAmount = planInfo.price;
    } else if (service_type === 'airtime') {
      // For airtime, the amount is what user specifies (no fixed plans)
      // We'll validate this in the main function
      expectedAmount = null; // Will be set by user input
    }
    
    // Validate phone number format
    if (!validatePhoneNumber(phone_number)) {
      throw new Error('Invalid phone number format');
    }
    
    return {
      phoneInfo: {
        phone_number: phone_number,
        network: service_id,
        service_type: service_type
      },
      planInfo,
      expectedAmount,
      isValid: true
    };
    
  } catch (error) {
    logger.error('Customer/plan validation error:', error);
    return {
      phoneInfo: null,
      planInfo: null,
      expectedAmount: null,
      isValid: false,
      error: error.message
    };
  }
}

/**
 * Validate that user amount matches plan price (for data only)
 */
function validateAmountMatchesPlan(userAmount, expectedAmount, serviceType, tolerance = 0.01) {
  // For airtime, any amount within limits is acceptable
  if (serviceType === 'airtime') {
    return { isValid: true, providedAmount: userAmount, expectedAmount: userAmount };
  }
  
  // For data, amount must match plan price exactly
  if (!expectedAmount) {
    return {
      isValid: false,
      error: 'PLAN_PRICE_NOT_FOUND',
      message: 'Could not determine the correct price for this data plan'
    };
  }
  
  const difference = Math.abs(userAmount - expectedAmount);
  
  if (difference > tolerance) {
    return {
      isValid: false,
      error: 'AMOUNT_PLAN_MISMATCH',
      message: `Amount mismatch: You provided ₦${userAmount} but the selected data plan costs ₦${expectedAmount}`,
      providedAmount: userAmount,
      expectedAmount: expectedAmount,
      difference: difference
    };
  }
  
  return { isValid: true, providedAmount: userAmount, expectedAmount: expectedAmount };
}

/**
 * Enhanced validation with price verification and Password PIN
 */
function validateDataAirtimeRequest(body) {
  const errors = [];
  const sanitized = {};
  
  if (!body.phone_number) {
    errors.push('Phone number is required');
  } else {
    sanitized.phone_number = String(body.phone_number).trim();
    if (!validatePhoneNumber(sanitized.phone_number)) {
      errors.push('Invalid phone number format');
    }
  }
  
  if (!body.service_id) {
    errors.push('Service ID (network) is required');
  } else {
    sanitized.service_id = String(body.service_id).toLowerCase().trim();
    if (!DATA_SERVICES.includes(sanitized.service_id) && !AIRTIME_SERVICES.includes(sanitized.service_id)) {
      errors.push(`Invalid service ID. Must be one of: ${[...new Set([...DATA_SERVICES, ...AIRTIME_SERVICES])].join(', ')}`);
    }
  }
  
  if (!body.service_type) {
    errors.push('Service type is required');
  } else {
    sanitized.service_type = String(body.service_type).toLowerCase().trim();
    if (!['data', 'airtime'].includes(sanitized.service_type)) {
      errors.push('Service type must be "data" or "airtime"');
    }
  }
  
  // For data, variation_id is required
  if (sanitized.service_type === 'data') {
    if (!body.variation_id) {
      errors.push('Variation ID (data plan) is required for data purchases');
    } else {
      sanitized.variation_id = String(body.variation_id).trim();
      if (sanitized.variation_id.length === 0) {
        errors.push('Variation ID must be a non-empty string');
      }
    }
  } else {
    // For airtime, variation_id is optional
    if (body.variation_id) {
      sanitized.variation_id = String(body.variation_id).trim();
    }
  }
  
  // Amount validation
  if (!body.amount) {
    errors.push('Amount is required');
  } else {
    const numericAmount = Number(body.amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      errors.push('Amount must be a positive number');
    } else if (numericAmount > 50000) {
      errors.push('Amount above maximum. Maximum is ₦50,000');
    } else if (sanitized.service_type === 'airtime' && numericAmount < 50) {
      errors.push('Minimum airtime amount is ₦50');
    } else if (sanitized.service_type === 'data' && numericAmount < 100) {
      errors.push('Minimum data plan amount is ₦100');
    } else {
      sanitized.amount = numericAmount;
    }
  }
  
  // NGNB currency validation
  if (!body.payment_currency) {
    errors.push('Payment currency is required and must be NGNB');
  } else if (body.payment_currency.toUpperCase() !== 'NGNB') {
    errors.push('Payment currency must be NGNB only');
  } else {
    sanitized.payment_currency = 'NGNB';
  }
  
  // 2FA validation
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
  
  return { isValid: errors.length === 0, errors, sanitized };
}

/**
 * Validate NGNB limits
 */
function validateNGNBLimits(amount, serviceType) {
  const MIN_NGNB = serviceType === 'airtime' ? 50 : 100;
  const MAX_NGNB = 50000;
  
  if (amount < MIN_NGNB) {
    return {
      isValid: false,
      error: 'NGNB_MINIMUM_NOT_MET',
      message: `Minimum NGNB ${serviceType} purchase amount is ${MIN_NGNB} NGNB. Your amount: ${amount} NGNB.`,
      minimumRequired: MIN_NGNB,
      providedAmount: amount
    };
  }
  
  if (amount > MAX_NGNB) {
    return {
      isValid: false,
      error: 'NGNB_MAXIMUM_EXCEEDED',
      message: `Maximum NGNB ${serviceType} purchase amount is ${MAX_NGNB} NGNB. Your amount: ${amount} NGNB.`,
      maximumAllowed: MAX_NGNB,
      providedAmount: amount
    };
  }
  
  return { isValid: true };
}

/**
 * Check for existing pending transactions to prevent duplicates
 */
async function checkForPendingTransactions(userId, customOrderId, customRequestId, serviceType) {
  const pendingTransactions = await BillTransaction.find({
    $or: [
      { userId: userId, billType: { $in: ['data', 'airtime'] }, status: { $in: ['initiated-api', 'processing-api', 'pending'] } },
      { orderId: customOrderId },
      { requestId: customRequestId }
    ],
    createdAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) } // Last 5 minutes
  });
  
  return pendingTransactions.length > 0;
}

/**
 * Call eBills API for data/airtime purchase - FIXED to use VTUAuth properly
 * @param {Object} params - API parameters
 * @returns {Promise<Object>} eBills API response
 */
async function callEBillsDataAirtimeAPI({ phone_number, amount, service_id, variation_id, service_type, request_id, userId }) {
  try {
    const apiEndpoint = service_type === 'data' ? '/api/v2/data' : '/api/v2/airtime';
    const apiPayload = {
      request_id: request_id,
      phone: phone_number,
      service_id,
      amount: parseInt(amount)
    };
    
    // Add variation_id for data purchases
    if (service_type === 'data' && variation_id) {
      apiPayload.variation_id = variation_id;
    }

    logger.info(`Making eBills ${service_type} purchase request:`, {
      phone_number,
      amount,
      service_id,
      variation_id,
      service_type,
      request_id,
      endpoint: apiEndpoint
    });

    // 🔑 KEY FIX: Use VTUAuth to make authenticated request instead of direct axios
    const response = await vtuAuth.makeRequest('POST', apiEndpoint, apiPayload, {
      timeout: 45000,
      baseURL: EBILLS_BASE_URL,
      headers: { 
        'Content-Type': 'application/json', 
        'Accept': 'application/json' 
      }
    });

    logger.info(`eBills ${service_type} API response for ${request_id}:`, {
      code: response.code,
      message: response.message,
      data: response.data
    });

    // Handle eBills API response structure
    if (response.code !== 'success') {
      throw new Error(`eBills ${service_type} API error: ${response.message || 'Unknown error'}`);
    }

    return response;

  } catch (error) {
    logger.error(`❌ eBills ${service_type} purchase failed:`, {
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

    if (error.message.includes('invalid phone')) {
      throw new Error('Invalid phone number format. Please check the number and try again.');
    }

    if (error.response?.status === 422) {
      const validationErrors = error.response.data?.errors || {};
      const errorMessages = Object.values(validationErrors).flat();
      throw new Error(`Validation error: ${errorMessages.join(', ')}`);
    }

    throw new Error(`eBills ${service_type} API error: ${error.message}`);
  }
}

/**
 * Main data/airtime purchase endpoint - mirroring airtime flow
 */
router.post('/purchase', async (req, res) => {
  const startTime = Date.now();
  let balanceActionTaken = false;
  let balanceActionType = null; // 'reserved' or 'updated'
  let transactionCreated = false;
  let pendingTransaction = null;
  let ebillsResponse = null;

  try {
    const requestBody = req.body;
    const userId = req.user.id;
    
    logger.info(`📱📊 Data/Airtime purchase request from user ${userId}:`, {
      ...requestBody,
      passwordpin: '[REDACTED]' // Don't log the actual password pin
    });
    
    // Step 1: Validate request
    const validation = validateDataAirtimeRequest(requestBody);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors
      });
    }
    
    const { phone_number, service_id, service_type, variation_id, amount, twoFactorCode, passwordpin } = validation.sanitized;
    const currency = 'NGNB';
    
    // Step 2: Generate unique IDs
    const uniqueOrderId = generateUniqueOrderId(service_type);
    const uniqueRequestId = generateUniqueRequestId(userId, service_type);
    
    logger.info(`Generated unique IDs for ${service_type} - OrderID: ${uniqueOrderId}, RequestID: ${uniqueRequestId}`);
    
    // Step 3: Check for duplicate/pending transactions
    const hasPendingTransactions = await checkForPendingTransactions(userId, uniqueOrderId, uniqueRequestId, service_type);
    if (hasPendingTransactions) {
      return res.status(409).json({
        success: false,
        error: 'DUPLICATE_OR_PENDING_TRANSACTION',
        message: `You have a pending ${service_type} transaction or duplicate IDs detected. Please wait before making another purchase.`
      });
    }
    
    // Step 4: Validate user and 2FA
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (!user.twoFASecret || !user.is2FAEnabled) {
      return res.status(400).json({
        success: false,
        message: 'Two-factor authentication is not set up or not enabled. Please enable 2FA first.'
      });
    }

    if (!validateTwoFactorAuth(user, twoFactorCode)) {
      logger.warn(`🚫 2FA validation failed for ${service_type} purchase`, { 
        userId, errorType: 'INVALID_2FA'
      });
      return res.status(401).json({
        success: false,
        error: 'INVALID_2FA_CODE',
        message: 'Invalid two-factor authentication code'
      });
    }

    logger.info(`✅ 2FA validation successful for ${service_type} purchase`, { userId });

    // Step 5: Validate password pin
    if (!user.passwordpin) {
      return res.status(400).json({
        success: false,
        message: 'Password PIN is not set up for your account. Please set up your password PIN first.'
      });
    }

    const isPasswordPinValid = await comparePasswordPin(passwordpin, user.passwordpin);
    if (!isPasswordPinValid) {
      logger.warn(`🚫 Password PIN validation failed for ${service_type} purchase`, { 
        userId, errorType: 'INVALID_PASSWORDPIN'
      });
      return res.status(401).json({
        success: false,
        error: 'INVALID_PASSWORDPIN',
        message: 'Invalid password PIN'
      });
    }

    logger.info(`✅ Password PIN validation successful for ${service_type} purchase`, { userId });

    // Step 6: KYC validation
    logger.info(`Validating KYC limits for ${service_type} purchase`, { userId, amount, currency: 'NGNB' });
    
    try {
      // Determine transaction type based on service_type
      const transactionType = service_type === 'data' ? 'DATA' : 'AIRTIME';
      const kycValidation = await validateTransactionLimit(userId, amount, 'NGNB', transactionType);
      
      if (!kycValidation.allowed) {
        logger.warn(`${service_type} purchase blocked by KYC limits`, {
          userId,
          amount,
          currency: 'NGNB',
          phone_number,
          service_id,
          service_type,
          variation_id,
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
            transactionType: transactionType
          }
        });
      }

      // Log successful KYC validation with details
      logger.info(`✅ KYC validation passed for ${service_type} purchase`, {
        userId,
        amount,
        currency: 'NGNB',
        phone_number,
        service_id,
        service_type,
        variation_id,
        kycLevel: kycValidation.data?.kycLevel,
        dailyRemaining: kycValidation.data?.dailyRemaining,
        monthlyRemaining: kycValidation.data?.monthlyRemaining,
        amountInNaira: kycValidation.data?.amountInNaira
      });

    } catch (kycError) {
      logger.error(`KYC validation failed with error for ${service_type} purchase`, {
        userId,
        amount,
        currency: 'NGNB',
        phone_number,
        service_id,
        service_type,
        variation_id,
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

    // Step 7: Validate customer and get plan details
    const customerValidation = await validateCustomerAndGetPlanPrice(
      phone_number, service_id, variation_id, service_type
    );

    if (!customerValidation.isValid) {
      return res.status(400).json({
        success: false,
        error: 'CUSTOMER_VALIDATION_FAILED',
        message: customerValidation.error || 'Customer validation failed',
        details: { phone_number, service_id, service_type, variation_id }
      });
    }

    // Step 8: Verify amount matches plan price (for data only)
    let purchaseAmount = amount;
    
    if (service_type === 'data') {
      const amountValidation = validateAmountMatchesPlan(amount, customerValidation.expectedAmount, service_type);

      if (!amountValidation.isValid) {
        return res.status(400).json({
          success: false,
          error: amountValidation.error,
          message: amountValidation.message,
          details: {
            phone_number,
            service_id,
            service_type,
            variation_id,
            provided_amount: amountValidation.providedAmount,
            expected_amount: amountValidation.expectedAmount,
            difference: amountValidation.difference,
            plan_info: customerValidation.planInfo
          },
          security_note: 'Amount must match the exact data plan price for security'
        });
      }
      
      purchaseAmount = customerValidation.expectedAmount;
    }
    
    // Step 9: Calculate NGNB amount
    const ngnbAmount = purchaseAmount;
    const ngnbToUsdRate = 1 / 1554.42;
    
    logger.info(`NGNB amount needed: ₦${purchaseAmount} → ${ngnbAmount} NGNB (1:1 ratio)`);
    
    // Step 10: Validate NGNB limits
    const ngnbLimitValidation = validateNGNBLimits(ngnbAmount, service_type);
    if (!ngnbLimitValidation.isValid) {
      return res.status(400).json({
        success: false,
        error: ngnbLimitValidation.error,
        message: ngnbLimitValidation.message,
        details: {
          currency: currency,
          providedAmount: ngnbLimitValidation.providedAmount,
          minimumRequired: ngnbLimitValidation.minimumRequired,
          maximumAllowed: ngnbLimitValidation.maximumAllowed
        }
      });
    }
    
    // Step 11: Validate user balance
    const balanceValidation = await validateUserBalance(userId, currency, ngnbAmount, {
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
          requiredAmount: ngnbAmount,
          currency: currency,
          shortfall: balanceValidation.shortfall
        }
      });
    }

    logger.info(`✅ ${service_type} purchase NGNB balance validation successful`, {
      userId,
      phone_number,
      amount: purchaseAmount,
      payment_currency: currency,
      availableBalance: balanceValidation.availableBalance,
      requiredAmount: ngnbAmount
    });

    // Step 12: Create transaction record with unique order ID
    const initialTransactionData = {
      orderId: uniqueOrderId, // Guaranteed unique order ID
      status: 'initiated-api',
      productName: service_type === 'data' ? 'Data' : 'Airtime',
      billType: service_type,
      quantity: 1,
      amount: purchaseAmount,
      amountNaira: purchaseAmount,
      amountCrypto: ngnbAmount,
      paymentCurrency: currency,
      cryptoPrice: ngnbToUsdRate,
      requestId: uniqueRequestId, // Guaranteed unique request ID
      metaData: {
        phone_number,
        service_id,
        service_type,
        variation_id: variation_id || null,
        user_id: userId,
        payment_currency: currency,
        balance_reserved: false,
        purchase_amount_usd: (ngnbAmount * ngnbToUsdRate).toFixed(2),
        is_ngnb_transaction: true,
        twofa_validated: true,
        passwordpin_validated: true,
        kyc_validated: true,
        price_verified: service_type === 'data',
        expected_amount: service_type === 'data' ? customerValidation.expectedAmount : purchaseAmount,
        plan_info: customerValidation.planInfo,
        unique_order_id: uniqueOrderId,
        unique_request_id: uniqueRequestId,
        order_id_type: 'system_generated_unique'
      },
      network: service_id.toUpperCase(),
      customerPhone: phone_number,
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
    
    logger.info(`📋 Bill transaction ${uniqueOrderId}: initiated-api | ${service_type} | ${ngnbAmount} NGNB | ✅ 2FA | ✅ PIN | ✅ KYC | ⚠️ Balance Pending`);
    
    // Step 13: Call eBills API
    try {
      logger.info(`Calling eBills ${service_type} API with unique RequestID: ${uniqueRequestId}...`);
      
      ebillsResponse = await callEBillsDataAirtimeAPI({
        phone_number,
        amount: purchaseAmount,
        service_id,
        variation_id,
        service_type,
        request_id: uniqueRequestId,
        userId
      });
      
    } catch (apiError) {
      logger.error(`eBills ${service_type} API call failed:`, {
        error: apiError.message,
        unique_order_id: uniqueOrderId,
        unique_request_id: uniqueRequestId,
        userId: userId,
        response: apiError.response?.data,
        status: apiError.response?.status,
        timeout: apiError.code === 'ECONNABORTED' || apiError.message.includes('timeout')
      });
      
      await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { 
        status: 'failed',
        processingErrors: [{ error: apiError.message, timestamp: new Date(), phase: 'ebills_api_call' }]
      });
      
      // Map eBills error codes to appropriate responses
      const errorData = apiError.response?.data;
      let statusCode = apiError.response?.status || 500;
      let errorMessage = apiError.message;
      let errorCode = 'EBILLS_API_ERROR';
      
      // Handle timeout specifically
      if (apiError.code === 'ECONNABORTED' || apiError.message.includes('timeout')) {
        statusCode = 504; // Gateway timeout
        errorMessage = `eBills ${service_type} API request timed out. Please try again.`;
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
        note: 'No balance was reserved since the eBills API call failed'
      });
    }
    
    // =====================================
    // STEP 14: HANDLE BALANCE BASED ON STATUS - USING INTERNAL FUNCTIONS
    // =====================================
    const ebillsStatus = ebillsResponse.data.status;
    
    if (ebillsStatus === 'completed-api') {
      // Transaction completed immediately - UPDATE BALANCE DIRECTLY
      logger.info(`✅ Transaction completed immediately, updating balance directly for ${uniqueRequestId}`);
      
      try {
        // Deduct balance directly (negative amount) - USING INTERNAL FUNCTION
        await updateUserBalance(userId, currency, -ngnbAmount);
        
        // Update user's portfolio timestamp - USING INTERNAL FUNCTION
        await updateUserPortfolioBalance(userId);
        
        balanceActionTaken = true;
        balanceActionType = 'updated';
        
        logger.info(`✅ Balance updated directly: -${ngnbAmount} ${currency} for user ${userId}`);
        
      } catch (balanceError) {
        logger.error('CRITICAL: Balance update failed for completed transaction:', {
          request_id: uniqueRequestId,
          userId,
          currency,
          ngnbAmount,
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
          message: `eBills ${service_type} transaction succeeded but balance update failed. Please contact support immediately.`,
          details: {
            orderId: uniqueOrderId,
            requestId: uniqueRequestId,
            ebills_order_id: ebillsResponse.data?.order_id,
            ebills_status: ebillsResponse.data?.status,
            phone_number,
            amount: purchaseAmount
          }
        });
      }
      
    } else if (['initiated-api', 'processing-api'].includes(ebillsStatus)) {
      // Transaction pending - RESERVE BALANCE - USING INTERNAL FUNCTION
      logger.info(`⏳ Transaction pending (${ebillsStatus}), reserving balance for ${uniqueRequestId}`);
      
      try {
        await reserveUserBalance(userId, currency, ngnbAmount);
        
        await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { 
          balanceReserved: true,
          'metaData.balance_reserved': true,
          'metaData.balance_reserved_at': new Date()
        });
        
        balanceActionTaken = true;
        balanceActionType = 'reserved';
        
        logger.info(`✅ Balance reserved: ${ngnbAmount} ${currency} for user ${userId}`);
        
      } catch (balanceError) {
        logger.error(`CRITICAL: Balance reservation failed after successful eBills ${service_type} API call:`, {
          request_id: uniqueRequestId,
          userId,
          currency,
          ngnbAmount,
          error: balanceError.message,
          ebills_order_id: ebillsResponse.data?.order_id
        });
        
        await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { 
          status: 'failed',
          processingErrors: [{
            error: `Balance reservation failed: ${balanceError.message}`,
            timestamp: new Date(),
            phase: 'balance_reservation',
            ebills_order_id: ebillsResponse.data?.order_id
          }]
        });
        
        return res.status(500).json({
          success: false,
          error: 'BALANCE_RESERVATION_FAILED',
          message: `eBills ${service_type} succeeded but balance reservation failed. Contact support.`,
          details: {
            orderId: uniqueOrderId,
            requestId: uniqueRequestId,
            ebills_order_id: ebillsResponse.data?.order_id,
            ebills_status: ebillsResponse.data?.status,
            phone_number,
            amount: purchaseAmount
          }
        });
      }
      
    } else if (ebillsStatus === 'refunded') {
      // Handle refunded status - no balance action needed
      logger.info(`💰 ${service_type} purchase refunded for user ${userId}, order ${uniqueOrderId}`);
      
    } else {
      // Handle other statuses
      logger.warn(`⚠️ Unexpected status ${ebillsStatus} for ${service_type} order ${uniqueOrderId}`);
    }
    
    // Step 15: Update transaction with eBills data
    const updatedTransactionData = {
      orderId: ebillsResponse.data.order_id.toString(), // Use eBills order ID
      status: ebillsResponse.data.status,
      productName: ebillsResponse.data.product_name,
      metaData: {
        ...initialTransactionData.metaData,
        service_name: ebillsResponse.data.service_name,
        phone: ebillsResponse.data.phone,
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
    
    // Step 16: Return response based on status
    const responseData = {
      order_id: ebillsResponse.data.order_id,
      request_id: uniqueRequestId,
      status: ebillsResponse.data.status,
      service_name: ebillsResponse.data.service_name,
      phone: ebillsResponse.data.phone,
      amount: ebillsResponse.data.amount,
      amount_charged: ebillsResponse.data.amount_charged,
      discount: ebillsResponse.data.discount,
      service_type: service_type,
      network: service_id.toUpperCase(),
      payment_details: {
        currency: currency,
        ngnb_amount: ngnbAmount,
        amount_usd: (ngnbAmount * ngnbToUsdRate).toFixed(2)
      },
      security_info: {
        price_verified: service_type === 'data',
        expected_amount: service_type === 'data' ? customerValidation.expectedAmount : purchaseAmount,
        twofa_validated: true,
        passwordpin_validated: true,
        kyc_validated: true,
        unique_ids_generated: true
      },
      balance_action: balanceActionType || 'none'
    };

    // Add plan details for data purchases
    if (service_type === 'data' && customerValidation.planInfo) {
      responseData.plan_details = {
        name: customerValidation.planInfo.name,
        data_allowance: customerValidation.planInfo.data_allowance,
        validity: customerValidation.planInfo.validity
      };
    }

    if (ebillsResponse.data.status === 'completed-api') {
      logger.info(`✅ ${service_type === 'data' ? 'Data' : 'Airtime'} purchase completed immediately for user ${userId}, order ${ebillsResponse.data.order_id}`);
      
      return res.status(200).json({
        success: true,
        message: `${service_type === 'data' ? 'Data' : 'Airtime'} purchase completed successfully`,
        data: responseData,
        transaction: finalTransaction
      });
    } else if (['initiated-api', 'processing-api'].includes(ebillsResponse.data.status)) {
      logger.info(`⏳ ${service_type === 'data' ? 'Data' : 'Airtime'} purchase processing for user ${userId}, order ${ebillsResponse.data.order_id}`);
      
      return res.status(202).json({
        success: true,
        message: `${service_type === 'data' ? 'Data' : 'Airtime'} purchase is being processed`,
        data: responseData,
        transaction: finalTransaction,
        note: 'You will receive a notification when completed'
      });
    } else if (ebillsResponse.data.status === 'refunded') {
      return res.status(200).json({
        success: true,
        message: `${service_type === 'data' ? 'Data' : 'Airtime'} purchase was refunded`,
        data: responseData,
        transaction: finalTransaction,
        note: 'Your balance will be restored automatically'
      });
    } else {
      return res.status(200).json({
        success: true,
        message: `${service_type === 'data' ? 'Data' : 'Airtime'} purchase status: ${ebillsResponse.data.status}`,
        data: responseData,
        transaction: finalTransaction
      });
    }
    
  } catch (error) {
    logger.error('Data/Airtime purchase unexpected error:', { 
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
        logger.info('🔄 Released reserved NGNB balance due to error');
      } catch (releaseError) {
        logger.error('❌ Failed to release reserved NGNB balance after error:', releaseError.message);
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
          processingErrors: [{ error: error.message, timestamp: new Date(), phase: 'unexpected_error' }]
        });
      } catch (updateError) {
        logger.error('Failed to update transaction:', updateError);
      }
    }
    
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred'
    });
  }
});

module.exports = router;