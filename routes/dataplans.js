const express = require('express');
const logger = require('../utils/logger');
const { payBetaAuth } = require('../auth/paybetaAuth');

// PayBeta API configuration
const PAYBETA_BASE_URL = process.env.PAYBETA_API_URL || 'https://api.paybeta.ng';

// Creating a router instance
const router = express.Router();

/**
 * Get data plan variations from PayBeta API
 * POST /data/plans - Get data plans with optional service_id filter
 */
router.post('/plans', async (req, res) => {
  try {
    const { service_id } = req.body;
    
    // Validate service_id if provided
    if (service_id) {
      const validServiceIds = ['mtn_data', 'airtel_data', 'glo_data', '9mobile_data', 'smile_data'];
      if (!validServiceIds.includes(service_id.toLowerCase())) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_SERVICE_ID',
          message: 'Invalid service ID. Must be one of: mtn_data, airtel_data, glo_data, 9mobile_data, smile_data',
          validServiceIds
        });
      }
    }
    
    logger.info('Fetching data plan variations from PayBeta', { service_id: service_id || 'all' });
    
    // Make request to PayBeta API
    const response = await payBetaAuth.makeRequest('POST', '/v2/data-bundle/list', {
      service: service_id || 'mtn_data' // Default to mtn_data if no service specified
    });
    
    if (response.status === 'successful') {
      const packages = response.data.packages || [];
      
      // Transform PayBeta packages to match our format
      const transformedPackages = packages.map(pkg => ({
        variation_id: pkg.code,
        service_name: service_id ? service_id.replace('_data', '').toUpperCase() : 'Data Bundle',
        service_id: service_id || 'mtn_data',
        data_plan: pkg.description,
        price: parseFloat(pkg.price),
        price_formatted: `₦${parseFloat(pkg.price).toLocaleString()}`,
        availability: 'Available'
      }));
      
      // Group packages by service provider
      const packagesByProvider = transformedPackages.reduce((acc, pkg) => {
        const provider = pkg.service_id;
        if (!acc[provider]) {
          acc[provider] = [];
        }
        acc[provider].push(pkg);
        return acc;
      }, {});
      
      logger.info('Data plans fetched successfully from PayBeta', { 
        service_id: service_id || 'all',
        count: transformedPackages.length 
      });
      
      return res.status(200).json({
        success: true,
        message: service_id ? 
          `${service_id.replace('_data', '').toUpperCase()} data plans retrieved successfully` : 
          'All data plans retrieved successfully',
        data: {
          plans_by_provider: packagesByProvider,
          total_available_plans: transformedPackages.length,
          total_all_plans: transformedPackages.length,
          filter_applied: service_id || null,
          providers_available: Object.keys(packagesByProvider)
        },
        // Also include raw data for backward compatibility
        raw_data: response
      });
      
    } else {
      logger.warn('PayBeta API returned error:', response);
      
      return res.status(400).json({
        success: false,
        error: 'PAYBETA_API_ERROR',
        message: response.message || 'Failed to fetch data plans'
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
      
      if (status === 400 && errorData?.message?.includes('service')) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_SERVICE_ID',
          message: 'Invalid service ID provided'
        });
      }

      return res.status(status).json({
        success: false,
        error: 'SERVICE_API_ERROR',
        message: errorData?.message || 'Service request failed'
      });
    }

    // Network or timeout errors
    if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
      return res.status(504).json({
        success: false,
        error: 'TIMEOUT',
        message: 'Service request timed out. Please try again.'
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
 * GET /data/plans?service_id=mtn_data - Get data plans with optional service_id filter
 */
router.get('/plans', async (req, res) => {
  try {
    const { service_id } = req.query;
    
    // Validate service_id if provided
    if (service_id) {
      const validServiceIds = ['mtn_data', 'airtel_data', 'glo_data', '9mobile_data', 'smile_data'];
      if (!validServiceIds.includes(service_id.toLowerCase())) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_SERVICE_ID',
          message: 'Invalid service ID. Must be one of: mtn_data, airtel_data, glo_data, 9mobile_data, smile_data',
          validServiceIds
        });
      }
    }
    
    logger.info('Fetching data plan variations from PayBeta (GET)', { service_id: service_id || 'all' });
    
    // Make request to PayBeta API
    const response = await payBetaAuth.makeRequest('POST', '/v2/data-bundle/list', {
      service: service_id || 'mtn_data' // Default to mtn_data if no service specified
    });
    
    if (response.status === 'successful') {
      const packages = response.data.packages || [];
      
      // Transform PayBeta packages to match our format
      const transformedPackages = packages.map(pkg => ({
        variation_id: pkg.code,
        service_name: service_id ? service_id.replace('_data', '').toUpperCase() : 'Data Bundle',
        service_id: service_id || 'mtn_data',
        data_plan: pkg.description,
        price: parseFloat(pkg.price),
        price_formatted: `₦${parseFloat(pkg.price).toLocaleString()}`,
        availability: 'Available'
      }));
      
      logger.info('Data plans fetched successfully from PayBeta (GET)', { 
        service_id: service_id || 'all',
        count: transformedPackages.length 
      });
      
      return res.status(200).json({
        success: true,
        message: service_id ? 
          `${service_id.replace('_data', '').toUpperCase()} data plans retrieved successfully` : 
          'All data plans retrieved successfully',
        data: {
          plans: transformedPackages,
          total_available_plans: transformedPackages.length,
          total_all_plans: transformedPackages.length,
          filter_applied: service_id || null
        }
      });
      
    } else {
      return res.status(400).json({
        success: false,
        error: 'PAYBETA_API_ERROR',
        message: response.message || 'Failed to fetch data plans'
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
      
      if (status === 400 && errorData?.message?.includes('service')) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_SERVICE_ID',
          message: 'Invalid service ID provided'
        });
      }

      return res.status(status).json({
        success: false,
        error: 'SERVICE_API_ERROR',
        message: errorData?.message || 'Service request failed'
      });
    }

    if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
      return res.status(504).json({
        success: false,
        error: 'TIMEOUT',
        message: 'Service request timed out. Please try again.'
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
      service_id: 'mtn_data',
      service_name: 'MTN',
      description: 'MTN Nigeria data plans'
    },
    {
      service_id: 'airtel_data',
      service_name: 'Airtel',
      description: 'Airtel Nigeria data plans'
    },
    {
      service_id: 'glo_data',
      service_name: 'Glo',
      description: 'Globacom Nigeria data plans'
    },
    {
      service_id: '9mobile_data',
      service_name: '9mobile',
      description: '9mobile Nigeria data plans'
    },
    {
      service_id: 'smile_data',
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
    payBetaBaseUrl: PAYBETA_BASE_URL,
    version: '2.0.0'
  });
});

module.exports = router;