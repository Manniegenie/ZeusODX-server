// routes/electricity.js
const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { vtuAuth } = require('../auth/billauth');
const { payBetaAuth } = require('../auth/paybetaAuth');
const { validateUserBalance } = require('../services/balance');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const logger = require('../utils/logger');
const crypto = require('crypto');

const router = express.Router();

// Cache for user data to avoid repeated DB queries
const userCache = new Map();
const CACHE_TTL = 30000; // 30 seconds

const ELECTRICITY_SERVICES = [
  'ikeja-electric','eko-electric','kano-electric','portharcourt-electric',
  'jos-electric','ibadan-electric','kaduna-electric','abuja-electric',
  'enugu-electric','benin-electric','aba-electric','yola-electric'
];

const VALID_METER_TYPES = ['prepaid', 'postpaid'];

/**
 * Normalize service ID to match network enum format
 * @param {string} serviceId - Service ID from request
 * @returns {string} Normalized service ID for network enum
 */
function normalizeServiceIdForNetwork(serviceId) {
  const serviceMapping = {
    'ikeja-electric': 'IKEJA-ELECTRIC',
    'eko-electric': 'EKO-ELECTRIC', 
    'kano-electric': 'KANO-ELECTRIC',
    'portharcourt-electric': 'PORTHARCOURT-ELECTRIC',
    'jos-electric': 'JOS-ELECTRIC',
    'ibadan-electric': 'IBADAN-ELECTRIC',
    'kaduna-electric': 'KADUNA-ELECTRIC',
    'abuja-electric': 'ABUJA-ELECTRIC',
    'enugu-electric': 'ENUGU-ELECTRIC',
    'benin-electric': 'BENIN-ELECTRIC',
    'aba-electric': 'ABA-ELECTRIC',
    'yola-electric': 'YOLA-ELECTRIC'
  };
  
  return serviceMapping[serviceId.toLowerCase()] || serviceId;
}

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

function validateElectricityRequest(body) {
  const errors = [];
  const sanitized = {};

  if (!body.customer_id) {
    errors.push('Customer ID (meter/account number) is required');
  } else {
    sanitized.customer_id = String(body.customer_id).trim();
    if (!sanitized.customer_id.length) {
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
      
      const minAmount = 1000;
      const maxAmount = 100000;
      if (sanitized.amount < minAmount) {
        errors.push(`Amount below minimum. Minimum electricity purchase is ${minAmount} NGNZ`);
      }
      if (sanitized.amount > maxAmount) {
        errors.push(`Amount above maximum. Maximum electricity purchase is ${maxAmount} NGNZ`);
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

  // Add customer details for PayBeta
  if (body.customerName) {
    sanitized.customerName = String(body.customerName).trim();
  }
  
  if (body.customerAddress) {
    sanitized.customerAddress = String(body.customerAddress).trim();
  }

  sanitized.payment_currency = 'NGNZ';

  return { isValid: errors.length === 0, errors, sanitized };
}

/**
 * GET /electricity/providers - Fetch electricity providers from PayBeta
 */
router.get('/providers', async (req, res) => {
  const requestId = `electricity_providers_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  
  try {
    logger.info(`🔌 [${requestId}] Fetching electricity providers from PayBeta`, {
      timestamp: new Date().toISOString()
    });

    // Check if PayBeta API key is configured
    if (!process.env.PAYBETA_API_KEY) {
      logger.error(`❌ [${requestId}] PayBeta API key not configured`);
      return res.status(503).json({
        success: false,
        error: 'SERVICE_CONFIGURATION_ERROR',
        message: 'Electricity service is temporarily unavailable. Please try again later.'
      });
    }

    const startTime = Date.now();
    
    // Call PayBeta electricity providers endpoint
    const response = await payBetaAuth.makeRequest('GET', '/v2/electricity/providers', {}, {
      timeout: 15000
    });

    const processingTime = Date.now() - startTime;
    
    logger.info(`🔌 [${requestId}] PayBeta providers response: ${response.status}`, {
      providerCount: response.data?.length || 0,
      requestId,
      status: response.status,
      timestamp: new Date().toISOString()
    });

    // Log raw response for debugging
    logger.info(`🔍 [${requestId}] Raw PayBeta response:`, {
      rawData: response.data,
      rawDataLength: response.data?.length || 0,
      rawDataTypes: response.data?.map(item => ({
        name: item.name,
        slug: item.slug,
        hasLogo: !!item.logo
      })),
      requestId,
      timestamp: new Date().toISOString()
    });

    if (response.status !== 'successful') {
      throw new Error(`PayBeta API error: ${response.message || 'Unknown error'}`);
    }

    // Process providers to add hasLogo and icon properties
    const processedProviders = (response.data || []).map(provider => ({
      id: provider.slug || provider.name?.toLowerCase().replace(/\s+/g, '-'),
      name: provider.name,
      displayName: provider.name,
      slug: provider.slug,
      category: provider.category || 'electricity',
      logo: provider.logo || '',
      hasLogo: !!provider.logo,
      status: provider.status !== false
    }));

    // Remove duplicates based on ID
    const uniqueProviders = processedProviders.filter((provider, index, self) => 
      index === self.findIndex(p => p.id === p.id)
    );

    logger.info(`🔍 [${requestId}] After deduplication:`, {
      originalCount: processedProviders.length,
      uniqueCount: uniqueProviders.length,
      removedDuplicates: processedProviders.length - uniqueProviders.length,
      requestId,
      timestamp: new Date().toISOString()
    });

    logger.info(`🔍 [${requestId}] Processed providers:`, {
      processedCount: uniqueProviders.length,
      processedProviders: uniqueProviders.map(p => ({
        id: p.id,
        name: p.name,
        slug: p.slug
      })),
      requestId,
      timestamp: new Date().toISOString()
    });

    logger.info(`✅ [${requestId}] Electricity providers fetched successfully`, {
      processingTime: `${processingTime}ms`,
      providerCount: uniqueProviders.length,
      requestId,
      timestamp: new Date().toISOString()
    });

    return res.status(200).json({
      success: true,
      data: {
        providers: uniqueProviders
      },
      message: 'Electricity providers fetched successfully'
    });

  } catch (error) {
    const processingTime = Date.now() - Date.now();
    
    logger.error(`❌ [${requestId}] Electricity providers fetch failed:`, {
      error: error.message,
      processingTime: `${processingTime}ms`,
      requestId,
      timestamp: new Date().toISOString()
    });

    if (error.message.includes('timeout') || error.message.includes('TIMEOUT')) {
      return res.status(504).json({
        success: false,
        error: 'PROVIDERS_TIMEOUT',
        message: 'Electricity providers request timed out. Please try again.'
      });
    }

    if (error.message.includes('SERVICE_CONFIGURATION_ERROR')) {
      return res.status(503).json({
        success: false,
        error: 'SERVICE_CONFIGURATION_ERROR',
        message: 'Electricity service is temporarily unavailable. Please try again later.'
      });
    }

    return res.status(500).json({
      success: false,
      error: 'PROVIDERS_API_ERROR',
      message: 'Failed to fetch electricity providers. Please try again later.'
    });
  }
});

/**
 * POST /electricity/validate - Validate electricity customer using PayBeta
 */
router.post('/validate', async (req, res) => {
  const requestId = `electricity_validate_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  
  try {
    const { service, meterNumber, meterType } = req.body;
    
    logger.info(`🔌 [${requestId}] Electricity customer validation request:`, {
      service,
      meterNumber: meterNumber ? `${meterNumber.substring(0, 3)}***${meterNumber.substring(meterNumber.length - 3)}` : 'N/A',
      meterType,
      requestId,
      timestamp: new Date().toISOString()
    });

    // Validate required fields
    if (!service || !meterNumber || !meterType) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Service, meter number, and meter type are required'
      });
    }

    // Check if PayBeta API key is configured
    if (!process.env.PAYBETA_API_KEY) {
      logger.error(`❌ [${requestId}] PayBeta API key not configured`);
      return res.status(503).json({
        success: false,
        error: 'SERVICE_CONFIGURATION_ERROR',
        message: 'Electricity validation service is temporarily unavailable. Please try again later.'
      });
    }

    const startTime = Date.now();
    
    // Call PayBeta electricity validation endpoint
    const payload = {
      service: service.toLowerCase(),
      meterNumber: meterNumber.trim(),
      meterType: meterType.toLowerCase()
    };

    const response = await payBetaAuth.makeRequest('POST', '/v2/electricity/validate', payload, {
      timeout: 15000
    });

    const processingTime = Date.now() - startTime;
    
    logger.info(`🔌 [${requestId}] PayBeta validation response: ${response.status}`, {
      requestId,
      status: response.status,
      processingTime: `${processingTime}ms`,
      timestamp: new Date().toISOString()
    });

    if (response.status !== 'successful') {
      logger.warn(`⚠️ [${requestId}] PayBeta validation failed:`, {
        error: response.message,
        requestId,
        timestamp: new Date().toISOString()
      });
      
      return res.status(400).json({
        success: false,
        error: 'CUSTOMER_NOT_FOUND',
        message: response.message || 'Customer not found or invalid meter details'
      });
    }

    // Process validation response
    const validationData = response.data || {};
    
    logger.info(`✅ [${requestId}] Electricity customer validation successful:`, {
      customerName: validationData.customerName,
      customerAddress: validationData.customerAddress,
      meterNumber: validationData.meterNumber,
      meterType: validationData.meterType,
      minimumAmount: validationData.minimuVendAmount,
      requestId,
      timestamp: new Date().toISOString()
    });

    return res.status(200).json({
      success: true,
      data: {
        customerName: validationData.customerName,
        customerAddress: validationData.customerAddress,
        meterNumber: validationData.meterNumber,
        meterType: validationData.meterType,
        minimumAmount: validationData.minimuVendAmount || validationData.minimumAmount || 0,
        service: service,
        verifiedAt: new Date().toISOString(),
        requestId: requestId
      },
      message: 'Customer validation successful'
    });

  } catch (error) {
    const processingTime = Date.now() - Date.now();
    
    logger.error(`❌ [${requestId}] Electricity customer validation failed:`, {
      error: error.message,
      processingTime: `${processingTime}ms`,
      requestId,
      timestamp: new Date().toISOString()
    });

    if (error.message.includes('timeout') || error.message.includes('TIMEOUT')) {
      return res.status(504).json({
        success: false,
        error: 'VALIDATION_TIMEOUT',
        message: 'Customer validation timed out. Please try again.'
      });
    }

    if (error.message.includes('SERVICE_CONFIGURATION_ERROR')) {
      return res.status(503).json({
        success: false,
        error: 'SERVICE_CONFIGURATION_ERROR',
        message: 'Electricity validation service is temporarily unavailable. Please try again later.'
      });
    }

    return res.status(500).json({
      success: false,
      error: 'VALIDATION_API_ERROR',
      message: 'Customer validation failed. Please try again later.'
    });
  }
});

async function callPayBetaElectricityAPI({ service, meterNumber, meterType, amount, customerName, customerAddress, reference, userId }) {
  try {
    const payload = {
      service: service.toLowerCase(),
      meterNumber: meterNumber.trim(),
      meterType: meterType.toLowerCase(),
      amount: parseInt(amount),
      customerName: customerName,
      customerAddress: customerAddress,
      reference: reference
    };

    logger.info('PayBeta electricity payload:', {
      service: payload.service,
      meterNumber: `${payload.meterNumber.substring(0, 3)}***${payload.meterNumber.substring(payload.meterNumber.length - 3)}`,
      meterType: payload.meterType,
      amount: payload.amount,
      customerName: payload.customerName,
      customerAddress: payload.customerAddress,
      reference: payload.reference,
      referenceLength: payload.reference.length,
      allFieldsPresent: {
        service: !!payload.service,
        meterNumber: !!payload.meterNumber,
        meterType: !!payload.meterType,
        amount: !!payload.amount,
        customerName: !!payload.customerName,
        customerAddress: !!payload.customerAddress,
        reference: !!payload.reference
      }
    });

    logger.info('Making PayBeta electricity purchase request:', {
      service, meterNumber: `${meterNumber.substring(0, 3)}***${meterNumber.substring(meterNumber.length - 3)}`, 
      meterType, amount, reference, endpoint: '/v2/electricity/purchase',
      customerName: customerName ? `${customerName.substring(0, 3)}***` : 'N/A',
      customerAddress: customerAddress ? `${customerAddress.substring(0, 10)}***` : 'N/A'
    });

    const response = await payBetaAuth.makeRequest('POST', '/v2/electricity/purchase', payload, {
      timeout: 30000
    });

    logger.info(`PayBeta Electricity API response:`, {
      status: response.status,
      message: response.message,
      transactionId: response.data?.transactionId,
      reference: response.data?.reference
    });

    // Debug: Log all available fields in PayBeta response
    logger.info(`🔍 PayBeta Electricity API response fields:`, {
      availableFields: Object.keys(response.data || {}),
      fullResponse: response.data,
      hasToken: !!(response.data?.token),
      hasUnit: !!(response.data?.unit),
      hasChargedAmount: !!(response.data?.chargedAmount),
      hasBiller: !!(response.data?.biller)
    });

    if (response.status !== 'successful') {
      throw new Error(`PayBeta Electricity API error: ${response.message || 'Unknown error'}`);
    }

    return response;
  } catch (error) {
    logger.error('❌ PayBeta electricity purchase failed:', {
      userId, error: error.message,
      status: error.response?.status,
      paybetaError: error.response?.data
    });

    if (error.message.includes('insufficient')) {
      throw new Error('Insufficient balance with PayBeta provider. Please contact support.');
    }
    if (error.response?.status === 422) {
      const validationErrors = error.response.data?.errors || {};
      const errorMessages = Object.values(validationErrors).flat();
      throw new Error(`Validation error: ${errorMessages.join(', ')}`);
    }

    throw new Error(`PayBeta Electricity API error: ${error.message}`);
  }
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

    const response = await vtuAuth.makeRequest('POST', '/api/v2/electricity', payload, {
      timeout: 25000 // Reduced from 45s for faster failure
    });

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
 * STREAMLINED electricity purchase endpoint - ATOMIC IMMEDIATE DEBIT
 */
router.post('/purchase', async (req, res) => {
  const startTime = Date.now();
  let balanceDeducted = false;
  let transactionCreated = false;
  let pendingTransaction = null;
  let ebillsResponse = null;
  let validation; // <- declared here so catch block can reference

  try {
    const requestBody = req.body;
    const userId = req.user.id;

    logger.info(`⚡ Electricity purchase request from user ${userId}:`, {
      ...requestBody,
      passwordpin: '[REDACTED]'
    });

    // Step 1: Validate request
    validation = validateElectricityRequest(requestBody);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors
      });
    }

    const { customer_id, service_id, variation_id, amount, twoFactorCode, passwordpin, customerName, customerAddress } = validation.sanitized;
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
      logger.warn('🚫 2FA validation failed for electricity purchase', { 
        userId, errorType: 'INVALID_2FA'
      });
      return res.status(401).json({
        success: false,
        error: 'INVALID_2FA_CODE',
        message: 'Invalid two-factor authentication code'
      });
    }

    logger.info('✅ 2FA validation successful for electricity purchase', { userId });

    // Step 3: Validate password pin
    if (!user.passwordpin) {
      return res.status(400).json({
        success: false,
        message: 'Password PIN is not set up for your account. Please set up your password PIN first.'
      });
    }

    const isPasswordPinValid = await comparePasswordPin(passwordpin, user.passwordpin);
    if (!isPasswordPinValid) {
      logger.warn('🚫 Password PIN validation failed for electricity purchase', { 
        userId, errorType: 'INVALID_PASSWORDPIN'
      });
      return res.status(401).json({
        success: false,
        error: 'INVALID_PASSWORDPIN',
        message: 'Invalid password PIN'
      });
    }

    logger.info('✅ Password PIN validation successful for electricity purchase', { userId });


    // Step 5: Generate unique IDs
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    // Create shorter reference for PayBeta (max 40 characters)
    const shortUserId = userId.substring(0, 8); // Take first 8 chars of userId
    const shortTimestamp = timestamp.toString().slice(-8); // Take last 8 digits of timestamp
    const finalRequestId = `elec_${shortUserId}_${shortTimestamp}_${randomSuffix}`;
    const uniqueOrderId = `pending_${userId}_${timestamp}`;
    
    // Ensure reference is within PayBeta's 40 character limit
    const validatedReference = finalRequestId.length <= 40 ? finalRequestId : `elec_${randomSuffix}_${Date.now().toString().slice(-6)}`;
    
    logger.info('Generated reference for PayBeta:', {
      finalRequestId,
      validatedReference,
      referenceLength: validatedReference.length,
      maxAllowed: 40,
      isWithinLimit: validatedReference.length <= 40
    });

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
      productName: 'Electricity',
      billType: 'electricity',
      quantity: 1,
      amount: amount,
      amountNaira: amount,
      paymentCurrency: currency,
      requestId: finalRequestId,
      metaData: {
        customer_id,
        service_id,
        variation_id,
        meter_type: variation_id,
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
        service_provider: service_id,
        meter_type: variation_id
      },
      userId: userId,
      timestamp: new Date(),
      twoFactorValidated: true,
      passwordPinValidated: true,
    };

    const pendingTx = await BillTransaction.create(initialTransactionData);
    pendingTransaction = pendingTx;
    transactionCreated = true;

    logger.info(`📋 Bill transaction ${uniqueOrderId}: initiated-api | electricity | ${amount} NGNZ | ✅ 2FA | ✅ PIN`);

    // Step 8: Call PayBeta API
    try {
      // Use customer details from validation (passed from frontend after validation)
      const payBetaCustomerName = customerName || 'Customer';
      const payBetaCustomerAddress = customerAddress || 'Address';
      
      ebillsResponse = await callPayBetaElectricityAPI({
        service: service_id,
        meterNumber: customer_id,
        meterType: variation_id,
        amount: amount,
        customerName: payBetaCustomerName,
        customerAddress: payBetaCustomerAddress,
        reference: validatedReference,
        userId: userId
      });
    } catch (apiError) {
      await BillTransaction.findByIdAndUpdate(pendingTransaction._id, {
        status: 'failed',
        processingErrors: [{ error: apiError.message, timestamp: new Date(), phase: 'api_call' }]
      });
      return res.status(500).json({
        success: false,
        error: 'PAYBETA_ELECTRICITY_API_ERROR',
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
        message: 'eBills electricity transaction succeeded but balance deduction failed. Please contact support immediately.',
        details: {
          ebills_order_id: ebillsResponse.data?.order_id,
          ebills_status: ebillsResponse.data?.status,
          amount: amount,
          customer_id: customer_id
        }
      });
    }

    // Step 10: Update transaction with PayBeta response
    const finalStatus = 'completed'; // PayBeta successful response means completed
    const updateData = {
      orderId: ebillsResponse.data.transactionId?.toString?.() || String(ebillsResponse.data.transactionId),
      status: finalStatus,
      productName: 'Electricity',
      balanceCompleted: true, // Always true since we deduct immediately
      metaData: {
        ...initialTransactionData.metaData,
        service_name: ebillsResponse.data.biller,
        customer_name: customerName,
        customer_address: customerAddress,
        token: ebillsResponse.data.token || ebillsResponse.data.transactionId,
        units: ebillsResponse.data.unit,
        amount_charged: ebillsResponse.data.chargedAmount,
        balance_action_taken: true,
        balance_action_type: 'immediate_debit',
        balance_action_at: new Date(),
        paybeta_status: 'successful',
        paybeta_transaction_id: ebillsResponse.data.transactionId,
        paybeta_reference: ebillsResponse.data.reference,
        paybeta_commission: ebillsResponse.data.commission,
        paybeta_bonus_token: ebillsResponse.data.bonusToken,
        paybeta_customer_id: ebillsResponse.data.customerId,
        paybeta_transaction_date: ebillsResponse.data.transactionDate
      }
    };

    const finalTransaction = await BillTransaction.findByIdAndUpdate(
      pendingTransaction._id,
      updateData,
      { new: true }
    );
    
    // Verify the database update worked
    logger.info(`📋 Transaction status updated: ${ebillsResponse.data.transactionId} | ${finalStatus} | PayBeta: successful | Balance: immediate_debit`);
    logger.info(`📋 Database update verification:`, {
      transactionId: finalTransaction?._id,
      status: finalTransaction?.status,
      orderId: finalTransaction?.orderId,
      balanceCompleted: finalTransaction?.balanceCompleted
    });

    // Debug: Log what token and other fields were stored
    logger.info(`🔍 Token and fields stored in database:`, {
      token: ebillsResponse.data.token,
      units: ebillsResponse.data.unit,
      chargedAmount: ebillsResponse.data.chargedAmount,
      biller: ebillsResponse.data.biller,
      commission: ebillsResponse.data.commission,
      bonusToken: ebillsResponse.data.bonusToken,
      customerId: ebillsResponse.data.customerId,
      transactionDate: ebillsResponse.data.transactionDate,
      metaDataToken: finalTransaction?.metaData?.token,
      metaDataUnits: finalTransaction?.metaData?.units
    });

    // Step 11: Return response - maintaining PayBeta format for compatibility
    return res.status(200).json({
      code: 'success',
      message: 'Electricity purchase successful',
      data: {
        order_id: ebillsResponse.data.transactionId,
        status: 'completed',
        product_name: 'Electricity',
        service_name: ebillsResponse.data.biller,
        customer_name: customerName,
        customer_address: customerAddress,
        token: ebillsResponse.data.token || ebillsResponse.data.transactionId,
        units: ebillsResponse.data.unit,
        amount_charged: ebillsResponse.data.chargedAmount,
        transactionId: ebillsResponse.data.transactionId,
        reference: ebillsResponse.data.reference,
        // Additional PayBeta fields for utility receipt
        bonusToken: ebillsResponse.data.bonusToken,
        commission: ebillsResponse.data.commission,
        transactionDate: ebillsResponse.data.transactionDate,
        customerId: ebillsResponse.data.customerId
      }
    });

  } catch (error) {
    logger.error('Electricity purchase unexpected error:', {
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
