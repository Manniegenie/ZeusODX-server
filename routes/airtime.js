// routes/airtime.js
const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { vtuAuth } = require('../auth/billauth');
const { validateUserBalance } = require('../services/balance');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { validateTransactionLimit } = require('../services/kyccheckservice');
const logger = require('../utils/logger');

const { sendUtilityTransactionEmail } = require('../services/EmailService'); // <-- new import

const router = express.Router();

// Cache for user data to avoid repeated DB queries
const userCache = new Map();
const CACHE_TTL = 30000; // 30 seconds

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
  
  const user = await User.findById(userId).select(
    'twoFASecret is2FAEnabled passwordpin ngnzBalance lastBalanceUpdate email firstName username'
  ).lean(); // Use lean() for better performance, include email/name fields
  
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
 * Validate phone number format according to eBills API specs
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
 * Sanitize and validate airtime request body
 */
function validateAirtimeRequest(body) {
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
    if (!['mtn', 'airtel', 'glo', '9mobile'].includes(sanitized.service_id)) {
      errors.push('Invalid service ID. Must be: mtn, airtel, glo, or 9mobile');
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
      
      const minAmount = 50; // UPDATED: Minimum changed from 100 to 50
      const maxAmount = 50000;
      if (sanitized.amount < minAmount) {
        errors.push(`Amount below minimum. Minimum airtime purchase is ${minAmount} NGNZ`); // UPDATED: NGNB to NGNZ
      }
      if (sanitized.amount > maxAmount) {
        errors.push(`Amount above maximum. Maximum airtime purchase is ${maxAmount} NGNZ`); // UPDATED: NGNB to NGNZ
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
  
  sanitized.payment_currency = 'NGNZ'; // UPDATED: NGNB to NGNZ
  
  return {
    isValid: errors.length === 0,
    errors,
    sanitized
  };
}

/**
 * Call eBills API for airtime purchase
 */
async function callEBillsAPI({ phone, amount, service_id, request_id, userId }) {
  try {
    const payload = { phone, amount, service_id, request_id };

    logger.info('Making eBills airtime purchase request:', {
      phone, amount, service_id, request_id, endpoint: '/api/v2/airtime'
    });

    const response = await vtuAuth.makeRequest('POST', '/api/v2/airtime', payload, {
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
 * STREAMLINED airtime purchase endpoint - ATOMIC IMMEDIATE DEBIT
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
    
    // Step 2: Get user data (with caching) and run validations in parallel
    const [user, kycValidation] = await Promise.all([
      getCachedUser(userId),
      validateTransactionLimit(userId, amount, 'NGNZ', 'AIRTIME')
    ]);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Step 2.1: EARLY BALANCE CHECK - Check balance immediately after getting user
    const availableBalance = user.ngnzBalance || 0;
    if (availableBalance < amount) {
      logger.info(`Insufficient NGNZ balance for user ${userId}: Available=${availableBalance}, Required=${amount}`);
      return res.status(400).json({
        success: false,
        error: 'INSUFFICIENT_NGNZ_BALANCE',
        message: `Insufficient NGNZ balance. Available: ₦${availableBalance.toLocaleString()}, Required: ₦${amount.toLocaleString()}`,
        details: {
          availableBalance,
          requiredAmount: amount,
          currency: currency,
          shortfall: amount - availableBalance
        }
      });
    }

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

    // Step 3: Validate password pin
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

    // Step 4: KYC validation
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
      logger.info(`Final balance check failed for user ${userId}: Available=${currentBalance}, Required=${amount}`);
      return res.status(400).json({
        success: false,
        error: 'INSUFFICIENT_NGNZ_BALANCE',
        message: `Insufficient NGNZ balance. Available: ₦${currentBalance.toLocaleString()}, Required: ₦${amount.toLocaleString()}`,
        details: {
          availableBalance: currentBalance,
          requiredAmount: amount,
          currency: currency,
          shortfall: amount - currentBalance
        }
      });
    }

    // Step 7: Create minimal transaction record
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
        kyc_validated: true,
        is_ngnz_transaction: true
      },
      network: service_id.toUpperCase(),
      customerPhone: phone,
      userId: userId,
      timestamp: new Date(),
      twoFactorValidated: true,
      passwordPinValidated: true,
      kycValidated: true
    };
    
    pendingTransaction = await BillTransaction.create(initialTransactionData);
    transactionCreated = true;
    
    logger.info(`📋 Bill transaction ${uniqueOrderId}: initiated-api | airtime | ${amount} NGNZ | ✅ 2FA | ✅ PIN | ✅ KYC`);
    
    // Step 8: Call eBills API
    try {
      ebillsResponse = await callEBillsAPI({
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
      
      return res.status(500).json({
        success: false,
        error: 'EBILLS_API_ERROR',
        message: apiError.message
      });
    }
    
    // =====================================
    // STEP 9: ATOMIC IMMEDIATE DEBIT ON API SUCCESS
    // =====================================
    const ebillsStatus = ebillsResponse.data.status;
    
    // Deduct balance immediately regardless of eBills status (as long as API call succeeded)
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
            ebills_order_id: ebillsResponse.data?.order_id
          }]
        });
        
        return res.status(400).json({
          success: false,
          error: 'INSUFFICIENT_NGNZ_BALANCE',
          message: 'Insufficient NGNZ balance to complete the transaction. Your balance may have changed during processing.',
          details: {
            ebills_order_id: ebillsResponse.data?.order_id,
            ebills_status: ebillsResponse.data?.status,
            amount: amount,
            currency: 'NGNZ'
          }
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
    
    // Step 10: Update transaction with eBills response
    const updateData = {
      orderId: ebillsResponse.data.order_id.toString(),
      status: ebillsResponse.data.status,
      productName: ebillsResponse.data.product_name,
      balanceCompleted: true, // Always true since we deduct immediately
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
    
    // -------------------------------
    // SEND UTILITY EMAIL (non-blocking)
    // -------------------------------
    try {
      if (user && user.email) {
        const emailOptions = {
          utilityType: 'Airtime',
          amount,
          currency,
          reference: finalRequestId,
          status: ebillsStatus,
          date: new Date().toLocaleString(),
          recipientPhone: phone,
          provider: service_id.toUpperCase(),
          transactionId: ebillsResponse.data.order_id ? String(ebillsResponse.data.order_id) : '',
          account: phone,
          additionalNote: ebillsStatus === 'completed-api' ? 'Airtime delivered successfully' : 'Airtime purchase is being processed',
          webUrl: `${process.env.APP_WEB_BASE_URL || ''}/transactions/${finalRequestId}`,
          appDeepLink: `${process.env.APP_DEEP_LINK || 'zeusodx://'}//transactions/${finalRequestId}`
        };

        await sendUtilityTransactionEmail(user.email, user.firstName || user.username || 'User', emailOptions);
        logger.info(`Utility email (Airtime) sent to ${user.email} for request ${finalRequestId}`);
      } else {
        logger.warn(`No email on file for user ${userId} — skipping utility email`);
      }
    } catch (emailErr) {
      logger.error('Failed to send utility email for airtime transaction', {
        userId,
        error: emailErr.message,
        stack: emailErr.stack
      });
      // don't fail the request — email errors are non-blocking
    }

    // Step 11: Return response based on status - MAINTAINING ORIGINAL RESPONSE STRUCTURE
    if (ebillsStatus === 'completed-api') {
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
        message: 'Insufficient NGNZ balance to complete the airtime purchase',
        details: {
          currency: 'NGNZ',
          requestedAmount: validation?.sanitized?.amount
        }
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
      message: 'An unexpected error occurred while processing your airtime purchase'
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
