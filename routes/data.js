// routes/data.js
const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { vtuAuth } = require('../auth/billauth');
const { payBetaAuth } = require('../auth/paybetaAuth');
const { validateUserBalance } = require('../services/balance');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { sendAirtimePurchaseNotification } = require('../services/notificationService');
const { sendUtilityTransactionEmail } = require('../services/EmailService');
const logger = require('../utils/logger');

const router = express.Router();

// Cache for user data to avoid repeated DB queries
const userCache = new Map();
const CACHE_TTL = 30000; // 30 seconds

// Valid data service providers
const DATA_SERVICES = ['mtn', 'glo', 'airtel', '9mobile'];

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
  
  // include email/firstName/username so we can email the user
  const user = await User.findById(userId).select(
    'twoFASecret is2FAEnabled passwordpin ngnzBalance lastBalanceUpdate email firstName username'
  ).lean();
  
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
 * Validate phone number format according to PayBeta API specs
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
 * Sanitize and validate data request body
 */
function validateDataRequest(body) {
  const errors = [];
  const sanitized = {};
  
  // Phone validation
  if (!body.phone) {
    errors.push('Phone number is required');
  } else {
    sanitized.phone = String(body.phone).trim();
    if (!validatePhoneNumber(sanitized.phone)) {
      errors.push('Invalid phone number format');
    }
  }
  
  // Service ID validation
  if (!body.service_id) {
    errors.push('Service ID is required');
  } else {
    sanitized.service_id = String(body.service_id).toLowerCase().trim();
    if (!DATA_SERVICES.includes(sanitized.service_id)) {
      errors.push('Invalid service ID. Must be: mtn, airtel, glo, or 9mobile');
    }
  }
  
  // Variation ID validation (data plan)
  if (!body.variation_id) {
    errors.push('Variation ID (data plan) is required');
  } else {
    sanitized.variation_id = String(body.variation_id).trim();
    if (sanitized.variation_id.length === 0) {
      errors.push('Variation ID must be a non-empty string');
    }
  }
  
  // Amount validation - UPDATED: Minimum changed to ₦50 and references NGNZ
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
      
      const minAmount = 99; // UPDATED: Minimum changed from 100 to 99
      const maxAmount = 50000;
      if (sanitized.amount < minAmount) {
        errors.push(`Amount below minimum. Minimum data purchase is ${minAmount} NGNZ`);
      }
      if (sanitized.amount > maxAmount) {
        errors.push(`Amount above maximum. Maximum data purchase is ${maxAmount} NGNZ`);
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
 * Call PayBeta API for data purchase
 */
async function callEBillsAPI({ phone, amount, service_id, variation_id, request_id, userId }) {
  try {
    const payload = { 
      phone, 
      amount: parseInt(amount), 
      service_id, 
      variation_id, 
      request_id 
    };

    logger.info('Making PayBeta data purchase request:', {
      phone, amount, service_id, variation_id, request_id, endpoint: '/v2/data-bundle/purchase'
    });

    const response = await vtuAuth.makeRequest('POST', '/api/v2/data', payload, {
      timeout: 25000 // Reduced from 45s for faster failure
    });

    logger.info(`PayBeta API response for ${request_id}:`, {
      code: response.code,
      message: response.message,
      status: response.data?.status,
      order_id: response.data?.order_id
    });

    if (response.code !== 'success') {
      throw new Error(`PayBeta API error: ${response.message || 'Unknown error'}`);
    }

    return response;

  } catch (error) {
    logger.error('❌ PayBeta data purchase failed:', {
      request_id, userId, error: error.message,
      status: error.response?.status,
      payBetaError: error.response?.data
    });

    if (error.message.includes('IP Address')) {
      throw new Error('IP address not whitelisted with PayBeta. Please contact support.');
    }
    if (error.message.includes('insufficient')) {
      throw new Error('Insufficient balance with PayBeta provider. Please contact support.');
    }
    if (error.response?.status === 422) {
      const validationErrors = error.response.data?.errors || {};
      const errorMessages = Object.values(validationErrors).flat();
      throw new Error(`Validation error: ${errorMessages.join(', ')}`);
    }

    throw new Error(`PayBeta API error: ${error.message}`);
  }
}

/**
 * Call PayBeta API for data purchase
 */
async function callPayBetaAPI({ phone, amount, service_id, variation_id, request_id, userId }) {
  try {
    // Map service_id to PayBeta format
    const serviceMapping = {
      'mtn': 'mtn_data',
      'airtel': 'airtel_data', 
      'glo': 'glo_data',
      '9mobile': '9mobile_data'
    };

    const payBetaService = serviceMapping[service_id];
    if (!payBetaService) {
      throw new Error(`Unsupported service for PayBeta: ${service_id}`);
    }

    // Ensure reference is under 40 characters for PayBeta
    const payBetaReference = request_id.length > 40 ? 
      request_id.substring(0, 40) : request_id;

    const payload = {
      service: payBetaService,
      amount: Math.round(amount), // PayBeta expects integer
      phoneNumber: phone.trim(),
      code: variation_id,
      reference: payBetaReference
    };

    logger.info('Making PayBeta data purchase request:', {
      phone, service_id, variation_id, amount, request_id, endpoint: '/v2/data-bundle/purchase',
      payload: payload
    });

    const response = await payBetaAuth.makeRequest('POST', '/v2/data-bundle/purchase', payload, {
      timeout: 60000 // Increased to 60 seconds
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

    // Transform PayBeta response to match internal format for consistency
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
    logger.error('❌ PayBeta data purchase failed:', {
      request_id, userId, error: error.message,
      status: error.response?.status,
      payBetaError: error.response?.data,
      errorCode: error.code
    });

    if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
      throw new Error('PayBeta API request timed out. The service may be slow. Please try again.');
    }
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
 * STREAMLINED data purchase endpoint - ATOMIC IMMEDIATE DEBIT
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
    
    logger.info(`📊 Data purchase request from user ${userId}:`, {
      ...requestBody,
      passwordpin: '[REDACTED]'
    });
    
    // Step 1: Validate request
    validation = validateDataRequest(requestBody);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors
      });
    }
    
    const { phone, service_id, variation_id, amount, twoFactorCode, passwordpin } = validation.sanitized;
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
      logger.warn('🚫 2FA validation failed for data purchase', { 
        userId, errorType: 'INVALID_2FA'
      });
      return res.status(401).json({
        success: false,
        error: 'INVALID_2FA_CODE',
        message: 'Invalid two-factor authentication code'
      });
    }

    logger.info('✅ 2FA validation successful for data purchase', { userId });

    // Step 3: Validate password pin
    if (!user.passwordpin) {
      return res.status(400).json({
        success: false,
        message: 'Password PIN is not set up for your account. Please set up your password PIN first.'
      });
    }

    const isPasswordPinValid = await comparePasswordPin(passwordpin, user.passwordpin);
    if (!isPasswordPinValid) {
      logger.warn('🚫 Password PIN validation failed for data purchase', { 
        userId, errorType: 'INVALID_PASSWORDPIN'
      });
      return res.status(401).json({
        success: false,
        error: 'INVALID_PASSWORDPIN',
        message: 'Invalid password PIN'
      });
    }

    logger.info('✅ Password PIN validation successful for data purchase', { userId });

    
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
      productName: 'Data',
      billType: 'data',
      quantity: 1,
      amount: amount,
      amountNaira: amount,
      paymentCurrency: currency,
      requestId: finalRequestId,
      metaData: {
        phone,
        network: service_id.toUpperCase(),
        service_id,
        variation_id,
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
      customerInfo: {
        phone,
        network: service_id,
        variation_id
      },
      userId: userId,
      timestamp: new Date(),
      twoFactorValidated: true,
      passwordPinValidated: true,
    };
    
    pendingTransaction = await BillTransaction.create(initialTransactionData);
    transactionCreated = true;
    
    logger.info(`📋 Bill transaction ${uniqueOrderId}: initiated-api | data | ${amount} NGNZ | ✅ 2FA | ✅ PIN`);
    
    // Step 8: Call PayBeta API first
    try {
      payBetaResponse = await callPayBetaAPI({
        phone, amount, service_id, variation_id,
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
      biller: payBetaResponse.data.biller
    });
    
    // Only deduct balance if PayBeta transaction is successful
    if (payBetaStatus === 'successful') {
      logger.info(`✅ PayBeta API succeeded (${payBetaStatus}), deducting balance for ${finalRequestId}`);
      
      try {
        await updateUserBalance(userId, currency, -amount);
        balanceDeducted = true;
        
        logger.info(`✅ Balance deducted: -${amount} ${currency} for user ${userId}`);
        
      } catch (balanceError) {
        logger.error('CRITICAL: Balance deduction failed after successful PayBeta API call:', {
          request_id: finalRequestId,
          userId,
          currency,
          amount,
          error: balanceError.message,
          paybeta_order_id: payBetaResponse.data?.order_id
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
            phone: phone
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
          phase: 'paybeta_response',
          paybeta_order_id: payBetaResponse.data?.order_id
        }]
      });
      
      return res.status(500).json({
        success: false,
        error: 'PAYBETA_TRANSACTION_FAILED',
        message: `PayBeta transaction not successful: ${payBetaStatus}`,
        details: {
          paybeta_order_id: payBetaResponse.data?.order_id,
          paybeta_status: payBetaResponse.data?.status,
          amount: amount,
          phone: phone
        }
      });
    }
    
    // Step 10: Update transaction with proper status mapping
    const finalStatus = payBetaStatus === 'successful' ? 'completed' : 'failed';
    const updateData = {
      orderId: payBetaResponse.data.order_id.toString(),
      status: finalStatus,
      productName: payBetaResponse.data.biller || 'Data',
      balanceCompleted: true, // Always true since we deduct immediately
      metaData: {
        ...initialTransactionData.metaData,
        service_name: payBetaResponse.data.biller,
        amount_charged: payBetaResponse.data.chargedAmount,
        balance_action_taken: true,
        balance_action_type: 'immediate_debit',
        balance_action_at: new Date(),
        paybeta_status: payBetaStatus,
        paybeta_transaction_id: payBetaResponse.data.order_id,
        paybeta_reference: payBetaResponse.data.reference,
        paybeta_commission: payBetaResponse.data.commission,
        paybeta_customer_id: payBetaResponse.data.customerId,
        paybeta_transaction_date: payBetaResponse.data.transactionDate
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
    
    logger.info(`📋 Transaction completed: ${payBetaResponse.data.order_id} | ${payBetaStatus} | Balance: immediate_debit | ${Date.now() - startTime}ms`);
    

    // Step 11: Return response - ONLY SUCCESS WHEN PAYBETA IS SUCCESSFUL
    if (payBetaStatus === 'successful') {
      
      // ✅ SEND SUCCESS NOTIFICATION
      try {
        await sendAirtimePurchaseNotification(
          userId,
          amount,
          service_id,
          phone,
          'completed',
          {
            orderId: payBetaResponse.data.order_id.toString(),
            requestId: finalRequestId,
            serviceName: payBetaResponse.data.biller,
            currency: 'NGNZ',
            productType: 'DATA'
          }
        );
        
        logger.info('Data purchase notification sent (completed)', { 
          userId, 
          orderId: payBetaResponse.data.order_id 
        });
      } catch (notificationError) {
        logger.error('Failed to send data purchase notification', {
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
              utilityType: 'Data Purchase',
              amount,
              currency,
              reference: payBetaResponse.data.order_id?.toString() || finalRequestId,
              status: 'COMPLETED',
              date: payBetaResponse.data.transactionDate || new Date(),
              recipientPhone: phone,
              provider: payBetaResponse.data.biller || service_id.toUpperCase(),
              transactionId: payBetaResponse.data.order_id?.toString(),
              account: phone
            }
          );

          logger.info('Data purchase email sent', {
            userId,
            email: user.email,
            orderId: payBetaResponse.data.order_id
          });
        } else {
          logger.warn('Skipping data purchase email - no email on file', {
            userId
          });
        }
      } catch (emailError) {
        logger.error('Failed to send data purchase email', {
          userId,
          email: user.email,
          error: emailError.message
        });
      }
      
      return res.status(200).json({
        success: true,
        message: 'Data purchase completed successfully',
        data: {
          order_id: payBetaResponse.data.order_id,
          status: payBetaResponse.data.status,
          phone: payBetaResponse.data.customerId,
          amount: payBetaResponse.data.amount,
          service_name: payBetaResponse.data.biller,
          request_id: finalRequestId,
          balance_action: 'deducted_on_success',
          payment_details: {
            currency: currency,
            ngnz_amount: amount,
            amount_usd: (amount * (1 / 1554.42)).toFixed(2)
          }
        }
      });
    } else {
      // This should not happen since we already handled non-successful cases above
      return res.status(200).json({
        success: true,
        message: `Data purchase status: ${payBetaStatus}`,
        data: {
          ...payBetaResponse.data,
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
    
  } catch (error) {
    logger.error('Data purchase unexpected error:', {
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
      message: 'An unexpected error occurred while processing your data purchase'
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
