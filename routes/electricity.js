const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { vtuAuth } = require('../auth/billauth');
const { validateUserBalance } = require('../services/balance');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { validateTransactionLimit } = require('../services/kyccheckservice');
const logger = require('../utils/logger');
const crypto = require('crypto');

const router = express.Router();

const ELECTRICITY_SERVICES = [
  'ikeja-electric','eko-electric','kano-electric','portharcourt-electric',
  'jos-electric','ibadan-electric','kaduna-electric','abuja-electric',
  'enugu-electric','benin-electric','aba-electric','yola-electric'
];

const VALID_METER_TYPES = ['prepaid', 'postpaid'];

const SUPPORTED_TOKENS = {
  BTC:{name:'Bitcoin'}, ETH:{name:'Ethereum'}, SOL:{name:'Solana'},
  USDT:{name:'Tether'}, USDC:{name:'USD Coin'}, BNB:{name:'Binance Coin'},
  MATIC:{name:'Polygon'}, AVAX:{name:'Avalanche'}, NGNZ:{name:'NGNZ Token'}
};

const TOKEN_FIELD_MAPPING = {
  BTC:'btc', ETH:'eth', SOL:'sol', USDT:'usdt', USDC:'usdc',
  BNB:'bnb', MATIC:'matic', AVAX:'avax', NGNZ:'ngnz'
};

async function reserveUserBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number' || amount <= 0) {
    throw new Error('Invalid parameters for balance reservation');
  }
  const currencyUpper = currency.toUpperCase();
  if (!SUPPORTED_TOKENS[currencyUpper]) throw new Error(`Unsupported currency: ${currencyUpper}`);
  const currencyLower = TOKEN_FIELD_MAPPING[currencyUpper];
  const pendingBalanceKey = `${currencyLower}PendingBalance`;
  const update = { $inc: { [pendingBalanceKey]: amount }, $set: { lastBalanceUpdate: new Date() } };
  const user = await User.findByIdAndUpdate(userId, update, { new: true, runValidators: true });
  if (!user) throw new Error(`User not found: ${userId}`);
  logger.info(`Reserved ${amount} ${currencyUpper} for user ${userId}`);
  return user;
}

async function releaseReservedBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number' || amount <= 0) {
    throw new Error('Invalid parameters for balance release');
  }
  const currencyUpper = currency.toUpperCase();
  if (!SUPPORTED_TOKENS[currencyUpper]) throw new Error(`Unsupported currency: ${currencyUpper}`);
  const currencyLower = TOKEN_FIELD_MAPPING[currencyUpper];
  const pendingBalanceKey = `${currencyLower}PendingBalance`;
  const update = { $inc: { [pendingBalanceKey]: -amount }, $set: { lastBalanceUpdate: new Date() } };
  const user = await User.findByIdAndUpdate(userId, update, { new: true, runValidators: true });
  if (!user) throw new Error(`User not found: ${userId}`);
  logger.info(`Released ${amount} ${currencyUpper} for user ${userId}`);
  return user;
}

async function updateUserBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number') {
    throw new Error('Invalid parameters for balance update');
  }
  const currencyUpper = currency.toUpperCase();
  if (!SUPPORTED_TOKENS[currencyUpper]) throw new Error(`Unsupported currency: ${currencyUpper}`);
  const currencyLower = TOKEN_FIELD_MAPPING[currencyUpper];
  const balanceField = `${currencyLower}Balance`;
  const updateFields = { $inc: { [balanceField]: amount }, $set: { lastBalanceUpdate: new Date() } };
  const user = await User.findByIdAndUpdate(userId, updateFields, { new: true, runValidators: true });
  if (!user) throw new Error(`User not found: ${userId}`);
  logger.info(`Updated balance for user ${userId}: ${amount > 0 ? '+' : ''}${amount} ${currencyUpper}`);
  return user;
}

async function updateUserPortfolioBalance(userId) {
  if (!userId) throw new Error('User ID is required');
  const user = await User.findByIdAndUpdate(
    userId,
    { $set: { portfolioLastUpdated: new Date() } },
    { new: true, runValidators: true }
  );
  if (!user) throw new Error(`User not found: ${userId}`);
  logger.info(`Updated portfolio timestamp for user ${userId}`);
  return user;
}

async function comparePasswordPin(candidatePasswordPin, hashedPasswordPin) {
  if (!candidatePasswordPin || !hashedPasswordPin) return false;
  try { return await bcrypt.compare(candidatePasswordPin, hashedPasswordPin); }
  catch (error) { logger.error('Password pin comparison failed:', error); return false; }
}

function validateElectricityRequest(body) {
  const errors = [];
  const sanitized = {};

  if (!body.customer_id) errors.push('Customer ID (meter/account number) is required');
  else {
    sanitized.customer_id = String(body.customer_id).trim();
    if (!sanitized.customer_id.length) errors.push('Customer ID must be a non-empty string');
  }

  if (!body.service_id) errors.push('Service ID is required');
  else {
    sanitized.service_id = String(body.service_id).toLowerCase().trim();
    if (!ELECTRICITY_SERVICES.includes(sanitized.service_id)) {
      errors.push(`Invalid service ID. Must be one of: ${ELECTRICITY_SERVICES.join(', ')}`);
    }
  }

  if (!body.variation_id) errors.push('Variation ID (meter type) is required');
  else {
    sanitized.variation_id = String(body.variation_id).toLowerCase().trim();
    if (!VALID_METER_TYPES.includes(sanitized.variation_id)) {
      errors.push('Variation ID must be "prepaid" or "postpaid"');
    }
  }

  if (body.amount === undefined || body.amount === null || body.amount === '') {
    errors.push('Amount is required');
  } else {
    const rawAmount = Number(body.amount);
    if (!Number.isFinite(rawAmount)) errors.push('Amount must be a valid number');
    else {
      sanitized.amount = Math.abs(Math.round(rawAmount * 100) / 100);
      if (rawAmount < 0) errors.push('Amount cannot be negative');
      if (sanitized.amount <= 0) errors.push('Amount must be greater than zero');
      const minAmount = 1000, maxAmount = 100000;
      if (sanitized.amount < minAmount) errors.push(`Amount below minimum. Minimum electricity purchase is ${minAmount} NGNZ`);
      if (sanitized.amount > maxAmount) errors.push(`Amount above maximum. Maximum electricity purchase is ${maxAmount} NGNZ`);
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

async function callEBillsElectricityAPI({ customer_id, service_id, variation_id, amount, request_id, userId }) {
  try {
    const payload = {
      request_id: request_id,
      customer_id: customer_id.trim(),
      service_id,
      variation_id,
      amount: parseInt(amount)
    };

    logger.info('Making eBills electricity purchase request:', {
      customer_id, service_id, variation_id, amount, request_id, endpoint: '/api/v2/electricity'
    });

    const response = await vtuAuth.makeRequest('POST', '/api/v2/electricity', payload, { timeout: 45000 });

    logger.info(`eBills Electricity API response for ${request_id}:`, {
      code: response.code,
      message: response.message,
      status: response.data?.status,
      order_id: response.data?.order_id
    });

    if (response.code !== 'success') {
      throw new Error(`eBills Electricity API error: ${response.message || 'Unknown error'}`);
    }

    return response;
  } catch (error) {
    logger.error('❌ eBills electricity purchase failed:', {
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

    throw new Error(`eBills Electricity API error: ${error.message}`);
  }
}

/**
 * Main electricity purchase endpoint (mirrors eBills response on success)
 */
router.post('/purchase', async (req, res) => {
  const startTime = Date.now();
  let balanceActionTaken = false;
  let balanceActionType = null;
  let transactionCreated = false;
  let pendingTransaction = null;
  let ebillsResponse = null;

  try {
    const requestBody = req.body;
    const userId = req.user.id;

    logger.info(`⚡ Electricity purchase request from user ${userId}:`, {
      ...requestBody,
      passwordpin: '[REDACTED]'
    });

    // 1) Validate request
    const validation = validateElectricityRequest(requestBody);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors
      });
    }

    const { customer_id, service_id, variation_id, amount, twoFactorCode, passwordpin } = validation.sanitized;
    const currency = 'NGNZ';

    // 2) Validate user + 2FA
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.twoFASecret || !user.is2FAEnabled) {
      return res.status(400).json({
        success: false,
        message: 'Two-factor authentication is not set up or not enabled. Please enable 2FA first.'
      });
    }

    if (!validateTwoFactorAuth(user, twoFactorCode)) {
      logger.warn('🚫 2FA validation failed for electricity purchase', { userId, errorType: 'INVALID_2FA' });
      return res.status(401).json({ success: false, error: 'INVALID_2FA_CODE', message: 'Invalid two-factor authentication code' });
    }
    logger.info('✅ 2FA validation successful for electricity purchase', { userId });

    // 3) Password PIN
    if (!user.passwordpin) {
      return res.status(400).json({
        success: false,
        message: 'Password PIN is not set up for your account. Please set up your password PIN first.'
      });
    }
    const isPasswordPinValid = await comparePasswordPin(passwordpin, user.passwordpin);
    if (!isPasswordPinValid) {
      logger.warn('🚫 Password PIN validation failed for electricity purchase', { userId, errorType: 'INVALID_PASSWORDPIN' });
      return res.status(401).json({ success: false, error: 'INVALID_PASSWORDPIN', message: 'Invalid password PIN' });
    }
    logger.info('✅ Password PIN validation successful for electricity purchase', { userId });

    // 4) KYC limits
    const kycValidation = await validateTransactionLimit(userId, amount, 'NGNZ', 'ELECTRICITY');
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

    // 5) Pending check
    const existingPending = await BillTransaction.getUserPendingTransactions(userId, 'electricity', 5);
    if (existingPending.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'PENDING_TRANSACTION_EXISTS',
        message: 'You already have a pending electricity purchase. Please wait for it to complete.'
      });
    }

    // 6) IDs
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const finalRequestId = `${userId}_${timestamp}_${randomSuffix}`;
    const uniqueOrderId = `pending_${userId}_${timestamp}`;

    // 7) Balance check
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
          currency
        }
      });
    }

    // 8) Create transaction
    const initialTransactionData = {
      orderId: uniqueOrderId,
      status: 'initiated-api',
      productName: 'Electricity',
      billType: 'electricity',
      quantity: 1,
      amount: amount,
      amountNaira: amount,
      paymentCurrency: currency,
      requestId: finalRequestId,
      metaData: {
        customer_id, service_id, variation_id, meter_type: variation_id,
        user_id: userId, payment_currency: currency, ngnz_amount: amount,
        exchange_rate: 1, twofa_validated: true, passwordpin_validated: true,
        kyc_validated: true, is_ngnz_transaction: true
      },
      network: service_id.toUpperCase(),
      customerPhone: customer_id,
      customerInfo: { customer_id, service_provider: service_id, meter_type: variation_id },
      userId: userId,
      timestamp: new Date(),
      balanceReserved: false,
      twoFactorValidated: true,
      passwordPinValidated: true,
      kycValidated: true
    };

    const pendingTx = await BillTransaction.create(initialTransactionData);
    pendingTransaction = pendingTx;
    transactionCreated = true;

    logger.info(`📋 Bill transaction ${uniqueOrderId}: initiated-api | electricity | ${amount} NGNZ | ✅ 2FA | ✅ PIN | ✅ KYC | ⚠️ Balance Pending`);

    // 9) Call eBills
    try {
      ebillsResponse = await callEBillsElectricityAPI({
        customer_id, service_id, variation_id, amount,
        request_id: finalRequestId, userId
      });
    } catch (apiError) {
      await BillTransaction.findByIdAndUpdate(pendingTransaction._id, {
        status: 'failed',
        processingErrors: [{ error: apiError.message, timestamp: new Date(), phase: 'api_call' }]
      });
      return res.status(500).json({
        success: false,
        error: 'EBILLS_ELECTRICITY_API_ERROR',
        message: apiError.message
      });
    }

    // 10) Balance handling based on provider status
    const ebillsStatus = ebillsResponse.data.status;

    if (ebillsStatus === 'completed-api') {
      try {
        await updateUserBalance(userId, currency, -amount);
        await updateUserPortfolioBalance(userId);
        balanceActionTaken = true;
        balanceActionType = 'updated';
        logger.info(`✅ Balance updated directly: -${amount} ${currency} for user ${userId}`);
      } catch (balanceError) {
        logger.error('CRITICAL: Balance update failed for completed transaction:', {
          request_id: finalRequestId, userId, currency, amount, error: balanceError.message,
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
          message: 'eBills electricity transaction succeeded but balance update failed. Please contact support immediately.'
        });
      }
    } else if (['initiated-api', 'processing-api'].includes(ebillsStatus)) {
      try {
        await reserveUserBalance(userId, currency, amount);
        await pendingTransaction.markBalanceReserved();
        balanceActionTaken = true;
        balanceActionType = 'reserved';
        logger.info(`✅ Balance reserved: ${amount} ${currency} for user ${userId}`);
      } catch (balanceError) {
        logger.error('CRITICAL: Balance reservation failed after eBills success:', {
          request_id: finalRequestId, userId, currency, amount, error: balanceError.message,
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
          message: 'eBills electricity transaction succeeded but balance reservation failed. Please contact support immediately.'
        });
      }
    } else {
      logger.warn(`Unexpected eBills status: ${ebillsStatus} for ${finalRequestId}`);
    }

    // 11) Update transaction with eBills response (internal only; response to client mirrors eBills)
    const updateData = {
      orderId: ebillsResponse.data.order_id?.toString?.() || String(ebillsResponse.data.order_id),
      status: ebillsResponse.data.status,
      productName: ebillsResponse.data.product_name,
      metaData: {
        ...initialTransactionData.metaData,
        service_name: ebillsResponse.data.service_name,
        customer_name: ebillsResponse.data.customer_name,
        customer_address: ebillsResponse.data.customer_address,
        token: ebillsResponse.data.token,
        units: ebillsResponse.data.units,
        band: ebillsResponse.data.band,
        amount_charged: ebillsResponse.data.amount_charged,
        balance_action_taken: balanceActionTaken,
        balance_action_type: balanceActionType,
        balance_action_at: new Date(),
        ebills_initial_balance: ebillsResponse.data.initial_balance,
        ebills_final_balance: ebillsResponse.data.final_balance
      },
      // derive balance flags for our DB only
      balanceReserved: balanceActionType === 'reserved',
      balanceCompleted: balanceActionType === 'updated'
    };

    await BillTransaction.findByIdAndUpdate(pendingTransaction._id, updateData, { new: true });
    logger.info(`📋 Transaction updated: ${ebillsResponse.data.order_id} | ${ebillsResponse.data.status} | Balance: ${balanceActionType || 'none'}`);

    // 12) ❗RETURN EXACT EBILLS FORMAT
    return res.status(200).json(ebillsResponse);

  } catch (error) {
    logger.error('Electricity purchase unexpected error:', {
      userId: req.user?.id,
      error: error.message,
      processingTime: Date.now() - startTime
    });

    // Attempt cleanup if we had reserved balance
    try {
      if (balanceActionTaken && balanceActionType === 'reserved') {
        // If validation var not in scope, skip safe read
        const amt = (req.body && Number(req.body.amount)) || 0;
        if (amt > 0) await releaseReservedBalance(req.user.id, 'NGNZ', amt);
        logger.info('🔄 Released reserved NGNZ balance due to error');
      } else if (balanceActionTaken && balanceActionType === 'updated') {
        logger.error('❌ CRITICAL: Direct balance update completed but transaction failed. Manual intervention required.');
      }
    } catch (releaseError) {
      logger.error('❌ Failed to release reserved NGNZ balance after error:', releaseError.message);
    }

    if (transactionCreated && pendingTransaction) {
      try {
        await BillTransaction.findByIdAndUpdate(pendingTransaction._id, {
          status: 'failed',
          processingErrors: [{ error: error.message, timestamp: new Date(), phase: 'unexpected_error' }]
        });
      } catch (updateError) {
        logger.error('Failed to update transaction status:', updateError);
      }
    }

    return res.status(500).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred while processing your electricity purchase'
    });
  }
});

module.exports = router;
