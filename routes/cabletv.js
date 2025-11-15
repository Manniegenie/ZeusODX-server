// routes/cabletv.js
const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { vtuAuth } = require('../auth/billauth');
const { payBetaAuth } = require('../auth/paybetaAuth');
const { validateUserBalance } = require('../services/balance');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const logger = require('../utils/logger');
const { sendUtilityTransactionEmail } = require('../services/EmailService');

const router = express.Router();

// Cache for user data to avoid repeated DB queries
const userCache = new Map();
const CACHE_TTL = 5000; // 5 seconds - reduced for profile data freshness
const { registerCache } = require('../utils/cacheManager');
registerCache('cabletv_userCache', userCache);

// Valid cable TV service providers
const CABLE_TV_SERVICES = ['dstv', 'gotv', 'startimes', 'showmax'];
const VALID_SUBSCRIPTION_TYPES = ['change', 'renew'];

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
 * Optimized user data retrieval with caching
 */
async function getCachedUser(userId) {
  const cacheKey = `user_${userId}`;
  const cached = userCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.user;
  }
  
  // Include email and name fields so we can send notifications
  const user = await User.findById(userId).select(
    'twoFASecret is2FAEnabled passwordpin ngnzBalance lastBalanceUpdate email firstName username'
  ).lean(); // Use lean() for better performance, only select what we need
  
  if (user) {
    userCache.set(cacheKey, { user, timestamp: Date.now() });
    // Auto-cleanup cache
    setTimeout(() => userCache.delete(cacheKey), CACHE_TTL);
  }
  
  return user;
}

/**
 * SIMPLIFIED: Direct balance update only (no reservations, no portfolio updates)
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
    
    // Simple atomic update
    const updateFields = {
      $inc: { [balanceField]: amount },
      $set: { lastBalanceUpdate: new Date() }
    };
    
    const user = await User.findByIdAndUpdate(
      userId, 
      updateFields, 
      { new: true, runValidators: true }
    );
    
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    
    // Clear cache
    userCache.delete(`user_${userId}`);
    
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
 * Sanitize and validate cable TV request body
 */
function validateCableTVRequest(body) {
  const errors = [];
  const sanitized = {};
  
  // Customer ID validation
  if (!body.customer_id) {
    errors.push('Customer ID (smartcard/IUC number) is required');
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
    sanitized.service_id = String(body.service_id).toLowerCase().trim();
    if (!CABLE_TV_SERVICES.includes(sanitized.service_id)) {
      errors.push(`Invalid service ID. Must be one of: ${CABLE_TV_SERVICES.join(', ')}`);
    }
  }
  
  // Variation ID validation
  if (!body.variation_id) {
    errors.push('Variation ID (package/bouquet) is required');
  } else {
    sanitized.variation_id = String(body.variation_id).trim();
    if (sanitized.variation_id.length === 0) {
      errors.push('Variation ID must be a non-empty string');
    }
  }
  
  // Subscription type validation
  if (body.subscription_type) {
    sanitized.subscription_type = String(body.subscription_type).toLowerCase().trim();
    if (!VALID_SUBSCRIPTION_TYPES.includes(sanitized.subscription_type)) {
      errors.push('Subscription type must be "change" or "renew"');
    }
  } else {
    sanitized.subscription_type = 'change';
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
      
      const minAmount = 500; // Minimum for cable TV
      const maxAmount = 50000; // Maximum for cable TV
      if (sanitized.amount < minAmount) {
        errors.push(`Amount below minimum. Minimum cable TV purchase is ${minAmount} NGNZ`);
      }
      if (sanitized.amount > maxAmount) {
        errors.push(`Amount above maximum. Maximum cable TV purchase is ${maxAmount} NGNZ`);
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
 * Call eBills API for cable TV purchase
 */
async function callEBillsAPI({ customer_id, service_id, variation_id, subscription_type, amount, request_id, userId }) {
  try {
    const payload = {
      request_id: request_id,
      customer_id: customer_id.trim(),
      service_id,
      variation_id,
      subscription_type,
      amount: parseInt(amount)
    };

    logger.info('Making eBills cable TV purchase request:', {
      customer_id, service_id, variation_id, subscription_type, amount, request_id, endpoint: '/api/v2/tv'
    });

    const response = await vtuAuth.makeRequest('POST', '/api/v2/tv', payload, {
      timeout: 25000 // Reduced from 45s for faster failure
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
    logger.error('❌ eBills cable TV purchase failed:', {
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
 * Call PayBeta API for cable TV purchase
 */
async function callPayBetaAPI({ customer_id, service_id, variation_id, amount, request_id, userId, customer_name }) {
  try {
    // Map service_id to PayBeta format
    const serviceMapping = {
      'dstv': 'dstv',
      'gotv': 'gotv', 
      'startimes': 'startimes',
      'showmax': 'showmax'
    };

    const payBetaService = serviceMapping[service_id];
    if (!payBetaService) {
      throw new Error(`Unsupported service for PayBeta: ${service_id}`);
    }

    // Ensure reference is under 40 characters for PayBeta
    const payBetaReference = request_id.length > 40 ? 
      request_id.substring(0, 40) : request_id;

    let payload;
    let endpoint;
    
    // Handle Showmax differently as it has its own purchase endpoint
    if (service_id.toLowerCase() === 'showmax') {
      logger.info('Using Showmax-specific purchase endpoint and payload format');
      payload = {
        service: payBetaService,
        smartCardNumber: customer_id.trim(),
        amount: parseFloat(amount), // Showmax can handle decimal amounts
        packageCode: variation_id,
        customerName: customer_name || 'CUSTOMER',
        reference: payBetaReference
      };
      endpoint = '/v2/showmax/purchase';
    } else {
      payload = {
        service: payBetaService,
        smartCardNumber: customer_id.trim(),
        amount: Math.round(amount), // Other providers expect integer
        packageCode: variation_id,
        customerName: customer_name || 'CUSTOMER',
        reference: payBetaReference
      };
      endpoint = '/v2/cable/purchase';
    }

    logger.info('Making PayBeta cable TV purchase request:', {
      customer_id, service_id, variation_id, amount, request_id, endpoint
    });

    const response = await payBetaAuth.makeRequest('POST', endpoint, payload, {
      timeout: 25000
    });

    logger.info(`PayBeta API response for ${request_id}:`, {
      status: response.status,
      message: response.message,
      reference: response.data?.reference,
      transactionId: response.data?.transactionId
    });

    if (response.status !== 'successful') {
      throw new Error(`PayBeta API error: ${response.message || 'Unknown error'}`);
    }

    // Transform PayBeta response to match eBills format for consistency
    return {
      code: 'success',
      message: response.message,
      data: {
        status: 'successful',
        order_id: response.data.transactionId,
        reference: response.data.reference,
        amount: response.data.amount,
        chargedAmount: response.data.chargedAmount,
        commission: response.data.commission,
        biller: response.data.biller,
        customerId: response.data.customerId,
        transactionDate: response.data.transactionDate
      }
    };

  } catch (error) {
    logger.error('❌ PayBeta cable TV purchase failed:', {
      request_id, userId, error: error.message,
      status: error.response?.status,
      payBetaError: error.response?.data
    });

    if (error.message.includes('insufficient')) {
      throw new Error('Insufficient balance with PayBeta provider. Please contact support.');
    }
    if (error.message.includes('validation')) {
      throw new Error('Invalid request parameters. Please check your input.');
    }

    throw new Error(`PayBeta API error: ${error.message}`);
  }
}

/**
 * STREAMLINED cable TV purchase endpoint - ATOMIC IMMEDIATE DEBIT
 */
router.post('/purchase', async (req, res) => {
  const startTime = Date.now();
  let balanceDeducted = false;
  let transactionCreated = false;
  let pendingTransaction = null;
  let payBetaResponse = null;
  let validation;

  try {
    const requestBody = req.body;
    const userId = req.user.id;
    
    logger.info(`📺 Cable TV purchase request from user ${userId}:`, {
      ...requestBody,
      passwordpin: '[REDACTED]'
    });
    
    // Step 1: Validate request
    validation = validateCableTVRequest(requestBody);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors
      });
    }
    
    const { customer_id, service_id, variation_id, subscription_type, amount, twoFactorCode, passwordpin } = validation.sanitized;
    const currency = 'NGNZ';
    
    // Step 2: Get user data
    const user = await getCachedUser(userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Step 2.1: Balance check
    const availableBalance = user.ngnzBalance || 0;
    if (availableBalance < amount) {
      return res.status(400).json({
        success: false,
        error: 'INSUFFICIENT_NGNZ_BALANCE',
        message: 'NGNZ balance insufficient'
      });
    }

    if (!user.twoFASecret || !user.is2FAEnabled) {
      return res.status(400).json({
        success: false,
        message: 'Two-factor authentication is not set up or not enabled. Please enable 2FA first.'
      });
    }

    if (!validateTwoFactorAuth(user, twoFactorCode)) {
      logger.warn('🚫 2FA validation failed for cable TV purchase', { 
        userId, errorType: 'INVALID_2FA'
      });
      return res.status(401).json({
        success: false,
        error: 'INVALID_2FA_CODE',
        message: 'Invalid two-factor authentication code'
      });
    }

    logger.info('✅ 2FA validation successful for cable TV purchase', { userId });

    // Step 3: Validate password pin
    if (!user.passwordpin) {
      return res.status(400).json({
        success: false,
        message: 'Password PIN is not set up for your account. Please set up your password PIN first.'
      });
    }

    const isPasswordPinValid = await comparePasswordPin(passwordpin, user.passwordpin);
    if (!isPasswordPinValid) {
      logger.warn('🚫 Password PIN validation failed for cable TV purchase', { 
        userId, errorType: 'INVALID_PASSWORDPIN'
      });
      return res.status(401).json({
        success: false,
        error: 'INVALID_PASSWORDPIN',
        message: 'Invalid password PIN'
      });
    }

    logger.info('✅ Password PIN validation successful for cable TV purchase', { userId });

    
    // Step 5: Generate unique IDs
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const finalRequestId = `${userId}_${timestamp}_${randomSuffix}`;
    const uniqueOrderId = `pending_${userId}_${timestamp}`;
    
    // Step 6: REDUNDANT BALANCE CHECK (in case balance changed between cache and now)
    // Re-fetch latest balance from database for final confirmation
    const latestUser = await User.findById(userId).select('ngnzBalance').lean();
    if (!latestUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found during balance verification'
      });
    }

    const currentBalance = latestUser.ngnzBalance || 0;
    if (currentBalance < amount) {
      return res.status(400).json({
        success: false,
        error: 'INSUFFICIENT_NGNZ_BALANCE',
        message: 'NGNZ balance insufficient'
      });
    }

    // Step 7: Create minimal transaction record
    const initialTransactionData = {
      orderId: uniqueOrderId,
      status: 'initiated-api',
      productName: 'Cable TV',
      billType: 'cable_tv',
      quantity: 1,
      amount: amount,
      amountNaira: amount,
      paymentCurrency: currency,
      requestId: finalRequestId,
      metaData: {
        customer_id,
        service_id,
        variation_id,
        subscription_type,
        user_id: userId,
        payment_currency: currency,
        ngnz_amount: amount,
        exchange_rate: 1,
        twofa_validated: true,
        passwordpin_validated: true,
        is_ngnz_transaction: true
      },
      network: service_id.toUpperCase(),
      customerPhone: customer_id,
      customerInfo: {
        customer_id,
        service_id,
        variation_id,
        subscription_type
      },
      userId: userId,
      timestamp: new Date(),
      twoFactorValidated: true,
      passwordPinValidated: true,
    };
    
    pendingTransaction = await BillTransaction.create(initialTransactionData);
    transactionCreated = true;
    
    logger.info(`📋 Bill transaction ${uniqueOrderId}: initiated-api | cable_tv | ${amount} NGNZ | ✅ 2FA | ✅ PIN`);
    
    // Step 8: Call PayBeta API
    try {
      payBetaResponse = await callPayBetaAPI({
        customer_id, service_id, variation_id, amount,
        request_id: finalRequestId,
        userId,
        customer_name: 'CUSTOMER' // You can enhance this to get actual customer name
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
        error: 'PAYBETA_API_ERROR',
        message: apiError.message
      });
    }
    
    // =====================================
    // STEP 9: ONLY DEDUCT BALANCE IF PAYBETA IS SUCCESSFUL
    // =====================================
    const payBetaStatus = payBetaResponse.data.status; // Status is in data object
    
    // Debug: Log PayBeta response structure
    logger.info(`🔍 PayBeta Response Debug:`, {
      payBetaStatus,
      fullResponse: payBetaResponse,
      orderId: payBetaResponse.data.order_id,
      service: payBetaResponse.data.service_name
    });
    
    // Only deduct balance if PayBeta transaction is successful
    if (payBetaStatus === 'successful') {
      logger.info(`✅ PayBeta API succeeded (${payBetaStatus}), deducting balance for ${finalRequestId}`);
      
      try {
        await updateUserBalance(userId, currency, -amount);
        balanceDeducted = true;
        
        logger.info(`✅ Balance deducted immediately: -${amount} ${currency} for user ${userId}`);
        
      } catch (balanceError) {
      logger.error('CRITICAL: Balance deduction failed after successful PayBeta API call:', {
        request_id: finalRequestId,
        userId,
        currency,
        amount,
        error: balanceError.message,
        paybeta_order_id: ebillsResponse.data?.order_id
      });

      // Check if this is an insufficient balance error during deduction
      if (balanceError.message.includes('insufficient') || 
          balanceError.message.includes('balance') ||
          balanceError.message.toLowerCase().includes('ngnz')) {
        
        await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { 
          status: 'failed',
          processingErrors: [{
        error: `Insufficient NGNZ balance during deduction: ${balanceError.message}`,
        timestamp: new Date(),
        phase: 'balance_deduction',
        paybeta_order_id: payBetaResponse.data?.order_id
          }]
        });
        
        return res.status(400).json({
          success: false,
          error: 'INSUFFICIENT_NGNZ_BALANCE',
          message: 'NGNZ balance insufficient'
        });
      }
      
      await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { 
        status: 'failed',
        processingErrors: [{
        error: `Balance deduction failed after PayBeta success: ${balanceError.message}`,
        timestamp: new Date(),
        phase: 'balance_deduction',
        paybeta_order_id: payBetaResponse.data?.order_id
        }]
      });
      
      return res.status(500).json({
        success: false,
        error: 'BALANCE_UPDATE_FAILED',
        message: 'PayBeta transaction succeeded but balance deduction failed. Please contact support immediately.',
        details: {
          paybeta_order_id: payBetaResponse.data?.order_id,
          paybeta_status: payBetaResponse.data?.status,
          amount: amount,
          customer_id: customer_id
        }
      });
    }
    } else {
      // PayBeta was not successful, don't deduct balance
      logger.info(`❌ PayBeta API not successful (${payBetaStatus}), not deducting balance for ${finalRequestId}`);
      
      await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { 
        status: 'failed',
        processingErrors: [{
          error: `PayBeta transaction not successful: ${payBetaStatus}`,
          timestamp: new Date(),
          phase: 'paybeta_status_check'
        }]
      });
      
      return res.status(200).json({
        success: true,
        message: 'Cable TV purchase not successful',
        data: {
          order_id: payBetaResponse.data.order_id,
          status: payBetaResponse.data.status,
          service_name: service_id.toUpperCase(),
          customer_id: customer_id,
          request_id: finalRequestId,
          balance_action: 'not_deducted',
          payment_details: {
            currency: currency,
            ngnz_amount: amount,
            amount_usd: (amount * (1 / 1554.42)).toFixed(2)
          }
        }
      });
    }
    
    // Step 10: Update transaction with proper status mapping
    const finalStatus = payBetaStatus === 'successful' ? 'completed' : 'failed';
    const updateData = {
      orderId: payBetaResponse.data.order_id.toString(),
      status: finalStatus,
      productName: payBetaResponse.data.product_name || 'Cable TV',
      balanceCompleted: true,
      metaData: {
        ...initialTransactionData.metaData,
        service_name: payBetaResponse.data.service_name,
        customer_name: payBetaResponse.data.customer_name,
        discount: payBetaResponse.data.discount,
        amount_charged: payBetaResponse.data.amount_charged,
        balance_action_taken: true,
        balance_action_type: 'immediate_debit',
        balance_action_at: new Date(),
        paybeta_status: payBetaStatus,
        paybeta_transaction_id: payBetaResponse.data.order_id,
        paybeta_reference: payBetaResponse.data.reference,
        paybeta_initial_balance: payBetaResponse.data.initial_balance,
        paybeta_final_balance: payBetaResponse.data.final_balance
      }
    };
    
    const finalTransaction = await BillTransaction.findByIdAndUpdate(
      pendingTransaction._id,
      updateData,
      { new: true }
    );
    
    // Verify the database update worked
    logger.info(`📋 Transaction status updated: ${payBetaResponse.data.order_id} | ${finalStatus} | PayBeta: ${payBetaStatus} | Balance: immediate_debit`);
    logger.info(`📋 Database update verification:`, {
      transactionId: finalTransaction?._id,
      status: finalTransaction?.status,
      orderId: finalTransaction?.orderId,
      balanceCompleted: finalTransaction?.balanceCompleted
    });
    
    // Double-check by querying the database directly
    const verifyTransaction = await BillTransaction.findById(pendingTransaction._id);
    logger.info(`📋 Direct database verification:`, {
      id: verifyTransaction?._id,
      status: verifyTransaction?.status,
      orderId: verifyTransaction?.orderId,
      balanceCompleted: verifyTransaction?.balanceCompleted,
      billType: verifyTransaction?.billType,
      userId: verifyTransaction?.userId
    });
    
    logger.info(`📋 Transaction completed: ${payBetaResponse.data.order_id} | ${payBetaStatus} | Balance: immediate_debit | ${Date.now() - startTime}ms`);
    

    // Step 11: Return response - ONLY SUCCESS NOTIFICATION WHEN SUCCESSFUL
    if (payBetaStatus === 'successful') {
      // ✅ Send push notification
      try {
        const { sendUtilityPaymentNotification } = require('../services/notificationService');
        await sendUtilityPaymentNotification(
          userId,
          'CABLE_TV',
          amount,
          service_id.toUpperCase(),
          customer_id,
          {
            orderId: payBetaResponse.data.order_id?.toString(),
            requestId: finalRequestId,
            currency: 'NGNZ',
            transactionId: payBetaResponse.data.order_id?.toString()
          }
        );
        logger.info('Cable TV purchase notification sent', { 
          userId, 
          orderId: payBetaResponse.data.order_id 
        });
      } catch (notificationError) {
        logger.error('Failed to send cable TV purchase notification', {
          userId,
          orderId: payBetaResponse.data.order_id,
          error: notificationError.message
        });
      }

      // ✅ Send transaction email
      try {
        if (user.email) {
          await sendUtilityTransactionEmail(
            user.email,
            user.firstName || user.username || 'User',
            {
              utilityType: 'Cable TV Subscription',
              amount,
              currency,
              reference: payBetaResponse.data.order_id?.toString() || finalRequestId,
              status: 'COMPLETED',
              date: payBetaResponse.data.transaction_date || new Date(),
              recipientPhone: customer_id,
              provider: service_id.toUpperCase(),
              transactionId: payBetaResponse.data.order_id?.toString(),
              account: customer_id
            }
          );

          logger.info('Cable TV purchase email sent', {
            userId,
            email: user.email,
            orderId: payBetaResponse.data.order_id
          });
        } else {
          logger.warn('Skipping cable TV purchase email - no email on file', {
            userId
          });
        }
      } catch (emailError) {
        logger.error('Failed to send cable TV purchase email', {
          userId,
          email: user.email,
          error: emailError.message
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Cable TV purchase completed successfully',
        data: {
          order_id: payBetaResponse.data.order_id,
          status: payBetaResponse.data.status,
          service_name: service_id.toUpperCase(),
          customer_id: customer_id,
          customer_name: payBetaResponse.data.customerId,
          amount: payBetaResponse.data.amount,
          amount_charged: payBetaResponse.data.chargedAmount,
          request_id: finalRequestId,
          balance_action: 'deducted_on_success',
          payment_details: {
            currency: currency,
            ngnz_amount: amount,
            amount_usd: (amount * (1 / 1554.42)).toFixed(2)
          }
        }
      });
    } else if (['initiated-api', 'processing-api'].includes(payBetaStatus)) {
      return res.status(202).json({
        success: true,
        message: 'Cable TV purchase is being processed',
        data: {
          order_id: payBetaResponse.data.order_id,
          status: payBetaResponse.data.status,
          service_name: service_id.toUpperCase(),
          customer_id: customer_id,
          customer_name: payBetaResponse.data.customerId,
          amount: payBetaResponse.data.amount,
          amount_charged: payBetaResponse.data.amount_charged,
          request_id: finalRequestId,
          balance_action: 'updated_directly', // Changed from 'reserved' since we deduct immediately
          payment_details: {
            currency: currency,
            ngnz_amount: amount,
            amount_usd: (amount * (1 / 1554.42)).toFixed(2)
          }
        },
        note: 'Balance deducted immediately. You will receive a notification when the service is activated'
      });
    } else {
      return res.status(200).json({
        success: true,
        message: `Cable TV purchase status: ${payBetaStatus}`,
        data: {
          ...payBetaResponse.data,
          request_id: finalRequestId,
          balance_action: 'updated_directly',
          payment_details: {
            currency: currency,
            ngnz_amount: amount,
            amount_usd: (amount * (1 / 1554.42)).toFixed(2)
          }
        }
      });
    }
    
  } catch (error) {
    logger.error('Cable TV purchase unexpected error:', {
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      processingTime: Date.now() - startTime
    });

    // Check if the error is related to insufficient balance
    if (error.message && 
        (error.message.toLowerCase().includes('insufficient') || 
         error.message.toLowerCase().includes('balance') ||
         error.message.toLowerCase().includes('ngnz'))) {
      
      logger.info('Detected balance-related error in catch block', { 
        userId: req.user?.id, 
        error: error.message 
      });

      return res.status(400).json({
        success: false,
        error: 'INSUFFICIENT_NGNZ_BALANCE',
        message: 'NGNZ balance insufficient'
      });
    }

    // SIMPLIFIED CLEANUP: If balance was deducted but something failed, reverse it
    if (balanceDeducted) {
      try {
        await updateUserBalance(req.user.id, 'NGNZ', validation?.sanitized?.amount || 0); // Add back
        logger.info('🔄 Reversed balance deduction due to error');
      } catch (reverseError) {
        logger.error('❌ CRITICAL: Failed to reverse balance deduction after error:', reverseError.message);
      }
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
      message: 'An unexpected error occurred while processing your cable TV purchase'
    });
  }
});

/**
 * Cable TV customer verification endpoint
 * POST /verifycabletv/verify
 */
router.post('/verify', async (req, res) => {
  const startTime = Date.now();
  const requestId = `cable_verify_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    logger.info(`📺 Cable TV verification request:`, {
      requestId,
      userId: req.user?.id,
      body: req.body
    });

    const { service_id, customer_id } = req.body;
    
    // Validate required fields
    if (!service_id) {
      return res.status(400).json({
        success: false,
        message: 'Service ID is required'
      });
    }
    
    if (!customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer ID is required'
      });
    }
    
    // Validate service_id
    if (!CABLE_TV_SERVICES.includes(service_id.toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: `Invalid service ID. Must be one of: ${CABLE_TV_SERVICES.join(', ')}`
      });
    }
    
    logger.info(`🔍 [${requestId}] Verifying cable TV customer via PayBeta:`, {
      requestId,
      service_id,
      customer_id: customer_id?.substring(0, 4) + '***'
    });
    
    // Call PayBeta API for customer verification
    let payBetaResponse;
    try {
      // Check if PayBeta API key is configured
      if (!process.env.PAYBETA_API_KEY) {
        logger.error(`❌ [${requestId}] PayBeta API key not configured`);
        return res.status(503).json({
          success: false,
          error: 'SERVICE_CONFIGURATION_ERROR',
          message: 'Cable TV verification service is not properly configured. Please contact support.',
          requestId
        });
      }
      
      // Use PayBeta's customer verification endpoint
      const response = await payBetaAuth.makeRequest('POST', '/v2/cable/verify', {
        service: service_id.toLowerCase(),
        smartCardNumber: customer_id.trim()
      });
      
      payBetaResponse = response;
      
      logger.info(`📡 [${requestId}] PayBeta verification response:`, {
        requestId,
        status: response.status,
        message: response.message,
        hasData: !!response.data
      });
      
    } catch (apiError) {
      logger.error(`❌ [${requestId}] PayBeta verification failed:`, {
        requestId,
        service_id,
        customer_id: customer_id?.substring(0, 4) + '***',
        error: apiError.message,
        status: apiError.response?.status,
        payBetaError: apiError.response?.data,
        hasApiKey: !!process.env.PAYBETA_API_KEY
      });
      
      // Handle different error types
      if (apiError.message.includes('API key not configured') || 
          apiError.message.includes('authentication failed')) {
        return res.status(503).json({
          success: false,
          error: 'SERVICE_CONFIGURATION_ERROR',
          message: 'Cable TV verification service is not properly configured. Please contact support.',
          requestId
        });
      }
      
      if (apiError.message.includes('Customer not found') || 
          apiError.message.includes('Invalid customer')) {
        return res.status(404).json({
          success: false,
          error: 'CUSTOMER_NOT_FOUND',
          message: 'Customer not found or invalid customer details',
          details: {
            service_id,
            customer_id: customer_id?.substring(0, 4) + '***',
            requestId
          }
        });
      }
      
      if (apiError.message.includes('timeout')) {
        return res.status(504).json({
          success: false,
          error: 'VERIFICATION_TIMEOUT',
          message: 'Customer verification request timed out. Please try again.',
          requestId
        });
      }
      
      return res.status(500).json({
        success: false,
        error: 'VERIFICATION_API_ERROR',
        message: 'Customer verification service is temporarily unavailable',
        requestId
      });
    }
    
    // Process successful verification response
    if (payBetaResponse.status === 'successful') {
      const customerData = payBetaResponse.data;
      
      const enhancedResponse = {
        success: true,
        message: 'Cable TV customer verification successful',
        data: {
          customer_id: customer_id,
          service_id: service_id,
          customer_name: customerData.customerName || 'N/A',
          current_status: customerData.status || 'Unknown',
          current_bouquet: customerData.currentBouquet || 'N/A',
          renewal_amount: customerData.renewalAmount || 0,
          due_date: customerData.dueDate || null,
          balance: customerData.balance || 0,
          verified_at: new Date().toISOString(),
          requestId
        }
      };
      
      logger.info(`✅ [${requestId}] Cable TV verification completed successfully`, {
        requestId,
        service_id,
        customer_id: customer_id?.substring(0, 4) + '***',
        processingTime: `${Date.now() - startTime}ms`
      });
      
      return res.status(200).json(enhancedResponse);
    } else {
      return res.status(400).json({
        success: false,
        error: 'VERIFICATION_FAILED',
        message: payBetaResponse.message || 'Customer verification failed',
        details: {
          service_id,
          customer_id: customer_id?.substring(0, 4) + '***',
          requestId
        }
      });
    }
    
  } catch (error) {
    logger.error(`💀 [${requestId}] Cable TV verification unexpected error:`, {
      requestId,
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      processingTime: `${Date.now() - startTime}ms`
    });
    
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred during customer verification',
      requestId
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
