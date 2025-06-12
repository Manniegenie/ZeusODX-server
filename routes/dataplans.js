const express = require('express');
const axios = require('axios');
const logger = require('../utils/logger');

// eBills API configuration
const EBILLS_BASE_URL = process.env.EBILLS_BASE_URL || 'https://ebills.africa/wp-json';

// Creating a router instance
const router = express.Router();

/**
 * Get data plan variations from eBills API
 * POST /data/plans - Get data plans with optional service_id filter
 */
router.post('/plans', async (req, res) => {
  try {
    const { service_id } = req.body;
    
    // Validate service_id if provided
    if (service_id) {
      const validServiceIds = ['mtn', 'airtel', 'glo', '9mobile', 'smile'];
      if (!validServiceIds.includes(service_id.toLowerCase())) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_SERVICE_ID',
          message: 'Invalid service ID. Must be one of: mtn, airtel, glo, 9mobile, smile',
          validServiceIds
        });
      }
    }
    
    logger.info('Fetching data plan variations', { service_id: service_id || 'all' });
    
    // Prepare query parameters
    const queryParams = service_id ? { service_id: service_id.toLowerCase() } : {};
    
    // Make request to eBills API (this is a public endpoint, no auth required)
    const response = await axios.get(`${EBILLS_BASE_URL}/api/v2/variations/data`, {
      params: queryParams,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    logger.info('Data plans fetched successfully', { 
      service_id: service_id || 'all',
      count: response.data?.data?.length || 0 
    });
    
    // Handle eBills API response
    if (response.data.code === 'success') {
      // Filter out unavailable plans by default (can be made configurable)
      const allPlans = response.data.data || [];
      const availablePlans = allPlans.filter(plan => plan.availability === 'Available');
      
      // Group plans by service provider for better organization
      const plansByProvider = availablePlans.reduce((acc, plan) => {
        const provider = plan.service_id;
        if (!acc[provider]) {
          acc[provider] = [];
        }
        acc[provider].push({
          variation_id: plan.variation_id,
          service_name: plan.service_name,
          service_id: plan.service_id,
          data_plan: plan.data_plan,
          price: parseInt(plan.price), // Convert price to number
          price_formatted: `₦${parseInt(plan.price).toLocaleString()}`,
          availability: plan.availability
        });
        return acc;
      }, {});
      
      return res.status(200).json({
        success: true,
        message: service_id ? 
          `${service_id.toUpperCase()} data plans retrieved successfully` : 
          'All data plans retrieved successfully',
        data: {
          plans_by_provider: plansByProvider,
          total_available_plans: availablePlans.length,
          total_all_plans: allPlans.length,
          filter_applied: service_id || null,
          providers_available: Object.keys(plansByProvider)
        },
        // Also include raw data for backward compatibility
        raw_data: response.data
      });
      
    } else {
      // Handle eBills API error responses
      logger.warn('eBills API returned error:', response.data);
      
      return res.status(400).json({
        success: false,
        error: 'EBILLS_API_ERROR',
        message: response.data.message || 'Failed to fetch data plans',
        ebills_code: response.data.code
      });
    }
    
  } catch (error) {
    logger.error('Fetch data plans error:', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
      service_id: req.body?.service_id
    });
    
    // Handle different types of errors
    if (error.response) {
      const status = error.response.status;
      const errorData = error.response.data;
      
      if (status === 400 && errorData?.code === 'invalid_service_id') {
        return res.status(400).json({
          success: false,
          error: 'INVALID_SERVICE_ID',
          message: 'Invalid service ID provided to eBills API'
        });
      }
      
      if (status === 404 && errorData?.code === 'no_product') {
        return res.status(404).json({
          success: false,
          error: 'NO_PRODUCT',
          message: 'Data plans product not found'
        });
      }
      
      return res.status(status).json({
        success: false,
        error: 'EBILLS_API_ERROR',
        message: errorData?.message || 'eBills API request failed'
      });
    }
    
    // Network or timeout errors
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      return res.status(504).json({
        success: false,
        error: 'TIMEOUT',
        message: 'Request to eBills API timed out. Please try again.'
      });
    }
    
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred while fetching data plans'
    });
  }
});

/**
 * Get data plan variations with query parameters (alternative endpoint)
 * GET /data/plans?service_id=mtn - Get data plans with optional service_id filter
 */
router.get('/plans', async (req, res) => {
  try {
    const { service_id } = req.query;
    
    // Validate service_id if provided
    if (service_id) {
      const validServiceIds = ['mtn', 'airtel', 'glo', '9mobile', 'smile'];
      if (!validServiceIds.includes(service_id.toLowerCase())) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_SERVICE_ID',
          message: 'Invalid service ID. Must be one of: mtn, airtel, glo, 9mobile, smile',
          validServiceIds
        });
      }
    }
    
    logger.info('Fetching data plan variations (GET)', { service_id: service_id || 'all' });
    
    // Prepare query parameters
    const queryParams = service_id ? { service_id: service_id.toLowerCase() } : {};
    
    // Make request to eBills API (this is a public endpoint, no auth required)
    const response = await axios.get(`${EBILLS_BASE_URL}/api/v2/variations/data`, {
      params: queryParams,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    logger.info('Data plans fetched successfully (GET)', { 
      service_id: service_id || 'all',
      count: response.data?.data?.length || 0 
    });
    
    // Handle eBills API response (same logic as POST endpoint)
    if (response.data.code === 'success') {
      const allPlans = response.data.data || [];
      const availablePlans = allPlans.filter(plan => plan.availability === 'Available');
      
      return res.status(200).json({
        success: true,
        message: service_id ? 
          `${service_id.toUpperCase()} data plans retrieved successfully` : 
          'All data plans retrieved successfully',
        data: {
          plans: availablePlans.map(plan => ({
            variation_id: plan.variation_id,
            service_name: plan.service_name,
            service_id: plan.service_id,
            data_plan: plan.data_plan,
            price: parseInt(plan.price),
            price_formatted: `₦${parseInt(plan.price).toLocaleString()}`,
            availability: plan.availability
          })),
          total_available_plans: availablePlans.length,
          total_all_plans: allPlans.length,
          filter_applied: service_id || null
        }
      });
      
    } else {
      return res.status(400).json({
        success: false,
        error: 'EBILLS_API_ERROR',
        message: response.data.message || 'Failed to fetch data plans',
        ebills_code: response.data.code
      });
    }
    
  } catch (error) {
    logger.error('Fetch data plans error (GET):', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
      service_id: req.query?.service_id
    });
    
    // Same error handling as POST endpoint
    if (error.response) {
      const status = error.response.status;
      const errorData = error.response.data;
      
      if (status === 400 && errorData?.code === 'invalid_service_id') {
        return res.status(400).json({
          success: false,
          error: 'INVALID_SERVICE_ID',
          message: 'Invalid service ID provided to eBills API'
        });
      }
      
      if (status === 404 && errorData?.code === 'no_product') {
        return res.status(404).json({
          success: false,
          error: 'NO_PRODUCT',
          message: 'Data plans product not found'
        });
      }
      
      return res.status(status).json({
        success: false,
        error: 'EBILLS_API_ERROR',
        message: errorData?.message || 'eBills API request failed'
      });
    }
    
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      return res.status(504).json({
        success: false,
        error: 'TIMEOUT',
        message: 'Request to eBills API timed out. Please try again.'
      });
    }
    
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred while fetching data plans'
    });
  }
});

/**
 * Get available network providers for data plans
 * GET /data/providers - Get list of available network providers
 */
router.get('/providers', (req, res) => {
  const providers = [
    {
      service_id: 'mtn',
      service_name: 'MTN',
      description: 'MTN Nigeria data plans'
    },
    {
      service_id: 'airtel',
      service_name: 'Airtel',
      description: 'Airtel Nigeria data plans'
    },
    {
      service_id: 'glo',
      service_name: 'Glo',
      description: 'Globacom Nigeria data plans'
    },
    {
      service_id: '9mobile',
      service_name: '9mobile',
      description: '9mobile Nigeria data plans'
    },
    {
      service_id: 'smile',
      service_name: 'Smile',
      description: 'Smile Nigeria data plans'
    }
  ];
  
  return res.status(200).json({
    success: true,
    message: 'Available network providers retrieved successfully',
    data: {
      providers,
      total_providers: providers.length
    }
  });
});

/**
 * Health check endpoint for data plans service
 */
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'Data Plans API',
    timestamp: new Date().toISOString(),
    ebillsBaseUrl: EBILLS_BASE_URL,
    version: '1.0.0'
  });
});

module.exports = router;