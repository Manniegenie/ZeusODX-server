// routes/verifycabletv.js
const express = require('express');
const axios = require('axios');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Verify cable TV customer using PayBeta API
 * @param {string} service - Cable TV service (dstv, gotv, startimes, showmax)
 * @param {string} smartCardNumber - Smart card number
 * @returns {Promise<Object>} Verification result
 */
async function verifyCableTVCustomer(service, smartCardNumber) {
  try {
    const baseURL = process.env.PAYBETA_API_URL || 'https://api.paybeta.ng';
    const apiKey = process.env.PAYBETA_API_KEY;
    
    if (!apiKey) {
      throw new Error('PayBeta API key not configured');
    }

    const data = JSON.stringify({
      service: service,
      smartCardNumber: smartCardNumber
    });

    const config = {
      method: 'post',
      url: `${baseURL}/v2/cable/validate`,
      headers: { 
        'Accept': '', 
        'P-API-KEY': apiKey, 
        'Content-Type': 'application/json'
      },
      data: data,
      timeout: 25000
    };

    logger.info('🔍 Making PayBeta cable TV verification request:', {
      service: service,
      smartCardNumber: smartCardNumber.substring(0, 4) + '***',
      url: config.url
    });

    const response = await axios(config);
    
    logger.info('✅ PayBeta cable TV verification successful:', {
      service: service,
      smartCardNumber: smartCardNumber.substring(0, 4) + '***',
      status: response.data.status,
      customerName: response.data.data?.customerName
    });

    return {
      success: true,
      data: {
        customer_name: response.data.data.customerName,
        customer_id: response.data.data.smartCardNumber,
        service_id: response.data.data.service,
        status: 'verified',
        service_name: service.toUpperCase(),
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
    logger.error('❌ PayBeta cable TV verification failed:', {
      service: service,
      smartCardNumber: smartCardNumber.substring(0, 4) + '***',
      error: error.message,
      status: error.response?.status,
      responseData: error.response?.data
    });

    if (error.response?.status === 422) {
      throw new Error('Invalid smart card number. Please check the number and try again.');
    }
    
    if (error.response?.status === 401) {
      throw new Error('PayBeta API authentication failed. Please contact support.');
    }
    
    if (error.code === 'ETIMEDOUT') {
      throw new Error('Request timed out. Please try again.');
    }

    throw new Error(`Cable TV verification failed: ${error.message}`);
  }
}

/**
 * Cable TV customer verification endpoint
 */
router.post('/verify', async (req, res) => {
  const startTime = Date.now();
  const requestId = `cabletv_verify_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    const { service_id, customer_id } = req.body;
    
    // Validate required fields
    if (!service_id) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_SERVICE_ID',
        message: 'Service ID is required'
      });
    }
    
    if (!customer_id) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_CUSTOMER_ID',
        message: 'Customer ID (smart card number) is required'
      });
    }

    // Validate service_id
    const validServices = ['dstv', 'gotv', 'startimes', 'showmax'];
    if (!validServices.includes(service_id.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_SERVICE_ID',
        message: `Invalid service ID. Must be one of: ${validServices.join(', ')}`
      });
    }

    // Clean and validate smart card number
    let smartCardNumber = customer_id.trim().replace(/[\s\-_]/g, '');
    
    if (!/^\d+$/.test(smartCardNumber)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_SMART_CARD_FORMAT',
        message: 'Smart card number must contain only numbers'
      });
    }
    
    if (smartCardNumber.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_SMART_CARD_LENGTH',
        message: 'Smart card number must be at least 6 characters'
      });
    }

    logger.info('📺 Cable TV verification request:', {
      requestId,
      service_id,
      customer_id: customer_id.substring(0, 4) + '***',
      smartCardLength: smartCardNumber.length
    });

    // Call PayBeta verification
    const result = await verifyCableTVCustomer(service_id.toLowerCase(), smartCardNumber);
    
    const totalDuration = Date.now() - startTime;
    
    logger.info('✅ Cable TV verification completed successfully:', {
      requestId,
      service_id,
      customer_id: customer_id.substring(0, 4) + '***',
      customer_name: result.data.customer_name,
      totalDuration: `${totalDuration}ms`
    });

    return res.status(200).json({
      success: true,
      message: 'Cable TV customer verification successful',
      data: result.data,
      meta: {
        requestId,
        processingTime: `${totalDuration}ms`,
        service: service_id,
        verified_at: new Date().toISOString()
      }
    });

  } catch (error) {
    const totalDuration = Date.now() - startTime;
    
    logger.error('❌ Cable TV verification failed:', {
      requestId,
      error: error.message,
      totalDuration: `${totalDuration}ms`
    });

    return res.status(500).json({
      success: false,
      error: 'VERIFICATION_FAILED',
      message: error.message,
      meta: {
        requestId,
        processingTime: `${totalDuration}ms`
      }
    });
  }
});

/**
 * Test PayBeta cable TV verification with known working smart card
 */
router.post('/test', async (req, res) => {
  try {
    const testSmartCard = '8072916698'; // Known working smart card
    const testService = 'gotv';
    
    logger.info('🧪 Testing PayBeta cable TV verification:', {
      service: testService,
      smartCard: testSmartCard.substring(0, 4) + '***'
    });
    
    const result = await verifyCableTVCustomer(testService, testSmartCard);
    
    logger.info('✅ PayBeta cable TV test successful:', result);
    
    return res.status(200).json({
      success: true,
      message: 'PayBeta cable TV test successful',
      data: result.data
    });
    
  } catch (error) {
    logger.error('❌ PayBeta cable TV test failed:', error.message);
    
    return res.status(500).json({
      success: false,
      error: 'TEST_FAILED',
      message: error.message
    });
  }
});

module.exports = router;
