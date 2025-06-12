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

// Valid cable TV service providers
const CABLE_TV_SERVICES = ['dstv', 'gotv', 'startimes', 'showmax'];
const VALID_SUBSCRIPTION_TYPES = ['change', 'renew'];

/**
 * Generate a unique order ID
 */
function generateUniqueOrderId() {
  const timestamp = Date.now();
  const randomBytes = crypto.randomBytes(4).toString('hex');
  return `cabletv_order_${timestamp}_${randomBytes}`;
}

/**
 * Generate a unique request ID based on user ID and timestamp
 */
function generateUniqueRequestId(userId) {
  const timestamp = Date.now();
  const randomSuffix = crypto.randomBytes(2).toString('hex');
  return `cabletv_req_${userId}_${timestamp}_${randomSuffix}`;
}

/**
 * Get package price from eBills variations API - FIXED to use VTUAuth properly
 */
async function getPackagePrice(service_id, variation_id) {
  try {
    // 🔑 KEY FIX: Use VTUAuth to make authenticated request
    const variationsResponse = await vtuAuth.makeRequest(
      'GET',
      `/api/v2/variations/tv/${service_id}`,
      null,
      { 
        timeout: 15000, 
        baseURL: EBILLS_BASE_URL, 
        headers: { 'Accept': 'application/json' } 
      }
    );
    
    if (variationsResponse.code !== 'success') {
      throw new Error('Failed to fetch package variations');
    }
    
    const selectedPackage = variationsResponse.data.find(pkg => pkg.variation_id === variation_id);
    if (!selectedPackage) {
      throw new Error(`Package with variation_id ${variation_id} not found`);
    }
    
    return {
      price: parseFloat(selectedPackage.price),
      name: selectedPackage.name,
      description: selectedPackage.description
    };
  } catch (error) {
    logger.error('Failed to get package price:', error.message);
    throw error;
  }
}

/**
 * Validate customer and get expected amount - FIXED to use VTUAuth properly
 */
async function validateCustomerAndGetAmount(customer_id, service_id, variation_id, subscription_type) {
  try {
    const verificationPayload = {
      customer_id: customer_id.trim(),
      service_id
    };
    
    if (variation_id) {
      verificationPayload.variation_id = variation_id;
    }
    
    // 🔑 KEY FIX: Use VTUAuth to make authenticated request
    const verificationResponse = await vtuAuth.makeRequest(
      'POST',
      '/api/v2/verify-customer',
      verificationPayload,
      {
        timeout: 15000,
        baseURL: EBILLS_BASE_URL,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
      }
    );
    
    if (verificationResponse.code !== 'success') {
      throw new Error(`Customer verification failed: ${verificationResponse.message}`);
    }
    
    let expectedAmount = null;
    let customerInfo = verificationResponse.data;
    
    // For renewal subscriptions, use the renewal_amount from verification
    if (subscription_type === 'renew' && customerInfo.renewal_amount) {
      expectedAmount = parseFloat(customerInfo.renewal_amount);
    }
    // For change subscriptions, get package price from variations
    else if (subscription_type === 'change') {
      const packageInfo = await getPackagePrice(service_id, variation_id);
      expectedAmount = packageInfo.price;
      customerInfo.package_info = packageInfo;
    }
    
    return { customerInfo, expectedAmount, isValid: true };
    
  } catch (error) {
    logger.error('Customer validation error:', error);
    return { customerInfo: null, expectedAmount: null, isValid: false, error: error.message };
  }
}

/**
 * Validate that user amount matches package price
 */
function validateAmountMatchesPackage(userAmount, expectedAmount, tolerance = 0.01) {
  if (!expectedAmount) {
    return {
      isValid: false,
      error: 'PACKAGE_PRICE_NOT_FOUND',
      message: 'Could not determine the correct price for this package'
    };
  }
  
  const difference = Math.abs(userAmount - expectedAmount);
  
  if (difference > tolerance) {
    return {
      isValid: false,
      error: 'AMOUNT_PACKAGE_MISMATCH',
      message: `Amount mismatch: You provided ₦${userAmount} but the selected package costs ₦${expectedAmount}`,
      providedAmount: userAmount,
      expectedAmount: expectedAmount,
      difference: difference
    };
  }
  
  return { isValid: true, providedAmount: userAmount, expectedAmount: expectedAmount };
}

/**
 * Enhanced validation with price verification
 */
function validateCableTVRequest(body) {
  const errors = [];
  const sanitized = {};
  
  if (!body.customer_id) {
    errors.push('Customer ID (smartcard/IUC number) is required');
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
    if (!CABLE_TV_SERVICES.includes(sanitized.service_id)) {
      errors.push(`Invalid service ID. Must be one of: ${CABLE_TV_SERVICES.join(', ')}`);
    }
  }
  
  if (!body.variation_id) {
    errors.push('Variation ID (package/bouquet) is required');
  } else {
    sanitized.variation_id = String(body.variation_id).trim();
    if (sanitized.variation_id.length === 0) {
      errors.push('Variation ID must be a non-empty string');
    }
  }
  
  // Handle subscription_type (defaults to 'change')
  if (body.subscription_type) {
    sanitized.subscription_type = String(body.subscription_type).toLowerCase().trim();
    if (!VALID_SUBSCRIPTION_TYPES.includes(sanitized.subscription_type)) {
      errors.push('Subscription type must be "change" or "renew"');
    }
  } else {
    sanitized.subscription_type = 'change';
  }
  
  // Amount is required for security validation
  if (!body.amount) {
    errors.push('Amount is required for package price verification');
  } else {
    const numericAmount = Number(body.amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      errors.push('Amount must be a positive number');
    } else if (numericAmount > 50000) {
      errors.push('Amount above maximum. Maximum is ₦50,000');
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
  
  return { isValid: errors.length === 0, errors, sanitized };
}

/**
 * Validate NGNB limits
 */
function validateNGNBLimits(amount) {
  const MIN_NGNB = 500;
  const MAX_NGNB = 50000;
  
  if (amount < MIN_NGNB) {
    return {
      isValid: false,
      error: 'NGNB_MINIMUM_NOT_MET',
      message: `Minimum NGNB cable TV purchase amount is ${MIN_NGNB} NGNB. Your amount: ${amount} NGNB.`,
      minimumRequired: MIN_NGNB,
      providedAmount: amount
    };
  }
  
  if (amount > MAX_NGNB) {
    return {
      isValid: false,
      error: 'NGNB_MAXIMUM_EXCEEDED',
      message: `Maximum NGNB cable TV purchase amount is ${MAX_NGNB} NGNB. Your amount: ${amount} NGNB.`,
      maximumAllowed: MAX_NGNB,
      providedAmount: amount
    };
  }
  
  return { isValid: true };
}

/**
 * Check for existing pending transactions to prevent duplicates
 */
async function checkForPendingTransactions(userId, customOrderId, customRequestId) {
  const pendingTransactions = await BillTransaction.find({
    $or: [
      { userId: userId, billType: 'cable_tv', status: { $in: ['initiated-api', 'processing-api', 'pending'] } },
      { orderId: customOrderId },
      { requestId: customRequestId }
    ],
    createdAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) } // Last 5 minutes
  });
  
  return pendingTransactions.length > 0;
}

/**
 * Call eBills API for cable TV purchase - FIXED to use VTUAuth properly
 * @param {Object} params - API parameters
 * @returns {Promise<Object>} eBills API response
 */
async function callEBillsCableTVAPI({ customer_id, service_id, variation_id, subscription_type, amount, request_id, userId }) {
  try {
    const apiPayload = {
      request_id: request_id,
      customer_id: customer_id.trim(),
      service_id,
      variation_id,
      subscription_type
    };
    
    if (subscription_type === 'renew' || amount) {
      apiPayload.amount = parseInt(amount);
    }

    logger.info('Making eBills cable TV purchase request:', {
      customer_id,
      service_id,
      variation_id,
      subscription_type,
      amount,
      request_id,
      endpoint: '/api/v2/tv'
    });

    // 🔑 KEY FIX: Use VTUAuth to make authenticated request instead of direct axios
    const response = await vtuAuth.makeRequest('POST', '/api/v2/tv', apiPayload, {
      timeout: 45000,
      baseURL: EBILLS_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    logger.info(`eBills cable TV API response for ${request_id}:`, {
      code: response.code,
      message: response.message,
      data: response.data
    });

    // Handle eBills API response structure
    if (response.code !== 'success') {
      throw new Error(`eBills Cable TV API error: ${response.message || 'Unknown error'}`);
    }

    return response;

  } catch (error) {
    logger.error('❌ eBills cable TV purchase failed:', {
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
      throw new Error('Invalid cable TV service provider. Please check and try again.');
    }

    if (error.response?.status === 422) {
      const validationErrors = error.response.data?.errors || {};
      const errorMessages = Object.values(validationErrors).flat();
      throw new Error(`Validation error: ${errorMessages.join(', ')}`);
    }

    throw new Error(`eBills Cable TV API error: ${error.message}`);
  }
}

/**
 * Main cable TV purchase endpoint with guaranteed unique order IDs
 */
router.post('/purchase', async (req, res) => {
  let reservationMade = false;
  let transactionCreated = false;
  let pendingTransaction = null;
  let ebillsResponse = null;

  try {
    const requestBody = req.body;
    const userId = req.user.id;
    
    logger.info(`Cable TV purchase request from user ${userId}:`, requestBody);
    
    // Step 1: Validate request
    const validation = validateCableTVRequest(requestBody);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors
      });
    }
    
    const { customer_id, service_id, variation_id, subscription_type, amount, twoFactorCode } = validation.sanitized;
    const currency = 'NGNB';
    
    // Step 2: Generate unique IDs
    const uniqueOrderId = generateUniqueOrderId();
    const uniqueRequestId = generateUniqueRequestId(userId);
    
    logger.info(`Generated unique IDs - OrderID: ${uniqueOrderId}, RequestID: ${uniqueRequestId}`);
    
    // Step 3: Check for duplicate/pending transactions
    const hasPendingTransactions = await checkForPendingTransactions(userId, uniqueOrderId, uniqueRequestId);
    if (hasPendingTransactions) {
      return res.status(409).json({
        success: false,
        error: 'DUPLICATE_OR_PENDING_TRANSACTION',
        message: 'You have a pending cable TV transaction or duplicate IDs detected. Please wait before making another purchase.'
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
      logger.warn('Invalid 2FA attempt for cable TV purchase', { userId });
      return res.status(401).json({
        success: false,
        message: 'Invalid two-factor authentication code'
      });
    }

    logger.info('2FA validation successful for cable TV purchase', { 
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
      userId 
    });

    // Step 5: Validate customer and get expected amount
    const customerValidation = await validateCustomerAndGetAmount(
      customer_id, service_id, variation_id, subscription_type
    );

    if (!customerValidation.isValid) {
      return res.status(400).json({
        success: false,
        error: 'CUSTOMER_VALIDATION_FAILED',
        message: customerValidation.error || 'Customer validation failed',
        details: { customer_id, service_id, variation_id, subscription_type }
      });
    }

    // Step 6: Verify amount matches package price
    const amountValidation = validateAmountMatchesPackage(amount, customerValidation.expectedAmount);

    if (!amountValidation.isValid) {
      return res.status(400).json({
        success: false,
        error: amountValidation.error,
        message: amountValidation.message,
        details: {
          customer_id,
          customer_name: customerValidation.customerInfo?.customer_name,
          service_id,
          variation_id,
          subscription_type,
          provided_amount: amountValidation.providedAmount,
          expected_amount: amountValidation.expectedAmount,
          difference: amountValidation.difference,
          package_info: customerValidation.customerInfo?.package_info
        },
        security_note: 'Amount must match the exact package price for security'
      });
    }

    // Step 7: Use verified amount
    const purchaseAmount = customerValidation.expectedAmount;
    const ngnbAmount = purchaseAmount;
    const ngnbToUsdRate = 1 / 1554.42;
    
    logger.info(`NGNB amount needed: ₦${purchaseAmount} → ${ngnbAmount} NGNB (1:1 ratio)`);
    
    // Step 8: Validate NGNB limits
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
          maximumAllowed: ngnbLimitValidation.maximumAllowed
        }
      });
    }
    
    // Step 9: Validate user balance
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

    logger.info('Cable TV purchase NGNB balance validation successful', {
      userId,
      customer_id,
      amount: purchaseAmount,
      payment_currency: currency,
      availableBalance: balanceValidation.availableBalance,
      requiredAmount: ngnbAmount,
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' ')
    });

    // Step 10: Create transaction record with unique order ID
    const initialTransactionData = {
      orderId: uniqueOrderId, // Guaranteed unique order ID
      status: 'initiated-api',
      productName: 'Cable TV',
      billType: 'cable_tv',
      quantity: 1,
      amount: purchaseAmount,
      amountNaira: purchaseAmount,
      amountCrypto: ngnbAmount,
      paymentCurrency: currency,
      cryptoPrice: ngnbToUsdRate,
      requestId: uniqueRequestId, // Guaranteed unique request ID
      metaData: {
        customer_id,
        service_id,
        variation_id,
        subscription_type,
        user_id: userId,
        payment_currency: currency,
        balance_reserved: false,
        purchase_amount_usd: (ngnbAmount * ngnbToUsdRate).toFixed(2),
        is_ngnb_transaction: true,
        twofa_validated: true,
        price_verified: true,
        expected_amount: customerValidation.expectedAmount,
        customer_info: customerValidation.customerInfo,
        unique_order_id: uniqueOrderId,
        unique_request_id: uniqueRequestId,
        order_id_type: 'system_generated_unique'
      },
      network: service_id.toUpperCase(),
      customerPhone: customer_id,
      userId: userId,
      timestamp: new Date(),
      webhookProcessedAt: null
    };
    
    pendingTransaction = await BillTransaction.create(initialTransactionData);
    transactionCreated = true;
    
    logger.info(`📋 Bill transaction ${uniqueOrderId}: initiated-api | cable_tv | ${ngnbAmount} NGNB | ✅ 2FA | ⚠️ Not Reserved`);
    logger.info(`Created cable TV transaction ${pendingTransaction._id} with unique OrderID: ${uniqueOrderId}, RequestID: ${uniqueRequestId}`);
    
    // Step 11: Call eBills API FIRST (before reserving balance) - FIXED to use VTUAuth
    try {
      logger.info(`Calling eBills cable TV API with unique RequestID: ${uniqueRequestId}...`);
      
      // 🔑 CRITICAL FIX: Use the fixed callEBillsCableTVAPI function that uses VTUAuth properly
      ebillsResponse = await callEBillsCableTVAPI({
        customer_id,
        service_id,
        variation_id,
        subscription_type,
        amount: purchaseAmount,
        request_id: uniqueRequestId,
        userId
      });
      
    } catch (apiError) {
      logger.error(`eBills cable TV API call failed:`, {
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
        errorMessage = 'eBills Cable TV API request timed out. Please try again.';
        errorCode = 'EBILLS_TIMEOUT';
      } else if (errorData) {
        switch (errorData.code) {
          case 'duplicate_request_id':
            statusCode = 409;
            errorMessage = 'Duplicate request detected by eBills API. Please try again.';
            errorCode = 'DUPLICATE_REQUEST';
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
        note: 'No balance was reserved since the eBills API call failed',
        details: {
          unique_order_id: uniqueOrderId,
          unique_request_id: uniqueRequestId,
          userId: userId,
          customer_id,
          service_id,
          variation_id,
          subscription_type,
          amount: purchaseAmount
        }
      });
    }
    
    // Step 12: eBills API SUCCESS! Now reserve user balance
    try {
      logger.info(`eBills cable TV API successful for ${uniqueRequestId}. Now reserving balance...`);
      
      await reserveUserBalance(userId, currency, ngnbAmount);
      reservationMade = true;
      
      await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { 
        'metaData.balance_reserved': true,
        'metaData.balance_reserved_at': new Date()
      });
      
      logger.info(`📋 Bill transaction ${uniqueOrderId}: initiated-api | cable_tv | ${ngnbAmount} NGNB | ✅ 2FA | ✅ Reserved`);
      logger.info(`Successfully reserved ${ngnbAmount} ${currency} for user ${userId} after eBills cable TV API success`);
      
    } catch (balanceError) {
      logger.error(`CRITICAL: Balance reservation failed after successful eBills cable TV API call:`, {
        unique_order_id: uniqueOrderId,
        unique_request_id: uniqueRequestId,
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
        message: 'eBills cable TV succeeded but balance reservation failed. Contact support.',
        details: {
          orderId: uniqueOrderId,
          requestId: uniqueRequestId,
          ebills_order_id: ebillsResponse.data?.order_id,
          ebills_status: ebillsResponse.data?.status,
          customer_id,
          amount: purchaseAmount
        },
        transaction: pendingTransaction,
        support_note: 'Manual intervention required'
      });
    }
    
    // Step 13: Update transaction with eBills data while keeping our unique order ID
    const updatedTransactionData = {
      // Keep our unique orderId but store eBills order_id in metadata
      status: ebillsResponse.data.status,
      productName: ebillsResponse.data.product_name,
      metaData: {
        ...initialTransactionData.metaData,
        service_name: ebillsResponse.data.service_name,
        customer_name: ebillsResponse.data.customer_name,
        discount: ebillsResponse.data.discount,
        amount_charged: ebillsResponse.data.amount_charged,
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
    
    logger.info(`Cable TV transaction updated. Our OrderID: ${uniqueOrderId}, eBills OrderID: ${ebillsResponse.data.order_id}, Status: ${ebillsResponse.data.status}`);
    
    // Step 14: Return response based on status
    const responseData = {
      order_id: uniqueOrderId, // Return our unique order ID
      ebills_order_id: ebillsResponse.data.order_id, // Also provide eBills order ID
      request_id: uniqueRequestId,
      status: ebillsResponse.data.status,
      service_name: ebillsResponse.data.service_name,
      customer_id: ebillsResponse.data.customer_id,
      customer_name: ebillsResponse.data.customer_name,
      amount: ebillsResponse.data.amount,
      amount_charged: ebillsResponse.data.amount_charged,
      discount: ebillsResponse.data.discount,
      subscription_type: subscription_type,
      package_variation: variation_id,
      payment_details: {
        currency: currency,
        ngnb_amount: ngnbAmount,
        amount_usd: (ngnbAmount * ngnbToUsdRate).toFixed(2)
      },
      security_info: {
        price_verified: true,
        expected_amount: customerValidation.expectedAmount,
        twofa_validated: true,
        unique_ids_generated: true
      }
    };

    if (ebillsResponse.data.status === 'completed-api') {
      logger.info(`✅ Cable TV purchase completed immediately for user ${userId}, order ${uniqueOrderId}`);
      
      return res.status(200).json({
        success: true,
        message: 'Cable TV purchase completed successfully',
        data: responseData,
        transaction: finalTransaction
      });
    } else if (ebillsResponse.data.status === 'processing-api') {
      logger.info(`⏳ Cable TV purchase processing for user ${userId}, order ${uniqueOrderId}`);
      
      return res.status(202).json({
        success: true,
        message: 'Cable TV purchase is being processed',
        data: responseData,
        transaction: finalTransaction,
        note: 'You will receive a notification when activated'
      });
    } else if (ebillsResponse.data.status === 'refunded') {
      return res.status(200).json({
        success: true,
        message: 'Cable TV purchase was refunded',
        data: responseData,
        transaction: finalTransaction,
        note: 'Your balance will be restored automatically'
      });
    } else {
      return res.status(200).json({
        success: true,
        message: `Cable TV purchase status: ${ebillsResponse.data.status}`,
        data: responseData,
        transaction: finalTransaction
      });
    }
    
  } catch (error) {
    logger.error('Cable TV purchase error:', { userId: req.user?.id, error: error.message });

    // Cleanup
    if (reservationMade && validation?.sanitized) {
      try {
        await releaseReservedBalance(userId, currency, validation.sanitized.amount || 0);
        logger.info('🔄 Released reserved balance due to post-API error', { 
          userId, 
          currency: currency, 
          amount: validation.sanitized.amount || 0 
        });
      } catch (releaseError) {
        logger.error('Failed to release balance:', releaseError);
      }
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