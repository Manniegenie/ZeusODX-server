const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { vtuAuth } = require('../auth/billauth');
const { validateUserBalance } = require('../services/balance');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { validateTransactionLimit } = require('../services/kyccheckservice');
const logger = require('../utils/logger');

const router = express.Router();

// Cache for user data to avoid repeated DB queries
const userCache = new Map();
const CACHE_TTL = 30000; // 30 seconds

// Pre-compile validation patterns
const PHONE_REGEX = /^\d{10,16}$/;
const PIN_REGEX = /^\d{6}$/;
const SUPPORTED_NETWORKS = new Set(['mtn', 'airtel', 'glo', '9mobile']);

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
    'twoFASecret is2FAEnabled passwordpin btcBalance ethBalance solBalance usdtBalance usdcBalance bnbBalance maticBalance avaxBalance ngnzBalance portfolioLastUpdated lastBalanceUpdate'
  ).lean(); // Use lean() for better performance
  
  if (user) {
    userCache.set(cacheKey, { user, timestamp: Date.now() });
    // Auto-cleanup cache
    setTimeout(() => userCache.delete(cacheKey), CACHE_TTL);
  }
  
  return user;
}

/**
 * Optimized validation function - runs validations in parallel
 */
async function validateRequest(body, userId) {
  const errors = [];
  const sanitized = {};
  
  // Fast synchronous validations first
  const validationPromises = [];
  
  // Phone validation
  if (!body.phone) {
    errors.push('Phone number is required');
  } else {
    sanitized.phone = String(body.phone).replace(/\D/g, '');
    if (!PHONE_REGEX.test(sanitized.phone)) {
      errors.push('Invalid phone number format');
    }
  }
  
  // Service ID validation
  if (!body.service_id) {
    errors.push('Service ID is required');
  } else {
    sanitized.service_id = String(body.service_id).toLowerCase().trim();
    if (!SUPPORTED_NETWORKS.has(sanitized.service_id)) {
      errors.push('Invalid service ID. Must be: mtn, airtel, glo, or 9mobile');
    }
  }
  
  // Amount validation
  if (body.amount === undefined || body.amount === null || body.amount === '') {
    errors.push('Amount is required');
  } else {
    const rawAmount = Number(body.amount);
    if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
      errors.push('Amount must be a valid positive number');
    } else {
      sanitized.amount = Math.round(rawAmount * 100) / 100;
      if (sanitized.amount < 50 || sanitized.amount > 50000) {
        errors.push('Amount must be between 50 and 50,000 NGNZ');
      }
    }
  }
  
  // Basic field validation
  if (!body.twoFactorCode?.trim()) {
    errors.push('Two-factor authentication code is required');
  } else {
    sanitized.twoFactorCode = String(body.twoFactorCode).trim();
  }
  
  if (!body.passwordpin?.trim()) {
    errors.push('Password PIN is required');
  } else {
    sanitized.passwordpin = String(body.passwordpin).trim();
    if (!PIN_REGEX.test(sanitized.passwordpin)) {
      errors.push('Password PIN must be exactly 6 numbers');
    }
  }
  
  // Early return if basic validation fails
  if (errors.length > 0) {
    return { isValid: false, errors, sanitized };
  }
  
  // Run expensive validations in parallel
  validationPromises.push(
    // Get user data
    getCachedUser(userId),
    // Check for pending transactions
    BillTransaction.getUserPendingTransactions(userId, 'airtime', 5),
    // KYC validation
    validateTransactionLimit(userId, sanitized.amount, 'NGNZ', 'AIRTIME')
  );
  
  try {
    const [user, pendingTransactions, kycValidation] = await Promise.all(validationPromises);
    
    // User validation
    if (!user) {
      errors.push('User not found');
      return { isValid: false, errors, sanitized };
    }
    
    if (!user.twoFASecret || !user.is2FAEnabled) {
      errors.push('Two-factor authentication is not set up or not enabled');
    }
    
    if (!user.passwordpin) {
      errors.push('Password PIN is not set up for your account');
    }
    
    // Pending transactions check
    if (pendingTransactions.length > 0) {
      errors.push('You already have a pending airtime purchase');
    }
    
    // KYC validation
    if (!kycValidation.allowed) {
      errors.push(kycValidation.message);
    }
    
    // 2FA validation
    if (user.twoFASecret && !validateTwoFactorAuth(user, sanitized.twoFactorCode)) {
      errors.push('Invalid two-factor authentication code');
    }
    
    // Password PIN validation (async)
    if (user.passwordpin) {
      const isPasswordPinValid = await bcrypt.compare(sanitized.passwordpin, user.passwordpin);
      if (!isPasswordPinValid) {
        errors.push('Invalid password PIN');
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      sanitized,
      user,
      kycValidation
    };
    
  } catch (error) {
    logger.error('Validation error:', error);
    return {
      isValid: false,
      errors: ['Validation failed due to system error'],
      sanitized
    };
  }
}

/**
 * Optimized balance operations - single atomic operation
 */
async function updateUserBalanceAtomic(userId, currency, balanceChange, pendingChange = 0) {
  const currencyLower = currency.toLowerCase();
  const balanceField = `${currencyLower}Balance`;
  const pendingField = `${currencyLower}PendingBalance`;
  
  const updateFields = {
    $inc: {},
    $set: { lastBalanceUpdate: new Date() }
  };
  
  if (balanceChange !== 0) {
    updateFields.$inc[balanceField] = balanceChange;
  }
  
  if (pendingChange !== 0) {
    updateFields.$inc[pendingField] = pendingChange;
  }
  
  if (balanceChange !== 0) {
    updateFields.$set.portfolioLastUpdated = new Date();
  }
  
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
  
  return user;
}

/**
 * Optimized eBills API call with shorter timeout
 */
async function callEBillsAPI({ phone, amount, service_id, request_id }) {
  const payload = { phone, amount, service_id, request_id };
  
  try {
    const response = await vtuAuth.makeRequest('POST', '/api/v2/airtime', payload, {
      timeout: 25000 // Reduced from 45s to 25s
    });
    
    if (response.code !== 'success') {
      throw new Error(`eBills API error: ${response.message || 'Unknown error'}`);
    }
    
    return response;
  } catch (error) {
    // Simplified error handling
    if (error.message.includes('IP Address')) {
      throw new Error('Service temporarily unavailable. Please contact support.');
    }
    if (error.response?.status === 422) {
      throw new Error('Invalid request parameters');
    }
    throw new Error(`Payment processing failed: ${error.message}`);
  }
}

/**
 * Main optimized airtime purchase endpoint
 */
router.post('/purchase', async (req, res) => {
  const startTime = Date.now();
  const userId = req.user.id;
  let transaction = null;
  let balanceAction = null;
  
  try {
    // Step 1: Fast validation (now includes all validations in parallel)
    const validation = await validateRequest(req.body, userId);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors
      });
    }
    
    const { phone, service_id, amount, twoFactorCode, passwordpin } = validation.sanitized;
    const { user } = validation;
    
    // Step 2: Balance validation
    const balanceValidation = await validateUserBalance(userId, 'NGNZ', amount, {
      includeBalanceDetails: true
    });
    
    if (!balanceValidation.success) {
      return res.status(400).json({
        success: false,
        error: 'INSUFFICIENT_BALANCE',
        message: balanceValidation.message,
        details: {
          availableBalance: balanceValidation.availableBalance,
          requiredAmount: amount,
          currency: 'NGNZ'
        }
      });
    }
    
    // Step 3: Generate IDs
    const timestamp = Date.now();
    const requestId = `${userId}_${timestamp}_${Math.random().toString(36).substring(2, 8)}`;
    const orderId = `pending_${userId}_${timestamp}`;
    
    // Step 4: Create transaction and call API in parallel
    const [ebillsResponse] = await Promise.all([
      callEBillsAPI({ phone, amount, service_id, request_id: requestId }),
      // Create transaction after API call succeeds (moved to after API call)
    ]);
    
    // Step 5: Handle balance and transaction creation based on eBills response
    const ebillsStatus = ebillsResponse.data.status;
    const isCompleted = ebillsStatus === 'completed-api';
    const isPending = ['initiated-api', 'processing-api'].includes(ebillsStatus);
    
    if (isCompleted) {
      // Direct balance update for completed transactions
      await updateUserBalanceAtomic(userId, 'ngnz', -amount, 0);
      balanceAction = 'completed';
    } else if (isPending) {
      // Reserve balance for pending transactions
      await updateUserBalanceAtomic(userId, 'ngnz', 0, amount);
      balanceAction = 'reserved';
    }
    
    // Step 6: Create transaction record (after successful balance operation)
    transaction = await BillTransaction.create({
      orderId: ebillsResponse.data.order_id.toString(),
      status: ebillsStatus,
      productName: ebillsResponse.data.product_name || 'Airtime',
      billType: 'airtime',
      quantity: 1,
      amount: amount,
      amountNaira: amount,
      paymentCurrency: 'NGNZ',
      requestId: requestId,
      metaData: {
        phone,
        network: service_id.toUpperCase(),
        service_id,
        user_id: userId,
        payment_currency: 'NGNZ',
        ngnz_amount: amount,
        exchange_rate: 1,
        balance_action: balanceAction,
        service_name: ebillsResponse.data.service_name,
        amount_charged: ebillsResponse.data.amount_charged
      },
      network: service_id.toUpperCase(),
      customerPhone: phone,
      userId: userId,
      timestamp: new Date(),
      balanceReserved: isPending,
      balanceCompleted: isCompleted,
      twoFactorValidated: true,
      passwordPinValidated: true,
      kycValidated: true
    });
    
    // Step 7: Return optimized response
    const responseData = {
      order_id: ebillsResponse.data.order_id,
      status: ebillsStatus,
      phone: ebillsResponse.data.phone,
      amount: ebillsResponse.data.amount,
      service_name: ebillsResponse.data.service_name,
      request_id: requestId,
      balance_action: balanceAction,
      payment_details: {
        currency: 'NGNZ',
        ngnz_amount: amount,
        processing_time: Date.now() - startTime
      }
    };
    
    if (isCompleted) {
      return res.status(200).json({
        success: true,
        message: 'Airtime purchase completed successfully',
        data: responseData
      });
    } else if (isPending) {
      return res.status(202).json({
        success: true,
        message: 'Airtime purchase is being processed',
        data: responseData,
        note: 'You will receive a notification when the transaction is completed'
      });
    } else {
      return res.status(200).json({
        success: true,
        message: `Airtime purchase status: ${ebillsStatus}`,
        data: responseData
      });
    }
    
  } catch (error) {
    logger.error('Airtime purchase error:', {
      userId,
      error: error.message,
      processingTime: Date.now() - startTime
    });
    
    // Simplified cleanup
    if (balanceAction === 'reserved') {
      try {
        await updateUserBalanceAtomic(userId, 'ngnz', 0, -amount);
      } catch (cleanupError) {
        logger.error('Failed to cleanup reserved balance:', cleanupError);
      }
    }
    
    if (transaction) {
      try {
        await BillTransaction.findByIdAndUpdate(transaction._id, { 
          status: 'failed',
          processingErrors: [{ error: error.message, timestamp: new Date() }]
        });
      } catch (updateError) {
        logger.error('Failed to update transaction:', updateError);
      }
    }
    
    return res.status(500).json({
      success: false,
      error: 'PROCESSING_ERROR',
      message: error.message.includes('eBills') ? error.message : 'Transaction processing failed'
    });
  }
});

module.exports = router;