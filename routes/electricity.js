const express = require('express');
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { vtuAuth } = require('../auth/billauth');
const { validateUserBalance } = require('../services/balance');
const { reserveUserBalance, releaseReservedBalance } = require('../services/portfolio');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const logger = require('../utils/logger');
const crypto = require('crypto');

const router = express.Router();
const EBILLS_BASE_URL = process.env.EBILLS_BASE_URL || 'https://ebills.africa/wp-json';

// Valid electricity service providers
const ELECTRICITY_SERVICES = [
  'ikeja-electric', 'eko-electric', 'kano-electric', 'portharcourt-electric',
  'jos-electric', 'ibadan-electric', 'kaduna-electric', 'abuja-electric',
  'enugu-electric', 'benin-electric', 'aba-electric', 'yola-electric'
];

const VALID_METER_TYPES = ['prepaid', 'postpaid'];

/**
 * Generate a unique order ID for electricity
 */
function generateUniqueElectricityOrderId() {
  const timestamp = Date.now();
  const randomBytes = crypto.randomBytes(4).toString('hex');
  return `electricity_order_${timestamp}_${randomBytes}`;
}

/**
 * Generate a unique request ID for electricity based on user ID and timestamp
 */
function generateUniqueElectricityRequestId(userId) {
  const timestamp = Date.now();
  const randomSuffix = crypto.randomBytes(2).toString('hex');
  return `electricity_req_${userId}_${timestamp}_${randomSuffix}`;
}

/**
 * Check for existing pending electricity transactions to prevent duplicates
 */
async function checkForPendingElectricityTransactions(userId, customOrderId, customRequestId) {
  const pendingTransactions = await BillTransaction.find({
    $or: [
      { userId: userId, billType: 'electricity', status: { $in: ['initiated-api', 'processing-api', 'pending'] } },
      { orderId: customOrderId },
      { requestId: customRequestId }
    ],
    createdAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) } // Last 5 minutes
  });
  
  return pendingTransactions.length > 0;
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
 * Validate electricity purchase request - NGNB ONLY with 2FA
 */
function validateElectricityRequest(body) {
  const errors = [];
  const sanitized = {};
  
  if (!body.customer_id) {
    errors.push('Customer ID (meter/account number) is required');
  } else {
    sanitized.customer_id = String(body.customer_id).trim();
    if (sanitized.customer_id.length === 0) {
      errors.push('Customer ID must be a non-empty string');
    }
  }
  
  if (!body.service_id) {
    errors.push('Service ID is required');
  } else {
    sanitized.service_id = String(body.service_id).toLowerCase().trim();
    if (!ELECTRICITY_SERVICES.includes(sanitized.service_id)) {
      errors.push(`Invalid service ID. Must be one of: ${ELECTRICITY_SERVICES.join(', ')}`);
    }
  }
  
  if (!body.variation_id) {
    errors.push('Variation ID (meter type) is required');
  } else {
    sanitized.variation_id = String(body.variation_id).toLowerCase().trim();
    if (!VALID_METER_TYPES.includes(sanitized.variation_id)) {
      errors.push('Variation ID must be "prepaid" or "postpaid"');
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
    } else {
      sanitized.amount = numericAmount;
    }
  }
  
  // NGNB is now the only accepted currency
  if (!body.payment_currency) {
    errors.push('Payment currency is required and must be NGNB');
  } else if (body.payment_currency.toUpperCase() !== 'NGNB') {
    errors.push('Payment currency must be NGNB only');
  } else {
    sanitized.payment_currency = 'NGNB';
  }
  
  // Validate 2FA code
  if (!body.twoFactorCode?.trim()) {
    errors.push('Two-factor authentication code is required');
  } else {
    sanitized.twoFactorCode = String(body.twoFactorCode).trim();
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    sanitized
  };
}

/**
 * Validate NGNB transaction limits for electricity
 */
function validateNGNBLimits(amount) {
  const MIN_NGNB = 1000; // Higher minimum for electricity purchases
  const MAX_NGNB = 100000; // Higher limit for electricity purchases
  
  if (amount < MIN_NGNB) {
    return {
      isValid: false,
      error: 'NGNB_MINIMUM_NOT_MET',
      message: `Minimum NGNB electricity purchase amount is ${MIN_NGNB} NGNB. Your amount: ${amount} NGNB.`,
      minimumRequired: MIN_NGNB,
      providedAmount: amount
    };
  }
  
  if (amount > MAX_NGNB) {
    return {
      isValid: false,
      error: 'NGNB_MAXIMUM_EXCEEDED',
      message: `Maximum NGNB electricity purchase amount is ${MAX_NGNB} NGNB. Your amount: ${amount} NGNB.`,
      maximumAllowed: MAX_NGNB,
      providedAmount: amount
    };
  }
  
  return { isValid: true };
}

/**
 * Call eBills API for electricity purchase - FIXED to use VTUAuth properly
 * @param {Object} params - API parameters
 * @returns {Promise<Object>} eBills API response
 */
async function callEBillsElectricityAPI({ customer_id, service_id, variation_id, amount, request_id, userId }) {
  try {
    const payload = {
      request_id: request_id,
      customer_id: customer_id.trim(),
      service_id,
      variation_id,
      amount: parseInt(amount) // Ensure integer as per API spec
    };

    logger.info('Making eBills electricity purchase request:', {
      customer_id,
      service_id,
      variation_id,
      amount,
      request_id,
      endpoint: '/api/v2/electricity'
    });

    // 🔑 KEY FIX: Use VTUAuth to make authenticated request instead of direct axios
    const response = await vtuAuth.makeRequest('POST', '/api/v2/electricity', payload, {
      timeout: 45000,
      baseURL: EBILLS_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    logger.info(`eBills Electricity API response for ${request_id}:`, {
      code: response.code,
      message: response.message,
      data: response.data
    });

    // Handle eBills API response structure
    if (response.code !== 'success') {
      throw new Error(`eBills Electricity API error: ${response.message || 'Unknown error'}`);
    }

    return response;

  } catch (error) {
    logger.error('❌ eBills electricity purchase failed:', {
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
      throw new Error('Invalid electricity service provider. Please check and try again.');
    }

    if (error.message.includes('invalid variation_id')) {
      throw new Error('Invalid meter type (must be prepaid or postpaid). Please check and try again.');
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
 * Main electricity purchase endpoint with guaranteed unique order IDs - NGNB ONLY with 2FA
 */
router.post('/purchase', async (req, res) => {
  let reservationMade = false;
  let transactionCreated = false;
  let pendingTransaction = null;
  let ebillsResponse = null;

  try {
    const requestBody = req.body;
    const userId = req.user.id;
    
    logger.info(`Electricity purchase request from user ${userId}:`, requestBody);
    
    // Step 1: Validate request structure and use sanitized data
    const validation = validateElectricityRequest(requestBody);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors
      });
    }
    
    const { customer_id, service_id, variation_id, amount, payment_currency, twoFactorCode } = validation.sanitized;
    const currency = 'NGNB'; // Force NGNB as the only currency
    
    // Step 2: Generate unique IDs
    const uniqueOrderId = generateUniqueElectricityOrderId();
    const uniqueRequestId = generateUniqueElectricityRequestId(userId);
    
    logger.info(`Generated unique electricity IDs - OrderID: ${uniqueOrderId}, RequestID: ${uniqueRequestId}`);
    
    // Step 3: Check for duplicate/pending transactions
    const hasPendingTransactions = await checkForPendingElectricityTransactions(userId, uniqueOrderId, uniqueRequestId);
    if (hasPendingTransactions) {
      return res.status(409).json({
        success: false,
        error: 'DUPLICATE_OR_PENDING_TRANSACTION',
        message: 'You have a pending electricity transaction or duplicate IDs detected. Please wait before making another purchase.'
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
      logger.warn('Invalid 2FA attempt for electricity purchase', { userId });
      return res.status(401).json({
        success: false,
        message: 'Invalid two-factor authentication code'
      });
    }

    logger.info('2FA validation successful for electricity purchase', { 
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
      userId 
    });
    
    // Step 5: Calculate NGNB amount needed (1:1 with Naira)
    const ngnbAmount = amount; // NGNB is 1:1 with Naira
    const ngnbToUsdRate = 1 / 1554.42; // Approximate NGNB to USD rate
    
    logger.info(`NGNB calculation: ₦${amount} = ${ngnbAmount} NGNB (1:1 rate)`);
    
    // Step 6: Validate NGNB limits
    const ngnbLimitValidation = validateNGNBLimits(ngnbAmount);
    if (!ngnbLimitValidation.isValid) {
      return res.status(400).json({
        success: false,
        error: ngnbLimitValidation.error,
        message: ngnbLimitValidation.message,
        details: {
          currency: currency,
          providedAmount: ngnbLimitValidation.providedAmount,
          minimumRequired: ngnbLimitValidation.minimumRequired,
          maximumAllowed: ngnbLimitValidation.maximumAllowed,
          electricityAmount: amount,
          serviceProvider: service_id,
          meterType: variation_id
        }
      });
    }
    
    // Step 7: Validate user balance ONLY (don't reserve yet!)
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
          shortfall: balanceValidation.shortfall,
          electricityAmount: amount,
          electricityAmountUSD: (ngnbAmount * ngnbToUsdRate).toFixed(2),
          serviceProvider: service_id,
          meterType: variation_id
        }
      });
    }

    logger.info('Electricity purchase NGNB balance validation successful', {
      userId,
      customer_id,
      amount,
      payment_currency: currency,
      availableBalance: balanceValidation.availableBalance,
      requiredAmount: ngnbAmount,
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' ')
    });

    // Step 8: Create transaction record with unique order ID (NO BALANCE RESERVATION YET)
    const initialTransactionData = {
      orderId: uniqueOrderId, // Guaranteed unique order ID
      status: 'initiated-api',
      productName: 'Electricity',
      billType: 'electricity',
      quantity: 1,
      amount: amount,
      amountNaira: amount,
      amountCrypto: ngnbAmount,
      paymentCurrency: currency,
      cryptoPrice: ngnbToUsdRate,
      requestId: uniqueRequestId, // Guaranteed unique request ID
      metaData: {
        customer_id,
        service_id,
        variation_id,
        meter_type: variation_id,
        user_id: userId,
        payment_currency: currency,
        crypto_price: ngnbToUsdRate,
        balance_reserved: false,
        purchase_amount_usd: (ngnbAmount * ngnbToUsdRate).toFixed(2),
        is_ngnb_transaction: true,
        twofa_validated: true,
        unique_order_id: uniqueOrderId,
        unique_request_id: uniqueRequestId,
        order_id_type: 'system_generated_unique'
      },
      network: service_id.toUpperCase(),
      customerPhone: customer_id, // Store customer_id in customerPhone field for consistency
      customerInfo: {
        customer_id,
        service_provider: service_id,
        meter_type: variation_id
      },
      userId: userId,
      timestamp: new Date(),
      webhookProcessedAt: null
    };
    
    pendingTransaction = await BillTransaction.create(initialTransactionData);
    transactionCreated = true;
    
    logger.info(`📋 Bill transaction ${uniqueOrderId}: initiated-api | electricity | ${ngnbAmount} NGNB | ✅ 2FA | ⚠️ Not Reserved`);
    logger.info(`Created electricity transaction ${pendingTransaction._id} with unique OrderID: ${uniqueOrderId}, RequestID: ${uniqueRequestId}`);
    
    // Step 9: Call eBills API FIRST (before reserving balance) - FIXED to use VTUAuth
    try {
      logger.info(`Calling eBills Electricity API with unique RequestID: ${uniqueRequestId}...`);
      
      // 🔑 CRITICAL FIX: Use the fixed callEBillsElectricityAPI function that uses VTUAuth properly
      ebillsResponse = await callEBillsElectricityAPI({
        customer_id,
        service_id,
        variation_id,
        amount,
        request_id: uniqueRequestId,
        userId
      });
      
    } catch (apiError) {
      logger.error('eBills Electricity API call failed:', {
        error: apiError.message,
        unique_order_id: uniqueOrderId,
        unique_request_id: uniqueRequestId,
        userId: userId,
        response: apiError.response?.data,
        status: apiError.response?.status,
        timeout: apiError.code === 'ECONNABORTED' || apiError.message.includes('timeout')
      });
      
      // Update transaction status to failed (NO balance reservation since API failed)
      await BillTransaction.findByIdAndUpdate(
        pendingTransaction._id,
        { 
          status: 'failed',
          processingErrors: [{
            error: apiError.message,
            timestamp: new Date(),
            phase: 'ebills_electricity_api_call'
          }]
        }
      );
      
      const errorData = apiError.response?.data;
      let statusCode = apiError.response?.status || 500;
      let errorMessage = apiError.message;
      let errorCode = 'EBILLS_ELECTRICITY_API_ERROR';
      
      if (apiError.code === 'ECONNABORTED' || apiError.message.includes('timeout')) {
        statusCode = 504;
        errorMessage = 'eBills Electricity API request timed out. Please try again.';
        errorCode = 'EBILLS_TIMEOUT';
      } else if (errorData) {
        switch (errorData.code) {
          case 'missing_fields':
            statusCode = 400;
            errorMessage = 'Required fields missing';
            errorCode = 'MISSING_FIELDS';
            break;
          case 'invalid_service_id':
            statusCode = 400;
            errorMessage = 'Invalid electricity service provider';
            errorCode = 'INVALID_SERVICE_ID';
            break;
          case 'invalid_variation_id':
            statusCode = 400;
            errorMessage = 'Invalid meter type (must be prepaid or postpaid)';
            errorCode = 'INVALID_VARIATION_ID';
            break;
          case 'below_minimum_amount':
            statusCode = 400;
            errorMessage = 'Amount below minimum purchase requirement';
            errorCode = 'AMOUNT_TOO_LOW';
            break;
          case 'below_customer_arrears':
            statusCode = 400;
            errorMessage = 'Amount below customer arrears requirement';
            errorCode = 'ARREARS_NOT_COVERED';
            break;
          case 'insufficient_funds':
            statusCode = 502;
            errorMessage = 'Service temporarily unavailable (provider insufficient funds)';
            errorCode = 'PROVIDER_INSUFFICIENT_FUNDS';
            break;
          case 'duplicate_request_id':
            statusCode = 409;
            errorMessage = 'Duplicate request detected by eBills API. Please try again.';
            errorCode = 'DUPLICATE_REQUEST';
            break;
          case 'duplicate_order':
            statusCode = 409;
            errorMessage = 'Duplicate order within 3 minutes';
            errorCode = 'DUPLICATE_ORDER';
            break;
          case 'rest_forbidden':
            statusCode = 403;
            errorMessage = 'Unauthorized access to eBills API';
            errorCode = 'EBILLS_AUTH_ERROR';
            break;
          default:
            errorMessage = errorData.message || errorMessage;
        }
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
        note: 'No balance was reserved since the eBills Electricity API call failed',
        details: {
          unique_order_id: uniqueOrderId,
          unique_request_id: uniqueRequestId,
          userId: userId,
          customer_id,
          service_id,
          variation_id,
          amount,
          amount_usd: (ngnbAmount * ngnbToUsdRate).toFixed(2),
          meter_type: variation_id
        }
      });
    }
    
    // Step 10: eBills Electricity API SUCCESS! Now reserve user balance
    try {
      logger.info(`eBills Electricity API successful for ${uniqueRequestId}. Now reserving balance...`);
      
      await reserveUserBalance(userId, currency, ngnbAmount);
      reservationMade = true;
      
      await BillTransaction.findByIdAndUpdate(
        pendingTransaction._id,
        { 
          'metaData.balance_reserved': true,
          'metaData.balance_reserved_at': new Date()
        }
      );
      
      logger.info(`📋 Bill transaction ${uniqueOrderId}: initiated-api | electricity | ${ngnbAmount} NGNB | ✅ 2FA | ✅ Reserved`);
      logger.info(`Successfully reserved ${ngnbAmount} ${currency} for user ${userId} after eBills Electricity API success`);
      
    } catch (balanceError) {
      logger.error('CRITICAL: Balance reservation failed after successful eBills Electricity API call:', {
        unique_order_id: uniqueOrderId,
        unique_request_id: uniqueRequestId,
        userId,
        currency,
        ngnbAmount,
        error: balanceError.message,
        ebills_order_id: ebillsResponse.data?.order_id
      });
      
      await BillTransaction.findByIdAndUpdate(
        pendingTransaction._id,
        { 
          status: 'failed',
          processingErrors: [{
            error: `Balance reservation failed after eBills Electricity success: ${balanceError.message}`,
            timestamp: new Date(),
            phase: 'balance_reservation',
            ebills_order_id: ebillsResponse.data?.order_id
          }]
        }
      );
      
      return res.status(500).json({
        success: false,
        error: 'BALANCE_RESERVATION_FAILED',
        message: 'eBills electricity transaction succeeded but balance reservation failed. Please contact support immediately.',
        details: {
          orderId: uniqueOrderId,
          requestId: uniqueRequestId,
          ebills_order_id: ebillsResponse.data?.order_id,
          ebills_status: ebillsResponse.data?.status,
          service_name: ebillsResponse.data?.service_name,
          customer_name: ebillsResponse.data?.customer_name,
          amount: amount,
          amount_usd: (ngnbAmount * ngnbToUsdRate).toFixed(2),
          customer_id: customer_id
        },
        transaction: pendingTransaction,
        support_note: 'This requires manual intervention - eBills charged but balance not reserved'
      });
    }
    
    // Step 11: Update transaction with eBills response data while keeping our unique order ID
    const updatedTransactionData = {
      // Keep our unique orderId but store eBills order_id in metadata
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
        discount: ebillsResponse.data.discount,
        amount_charged: ebillsResponse.data.amount_charged,
        ebills_initial_balance: ebillsResponse.data.initial_balance,
        ebills_final_balance: ebillsResponse.data.final_balance,
        ebills_request_id: ebillsResponse.data.request_id,
        balance_reserved: true,
        balance_reserved_at: new Date(),
        twofa_validated: true,
        ebills_order_id: ebillsResponse.data.order_id, // Store eBills order ID separately
        order_id_type: 'system_generated_unique'
      }
    };
    
    const finalTransaction = await BillTransaction.findByIdAndUpdate(
      pendingTransaction._id,
      { $set: updatedTransactionData },
      { new: true }
    );
    
    logger.info(`Electricity transaction updated. Our OrderID: ${uniqueOrderId}, eBills OrderID: ${ebillsResponse.data.order_id}, Status: ${ebillsResponse.data.status}`);
    
    // Step 12: Handle different response statuses
    const responseData = {
      order_id: uniqueOrderId, // Return our unique order ID
      ebills_order_id: ebillsResponse.data.order_id, // Also provide eBills order ID
      request_id: uniqueRequestId,
      status: ebillsResponse.data.status,
      service_name: ebillsResponse.data.service_name,
      customer_id: ebillsResponse.data.customer_id,
      customer_name: ebillsResponse.data.customer_name,
      customer_address: ebillsResponse.data.customer_address,
      token: ebillsResponse.data.token,
      units: ebillsResponse.data.units,
      band: ebillsResponse.data.band,
      amount: ebillsResponse.data.amount,
      amount_charged: ebillsResponse.data.amount_charged,
      discount: ebillsResponse.data.discount,
      meter_type: variation_id,
      payment_details: {
        currency: currency,
        ngnb_amount: ngnbAmount,
        ngnb_to_usd_rate: ngnbToUsdRate,
        amount_usd: (ngnbAmount * ngnbToUsdRate).toFixed(2)
      },
      security_info: {
        twofa_validated: true,
        unique_ids_generated: true
      }
    };

    if (ebillsResponse.data.status === 'completed-api') {
      logger.info(`✅ Electricity purchase completed immediately for user ${userId}, order ${uniqueOrderId}`);
      
      return res.status(200).json({
        success: true,
        message: 'Electricity purchase completed successfully',
        data: responseData,
        transaction: finalTransaction
      });
      
    } else if (ebillsResponse.data.status === 'processing-api') {
      logger.info(`⏳ Electricity purchase processing for user ${userId}, order ${uniqueOrderId}`);
      
      return res.status(202).json({
        success: true,
        message: 'Electricity purchase is being processed',
        data: responseData,
        transaction: finalTransaction,
        note: 'You will receive a notification when the electricity units are generated'
      });
      
    } else if (ebillsResponse.data.status === 'refunded') {
      logger.info(`💰 Electricity purchase refunded for user ${userId}, order ${uniqueOrderId}`);
      
      return res.status(200).json({
        success: true,
        message: 'Electricity purchase was refunded',
        data: responseData,
        transaction: finalTransaction,
        note: 'Your balance will be restored automatically'
      });
      
    } else {
      logger.warn(`⚠️ Unexpected status ${ebillsResponse.data.status} for electricity order ${uniqueOrderId}`);
      
      return res.status(200).json({
        success: true,
        message: `Electricity purchase status: ${ebillsResponse.data.status}`,
        data: responseData,
        transaction: finalTransaction
      });
    }
    
  } catch (error) {
    logger.error('Electricity purchase unexpected error:', {
      userId: req.user?.id,
      error: error.message,
      reservationMade,
      transactionCreated,
      ebillsApiCalled: !!ebillsResponse
    });

    // Cleanup: Release reserved balance ONLY if reservation was made
    if (reservationMade && validation?.sanitized) {
      try {
        await releaseReservedBalance(userId, currency, validation.sanitized.amount || 0);
        logger.info('🔄 Released reserved balance due to post-API error', { 
          userId, 
          currency: currency, 
          amount: validation.sanitized.amount || 0 
        });
      } catch (releaseError) {
        logger.error('❌ Failed to release reserved balance after post-API error:', releaseError);
      }
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
        logger.error('Failed to update electricity transaction status after error:', updateError);
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