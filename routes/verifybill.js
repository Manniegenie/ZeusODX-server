const express = require('express');
const { vtuAuth } = require('../auth/billauth');
const { payBetaAuth } = require('../auth/paybetaAuth');
const logger = require('../utils/logger');

const router = express.Router();

// Define valid service IDs for each category
const ELECTRICITY_SERVICES = [
  'ikeja-electric', 'eko-electric', 'kano-electric', 'portharcourt-electric',
  'jos-electric', 'ibadan-electric', 'kaduna-electric', 'abuja-electric',
  'enugu-electric', 'benin-electric', 'aba-electric', 'yola-electric'
];

const CABLE_TV_SERVICES = ['dstv', 'gotv', 'startimes', 'showmax'];

const BETTING_SERVICES = [
  '1xBet', 'BangBet', 'Bet9ja', 'BetKing', 'BetLand', 'BetLion',
  'BetWay', 'CloudBet', 'LiveScoreBet', 'MerryBet', 'NaijaBet',
  'NairaBet', 'SupaBet'
];

const VALID_METER_TYPES = ['prepaid', 'postpaid'];

/**
 * Validate customer verification request
 */
function validateVerificationRequest(body) {
  const errors = [];
  
  // Check required fields
  if (!body.customer_id) {
    errors.push('Customer ID is required');
  } else if (typeof body.customer_id !== 'string' || body.customer_id.trim().length === 0) {
    errors.push('Customer ID must be a non-empty string');
  }
  
  if (!body.service_id) {
    errors.push('Service ID is required');
  } else {
    const allValidServices = [...ELECTRICITY_SERVICES, ...CABLE_TV_SERVICES, ...BETTING_SERVICES];
    if (!allValidServices.includes(body.service_id)) {
      errors.push(`Invalid service ID. Must be one of: ${allValidServices.join(', ')}`);
    }
  }
  
  // Check if variation_id is required for electricity services
  if (ELECTRICITY_SERVICES.includes(body.service_id)) {
    if (!body.variation_id) {
      errors.push('Variation ID (meter type) is required for electricity services');
    } else if (!VALID_METER_TYPES.includes(body.variation_id)) {
      errors.push('Variation ID must be "prepaid" or "postpaid" for electricity services');
    }
  }
  
  // variation_id should not be provided for non-electricity services
  if (!ELECTRICITY_SERVICES.includes(body.service_id) && body.variation_id) {
    errors.push('Variation ID should not be provided for non-electricity services');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Determine service category
 */
function getServiceCategory(service_id) {
  if (ELECTRICITY_SERVICES.includes(service_id)) return 'electricity';
  if (CABLE_TV_SERVICES.includes(service_id)) return 'cable_tv';
  if (BETTING_SERVICES.includes(service_id)) return 'betting';
  return 'unknown';
}

/**
 * Call eBills API for customer verification - FIXED: Removed explicit headers
 */
async function callEBillsVerificationAPI({ customer_id, service_id, variation_id, requestId, userId }) {
  try {
    const verificationPayload = {
      customer_id: customer_id.trim(),
      service_id
    };
    
    // Add variation_id only for electricity services
    if (ELECTRICITY_SERVICES.includes(service_id)) {
      verificationPayload.variation_id = variation_id;
    }

    logger.info(`🔍 [${requestId}] Making eBills customer verification request:`, {
      requestId,
      userId,
      customer_id: customer_id?.substring(0, 4) + '***', // Mask for privacy
      service_id,
      variation_id: variation_id || 'not_applicable',
      endpoint: '/api/v2/verify-customer'
    });

    // 🔑 FIXED: Let VTUAuth handle all headers automatically - removed explicit headers
    const response = await vtuAuth.makeRequest('POST', '/api/v2/verify-customer', verificationPayload, {
      timeout: 30000 // 30 seconds timeout for verification
    });

    logger.info(`📡 [${requestId}] eBills verification API response:`, {
      requestId,
      userId,
      customer_id: customer_id?.substring(0, 4) + '***',
      service_id,
      code: response.code,
      message: response.message,
      hasData: !!response.data
    });

    // Handle eBills API response structure - consistent with other utilities
    if (response.code !== 'success') {
      throw new Error(`eBills Customer Verification API error: ${response.message || 'Unknown error'}`);
    }

    return response;

  } catch (error) {
    logger.error(`❌ [${requestId}] eBills customer verification failed:`, {
      requestId,
      userId,
      customer_id: customer_id?.substring(0, 4) + '***',
      service_id,
      error: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      ebillsError: error.response?.data
    });

    // Enhanced error messages for common issues - consistent with other utilities
    if (error.message.includes('IP Address')) {
      throw new Error('IP address not whitelisted with eBills. Please contact support.');
    }

    if (error.message.includes('timeout')) {
      throw new Error('Customer verification request timed out. Please try again.');
    }

    if (error.response?.status === 422) {
      const validationErrors = error.response.data?.errors || {};
      const errorMessages = Object.values(validationErrors).flat();
      throw new Error(`Validation error: ${errorMessages.join(', ')}`);
    }

    if (error.response?.status === 401 || error.response?.status === 403) {
      throw new Error('Authentication failed with eBills API. Please contact support.');
    }

    throw new Error(`eBills Customer Verification API error: ${error.message}`);
  }
}

/**
 * Call PayBeta API for cable TV customer verification
 * Note: If PayBeta continues to fail with "Invalid Smart Card Number",
 * we may need to fallback to eBills for cable TV verification
 * 
 * Working example: smartCardNumber "8072916698" (10 digits) works with PayBeta
 * Issue: Some smart card numbers may not be in the correct format
 */
async function callPayBetaVerificationAPI({ customer_id, service_id, requestId, userId }) {
  try {
    // Map service_id to PayBeta format
    const serviceMapping = {
      'dstv': 'dstv',
      'gotv': 'gotv', 
      'startimes': 'startimes',
      'showmax': 'showmax'
    };

    const payBetaService = serviceMapping[service_id];
    if (!payBetaService) {
      throw new Error(`Unsupported service for PayBeta: ${service_id}`);
    }

    // Format and validate smart card number
    let smartCardNumber = customer_id.trim();
    
    // Remove any spaces, dashes, or special characters that might interfere
    smartCardNumber = smartCardNumber.replace(/[\s\-_]/g, '');
    
    // Additional cleaning: remove any non-numeric characters (fallback)
    const originalSmartCardNumber = smartCardNumber;
    smartCardNumber = smartCardNumber.replace(/[^0-9]/g, '');
    
    // Log if we had to clean the number
    if (originalSmartCardNumber !== smartCardNumber) {
      logger.warn(`🔍 [${requestId}] Smart card number was cleaned:`, {
        requestId,
        userId,
        service_id,
        payBetaService,
        originalLength: originalSmartCardNumber.length,
        cleanedLength: smartCardNumber.length,
        originalStart: originalSmartCardNumber.substring(0, 4) + '***',
        cleanedStart: smartCardNumber.substring(0, 4) + '***'
      });
    }
    
    // Basic validation for smart card number
    if (!smartCardNumber || smartCardNumber.length < 6) {
      throw new Error(`Invalid smart card number format. Must be at least 6 characters.`);
    }
    
    // Additional validation for GOtv (common format is 10-11 digits)
    if (payBetaService === 'gotv' && (smartCardNumber.length < 10 || smartCardNumber.length > 11)) {
      logger.warn(`🔍 [${requestId}] GOtv smart card number length warning:`, {
        requestId,
        userId,
        service_id,
        smartCardLength: smartCardNumber.length,
        expectedLength: '10-11 digits'
      });
    }
    
    // Validate that the smart card number is numeric
    if (!/^\d+$/.test(smartCardNumber)) {
      logger.error(`🔍 [${requestId}] Smart card number contains non-numeric characters:`, {
        requestId,
        userId,
        service_id,
        payBetaService,
        smartCardNumber: smartCardNumber.substring(0, 4) + '***',
        containsLetters: /[a-zA-Z]/.test(smartCardNumber),
        containsSpecialChars: /[^0-9]/.test(smartCardNumber)
      });
      throw new Error(`Invalid smart card number format. Must contain only numbers.`);
    }
    
    // Specific validation for GOtv based on working example (8072916698 = 10 digits)
    if (payBetaService === 'gotv' && smartCardNumber.length !== 10) {
      logger.warn(`🔍 [${requestId}] GOtv smart card number length mismatch:`, {
        requestId,
        userId,
        service_id,
        smartCardLength: smartCardNumber.length,
        expectedLength: '10 digits (based on working example)',
        note: 'PayBeta may require exactly 10 digits for GOtv'
      });
    }
    
    // Log the exact payload being sent to PayBeta for debugging
    logger.info(`🔍 [${requestId}] PayBeta verification payload:`, {
      requestId,
      userId,
      service_id,
      payBetaService,
      payload: {
        service: payBetaService,
        smartCardNumber: smartCardNumber.substring(0, 4) + '***' + smartCardNumber.substring(smartCardNumber.length - 2)
      },
      fullPayload: {
        service: payBetaService,
        smartCardNumber: smartCardNumber
      }
    });
    
    // Log the actual length for debugging (without exposing the full number)
    logger.info(`🔍 [${requestId}] Smart card number validation:`, {
      requestId,
      userId,
      service_id,
      payBetaService,
      smartCardLength: smartCardNumber.length,
      startsWith: smartCardNumber.substring(0, 2),
      endsWith: smartCardNumber.substring(smartCardNumber.length - 2),
      isNumeric: /^\d+$/.test(smartCardNumber),
      originalLength: customer_id.length,
      trimmedLength: customer_id.trim().length
    });

    const verificationPayload = {
      service: payBetaService,
      smartCardNumber: smartCardNumber
    };

    logger.info(`🔍 [${requestId}] Making PayBeta cable TV verification request:`, {
      requestId,
      userId,
      customer_id: customer_id?.substring(0, 4) + '***', // Mask for privacy
      service_id,
      payBetaService,
      smartCardLength: smartCardNumber.length,
      endpoint: '/v2/cable/validate'
    });

    // Log the exact request being made
    const baseURL = process.env.PAYBETA_API_URL || 'https://api.paybeta.ng';
    const fullURL = `${baseURL}/v2/cable/validate`;
    
    logger.info(`🔍 [${requestId}] Making PayBeta request with axios:`, {
      requestId,
      userId,
      service_id,
      method: 'POST',
      endpoint: '/v2/cable/validate',
      baseURL: baseURL,
      fullURL: fullURL,
      payload: verificationPayload,
      timeout: 25000
    });

    const response = await payBetaAuth.makeRequest('POST', '/v2/cable/validate', verificationPayload, {
      timeout: 25000
    });

    logger.info(`📡 [${requestId}] PayBeta verification API response:`, {
      requestId,
      userId,
      customer_id: customer_id?.substring(0, 4) + '***',
      service_id,
      status: response.status,
      message: response.message,
      hasData: !!response.data,
      responseData: response.data ? {
        customerName: response.data.customerName,
        smartCardNumber: response.data.smartCardNumber?.substring(0, 4) + '***',
        service: response.data.service
      } : null
    });

    if (response.status !== 'successful') {
      throw new Error(`PayBeta API error: ${response.message || 'Unknown error'}`);
    }

    // Transform PayBeta response to match eBills format for consistency
    return {
      code: 'success',
      message: response.message,
      data: {
        customer_id: response.data.smartCardNumber,
        customer_name: response.data.customerName,
        service_id: response.data.service,
        status: 'verified',
        service_name: service_id.toUpperCase(),
        customer_phone_number: null,
        customer_email_address: null,
        customer_username: null,
        minimum_amount: 100,
        maximum_amount: 100000,
        current_bouquet: 'N/A',
        renewal_amount: 0,
        due_date: null,
        balance: 0
      }
    };

  } catch (error) {
    logger.error(`❌ [${requestId}] PayBeta customer verification failed:`, {
      requestId,
      userId,
      customer_id: customer_id?.substring(0, 4) + '***',
      service_id,
      error: error.message,
      status: error.response?.status,
      payBetaError: error.response?.data
    });

    if (error.message.includes('API key not configured')) {
      throw new Error('PayBeta API key not configured. Please contact support.');
    }
    if (error.message.includes('authentication failed')) {
      throw new Error('PayBeta authentication failed. Please contact support.');
    }
    if (error.message.includes('validation error')) {
      throw new Error(`PayBeta validation error: ${error.message}`);
    }
    if (error.message.includes('Invalid Smart Card Number') || error.message.includes('Invalid smart card')) {
      throw new Error('Invalid smart card number format. Please check the number and try again.');
    }
    if (error.response?.data?.message?.includes('Invalid Smart Card Number')) {
      throw new Error('Invalid smart card number format. Please check the number and try again.');
    }

    throw new Error(`PayBeta API error: ${error.message}`);
  }
}

/**
 * Test PayBeta cable TV verification with known working smart card
 */
router.post('/test-paybeta', async (req, res) => {
  try {
    const testSmartCard = '8072916698'; // Known working smart card
    const testService = 'gotv';
    
    logger.info('🧪 Testing PayBeta cable TV verification with known working smart card:', {
      smartCard: testSmartCard.substring(0, 4) + '***',
      service: testService
    });
    
    const testResponse = await callPayBetaVerificationAPI({
      customer_id: testSmartCard,
      service_id: testService,
      requestId: 'test_' + Date.now(),
      userId: 'test_user'
    });
    
    logger.info('✅ PayBeta test successful:', testResponse);
    
    return res.status(200).json({
      success: true,
      message: 'PayBeta test successful',
      data: testResponse.data
    });
    
  } catch (error) {
    logger.error('❌ PayBeta test failed:', error.message);
    
    return res.status(500).json({
      success: false,
      error: 'PAYBETA_TEST_FAILED',
      message: error.message
    });
  }
});

/**
 * Test PayBeta configuration comparison with airtime.js
 */
router.post('/test-paybeta-config', async (req, res) => {
  try {
    const baseURL = process.env.PAYBETA_API_URL || 'https://api.paybeta.ng';
    const apiKey = process.env.PAYBETA_API_KEY;
    
    logger.info('🔧 PayBeta configuration check:', {
      baseURL: baseURL,
      hasApiKey: !!apiKey,
      apiKeyLength: apiKey ? apiKey.length : 0,
      endpoint: '/v2/cable/validate',
      fullURL: `${baseURL}/v2/cable/validate`
    });
    
    return res.status(200).json({
      success: true,
      message: 'PayBeta configuration details',
      config: {
        baseURL: baseURL,
        hasApiKey: !!apiKey,
        apiKeyLength: apiKey ? apiKey.length : 0,
        endpoint: '/v2/cable/validate',
        fullURL: `${baseURL}/v2/cable/validate`
      }
    });
    
  } catch (error) {
    logger.error('❌ PayBeta config check failed:', error.message);
    
    return res.status(500).json({
      success: false,
      error: 'CONFIG_CHECK_FAILED',
      message: error.message
    });
  }
});

/**
 * Test PayBeta with direct axios call (matching your working example)
 */
router.post('/test-paybeta-direct', async (req, res) => {
  try {
    const axios = require('axios');
    
    const testPayload = {
      service: 'gotv',
      smartCardNumber: '8072916698'
    };
    
    logger.info('🧪 Testing PayBeta with direct axios call:', testPayload);
    
    const baseURL = process.env.PAYBETA_API_URL || 'https://api.paybeta.ng';
    const fullURL = `${baseURL}/v2/cable/validate`;
    
    logger.info('🧪 Using PayBeta base URL:', { baseURL, fullURL });
    
    const response = await axios.post(fullURL, testPayload, {
      headers: {
        'P-API-KEY': process.env.PAYBETA_API_KEY,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      timeout: 25000
    });
    
    logger.info('✅ Direct PayBeta test successful:', response.data);
    
    return res.status(200).json({
      success: true,
      message: 'Direct PayBeta test successful',
      data: response.data
    });
    
  } catch (error) {
    logger.error('❌ Direct PayBeta test failed:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    
    return res.status(500).json({
      success: false,
      error: 'DIRECT_PAYBETA_TEST_FAILED',
      message: error.message,
      status: error.response?.status,
      responseData: error.response?.data
    });
  }
});

/**
 * Main customer verification endpoint - Updated to match other utilities' patterns
 */
router.post('/customer', async (req, res) => {
  const startTime = Date.now();
  const requestId = `verify_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // Step 1: Log incoming request
    logger.info(`🔍 Customer verification request from user:`, {
      requestId,
      userId: req.user?.id,
      userAgent: req.get('User-Agent'),
      ip: req.ip || req.connection.remoteAddress,
      timestamp: new Date().toISOString()
    });

    const requestBody = req.body;
    
    // Step 2: Check authentication
    if (!req.user) {
      logger.error(`❌ [${requestId}] No user object found in request`);
      return res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Authentication required',
        requestId
      });
    }

    const userId = req.user.id;
    
    // Step 3: Validate request
    const validation = validateVerificationRequest(requestBody);
    
    if (!validation.isValid) {
      logger.warn(`❌ [${requestId}] Request validation failed`, {
        requestId,
        userId,
        errors: validation.errors
      });
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors,
        requestId
      });
    }
    
    const { customer_id, service_id, variation_id } = requestBody;
    const serviceCategory = getServiceCategory(service_id);
    
    logger.info(`📊 [${requestId}] Service details determined`, {
      requestId,
      userId,
      customer_id: customer_id?.substring(0, 4) + '***',
      service_id,
      serviceCategory,
      variation_id: variation_id || 'not_provided'
    });
    
        // Step 4: Call appropriate API based on service category
        let apiResponse;
        try {
          if (serviceCategory === 'cable_tv') {
            // Try PayBeta first for cable TV services
            try {
              apiResponse = await callPayBetaVerificationAPI({
                customer_id,
                service_id,
                requestId,
                userId
              });
            } catch (payBetaError) {
              // If PayBeta fails with "Invalid Smart Card Number", fallback to eBills
              if (payBetaError.message.includes('Invalid Smart Card Number') || 
                  payBetaError.message.includes('Invalid smart card')) {
                logger.warn(`🔄 [${requestId}] PayBeta failed, falling back to eBills for cable TV verification:`, {
                  requestId,
                  userId,
                  service_id,
                  payBetaError: payBetaError.message
                });
                
                apiResponse = await callEBillsVerificationAPI({
                  customer_id,
                  service_id,
                  variation_id: null, // Cable TV doesn't need variation_id for eBills
                  requestId,
                  userId
                });
              } else {
                // Re-throw other PayBeta errors
                throw payBetaError;
              }
            }
          } else {
            // Use eBills for other services (airtime, electricity, betting)
            apiResponse = await callEBillsVerificationAPI({
              customer_id,
              service_id,
              variation_id,
              requestId,
              userId
            });
          }
        } catch (apiError) {
      logger.error(`${serviceCategory === 'cable_tv' ? 'PayBeta' : 'eBills'} verification API call failed:`, {
        requestId,
        userId,
        customer_id: customer_id?.substring(0, 4) + '***',
        service_id,
        error: apiError.message,
        processingTime: Date.now() - startTime
      });
      
      // Map API errors to appropriate responses - consistent with other utilities
      let statusCode = 500;
      let errorCode = 'VERIFICATION_API_ERROR';
      let errorMessage = apiError.message;
      
      if (apiError.message.includes('timeout')) {
        statusCode = 504;
        errorCode = 'VERIFICATION_TIMEOUT';
        errorMessage = 'Customer verification request timed out. Please try again.';
      } else if (apiError.message.includes('Customer Verification API error')) {
        statusCode = 400;
        errorCode = 'CUSTOMER_NOT_FOUND';
        errorMessage = 'Customer not found or invalid customer details';
      } else if (apiError.message.includes('Authentication failed')) {
        statusCode = 503;
        errorCode = 'SERVICE_UNAVAILABLE';
        errorMessage = 'Customer verification service is temporarily unavailable';
      }
      
      return res.status(statusCode).json({
        success: false,
        error: errorCode,
        message: errorMessage,
        details: {
          customer_id,
          service_id,
          service_category: serviceCategory,
          variation_id: variation_id || null,
          requestId
        }
      });
    }
    
    // Step 5: Process successful verification response
    const customerData = apiResponse.data;
    
    // Enhance response with service category and additional info
    const enhancedResponse = {
      success: true,
      message: 'Customer verification successful',
      service_category: serviceCategory,
      data: {
        ...customerData,
        service_category: serviceCategory,
        verified_at: new Date().toISOString(),
        requestId
      }
    };
    
    // Add category-specific enhancements
    if (serviceCategory === 'electricity') {
      enhancedResponse.data.purchase_info = {
        min_amount: customerData.min_purchase_amount || 1000,
        max_amount: customerData.max_purchase_amount || 100000,
        meter_type: variation_id,
        has_arrears: (customerData.customer_arrears || 0) > 0,
        outstanding_amount: customerData.outstanding || 0
      };
      logger.info(`⚡ [${requestId}] Added electricity-specific data`);
    } else if (serviceCategory === 'cable_tv') {
      enhancedResponse.data.subscription_info = {
        current_status: customerData.status || 'Unknown',
        current_bouquet: customerData.current_bouquet || 'N/A',
        renewal_amount: customerData.renewal_amount || 0,
        due_date: customerData.due_date || null,
        balance: customerData.balance || 0
      };
      logger.info(`📺 [${requestId}] Added cable TV-specific data`);
    } else if (serviceCategory === 'betting') {
      enhancedResponse.data.account_info = {
        username: customerData.customer_username || 'N/A',
        email: customerData.customer_email_address || 'N/A',
        phone: customerData.customer_phone_number || 'N/A',
        min_amount: customerData.minimum_amount || 100,
        max_amount: customerData.maximum_amount || 100000
      };
      logger.info(`🎲 [${requestId}] Added betting-specific data`);
    }
    
    const totalDuration = Date.now() - startTime;
    
    logger.info(`✅ [${requestId}] Customer verification completed successfully`, {
      requestId,
      userId,
      customer_id: customer_id?.substring(0, 4) + '***',
      serviceCategory,
      totalDuration: `${totalDuration}ms`,
      hasCustomerData: !!customerData
    });
    
    return res.status(200).json(enhancedResponse);
    
  } catch (error) {
    const totalDuration = Date.now() - startTime;
    
    logger.error(`💀 [${requestId}] Customer verification unexpected error`, {
      requestId,
      userId: req.user?.id,
      errorMessage: error.message,
      errorName: error.name,
      stack: error.stack,
      totalDuration: `${totalDuration}ms`,
      requestBody: req.body
    });
    
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred during customer verification',
      requestId
    });
  }
});

module.exports = router;