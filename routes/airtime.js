// routes/airtime.js
const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { vtuAuth } = require('../auth/billauth');
const { payBetaAuth } = require('../auth/paybetaAuth');
const { validateUserBalance } = require('../services/balance');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const logger = require('../utils/logger');

const { sendAirtimePurchaseNotification } = require('../services/notificationService');

const router = express.Router();

// Test PayBeta connection endpoint
router.get('/test-paybeta', async (req, res) => {
  try {
    const testResult = await payBetaAuth.testConnection();
    res.json({
      success: testResult.success,
      message: testResult.message || 'PayBeta connection test completed',
      authenticated: testResult.authenticated,
      error: testResult.error,
      suggestion: testResult.suggestion
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'PayBeta test failed',
      error: error.message
    });
  }
});

// Cache for user data to avoid repeated DB queries
const userCache = new Map();
const CACHE_TTL = 30000; // 30 seconds

// Supported tokens
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
  
  const user = await User.findById(userId).select(
    'twoFASecret is2FAEnabled passwordpin ngnzBalance lastBalanceUpdate email firstName username'
  ).lean();
  
  if (user) {
    userCache.set(cacheKey, { user, timestamp: Date.now() });
    setTimeout(() => userCache.delete(cacheKey), CACHE_TTL);
  }
  
  return user;
}

/**
 * Direct balance update
 */
async function updateUserBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number') {
    throw new Error('Invalid parameters for balance update');
  }
  
  try {
    const currencyUpper = currency.toUpperCase();
    
    if (!SUPPORTED_TOKENS[currencyUpper]) {
      throw new Error(`Unsupported currency: ${currencyUpper}`);
    }
    
    const currencyLower = TOKEN_FIELD_MAPPING[currencyUpper];
    const balanceField = `${currencyLower}Balance`;
    
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
 * Compare password pin
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
 * Validate airtime request
 */
function validateAirtimeRequest(body) {
  const errors = [];
  const sanitized = {};
  
  if (!body.phone) {
    errors.push('Phone number is required');
  } else {
    sanitized.phone = String(body.phone).trim();
    if (!validatePhoneNumber(sanitized.phone)) {
      errors.push('Invalid phone number format');
    }
  }
  
  if (!body.service_id) {
    errors.push('Service ID is required');
  } else {
    sanitized.service_id = String(body.service_id).toLowerCase().trim();
    if (!['mtn', 'airtel', 'glo', '9mobile'].includes(sanitized.service_id)) {
      errors.push('Invalid service ID. Must be: mtn, airtel, glo, or 9mobile');
    }
  }
  
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
      
      const minAmount = 50;
      const maxAmount = 50000;
      if (sanitized.amount < minAmount) {
        errors.push(`Amount below minimum. Minimum airtime purchase is ${minAmount} NGNZ`);
      }
      if (sanitized.amount > maxAmount) {
        errors.push(`Amount above maximum. Maximum airtime purchase is ${maxAmount} NGNZ`);
      }
    }
  }
  
  if (!body.twoFactorCode?.trim()) {
    errors.push('Two-factor authentication code is required');
  } else {
    sanitized.twoFactorCode = String(body.twoFactorCode).trim();
  }
  
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
 * Call eBills API
 */
async function callEBillsAPI({ phone, amount, service_id, request_id, userId }) {
  try {
    const payload = { phone, amount, service_id, request_id };

    logger.info('Making eBills airtime purchase request:', {
      phone, amount, service_id, request_id, endpoint: '/api/v2/airtime'
    });

    const response = await vtuAuth.makeRequest('POST', '/api/v2/airtime', payload, {
      timeout: 25000
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
    logger.error('❌ eBills airtime purchase failed:', {
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
 * Call PayBeta API
 */
async function callPayBetaAPI({ phone, amount, service_id, request_id, userId }) {
  try {
    // Map service_id to PayBeta format
    const serviceMapping = {
      'mtn': 'mtn_vtu',
      'airtel': 'airtel_vtu', 
      'glo': 'glo_vtu',
      '9mobile': '9mobile_vtu'
    };

    const payBetaService = serviceMapping[service_id];
    if (!payBetaService) {
      throw new Error(`Unsupported service for PayBeta: ${service_id}`);
    }

    const payload = {
      service: payBetaService,
      phoneNumber: phone,
      amount: Math.round(amount), // PayBeta expects integer
      reference: request_id
    };

    logger.info('Making PayBeta airtime purchase request:', {
      phone, amount, service_id, payBetaService, request_id, endpoint: '/v2/airtime/purchase'
    });

    const response = await payBetaAuth.makeRequest('POST', '/v2/airtime/purchase', payload, {
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
        previousBalance: response.data.previousBalance,
        currentBalance: response.data.currentBalance,
        transactionDate: response.data.transactionDate
      }
    };

  } catch (error) {
    logger.error('❌ PayBeta airtime purchase failed:', {
      request_id, userId, error: error.message,
      status: error.response?.status,
      payBetaError: error.response?.data
    });

    if (error.message.includes('API key not configured')) {
      throw new Error('PayBeta API key not configured. Please contact support.');
    }
    if (error.message.includes('authentication failed')) {
      throw new Error('PayBeta authentication failed. Please contact support.');
    }
    if (error.message.includes('validation error')) {
      throw new Error(`PayBeta validation error: ${error.message}`);
    }

    throw new Error(`PayBeta API error: ${error.message}`);
  }
}

/**
 * AIRTIME PURCHASE ENDPOINT - ONLY SUCCESS/FAILURE NOTIFICATIONS
 */
router.post('/purchase', async (req, res) => {
  const startTime = Date.now();
  let balanceDeducted = false;
  let transactionCreated = false;
  let pendingTransaction = null;
  let ebillsResponse = null;
  let validation;

  try {
    const requestBody = req.body;
    const userId = req.user.id;
    
    logger.info(`📱 Airtime purchase request from user ${userId}:`, {
      ...requestBody,
      passwordpin: '[REDACTED]'
    });
    
    // Step 1: Validate request
    validation = validateAirtimeRequest(requestBody);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors
      });
    }
    
    const { phone, service_id, amount, twoFactorCode, passwordpin } = validation.sanitized;
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

    // 2FA validation
    if (!user.twoFASecret || !user.is2FAEnabled) {
      return res.status(400).json({
        success: false,
        message: 'Two-factor authentication is not set up or not enabled. Please enable 2FA first.'
      });
    }

    if (!validateTwoFactorAuth(user, twoFactorCode)) {
      logger.warn('🚫 2FA validation failed for airtime purchase', { 
        userId, errorType: 'INVALID_2FA'
      });
      return res.status(401).json({
        success: false,
        error: 'INVALID_2FA_CODE',
        message: 'Invalid two-factor authentication code'
      });
    }

    logger.info('✅ 2FA validation successful for airtime purchase', { userId });

    // Password PIN validation
    if (!user.passwordpin) {
      return res.status(400).json({
        success: false,
        message: 'Password PIN is not set up for your account. Please set up your password PIN first.'
      });
    }

    const isPasswordPinValid = await comparePasswordPin(passwordpin, user.passwordpin);
    if (!isPasswordPinValid) {
      logger.warn('🚫 Password PIN validation failed for airtime purchase', { 
        userId, errorType: 'INVALID_PASSWORDPIN'
      });
      return res.status(401).json({
        success: false,
        error: 'INVALID_PASSWORDPIN',
        message: 'Invalid password PIN'
      });
    }

    logger.info('✅ Password PIN validation successful for airtime purchase', { userId });

    
    // Step 5: Generate unique IDs
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const finalRequestId = `${userId}_${timestamp}_${randomSuffix}`;
    const uniqueOrderId = `pending_${userId}_${timestamp}`;
    
    // Step 6: Final balance check
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

    // Step 7: Create transaction record
    const initialTransactionData = {
      orderId: uniqueOrderId,
      status: 'initiated-api',
      productName: 'Airtime',
      billType: 'airtime',
      quantity: 1,
      amount: amount,
      amountNaira: amount,
      paymentCurrency: currency,
      requestId: finalRequestId,
      metaData: {
        phone,
        network: service_id.toUpperCase(),
        service_id,
        user_id: userId,
        payment_currency: currency,
        ngnz_amount: amount,
        exchange_rate: 1,
        twofa_validated: true,
        passwordpin_validated: true,
        is_ngnz_transaction: true
      },
      network: service_id.toUpperCase(),
      customerPhone: phone,
      userId: userId,
      timestamp: new Date(),
      twoFactorValidated: true,
      passwordPinValidated: true,
    };
    
    pendingTransaction = await BillTransaction.create(initialTransactionData);
    transactionCreated = true;
    
    logger.info(`📋 Bill transaction ${uniqueOrderId}: initiated-api | airtime | ${amount} NGNZ | ✅ 2FA | ✅ PIN | PayBeta`);
    
    // Step 8: Call PayBeta API
    try {
      ebillsResponse = await callPayBetaAPI({
        phone, amount, service_id,
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
      
      // ✅ SEND FAILURE NOTIFICATION
      try {
        await sendAirtimePurchaseNotification(
          userId,
          amount,
          service_id,
          phone,
          'failed',
          {
            requestId: finalRequestId,
            error: apiError.message,
            currency: 'NGNZ'
          }
        );
        logger.info('Airtime purchase failure notification sent', { userId, requestId: finalRequestId });
      } catch (notificationError) {
        logger.error('Failed to send airtime failure notification', {
          userId,
          error: notificationError.message
        });
      }
      
      return res.status(500).json({
        success: false,
        error: 'EBILLS_API_ERROR',
        message: apiError.message
      });
    }
    
    // Step 9: Deduct balance
    const ebillsStatus = ebillsResponse.data.status;
    
    logger.info(`✅ eBills API succeeded (${ebillsStatus}), deducting balance immediately for ${finalRequestId}`);
    
    try {
      await updateUserBalance(userId, currency, -amount);
      balanceDeducted = true;
      
      logger.info(`✅ Balance deducted immediately: -${amount} ${currency} for user ${userId}`);
      
    } catch (balanceError) {
      logger.error('CRITICAL: Balance deduction failed after successful eBills API call:', {
        request_id: finalRequestId,
        userId,
        currency,
        amount,
        error: balanceError.message,
        ebills_order_id: ebillsResponse.data?.order_id
      });

      if (balanceError.message.includes('insufficient') || 
          balanceError.message.includes('balance') ||
          balanceError.message.toLowerCase().includes('ngnz')) {
        
        await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { 
          status: 'failed',
          processingErrors: [{
            error: `Insufficient NGNZ balance during deduction: ${balanceError.message}`,
            timestamp: new Date(),
            phase: 'balance_deduction',
            ebills_order_id: ebillsResponse.data?.order_id
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
          error: `Balance deduction failed after eBills success: ${balanceError.message}`,
          timestamp: new Date(),
          phase: 'balance_deduction',
          ebills_order_id: ebillsResponse.data?.order_id
        }]
      });
      
      return res.status(500).json({
        success: false,
        error: 'BALANCE_UPDATE_FAILED',
        message: 'eBills transaction succeeded but balance deduction failed. Please contact support immediately.',
        details: {
          ebills_order_id: ebillsResponse.data?.order_id,
          ebills_status: ebillsResponse.data?.status,
          amount: amount,
          phone: phone
        }
      });
    }
    
    // Step 10: Update transaction
    const updateData = {
      orderId: ebillsResponse.data.order_id.toString(),
      status: ebillsResponse.data.status,
      productName: ebillsResponse.data.product_name,
      balanceCompleted: true,
      metaData: {
        ...initialTransactionData.metaData,
        service_name: ebillsResponse.data.service_name,
        amount_charged: ebillsResponse.data.amount_charged,
        balance_action_taken: true,
        balance_action_type: 'immediate_debit',
        balance_action_at: new Date(),
        ebills_initial_balance: ebillsResponse.data.initial_balance,
        ebills_final_balance: ebillsResponse.data.final_balance
      }
    };
    
    const finalTransaction = await BillTransaction.findByIdAndUpdate(
      pendingTransaction._id,
      updateData,
      { new: true }
    );
    
    logger.info(`📋 Transaction completed: ${ebillsResponse.data.order_id} | ${ebillsStatus} | Balance: immediate_debit | ${Date.now() - startTime}ms`);
    

    // Step 11: Return response - ONLY NOTIFICATION ON SUCCESS
    if (ebillsStatus === 'completed-api') {
      
      // ✅ SEND SUCCESS NOTIFICATION
      try {
        await sendAirtimePurchaseNotification(
          userId,
          amount,
          service_id,
          phone,
          'completed',
          {
            orderId: ebillsResponse.data.order_id.toString(),
            requestId: finalRequestId,
            serviceName: ebillsResponse.data.service_name,
            currency: 'NGNZ'
          }
        );
        
        logger.info('Airtime purchase notification sent (completed)', { 
          userId, 
          orderId: ebillsResponse.data.order_id 
        });
      } catch (notificationError) {
        logger.error('Failed to send airtime purchase notification', {
          userId,
          orderId: ebillsResponse.data.order_id,
          error: notificationError.message
        });
      }
      
      return res.status(200).json({
        success: true,
        message: 'Airtime purchase completed successfully',
        data: {
          order_id: ebillsResponse.data.order_id,
          status: ebillsResponse.data.status,
          phone: ebillsResponse.data.phone,
          amount: ebillsResponse.data.amount,
          service_name: ebillsResponse.data.service_name,
          request_id: finalRequestId,
          balance_action: 'updated_directly',
          payment_details: {
            currency: currency,
            ngnz_amount: amount,
            amount_usd: (amount * (1 / 1554.42)).toFixed(2)
          }
        }
      });
    } else if (['initiated-api', 'processing-api'].includes(ebillsStatus)) {
      
      // ❌ NO NOTIFICATION FOR PROCESSING
      
      return res.status(202).json({
        success: true,
        message: 'Airtime purchase is being processed',
        data: {
          order_id: ebillsResponse.data.order_id,
          status: ebillsResponse.data.status,
          phone: ebillsResponse.data.phone,
          amount: ebillsResponse.data.amount,
          service_name: ebillsResponse.data.service_name,
          request_id: finalRequestId,
          balance_action: 'updated_directly',
          payment_details: {
            currency: currency,
            ngnz_amount: amount,
            amount_usd: (amount * (1 / 1554.42)).toFixed(2)
          }
        },
        note: 'Balance deducted immediately. You will receive a notification when the transaction is completed'
      });
    } else {
      return res.status(200).json({
        success: true,
        message: `Airtime purchase status: ${ebillsStatus}`,
        data: {
          ...ebillsResponse.data,
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
    logger.error('Airtime purchase unexpected error:', {
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      processingTime: Date.now() - startTime
    });

    if (error.message && 
        (error.message.toLowerCase().includes('insufficient') || 
         error.message.toLowerCase().includes('balance') ||
         error.message.toLowerCase().includes('ngnz'))) {
      
      return res.status(400).json({
        success: false,
        error: 'INSUFFICIENT_NGNZ_BALANCE',
        message: 'NGNZ balance insufficient'
      });
    }

    // Cleanup
    if (balanceDeducted) {
      try {
        await updateUserBalance(req.user.id, 'NGNZ', validation?.sanitized?.amount || 0);
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
      message: 'An unexpected error occurred while processing your airtime purchase'
    });
  }
});

// Clean up cache
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of userCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL) {
      userCache.delete(key);
    }
  }
}, 60000);

module.exports = router;