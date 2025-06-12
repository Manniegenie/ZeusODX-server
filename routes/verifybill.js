const express = require('express');
const { vtuAuth } = require('../auth/billauth');
const logger = require('../utils/logger');

const router = express.Router();
const EBILLS_BASE_URL = process.env.EBILLS_BASE_URL || 'https://ebills.africa/wp-json';

// Define valid service IDs for each category
const ELECTRICITY_SERVICES = [
  'ikeja-electric', 'eko-electric', 'kano-electric', 'portharcourt-electric',
  'jos-electric', 'ibadan-electric', 'kaduna-electric', 'abuja-electric',
  'enugu-electric', 'benin-electric', 'aba-electric', 'yola-electric'
];

const CABLE_TV_SERVICES = ['dstv', 'gotv', 'startimes'];

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
 * Main customer verification endpoint
 */
router.post('/customer', async (req, res) => {
  try {
    const requestBody = req.body;
    const userId = req.user.id; // From global auth middleware
    
    logger.info(`Customer verification request from user ${userId}:`, requestBody);
    
    // Step 1: Validate request
    const validation = validateVerificationRequest(requestBody);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors
      });
    }
    
    const { customer_id, service_id, variation_id } = requestBody;
    const serviceCategory = getServiceCategory(service_id);
    
    // Step 2: Prepare request payload
    const verificationPayload = {
      customer_id: customer_id.trim(),
      service_id
    };
    
    // Add variation_id only for electricity services
    if (serviceCategory === 'electricity') {
      verificationPayload.variation_id = variation_id;
    }
    
    logger.info(`Verifying ${serviceCategory} customer:`, verificationPayload);
    
    // Step 3: Make API call to eBills verification endpoint
    try {
      const ebillsResponse = await vtuAuth.makeRequest(
        'POST',
        '/api/v2/verify-customer',
        verificationPayload,
        {
          timeout: 30000, // 30 seconds timeout for verification
          baseURL: EBILLS_BASE_URL,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );
      
      logger.info(`eBills verification response for ${customer_id}:`, {
        code: ebillsResponse.code,
        message: ebillsResponse.message,
        service: service_id,
        category: serviceCategory
      });
      
      // Handle eBills API response
      if (ebillsResponse.code !== 'success') {
        // Map specific eBills error responses
        let statusCode = 400;
        let errorCode = 'VERIFICATION_FAILED';
        let errorMessage = ebillsResponse.message || 'Customer verification failed';
        
        switch (ebillsResponse.code) {
          case 'missing_fields':
            statusCode = 400;
            errorCode = 'MISSING_FIELDS';
            errorMessage = 'Required fields missing';
            break;
          case 'invalid_field':
            statusCode = 400;
            errorCode = 'INVALID_FIELD';
            errorMessage = 'Invalid service or variation ID';
            break;
          case 'failure':
            statusCode = 404;
            errorCode = 'CUSTOMER_NOT_FOUND';
            errorMessage = 'Customer not found or invalid customer ID';
            break;
          case 'rest_forbidden':
            statusCode = 403;
            errorCode = 'UNAUTHORIZED';
            errorMessage = 'Unauthorized access to verification service';
            break;
          default:
            errorMessage = ebillsResponse.message || 'Customer verification failed';
        }
        
        return res.status(statusCode).json({
          success: false,
          error: errorCode,
          message: errorMessage,
          details: {
            customer_id,
            service_id,
            service_category: serviceCategory,
            variation_id: variation_id || null
          }
        });
      }
      
      // Step 4: Process successful verification response
      const customerData = ebillsResponse.data;
      
      // Enhance response with service category and additional info
      const enhancedResponse = {
        success: true,
        message: 'Customer verification successful',
        service_category: serviceCategory,
        data: {
          ...customerData,
          service_category: serviceCategory,
          verified_at: new Date().toISOString()
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
      } else if (serviceCategory === 'cable_tv') {
        enhancedResponse.data.subscription_info = {
          current_status: customerData.status || 'Unknown',
          current_bouquet: customerData.current_bouquet || 'N/A',
          renewal_amount: customerData.renewal_amount || 0,
          due_date: customerData.due_date || null,
          balance: customerData.balance || 0
        };
      } else if (serviceCategory === 'betting') {
        enhancedResponse.data.account_info = {
          username: customerData.customer_username || 'N/A',
          email: customerData.customer_email_address || 'N/A',
          phone: customerData.customer_phone_number || 'N/A',
          min_amount: customerData.minimum_amount || 100,
          max_amount: customerData.maximum_amount || 100000
        };
      }
      
      logger.info(`✅ Customer verification successful for ${customer_id} (${serviceCategory})`);
      
      return res.status(200).json(enhancedResponse);
      
    } catch (apiError) {
      logger.error('eBills verification API call failed:', {
        customer_id,
        service_id,
        error: apiError.message,
        response: apiError.response?.data,
        status: apiError.response?.status,
        timeout: apiError.code === 'ECONNABORTED' || apiError.message.includes('timeout')
      });
      
      // Handle API call errors
      let statusCode = 500;
      let errorCode = 'VERIFICATION_API_ERROR';
      let errorMessage = 'Customer verification service is currently unavailable';
      
      if (apiError.code === 'ECONNABORTED' || apiError.message.includes('timeout')) {
        statusCode = 504;
        errorCode = 'VERIFICATION_TIMEOUT';
        errorMessage = 'Customer verification request timed out. Please try again.';
      } else if (apiError.response?.status === 401 || apiError.response?.status === 403) {
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
          variation_id: variation_id || null
        }
      });
    }
    
  } catch (error) {
    logger.error('Customer verification unexpected error:', {
      userId: req.user?.id,
      error: error.message,
      stack: error.stack
    });
    
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred during customer verification'
    });
  }
});

/**
 * Get supported services endpoint
 */
router.get('/services', (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      message: 'Supported verification services',
      data: {
        electricity: {
          services: ELECTRICITY_SERVICES,
          meter_types: VALID_METER_TYPES,
          requires_variation_id: true,
          description: 'Verify meter/account numbers for electricity providers'
        },
        cable_tv: {
          services: CABLE_TV_SERVICES,
          requires_variation_id: false,
          description: 'Verify smartcard numbers for cable TV providers'
        },
        betting: {
          services: BETTING_SERVICES,
          requires_variation_id: false,
          description: 'Verify betting account IDs for betting platforms'
        }
      },
      total_services: ELECTRICITY_SERVICES.length + CABLE_TV_SERVICES.length + BETTING_SERVICES.length
    });
  } catch (error) {
    logger.error('Get supported services error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'Customer Verification API',
    timestamp: new Date().toISOString(),
    ebillsBaseUrl: EBILLS_BASE_URL,
    version: '1.0.0',
    supported_categories: ['electricity', 'cable_tv', 'betting'],
    total_services: ELECTRICITY_SERVICES.length + CABLE_TV_SERVICES.length + BETTING_SERVICES.length
  });
});

module.exports = router;