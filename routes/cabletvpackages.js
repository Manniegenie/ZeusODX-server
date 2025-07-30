const express = require('express');
const axios = require('axios');
const logger = require('../utils/logger');

// eBills API configuration
const EBILLS_BASE_URL = process.env.EBILLS_BASE_URL || 'https://ebills.africa/wp-json';

// Creating a router instance
const router = express.Router();

/**
 * Get cable TV package variations from eBills API
 * POST /tv/packages - Get cable TV packages with optional service_id filter
 */
router.post('/packages', async (req, res) => {
  try {
    const { service_id } = req.body;
    
    // Validate service_id if provided
    if (service_id) {
      const validServiceIds = ['dstv', 'gotv', 'startimes', 'showmax'];
      if (!validServiceIds.includes(service_id.toLowerCase())) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_SERVICE_ID',
          message: 'Invalid service ID. Must be one of: dstv, gotv, startimes, showmax',
          validServiceIds
        });
      }
    }
    
    logger.info('Fetching cable TV package variations', { service_id: service_id || 'all' });
    
    // Prepare query parameters
    const queryParams = service_id ? { service_id: service_id.toLowerCase() } : {};
    
    // Make request to eBills API (this is a public endpoint, no auth required)
    const response = await axios.get(`${EBILLS_BASE_URL}/api/v2/variations/tv`, {
      params: queryParams,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    logger.info('Cable TV packages fetched successfully', { 
      service_id: service_id || 'all',
      count: response.data?.data?.length || 0 
    });
    
    // Handle eBills API response
    if (response.data.code === 'success') {
      // Filter out unavailable packages by default (can be made configurable)
      const allPackages = response.data.data || [];
      const availablePackages = allPackages.filter(pkg => pkg.availability === 'Available');
      
      // Group packages by service provider for better organization
      const packagesByProvider = availablePackages.reduce((acc, pkg) => {
        const provider = pkg.service_id;
        if (!acc[provider]) {
          acc[provider] = [];
        }
        acc[provider].push({
          variation_id: pkg.variation_id,
          service_name: pkg.service_name,
          service_id: pkg.service_id,
          package_bouquet: pkg.package_bouquet,
          price: parseInt(pkg.price), // Convert price to number
          price_formatted: `₦${parseInt(pkg.price).toLocaleString()}`,
          availability: pkg.availability
        });
        return acc;
      }, {});
      
      return res.status(200).json({
        success: true,
        message: service_id ? 
          `${service_id.toUpperCase()} cable TV packages retrieved successfully` : 
          'All cable TV packages retrieved successfully',
        data: {
          packages_by_provider: packagesByProvider,
          total_available_packages: availablePackages.length,
          total_all_packages: allPackages.length,
          filter_applied: service_id || null,
          providers_available: Object.keys(packagesByProvider)
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
        message: response.data.message || 'Failed to fetch cable TV packages',
        ebills_code: response.data.code
      });
    }
    
  } catch (error) {
    logger.error('Fetch cable TV packages error:', {
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
          message: 'Cable TV packages product not found'
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
      message: 'An unexpected error occurred while fetching cable TV packages'
    });
  }
});

/**
 * Get cable TV package variations with query parameters (alternative endpoint)
 * GET /tv/packages?service_id=dstv - Get cable TV packages with optional service_id filter
 */
router.get('/packages', async (req, res) => {
  try {
    const { service_id } = req.query;
    
    // Validate service_id if provided
    if (service_id) {
      const validServiceIds = ['dstv', 'gotv', 'startimes', 'showmax'];
      if (!validServiceIds.includes(service_id.toLowerCase())) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_SERVICE_ID',
          message: 'Invalid service ID. Must be one of: dstv, gotv, startimes, showmax',
          validServiceIds
        });
      }
    }
    
    logger.info('Fetching cable TV package variations (GET)', { service_id: service_id || 'all' });
    
    // Prepare query parameters
    const queryParams = service_id ? { service_id: service_id.toLowerCase() } : {};
    
    // Make request to eBills API (this is a public endpoint, no auth required)
    const response = await axios.get(`${EBILLS_BASE_URL}/api/v2/variations/tv`, {
      params: queryParams,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    logger.info('Cable TV packages fetched successfully (GET)', { 
      service_id: service_id || 'all',
      count: response.data?.data?.length || 0 
    });
    
    // Handle eBills API response (same logic as POST endpoint)
    if (response.data.code === 'success') {
      const allPackages = response.data.data || [];
      const availablePackages = allPackages.filter(pkg => pkg.availability === 'Available');
      
      return res.status(200).json({
        success: true,
        message: service_id ? 
          `${service_id.toUpperCase()} cable TV packages retrieved successfully` : 
          'All cable TV packages retrieved successfully',
        data: {
          packages: availablePackages.map(pkg => ({
            variation_id: pkg.variation_id,
            service_name: pkg.service_name,
            service_id: pkg.service_id,
            package_bouquet: pkg.package_bouquet,
            price: parseInt(pkg.price),
            price_formatted: `₦${parseInt(pkg.price).toLocaleString()}`,
            availability: pkg.availability
          })),
          total_available_packages: availablePackages.length,
          total_all_packages: allPackages.length,
          filter_applied: service_id || null
        }
      });
      
    } else {
      return res.status(400).json({
        success: false,
        error: 'EBILLS_API_ERROR',
        message: response.data.message || 'Failed to fetch cable TV packages',
        ebills_code: response.data.code
      });
    }
    
  } catch (error) {
    logger.error('Fetch cable TV packages error (GET):', {
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
          message: 'Cable TV packages product not found'
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
      message: 'An unexpected error occurred while fetching cable TV packages'
    });
  }
});

/**
 * Get available cable TV providers
 * GET /tv/providers - Get list of available cable TV providers
 */
router.get('/providers', (req, res) => {
  const providers = [
    {
      service_id: 'dstv',
      service_name: 'DStv',
      description: 'DStv Nigeria cable TV packages'
    },
    {
      service_id: 'gotv',
      service_name: 'GOtv',
      description: 'GOtv Nigeria cable TV packages'
    },
    {
      service_id: 'startimes',
      service_name: 'Startimes',
      description: 'Startimes Nigeria cable TV packages'
    },
    {
      service_id: 'showmax',
      service_name: 'Showmax',
      description: 'Showmax Nigeria streaming packages'
    }
  ];
  
  return res.status(200).json({
    success: true,
    message: 'Available cable TV providers retrieved successfully',
    data: {
      providers,
      total_providers: providers.length
    }
  });
});

/**
 * Health check endpoint for cable TV service
 */
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'Cable TV API',
    timestamp: new Date().toISOString(),
    ebillsBaseUrl: EBILLS_BASE_URL,
    version: '1.0.0'
  });
});

module.exports = router;