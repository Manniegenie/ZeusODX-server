const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { vtuAuth } = require('../auth/billauth'); // Import VTU authentication

// eBills API configuration
const EBILLS_BASE_URL = process.env.EBILLS_BASE_URL || 'https://ebills.africa/wp-json';
const { validateUserBalance } = require('../services/balance'); // Import balance validation
const { reserveUserBalance, releaseReservedBalance } = require('../services/portfolio'); // Import portfolio services
const { validateTwoFactorAuth } = require('../services/twofactorAuth'); // Import 2FA validation
const { validateTransactionLimit } = require('../services/kyccheckservice'); // Add KYC service import
const logger = require('../utils/logger');

// Creating a router instance
const router = express.Router();

/**
 * Validate phone number format according to eBills API specs
 * @param {string} phone - Phone number to validate
 * @returns {boolean} - True if valid
 */
function validatePhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return false;
  
  // Remove all non-digits and handle +234 format
  const cleanPhone = phone.replace(/\D/g, '');
  
  // eBills accepts 11-16 digits
  if (cleanPhone.length < 11 || cleanPhone.length > 16) return false;
  
  // Check if it starts with +234 (becomes 234 after cleaning)
  if (cleanPhone.startsWith('234')) {
    return cleanPhone.length >= 13 && cleanPhone.length <= 16; // 234 + 10-13 digits
  }
  
  // Check if it's a regular Nigerian number (starts with 0)
  if (cleanPhone.startsWith('0')) {
    return cleanPhone.length === 11; // 0 + 10 digits
  }
  
  // Other formats (international without +234)
  return cleanPhone.length >= 10 && cleanPhone.length <= 13;
}

/**
 * Sanitize and validate airtime request body - SIMPLIFIED for NGNZ only
 * @param {Object} body - Request body to validate
 * @returns {Object} - Validation result with isValid, errors, and sanitized data
 */
function validateAirtimeRequest(body) {
  const errors = [];
  const sanitized = {};
  
  // Sanitize and validate phone number
  if (!body.phone) {
    errors.push('Phone number is required');
  } else {
    sanitized.phone = String(body.phone).trim();
    if (!validatePhoneNumber(sanitized.phone)) {
      errors.push('Invalid phone number format');
    }
  }
  
  // Sanitize and validate service_id
  if (!body.service_id) {
    errors.push('Service ID is required');
  } else {
    sanitized.service_id = String(body.service_id).toLowerCase().trim();
    if (!['mtn', 'airtel', 'glo', '9mobile'].includes(sanitized.service_id)) {
      errors.push('Invalid service ID. Must be: mtn, airtel, glo, or 9mobile');
    }
  }
  
  // Sanitize and validate amount
  if (body.amount === undefined || body.amount === null || body.amount === '') {
    errors.push('Amount is required');
  } else {
    // Convert to number and sanitize
    const rawAmount = Number(body.amount);
    
    // Check for invalid numbers (NaN, Infinity, etc.)
    if (!Number.isFinite(rawAmount)) {
      errors.push('Amount must be a valid number');
    } else {
      // Ensure positive value and round to 2 decimal places to prevent precision issues
      sanitized.amount = Math.abs(Math.round(rawAmount * 100) / 100);
      
      // Check if original was negative (security check)
      if (rawAmount < 0) {
        errors.push('Amount cannot be negative');
      }
      
      // Check if amount is zero or effectively zero
      if (sanitized.amount <= 0) {
        errors.push('Amount must be greater than zero');
      } else {
        // Enforce 100 NGNZ minimum and 50,000 NGNZ maximum for ALL networks
        const minAmount = 100; // 100 NGNZ minimum
        const maxAmount = 50000; // 50,000 NGNZ maximum (hardcoded)
        
        if (sanitized.amount < minAmount) {
          errors.push(`Amount below minimum. Minimum airtime purchase is ${minAmount} NGNZ`);
        }
        
        if (sanitized.amount > maxAmount) {
          errors.push(`Amount above maximum. Maximum airtime purchase is ${maxAmount} NGNZ`);
        }
      }
    }
  }
  
  // Validate 2FA code
  if (!body.twoFactorCode?.trim()) {
    errors.push('Two-factor authentication code is required');
  } else {
    sanitized.twoFactorCode = String(body.twoFactorCode).trim();
  }
  
  // NGNZ is the only accepted payment currency - no validation needed, just set it
  sanitized.payment_currency = 'NGNZ';
  
  return {
    isValid: errors.length === 0,
    errors,
    sanitized
  };
}

/**
 * Call eBills API for airtime purchase - FIXED to use VTUAuth properly
 * @param {Object} params - API parameters
 * @returns {Promise<Object>} eBills API response
 */
async function callEBillsAPI({ phone, amount, service_id, request_id, userId }) {
  try {
    const payload = {
      phone: phone,
      amount: amount,
      service_id: service_id,
      request_id: request_id
    };

    logger.info('Making eBills airtime purchase request:', {
      phone,
      amount,
      service_id,
      request_id,
      endpoint: '/api/v2/airtime'
    });

    // 🔑 KEY FIX: Use VTUAuth to make authenticated request instead of direct axios
    const response = await vtuAuth.makeRequest('POST', '/api/v2/airtime', payload, {
      timeout: 45000 // 45 second timeout
    });

    logger.info(`eBills API response for ${request_id}:`, {
      code: response.code,
      message: response.message,
      data: response.data
    });

    // Handle eBills API response structure
    if (response.code !== 'success') {
      throw new Error(`eBills API error: ${response.message || 'Unknown error'}`);
    }

    return response;

  } catch (error) {
    logger.error('❌ eBills airtime purchase failed:', {
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

    throw new Error(`eBills API error: ${error.message}`);
  }
}

/**
 * Main airtime purchase endpoint - SIMPLIFIED for NGNZ only with 2FA and KYC
 * Note: Global auth middleware provides req.user.id
 */
router.post('/purchase', async (req, res) => {
  const startTime = Date.now();
  let reservationMade = false;
  let transactionCreated = false;
  let pendingTransaction = null;
  let ebillsResponse = null;

  try {
    const requestBody = req.body;
    const userId = req.user.id; // From global auth middleware
    
    logger.info(`Airtime purchase request from user ${userId}:`, requestBody);
    
    // Step 1: Validate request and use sanitized data
    const validation = validateAirtimeRequest(requestBody);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors
      });
    }
    
    // Use sanitized data instead of raw request body
    const { phone, service_id, amount, payment_currency, twoFactorCode } = validation.sanitized;
    const currency = 'NGNZ'; // Always NGNZ - no other currency accepted
    
    // Step 2: Validate user and 2FA
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
      logger.warn('Invalid 2FA attempt for airtime purchase', { userId });
      return res.status(401).json({
        success: false,
        message: 'Invalid two-factor authentication code'
      });
    }

    logger.info('2FA validation successful for airtime purchase', { 
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
      userId 
    });

    // ========================================
    // KYC LIMIT VALIDATION - NEW ADDITION
    // ========================================
    logger.info('Validating KYC limits for airtime purchase', { userId, amount, currency: 'NGNZ' });
    
    try {
      const kycValidation = await validateTransactionLimit(userId, amount, 'NGNZ', 'AIRTIME');
      
      if (!kycValidation.allowed) {
        logger.warn('Airtime purchase blocked by KYC limits', {
          userId,
          amount,
          currency: 'NGNZ',
          phone,
          service_id,
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
            transactionType: 'AIRTIME'
          }
        });
      }

      // Log successful KYC validation with details
      logger.info('KYC validation passed for airtime purchase', {
        userId,
        amount,
        currency: 'NGNZ',
        phone,
        service_id,
        kycLevel: kycValidation.data?.kycLevel,
        dailyRemaining: kycValidation.data?.dailyRemaining,
        monthlyRemaining: kycValidation.data?.monthlyRemaining,
        amountInNaira: kycValidation.data?.amountInNaira
      });

    } catch (kycError) {
      logger.error('KYC validation failed with error for airtime purchase', {
        userId,
        amount,
        currency: 'NGNZ',
        phone,
        service_id,
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
    // ========================================
    // END KYC VALIDATION
    // ========================================
    
    // Step 3: Check for existing pending transactions to prevent duplicates
    const existingPending = await BillTransaction.getUserPendingTransactions(userId, 'airtime', 5);
    if (existingPending.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'PENDING_TRANSACTION_EXISTS',
        message: 'You already have a pending airtime purchase. Please wait for it to complete.',
        details: {
          existingOrderId: existingPending[0].orderId,
          existingStatus: existingPending[0].status,
          createdAt: existingPending[0].createdAt
        }
      });
    }
    
    // Step 4: Use userId as request_id with unique orderId
    const finalRequestId = userId; // Direct mapping: userId = request_id
    const uniqueOrderId = `pending_${finalRequestId}_${Date.now()}`; // Make orderId unique
    
    logger.info(`Using userId as request_id: ${finalRequestId}, orderId: ${uniqueOrderId}`);
    
    // Step 5: SIMPLIFIED - No conversion needed, NGNZ amount equals Naira amount
    const ngnzAmount = amount; // 1:1 ratio since NGNZ is pegged to Naira
    
    logger.info(`NGNZ amount needed: ₦${amount} → ${ngnzAmount} NGNZ (1:1 ratio)`);
    
    // Step 6: Validate user NGNZ balance
    const balanceValidation = await validateUserBalance(userId, currency, ngnzAmount, {
      includeBalanceDetails: true,
      logValidation: true
    });
    
    if (!balanceValidation.success) {
      logger.warn('Airtime purchase NGNZ balance validation failed', {
        userId,
        phone,
        amount,
        payment_currency: currency,
        ngnzAmount,
        reason: balanceValidation.message,
        availableBalance: balanceValidation.availableBalance,
        requiredAmount: balanceValidation.requiredAmount,
        shortfall: balanceValidation.shortfall
      });
      
      return res.status(400).json({
        success: false,
        error: 'INSUFFICIENT_BALANCE',
        message: balanceValidation.message,
        details: {
          availableBalance: balanceValidation.availableBalance,
          requiredAmount: ngnzAmount,
          currency: currency,
          shortfall: balanceValidation.shortfall
        }
      });
    }

    logger.info('Airtime purchase NGNZ balance validation successful', {
      userId,
      phone,
      amount,
      payment_currency: currency,
      availableBalance: balanceValidation.availableBalance,
      requiredAmount: ngnzAmount,
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' ')
    });

    // Step 7: Create initial bill transaction record with pending status
    const initialTransactionData = {
      orderId: uniqueOrderId, // Unique orderId with timestamp
      status: 'initiated-api',
      productName: 'Airtime',
      billType: 'airtime',
      quantity: 1,
      amount: amount,
      amountNaira: amount,
      amountCrypto: ngnzAmount, // Legacy field for backward compatibility
      paymentCurrency: currency,
      cryptoPrice: 1, // 1:1 ratio with Naira
      requestId: finalRequestId, // userId as request_id
      metaData: {
        phone,
        network: service_id.toUpperCase(),
        service_id,
        user_id: userId,
        payment_currency: currency,
        ngnz_amount: ngnzAmount,
        exchange_rate: 1, // 1:1 ratio
        balance_reserved: false, // Track that balance isn't reserved yet
        twofa_validated: true, // Track that 2FA was validated
        kyc_validated: true, // Track that KYC was validated
        request_id_type: 'user_id_direct' // Track that we're using direct userId mapping
      },
      network: service_id.toUpperCase(),
      customerPhone: phone,
      customerInfo: {
        phone,
        network: service_id.toUpperCase()
      },
      userId: userId,
      timestamp: new Date(),
      webhookProcessedAt: null,
      balanceReserved: false, // New schema field
      twoFactorValidated: true, // New schema field
      kycValidated: true // New schema field
    };
    
    pendingTransaction = await BillTransaction.create(initialTransactionData);
    transactionCreated = true;
    
    logger.info(`📋 Bill transaction ${uniqueOrderId}: initiated-api | airtime | ${ngnzAmount} NGNZ | ✅ 2FA | ✅ KYC | ⚠️ Not Reserved`);
    logger.info(`Created pending transaction ${pendingTransaction._id} for request ${finalRequestId}`);
    
    // Step 8: Call eBills API FIRST (before reserving balance) - FIXED to use VTUAuth
    try {
      logger.info(`Calling eBills API for request ${finalRequestId} (userId: ${userId})...`);
      
      // 🔑 CRITICAL FIX: Use the fixed callEBillsAPI function that uses VTUAuth properly
      ebillsResponse = await callEBillsAPI({
        phone,
        amount,
        service_id,
        request_id: finalRequestId,
        userId
      });
      
    } catch (apiError) {
      logger.error('eBills API call failed:', {
        error: apiError.message,
        request_id: finalRequestId,
        userId: userId,
        response: apiError.response?.data,
        status: apiError.response?.status
      });
      
      // Update transaction status to failed
      await BillTransaction.findByIdAndUpdate(
        pendingTransaction._id,
        { 
          status: 'failed',
          processingErrors: [{
            error: apiError.message,
            timestamp: new Date(),
            phase: 'api_call'
          }]
        }
      );
      
      return res.status(500).json({
        success: false,
        error: 'EBILLS_API_ERROR',
        message: apiError.message,
        details: {
          request_id: finalRequestId,
          userId: userId,
          phone,
          amount,
          service_id
        }
      });
    }
    
    // Step 9: eBills API SUCCESS! Now reserve user NGNZ balance
    try {
      logger.info(`eBills API successful for ${finalRequestId}. Now reserving NGNZ balance...`);
      
      await reserveUserBalance(userId, currency, ngnzAmount);
      reservationMade = true;
      
      // Update transaction to mark balance as reserved using the new method
      await pendingTransaction.markBalanceReserved();
      
      logger.info(`📋 Bill transaction ${uniqueOrderId}: initiated-api | airtime | ${ngnzAmount} NGNZ | ✅ 2FA | ✅ KYC | ✅ Reserved`);
      logger.info(`Successfully reserved ${ngnzAmount} ${currency} for user ${userId}`);
      
    } catch (balanceError) {
      logger.error('CRITICAL: NGNZ balance reservation failed after successful eBills API call:', {
        request_id: finalRequestId,
        userId,
        currency,
        ngnzAmount,
        error: balanceError.message,
        ebills_order_id: ebillsResponse.data?.order_id
      });
      
      await BillTransaction.findByIdAndUpdate(
        pendingTransaction._id,
        { 
          status: 'failed',
          processingErrors: [{
            error: `NGNZ balance reservation failed after eBills success: ${balanceError.message}`,
            timestamp: new Date(),
            phase: 'balance_reservation',
            ebills_order_id: ebillsResponse.data?.order_id
          }]
        }
      );
      
      return res.status(500).json({
        success: false,
        error: 'BALANCE_RESERVATION_FAILED',
        message: 'eBills transaction succeeded but NGNZ balance reservation failed. Please contact support immediately.',
        details: {
          ebills_order_id: ebillsResponse.data?.order_id,
          ebills_status: ebillsResponse.data?.status,
          amount: amount,
          phone: phone
        }
      });
    }
    
    // Step 10: Update transaction with eBills response data
    const updatedTransactionData = {
      orderId: ebillsResponse.data.order_id.toString(),
      status: ebillsResponse.data.status,
      productName: ebillsResponse.data.product_name,
      metaData: {
        ...initialTransactionData.metaData,
        service_name: ebillsResponse.data.service_name,
        discount: ebillsResponse.data.discount,
        amount_charged: ebillsResponse.data.amount_charged,
        ebills_initial_balance: ebillsResponse.data.initial_balance,
        ebills_final_balance: ebillsResponse.data.final_balance,
        ebills_request_id: ebillsResponse.data.request_id,
        balance_reserved: true,
        balance_reserved_at: new Date(),
        twofa_validated: true,
        kyc_validated: true,
        request_id_type: 'user_id_direct'
      }
    };
    
    const finalTransaction = await BillTransaction.findByIdAndUpdate(
      pendingTransaction._id,
      { $set: updatedTransactionData },
      { new: true }
    );
    
    logger.info(`Transaction updated with eBills data. Order ID: ${ebillsResponse.data.order_id}, Status: ${ebillsResponse.data.status}`);
    
    // Step 11: Handle different response statuses
    if (ebillsResponse.data.status === 'completed-api') {
      // Transaction completed immediately
      logger.info(`✅ Airtime purchase completed immediately for user ${userId}, order ${ebillsResponse.data.order_id}`);
      
      return res.status(200).json({
        success: true,
        message: 'Airtime purchase completed successfully',
        data: {
          order_id: ebillsResponse.data.order_id,
          status: ebillsResponse.data.status,
          phone: ebillsResponse.data.phone,
          amount: ebillsResponse.data.amount,
          service_name: ebillsResponse.data.service_name,
          amount_charged: ebillsResponse.data.amount_charged,
          request_id: finalRequestId,
          payment_details: {
            currency: currency,
            ngnz_amount: ngnzAmount,
            exchange_rate: 1,
            amount_naira: amount
          }
        },
        transaction: finalTransaction
      });
      
    } else if (ebillsResponse.data.status === 'processing-api') {
      // Transaction is processing
      logger.info(`⏳ Airtime purchase processing for user ${userId}, order ${ebillsResponse.data.order_id}`);
      
      return res.status(202).json({
        success: true,
        message: 'Airtime purchase is being processed',
        data: {
          order_id: ebillsResponse.data.order_id,
          status: ebillsResponse.data.status,
          phone: ebillsResponse.data.phone,
          amount: ebillsResponse.data.amount,
          service_name: ebillsResponse.data.service_name,
          amount_charged: ebillsResponse.data.amount_charged,
          request_id: finalRequestId,
          payment_details: {
            currency: currency,
            ngnz_amount: ngnzAmount,
            exchange_rate: 1,
            amount_naira: amount
          }
        },
        transaction: finalTransaction,
        note: 'You will receive a notification when the transaction is completed'
      });
      
    } else {
      // Handle other statuses (refunded, etc.)
      return res.status(200).json({
        success: true,
        message: `Airtime purchase status: ${ebillsResponse.data.status}`,
        data: {
          ...ebillsResponse.data,
          request_id: finalRequestId,
          payment_details: {
            currency: currency,
            ngnz_amount: ngnzAmount,
            exchange_rate: 1,
            amount_naira: amount
          }
        },
        transaction: finalTransaction
      });
    }
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error('Airtime purchase unexpected error:', {
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      processingTime,
      reservationMade,
      transactionCreated,
      ebillsApiCalled: !!ebillsResponse
    });

    // Cleanup: Release reserved NGNZ balance if reservation was made
    if (reservationMade) {
      try {
        await releaseReservedBalance(req.user.id, 'NGNZ', validation?.sanitized?.amount || 0);
        logger.info('🔄 Released reserved NGNZ balance due to error', { 
          userId: req.user.id, 
          currency: 'NGNZ', 
          amount: validation?.sanitized?.amount || 0 
        });
      } catch (releaseError) {
        logger.error('❌ Failed to release reserved NGNZ balance after error', {
          userId: req.user.id,
          currency: 'NGNZ',
          amount: validation?.sanitized?.amount || 0,
          error: releaseError.message
        });
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
        logger.error('Failed to update transaction status after error:', updateError);
      }
    }
    
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred while processing your airtime purchase'
    });
  }
});

/**
 * GET /airtime/history
 * Get airtime purchase history for authenticated user
 */
router.get('/history', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { limit = 50, skip = 0, status, startDate, endDate } = req.query;

    const query = {
      userId,
      billType: 'airtime'
    };

    if (status) {
      query.status = status;
    }

    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = new Date(startDate);
      if (endDate) query.timestamp.$lte = new Date(endDate);
    }

    const transactions = await BillTransaction.find(query)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    const total = await BillTransaction.countDocuments(query);

    logger.info(`Fetching airtime purchase history for user ${userId}`, {
      query,
      limit: parseInt(limit),
      skip: parseInt(skip)
    });

    res.status(200).json({
      success: true,
      transactions,
      total,
      limit: parseInt(limit),
      skip: parseInt(skip)
    });

  } catch (error) {
    logger.error('Failed to fetch purchase history:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch purchase history'
    });
  }
});

/**
 * GET /airtime/status/:orderId
 * Check airtime purchase status
 */
router.get('/status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user?.id;

    const transaction = await BillTransaction.findOne({ orderId, userId });

    logger.info(`Checking purchase status for order ${orderId}`, { userId });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transaction not found'
      });
    }

    res.status(200).json({
      success: true,
      transaction
    });

  } catch (error) {
    logger.error('Failed to check purchase status:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to check purchase status'
    });
  }
});

/**
 * GET /airtime/networks
 * Get supported networks
 */
router.get('/networks', (req, res) => {
  res.status(200).json({
    success: true,
    networks: {
      'mtn': { name: 'MTN Nigeria', code: 'mtn' },
      'glo': { name: 'Globacom', code: 'glo' },
      'airtel': { name: 'Airtel Nigeria', code: 'airtel' },
      '9mobile': { name: '9mobile', code: '9mobile' }
    }
  });
});

/**
 * GET /airtime/test
 * Test eBills connectivity
 */
router.get('/test', async (req, res) => {
  try {
    logger.info('Testing eBills airtime service connectivity...');

    const authTest = await vtuAuth.testConnection();
    if (!authTest.success) {
      return res.status(500).json({
        success: false,
        error: 'Authentication failed',
        details: authTest
      });
    }

    // Test airtime endpoint connectivity
    try {
      await vtuAuth.makeRequest('GET', '/api/v2/variations/airtime');
      
      res.status(200).json({
        success: true,
        message: 'eBills airtime service is accessible',
        authentication: authTest
      });
    } catch (error) {
      if (error.response?.status === 404 || error.response?.status === 422) {
        res.status(200).json({
          success: true,
          message: 'eBills airtime service is accessible (endpoint reachable)',
          authentication: authTest
        });
      } else {
        throw error;
      }
    }

  } catch (error) {
    logger.error('eBills airtime connectivity test failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      suggestion: 'Check eBills API status and authentication credentials'
    });
  }
});

module.exports = router;