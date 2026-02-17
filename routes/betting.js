// routes/betting.js
const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { vtuAuth } = require('../auth/billauth');
const { payBetaAuth } = require('../auth/paybetaAuth');
const { validateUserBalance } = require('../services/balance');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { validateTransactionLimit } = require('../services/kyccheckservice');
const logger = require('../utils/logger');
const { sendUtilityTransactionEmail } = require('../services/EmailService');

const router = express.Router();

// Cache for user data to avoid repeated DB queries
const userCache = new Map();
const CACHE_TTL = 5000; // 5 seconds - reduced for profile data freshness
const { registerCache } = require('../utils/cacheManager');
registerCache('betting_userCache', userCache);

/**
 * Normalize service ID to match network enum format
 * @param {string} serviceId - Service ID from request
 * @returns {string} Normalized service ID for network enum
 */
function normalizeServiceIdForNetwork(serviceId) {
  const serviceMapping = {
    '1xbet': '1xBet',
    'bangbet': 'BangBet',
    'bet9ja': 'Bet9ja',
    'betking': 'BetKing',
    'betland': 'BetLand',
    'betlion': 'BetLion',
    'betway': 'BetWay',
    'cloudbet': 'CloudBet',
    'livescorebet': 'LiveScoreBet',
    'merrybet': 'MerryBet',
    'naijabet': 'NaijaBet',
    'nairabet': 'NairaBet',
    'supabet': 'SupaBet',
    'bet9ja_agent': 'Bet9ja',
    'livescore': 'LiveScoreBet',
    'hallabet': 'HallaBet',
    'mlotto': 'MLotto',
    'westernlotto': 'WesternLotto',
    'greenlotto': 'GreenLotto',
    'sportybet': 'SportyBet'
  };
  return serviceMapping[serviceId.toLowerCase()] || serviceId;
}

// Valid betting service providers
const BETTING_SERVICES = [
  '1xBet', 'BangBet', 'Bet9ja', 'BetKing', 'BetLand', 'BetLion',
  'BetWay', 'CloudBet', 'LiveScoreBet', 'MerryBet', 'NaijaBet', 'NairaBet', 'SupaBet'
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
  ).lean();

  if (user) {
    userCache.set(cacheKey, { user, timestamp: Date.now() });
    setTimeout(() => userCache.delete(cacheKey), CACHE_TTL);
  }

  return user;
}

/**
 * SIMPLIFIED: Direct balance update only (no reservations, no portfolio updates)
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

    const user = await User.findByIdAndUpdate(userId, updateFields, { new: true, runValidators: true });
    if (!user) throw new Error(`User not found: ${userId}`);

    userCache.delete(`user_${userId}`);
    logger.info(`Updated balance for user ${userId}: ${amount > 0 ? '+' : ''}${amount} ${currencyUpper}`);
    return user;
  } catch (error) {
    logger.error(`Failed to update balance for user ${userId}`, { currency, amount, error: error.message });
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

  if (!body.customer_id) errors.push('Customer ID (betting account ID) is required');
  else sanitized.customer_id = String(body.customer_id).trim();

  if (!body.service_id) errors.push('Service ID is required');
  else sanitized.service_id = String(body.service_id).trim();

  if (body.amount === undefined || body.amount === null || body.amount === '') errors.push('Amount is required');
  else {
    const rawAmount = Number(body.amount);
    if (!Number.isFinite(rawAmount)) errors.push('Amount must be a valid number');
    else {
      sanitized.amount = Math.abs(Math.round(rawAmount * 100) / 100);
      if (rawAmount < 0) errors.push('Amount cannot be negative');
      if (sanitized.amount <= 0) errors.push('Amount must be greater than zero');
      const minAmount = 1000;
      const maxAmount = 100000;
      if (sanitized.amount < minAmount) errors.push(`Amount below minimum. Minimum betting funding is ${minAmount} NGNZ`);
      if (sanitized.amount > maxAmount) errors.push(`Amount above maximum. Maximum betting funding is ${maxAmount} NGNZ`);
    }
  }

  if (!body.twoFactorCode?.trim()) errors.push('Two-factor authentication code is required');
  else sanitized.twoFactorCode = String(body.twoFactorCode).trim();

  if (!body.passwordpin?.trim()) errors.push('Password PIN is required');
  else {
    sanitized.passwordpin = String(body.passwordpin).trim();
    if (!/^\d{6}$/.test(sanitized.passwordpin)) errors.push('Password PIN must be exactly 6 numbers');
  }

  sanitized.payment_currency = 'NGNZ';
  return { isValid: errors.length === 0, errors, sanitized };
}

/**
 * Call PayBeta API for betting funding
 */
async function callPayBetaAPI({ customer_id, service_id, amount, request_id, userId, customer_name }) {
  try {
    const payBetaReference = request_id.length > 40 ? request_id.substring(0, 40) : request_id;

    const payload = {
      service: service_id.toLowerCase(),
      customerId: customer_id.trim(),
      amount: Math.round(amount),
      customerName: customer_name || 'CUSTOMER',
      reference: payBetaReference
    };

    logger.info('Making PayBeta betting funding request:', { customer_id, service_id, amount, request_id });

    const response = await payBetaAuth.makeRequest('POST', '/v2/gaming/purchase', payload, { timeout: 25000 });

    if (response.status !== 'successful') throw new Error(`Betting service error: ${response.message || 'Unknown error'}`);

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
    logger.error('❌ PayBeta betting funding failed:', { request_id, userId, error: error.message });
    if (error.message.includes('insufficient')) throw new Error('Service Unavailable. Please contact support.');
    throw new Error(`Betting service error: ${error.message}`);
  }
}

/**
 * STREAMLINED betting funding endpoint - ATOMIC IMMEDIATE DEBIT
 */
router.post('/fund', async (req, res) => {
  const startTime = Date.now();
  let balanceDeducted = false;
  let transactionCreated = false;
  let pendingTransaction = null;
  let ebillsResponse = null;
  let validation;

  try {
    const requestBody = req.body;
    const userId = req.user.id;
    
    logger.info(`🎰 Betting funding request from user ${userId}:`, {
      ...requestBody,
      passwordpin: '[REDACTED]'
    });
    
    // Step 1: Validate request
    validation = validateBettingRequest(requestBody);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors
      });
    }
    
    const { customer_id, service_id, amount, twoFactorCode, passwordpin } = validation.sanitized;
    const currency = 'NGNZ';
    
    // Step 1.1: KYC/limit validation
    const kycCheck = await validateTransactionLimit(userId, amount, currency, 'BILL_PAYMENT');
    logger.info('KYC check for betting funding', {
      userId,
      allowed: kycCheck.allowed,
      code: kycCheck.code,
      message: kycCheck.message,
      data: kycCheck.data
    });
    if (!kycCheck.allowed) {
      return res.status(400).json({
        success: false,
        error: kycCheck.code || 'KYC_VALIDATION_FAILED',
        message: kycCheck.message,
        data: kycCheck.data
      });
    }

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
        is_ngnz_transaction: true
      },
      network: normalizeServiceIdForNetwork(service_id),
      customerPhone: customer_id,
      customerInfo: {
        customer_id,
        betting_provider: service_id
      },
      userId: userId,
      timestamp: new Date(),
      twoFactorValidated: true,
      passwordPinValidated: true,
    };
    
    pendingTransaction = await BillTransaction.create(initialTransactionData);
    transactionCreated = true;
    
    logger.info(`📋 Bill transaction ${uniqueOrderId}: initiated-api | betting | ${amount} NGNZ | ✅ 2FA | ✅ PIN`);
    
    // Step 8: Call PayBeta API
    try {
      ebillsResponse = await callPayBetaAPI({
        customer_id, service_id, amount,
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
          customer_id: customer_id
        }
      });
    }
    
    // Step 10: Update transaction with eBills response
    const finalStatus = ebillsResponse.data.status === 'successful' ? 'completed' : 'failed';
    const updateData = {
      orderId: ebillsResponse.data.order_id.toString(),
      status: finalStatus,
      productName: ebillsResponse.data.product_name,
      balanceCompleted: true, // Always true since we deduct immediately
      metaData: {
        ...initialTransactionData.metaData,
        service_name: ebillsResponse.data.service_name,
        customer_name: ebillsResponse.data.customer_name,
        customer_username: ebillsResponse.data.customer_username,
        customer_email_address: ebillsResponse.data.customer_email_address,
        customer_phone_number: ebillsResponse.data.customer_phone_number,
        discount: ebillsResponse.data.discount,
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
    
    // Verify the database update worked
    logger.info(`📋 Transaction status updated: ${ebillsResponse.data.order_id} | ${finalStatus} | eBills: ${ebillsStatus} | Balance: immediate_debit`);
    logger.info(`📋 Database update verification:`, {
      transactionId: finalTransaction?._id,
      status: finalTransaction?.status,
      orderId: finalTransaction?.orderId,
      balanceCompleted: finalTransaction?.balanceCompleted
    });
    

    // Step 11: Return response based on status - MAINTAINING ORIGINAL RESPONSE STRUCTURE
    if (finalStatus === 'completed') {
      // ✅ Send push notification
      try {
        const { sendUtilityPaymentNotification } = require('../services/notificationService');
        await sendUtilityPaymentNotification(
          userId,
          'BETTING',
          amount,
          ebillsResponse.data.service_name || service_id,
          customer_id,
          {
            orderId: ebillsResponse.data.order_id?.toString(),
            requestId: finalRequestId,
            currency: 'NGNZ',
            transactionId: ebillsResponse.data.order_id?.toString(),
            customerName: ebillsResponse.data.customer_name
          }
        );
        logger.info('Betting funding notification sent', { 
          userId, 
          orderId: ebillsResponse.data.order_id 
        });
      } catch (notificationError) {
        logger.error('Failed to send betting funding notification', {
          userId,
          orderId: ebillsResponse.data.order_id,
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
              utilityType: 'Betting Account Funding',
              amount,
              currency,
              reference: ebillsResponse.data.order_id?.toString() || finalRequestId,
              status: 'COMPLETED',
              date: ebillsResponse.data.transaction_date || new Date(),
              account: customer_id,
              provider: ebillsResponse.data.service_name || service_id,
              transactionId: ebillsResponse.data.order_id?.toString(),
              additionalNote: ebillsResponse.data.customer_name ? `Customer: ${ebillsResponse.data.customer_name}` : ''
            }
          );

          logger.info('Betting funding email sent', {
            userId,
            email: user.email,
            orderId: ebillsResponse.data.order_id
          });
        } else {
          logger.warn('Skipping betting funding email - no email on file', {
            userId
          });
        }
      } catch (emailError) {
        logger.error('Failed to send betting funding email', {
          userId,
          email: user.email,
          error: emailError.message
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Betting account funding completed successfully',
        data: {
          order_id: ebillsResponse.data.order_id,
          status: finalStatus,
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
    } else if (['initiated-api', 'processing-api'].includes(ebillsStatus)) {
      return res.status(202).json({
        success: true,
        message: 'Betting account funding is being processed',
        data: {
          order_id: ebillsResponse.data.order_id,
          status: finalStatus,
          service_name: ebillsResponse.data.service_name,
          customer_id: ebillsResponse.data.customer_id,
          customer_name: ebillsResponse.data.customer_name,
          amount: ebillsResponse.data.amount,
          amount_charged: ebillsResponse.data.amount_charged,
          request_id: finalRequestId,
          balance_action: 'updated_directly', // Changed from 'reserved' since we deduct immediately
          payment_details: {
            currency: currency,
            ngnz_amount: amount,
            amount_usd: (amount * (1 / 1554.42)).toFixed(2)
          }
        },
        note: 'Balance deducted immediately. You will receive a notification when the betting account is funded'
      });
    } else {
      return res.status(200).json({
        success: true,
        message: `Betting funding status: ${ebillsStatus}`,
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
    logger.error('Betting funding unexpected error:', {
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
      message: 'An unexpected error occurred while processing your betting account funding'
    });
  }
});

/**
 * Get betting providers from PayBeta API
 * GET /betting/providers
 */
router.get('/providers', async (req, res) => {
  const startTime = Date.now();
  const requestId = `betting_providers_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    logger.info(`🎰 Fetching betting providers from PayBeta:`, {
      requestId,
      userId: req.user?.id
    });

    // Check if PayBeta API key is configured
    if (!process.env.PAYBETA_API_KEY) {
      logger.error(`❌ [${requestId}] PayBeta API key not configured`);
      return res.status(503).json({
        success: false,
        error: 'SERVICE_CONFIGURATION_ERROR',
        message: 'Betting providers service is not properly configured. Please contact support.',
        requestId
      });
    }

    // Call PayBeta API for providers
    const response = await payBetaAuth.makeRequest('GET', '/v2/gaming/providers');
    
    logger.info(`📡 [${requestId}] PayBeta providers response:`, {
      requestId,
      status: response.status,
      message: response.message,
      providerCount: response.data?.length || 0
    });

    if (response.status === 'successful' && response.data) {
      // Debug: Log the raw PayBeta response
      logger.info(`🔍 [${requestId}] Raw PayBeta response:`, {
        requestId,
        rawData: response.data,
        rawDataLength: response.data.length,
        rawDataTypes: response.data.map(p => ({ name: p.name, slug: p.slug, hasLogo: !!p.logo }))
      });

      // Process providers and add default images for those without logos
      const processedProviders = response.data.map(provider => ({
        id: provider.slug || provider.name?.toLowerCase(),
        name: provider.name,
        displayName: provider.name,
        slug: provider.slug,
        category: provider.category || 'gaming',
        logo: provider.logo || null, // Will be handled on frontend with default image
        hasLogo: !!provider.logo
      }));

      // Debug: Check for duplicate IDs and remove them
      const providerIds = processedProviders.map(p => p.id);
      const uniqueIds = [...new Set(providerIds)];
      const duplicateIds = providerIds.filter((id, index) => providerIds.indexOf(id) !== index);
      
      if (duplicateIds.length > 0) {
        logger.warn(`⚠️ [${requestId}] Duplicate provider IDs found:`, {
          requestId,
          duplicateIds,
          totalProcessed: processedProviders.length,
          uniqueCount: uniqueIds.length
        });
      }

      // Remove duplicates by keeping only the first occurrence of each ID
      const uniqueProviders = processedProviders.filter((provider, index, self) => 
        index === self.findIndex(p => p.id === provider.id)
      );

      logger.info(`🔍 [${requestId}] After deduplication:`, {
        requestId,
        originalCount: processedProviders.length,
        uniqueCount: uniqueProviders.length,
        removedDuplicates: processedProviders.length - uniqueProviders.length
      });

      // Debug: Log processed providers
      logger.info(`🔍 [${requestId}] Processed providers:`, {
        requestId,
        processedCount: uniqueProviders.length,
        processedProviders: uniqueProviders.map(p => ({ id: p.id, name: p.name, slug: p.slug }))
      });

      logger.info(`✅ [${requestId}] Betting providers fetched successfully`, {
        requestId,
        providerCount: uniqueProviders.length,
        processingTime: `${Date.now() - startTime}ms`
      });

      return res.status(200).json({
        success: true,
        message: 'Betting providers fetched successfully',
        data: {
          providers: uniqueProviders,
          total: uniqueProviders.length,
          requestId
        }
      });
    } else {
      return res.status(400).json({
        success: false,
        error: 'PROVIDERS_FETCH_FAILED',
        message: response.message || 'Failed to fetch betting providers',
        requestId
      });
    }

  } catch (error) {
    logger.error(`💀 [${requestId}] Betting providers fetch error:`, {
      requestId,
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      processingTime: `${Date.now() - startTime}ms`
    });

    // Handle different error types
    if (error.message.includes('API key not configured') || 
        error.message.includes('authentication failed')) {
      return res.status(503).json({
        success: false,
        error: 'SERVICE_CONFIGURATION_ERROR',
        message: 'Betting providers service is not properly configured. Please contact support.',
        requestId
      });
    }

    if (error.message.includes('timeout')) {
      return res.status(504).json({
        success: false,
        error: 'PROVIDERS_TIMEOUT',
        message: 'Request timed out. Please try again.',
        requestId
      });
    }

    return res.status(500).json({
      success: false,
      error: 'PROVIDERS_API_ERROR',
      message: 'Failed to fetch betting providers. Please try again later.',
      requestId
    });
  }
});

/**
 * Test PayBeta API directly
 * GET /betting/test-paybeta
 */
router.get('/test-paybeta', async (req, res) => {
  try {
    logger.info('🧪 Testing PayBeta API directly...');
    
    // Test with the exact format from PayBeta docs
    const testPayload = {
      service: 'nairabet',
      customerId: '20***96'  // Use the exact format from their docs
    };
    
    logger.info('🧪 Test payload:', testPayload);
    
    const response = await payBetaAuth.makeRequest('POST', '/v2/gaming/validate', testPayload);
    
    logger.info('🧪 PayBeta test response:', response);
    
    res.json({
      success: true,
      message: 'Service test successful',
      data: response
    });

  } catch (error) {
    logger.error('🧪 Service test failed:', error);

    res.status(500).json({
      success: false,
      message: 'Service test failed',
      error: error.message,
      details: error
    });
  }
});

/**
 * Validate betting customer using PayBeta API
 * POST /betting/validate
 */
router.post('/validate', async (req, res) => {
  const startTime = Date.now();
  const requestId = `betting_validate_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    const { service, customerId } = req.body;
    
    logger.info(`🎰 Betting customer validation request:`, {
      requestId,
      userId: req.user?.id,
      service,
      customerId: customerId?.substring(0, 4) + '***'
    });

    // Validate required fields
    if (!service) {
      return res.status(400).json({
        success: false,
        message: 'Service is required'
      });
    }
    
    if (!customerId) {
      return res.status(400).json({
        success: false,
        message: 'Customer ID is required'
      });
    }

    // Check if PayBeta API key is configured
    if (!process.env.PAYBETA_API_KEY) {
      logger.error(`❌ [${requestId}] PayBeta API key not configured`);
      return res.status(503).json({
        success: false,
        error: 'SERVICE_CONFIGURATION_ERROR',
        message: 'Betting validation service is not properly configured. Please contact support.',
        requestId
      });
    }

    // Call PayBeta API for customer validation
    // Map service names to PayBeta expected format (based on their documentation)
    const serviceMapping = {
      'betway': 'betway',  // Try lowercase first
      'bet9ja': 'bet9ja',
      'betking': 'betking',
      'bangbet': 'bangbet',
      '1xbet': '1xbet',
      'merrybet': 'merrybet',
      'betland': 'betland',
      'naijabet': 'naijabet',
      'nairabet': 'nairabet',  // This is in their docs
      'supabet': 'supabet',
      'bet9ja_agent': 'bet9ja_agent',
      'cloudbet': 'cloudbet',
      'livescore': 'livescore',
      'hallabet': 'hallabet',
      'mlotto': 'mlotto',
      'westernlotto': 'westernlotto',
      'greenlotto': 'greenlotto',
      'sportybet': 'sportybet'
    };
    
    // Use the mapped service name or fallback to original
    const payBetaServiceName = serviceMapping[service.toLowerCase()] || service.toLowerCase();
    
    // Format customer ID as PayBeta expects (remove any masking/formatting)
    const payBetaCustomerId = customerId.trim().replace(/\*/g, '').replace(/-/g, '');
    
    const payBetaPayload = {
      service: payBetaServiceName,
      customerId: payBetaCustomerId
    };
    
    logger.info(`📡 [${requestId}] PayBeta API payload:`, {
      requestId,
      payload: payBetaPayload,
      service: service,
      customerId: customerId?.substring(0, 4) + '***',
      fullPayload: payBetaPayload
    });
    
    // Add comprehensive debugging
    logger.info(`🔍 [${requestId}] PayBeta API Debug - Before Request:`, {
      requestId,
      endpoint: '/v2/gaming/validate',
      method: 'POST',
      payload: payBetaPayload,
      hasApiKey: !!process.env.PAYBETA_API_KEY,
      apiKeyLength: process.env.PAYBETA_API_KEY?.length,
      baseURL: process.env.PAYBETA_API_URL || 'https://api.paybeta.ng'
    });
    
    const response = await payBetaAuth.makeRequest('POST', '/v2/gaming/validate', payBetaPayload);
    
    logger.info(`📡 [${requestId}] PayBeta validation response:`, {
      requestId,
      status: response.status,
      message: response.message,
      fullResponse: response,
      hasData: !!response.data
    });

    if (response.status === 'successful') {
      const customerData = response.data;
      
      const enhancedResponse = {
        success: true,
        message: 'Betting customer validation successful',
        data: {
          customerId: customerData.customerId,
          customerName: customerData.customerName,
          service: customerData.service,
          minimumAmount: customerData.minimumAmount,
          verified_at: new Date().toISOString(),
          requestId
        }
      };
      
      logger.info(`✅ [${requestId}] Betting validation completed successfully`, {
        requestId,
        service,
        customerId: customerId?.substring(0, 4) + '***',
        processingTime: `${Date.now() - startTime}ms`
      });
      
      return res.status(200).json(enhancedResponse);
    } else {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_FAILED',
        message: response.message || 'Customer validation failed',
        details: {
          service,
          customerId: customerId?.substring(0, 4) + '***',
          requestId
        }
      });
    }

  } catch (error) {
    logger.error(`💀 [${requestId}] Betting validation error:`, {
      requestId,
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      processingTime: `${Date.now() - startTime}ms`
    });

    // Handle different error types
    if (error.message.includes('API key not configured') || 
        error.message.includes('authentication failed')) {
      return res.status(503).json({
        success: false,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Service Unavailable',
        requestId
      });
    }

    if (error.message.includes('Customer not found') || 
        error.message.includes('Invalid customer')) {
      return res.status(404).json({
        success: false,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Service Unavailable',
        requestId
      });
    }

    if (error.message.includes('timeout')) {
      return res.status(504).json({
        success: false,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Service Unavailable',
        requestId
      });
    }

    return res.status(500).json({
      success: false,
      error: 'SERVICE_UNAVAILABLE',
      message: 'Service Unavailable',
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
