// routes/cabletv.js
const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { vtuAuth } = require('../auth/billauth');
const { payBetaAuth } = require('../auth/paybetaAuth');
const { validateUserBalance } = require('../services/balance');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { validateCableAccount } = require('../services/paybetaCableValidation');
const { purchaseCableSubscription } = require('../services/paybetaCablePurchase');
const { sendPaymentNotification } = require('../services/notificationService');
const logger = require('../utils/logger');
const { sendUtilityTransactionEmail } = require('../services/EmailService');

const router = express.Router();

// Cache for user data to avoid repeated DB queries
const userCache = new Map();
const CACHE_TTL = 30000; // 30 seconds

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

  const pickValue = (keys, { trim = true } = {}) => {
    for (const key of keys) {
      const raw = body[key];
      if (raw === undefined || raw === null) continue;
      if (typeof raw === 'string') {
        const value = trim ? raw.trim() : raw;
        if (value.length === 0) continue;
        return value;
      }
      return raw;
    }
    return null;
  };

  // Customer ID validation
  const customerId = pickValue(['customer_id', 'customerId', 'smartCardNumber', 'smartcardNumber', 'customer']);
  if (!customerId) {
    errors.push('Customer ID (smartcard/IUC number) is required');
  } else {
    sanitized.customer_id = String(customerId).trim();
    if (sanitized.customer_id.length === 0) {
      errors.push('Customer ID must be a non-empty string');
    }
  }

  // Service ID validation
  const serviceId = pickValue(['service_id', 'service', 'provider', 'serviceId']);
  if (!serviceId) {
    errors.push('Service ID is required');
  } else {
    sanitized.service_id = String(serviceId).toLowerCase().trim();
    if (!CABLE_TV_SERVICES.includes(sanitized.service_id)) {
      errors.push(`Invalid service ID. Must be one of: ${CABLE_TV_SERVICES.join(', ')}`);
    }
  }
  
  // Variation ID validation
  const variationId = pickValue(['variation_id', 'packageCode', 'package_code', 'package']);
  if (!variationId) {
    errors.push('Variation ID (package/bouquet) is required');
  } else {
    sanitized.variation_id = String(variationId).trim();
    if (sanitized.variation_id.length === 0) {
      errors.push('Variation ID must be a non-empty string');
    }
  }

  // Subscription type validation
  const subscriptionType = pickValue(['subscription_type', 'subscriptionType', 'type']);
  if (subscriptionType) {
    sanitized.subscription_type = String(subscriptionType).toLowerCase().trim();
    if (!VALID_SUBSCRIPTION_TYPES.includes(sanitized.subscription_type)) {
      errors.push('Subscription type must be "change" or "renew"');
    }
  } else {
    sanitized.subscription_type = 'change';
  }

  // Amount validation - UPDATED: References NGNZ
  const amountValue = pickValue(['amount', 'price', 'payment_amount', 'paymentAmount']);
  if (amountValue === null || amountValue === '') {
    errors.push('Amount is required');
  } else {
    const rawAmount = Number(amountValue);
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

  // Optional customer name
  const customerName = pickValue(['customer_name', 'customerName', 'customer_full_name', 'customerFullName', 'name']);
  sanitized.customer_name = customerName ? String(customerName).trim() : undefined;

  // Optional client reference
  const reference = pickValue(['reference', 'referenceId', 'clientReference', 'transactionReference', 'ref']);
  sanitized.reference = reference ? String(reference).trim() : undefined;

  // 2FA validation
  const twoFactor = pickValue(['twoFactorCode', 'two_factor_code', 'twoFactor', 'otp', 'twofa']);
  if (!twoFactor) {
    errors.push('Two-factor authentication code is required');
  } else {
    sanitized.twoFactorCode = String(twoFactor).trim();
  }

  // Password PIN validation
  const passwordPin = pickValue(['passwordpin', 'passwordPin', 'pin', 'transactionPin']);
  if (!passwordPin) {
    errors.push('Password PIN is required');
  } else {
    sanitized.passwordpin = String(passwordPin).trim();
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

    const { customer_id, service_id, variation_id, subscription_type, amount, twoFactorCode, passwordpin, customer_name, reference } = validation.sanitized;
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
        is_ngnz_transaction: true,
        customer_name: customer_name || undefined,
        reference: reference || finalRequestId
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

    // Step 8: Call PayBeta API using the new service
    try {
      const purchaseReference = reference || finalRequestId;
      payBetaResponse = await purchaseCableSubscription({
        service: service_id,
        smartCardNumber: customer_id,
        amount: amount,
        packageCode: variation_id,
        customerName: customer_name || 'CUSTOMER',
        reference: purchaseReference
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
    const payBetaStatus = payBetaResponse.status; // Status is at root level in normalized response

    // Debug: Log PayBeta response structure
    logger.info(`🔍 PayBeta Response Debug:`, {
      payBetaStatus,
      fullResponse: payBetaResponse,
      transactionId: payBetaResponse.data.transactionId,
      biller: payBetaResponse.data.biller
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
        paybeta_transaction_id: payBetaResponse.data?.transactionId
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
        paybeta_transaction_id: payBetaResponse.data?.transactionId
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
        paybeta_transaction_id: payBetaResponse.data?.transactionId
        }]
      });

      return res.status(500).json({
        success: false,
        error: 'BALANCE_UPDATE_FAILED',
        message: 'PayBeta transaction succeeded but balance deduction failed. Please contact support immediately.',
        details: {
          paybeta_transaction_id: payBetaResponse.data?.transactionId,
          paybeta_status: payBetaResponse.status,
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
        success: false,
        status: payBetaResponse.status,
        message: payBetaResponse.message || 'Cable TV purchase not successful',
        data: payBetaResponse.data
      });
    }

    // Step 10: Update transaction with proper status mapping
    const finalStatus = payBetaStatus === 'successful' ? 'completed' : 'failed';
    const updateData = {
      orderId: payBetaResponse.data.transactionId || payBetaResponse.data.reference,
      status: finalStatus,
      productName: payBetaResponse.data.biller || 'Cable TV',
      balanceCompleted: true,
      metaData: {
        ...initialTransactionData.metaData,
        service_name: payBetaResponse.data.service_name || service_id.toUpperCase(),
        customer_name: payBetaResponse.data.customer_name || payBetaResponse.data.customerName || customer_name || undefined,
        discount: payBetaResponse.data.commission || 0,
        amount_charged: payBetaResponse.data.chargedAmount,
        balance_action_taken: true,
        balance_action_type: 'immediate_debit',
        balance_action_at: new Date(),
        paybeta_status: payBetaStatus,
        paybeta_transaction_id: payBetaResponse.data.transactionId,
        paybeta_reference: payBetaResponse.data.reference,
        paybeta_initial_balance: undefined,
        paybeta_final_balance: undefined
      }
    };

    const finalTransaction = await BillTransaction.findByIdAndUpdate(
      pendingTransaction._id,
      updateData,
      { new: true }
    );

    // Verify the database update worked
    logger.info(`📋 Transaction status updated: ${payBetaResponse.data.transactionId} | ${finalStatus} | PayBeta: ${payBetaStatus} | Balance: immediate_debit`);
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

    logger.info(`📋 Transaction completed: ${payBetaResponse.data.transactionId} | ${payBetaStatus} | Balance: immediate_debit | ${Date.now() - startTime}ms`);


    // Step 11: Return response - ONLY SUCCESS NOTIFICATION WHEN SUCCESSFUL
    if (payBetaStatus === 'successful') {
      // ✅ Send push notification
      try {
        await sendPaymentNotification(
          userId,
          amount,
          currency,
          `Cable TV subscription for ${payBetaResponse.data.biller || service_id.toUpperCase()}`,
          {
            type: 'CABLE_TV_PURCHASE',
            service: service_id,
            biller: payBetaResponse.data.biller,
            smartCardNumber: customer_id,
            customerName: customer_name,
            transactionId: payBetaResponse.data.transactionId,
            reference: payBetaResponse.data.reference,
            chargedAmount: payBetaResponse.data.chargedAmount,
            commission: payBetaResponse.data.commission
          }
        );
        logger.info('Cable TV purchase push notification sent', {
          userId,
          transactionId: payBetaResponse.data.transactionId
        });
      } catch (notificationError) {
        logger.error('Failed to send cable TV purchase push notification', {
          userId,
          error: notificationError.message
        });
        // Don't fail the request if notification fails
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
              reference: payBetaResponse.data.reference || payBetaResponse.data.transactionId || finalRequestId,
              status: 'COMPLETED',
              date: payBetaResponse.data.transactionDate || new Date(),
              recipientPhone: customer_id,
              provider: payBetaResponse.data.biller || service_id.toUpperCase(),
              transactionId: payBetaResponse.data.transactionId?.toString(),
              account: customer_id
            }
          );

          logger.info('Cable TV purchase email sent', {
            userId,
            email: user.email,
            transactionId: payBetaResponse.data.transactionId
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
        status: payBetaResponse.status,
        message: payBetaResponse.message || 'Cable TV purchase completed successfully',
        data: {
          reference: payBetaResponse.data.reference,
          amount: payBetaResponse.data.amount,
          chargedAmount: payBetaResponse.data.chargedAmount,
          commission: payBetaResponse.data.commission,
          biller: payBetaResponse.data.biller,
          customerId: payBetaResponse.data.customerId,
          token: payBetaResponse.data.token,
          unit: payBetaResponse.data.unit,
          bonusToken: payBetaResponse.data.bonusToken,
          transactionDate: payBetaResponse.data.transactionDate,
          transactionId: payBetaResponse.data.transactionId,
          service: service_id,
          customer_name: customer_name,
          smartCardNumber: customer_id,
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
        status: payBetaResponse.status,
        message: payBetaResponse.message || 'Cable TV purchase is being processed',
        data: {
          ...payBetaResponse.data,
          request_id: finalRequestId,
          balance_action: 'updated_directly',
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
        status: payBetaResponse.status,
        message: payBetaResponse.message || `Cable TV purchase status: ${payBetaStatus}`,
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
  const requestId = `cable_verify_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const getValue = (keys) => {
    for (const key of keys) {
      const value = req.body[key];
      if (value === undefined || value === null) continue;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length === 0) continue;
        return trimmed;
      }
      return value;
    }
    return null;
  };

  const serviceId = getValue(['service_id', 'service', 'provider', 'serviceId']);
  const smartCardNumber = getValue(['customer_id', 'customerId', 'smartCardNumber', 'smartcardNumber', 'cardNumber']);

  logger.info('📺 Cable TV validation request received', {
    requestId,
    userId: req.user?.id,
    serviceId,
    smartCardNumber: smartCardNumber ? `${String(smartCardNumber).slice(0, 4)}***` : undefined
  });

  if (!serviceId) {
    return res.status(400).json({
      status: 'failed',
      message: 'Service ID is required',
      data: null
    });
  }

  if (!smartCardNumber) {
    return res.status(400).json({
      status: 'failed',
      message: 'Smart card number is required',
      data: null
    });
  }

  if (!CABLE_TV_SERVICES.includes(String(serviceId).toLowerCase())) {
    return res.status(400).json({
      status: 'failed',
      message: `Invalid service ID. Must be one of: ${CABLE_TV_SERVICES.join(', ')}`,
      data: null
    });
  }

  if (!process.env.PAYBETA_API_KEY) {
    logger.error('❌ Cable validation blocked: PAYBETA_API_KEY missing', { requestId });
    return res.status(503).json({
      status: 'failed',
      message: 'Cable TV validation service is not configured. Please contact support.',
      data: null
    });
  }

  try {
    const validationResponse = await validateCableAccount({
      service: serviceId,
      smartCardNumber
    });

    logger.info('✅ Cable TV validation successful', {
      requestId,
      service: validationResponse.data.service,
      smartCardNumber: validationResponse.data.smartCardNumber ? `${String(validationResponse.data.smartCardNumber).slice(0, 4)}***` : undefined
    });

    return res.status(200).json(validationResponse);
  } catch (error) {
    logger.error('❌ Cable TV validation failed', {
      requestId,
      serviceId,
      smartCardNumber: smartCardNumber ? `${String(smartCardNumber).slice(0, 4)}***` : undefined,
      error: error.message,
      code: error.code,
      status: error.status,
      data: error.data
    });

    const statusCode = error.code === 'PAYBETA_VALIDATION_FAILED' ? 400
      : error.code === 'PAYBETA_API_ERROR' ? 502
      : error.code === 'INVALID_PARAMETERS' ? 400
      : 500;

    return res.status(statusCode).json({
      status: error.status || 'failed',
      message: error.message || 'Cable TV customer validation failed',
      data: error.data || {
        customerName: null,
        smartCardNumber: String(smartCardNumber),
        service: String(serviceId || '').toUpperCase()
      }
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
