const express = require('express');
const axios = require('axios');
const logger = require('../utils/logger');
const { payBetaAuth } = require('../auth/paybetaAuth');

// PayBeta API configuration
const PAYBETA_BASE_URL = process.env.PAYBETA_API_URL || 'https://api.paybeta.ng';

// Creating a router instance
const router = express.Router();

/**
 * Get cable TV package variations from PayBeta API
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
    
    logger.info('Fetching cable TV package variations from PayBeta', { service_id: service_id || 'all' });
    
    let response;
    
    // Handle Showmax separately as it has its own endpoint
    if (service_id && service_id.toLowerCase() === 'showmax') {
      logger.info('Fetching Showmax packages from dedicated endpoint');
      response = await payBetaAuth.makeRequest('GET', '/v2/showmax/bouquet');
    } else {
      // Make request to PayBeta API for other providers
      response = await payBetaAuth.makeRequest('POST', '/v2/cable/bouquet', {
        service: service_id || 'dstv' // Default to dstv if no service specified
      });
    }
    
    if (response.status === 'successful') {
      const packages = response.data.packages || [];
      
      // Transform PayBeta packages to match our format
      const transformedPackages = packages.map(pkg => ({
        variation_id: pkg.code,
        service_name: service_id ? service_id.toUpperCase() : 'Cable TV',
        service_id: service_id || 'dstv',
        package_bouquet: pkg.description,
        price: parseFloat(pkg.price), // Use parseFloat for Showmax decimal prices
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
      
      logger.info('Cable TV packages fetched successfully from PayBeta', { 
        service_id: service_id || 'all',
        count: transformedPackages.length 
      });
      
      return res.status(200).json({
        success: true,
        message: service_id ? 
          `${service_id.toUpperCase()} cable TV packages retrieved successfully` : 
          'All cable TV packages retrieved successfully',
        data: {
          packages_by_provider: packagesByProvider,
          total_available_packages: transformedPackages.length,
          total_all_packages: transformedPackages.length,
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
        message: response.message || 'Failed to fetch cable TV packages'
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
    
    logger.info('Fetching cable TV package variations from PayBeta (GET)', { service_id: service_id || 'all' });
    
    // Make request to PayBeta API
    const response = await payBetaAuth.makeRequest('POST', '/v2/cable/bouquet', {
      service: service_id || 'dstv' // Default to dstv if no service specified
    });
    
    if (response.status === 'successful') {
      const packages = response.data.packages || [];
      
      // Transform PayBeta packages to match our format
      const transformedPackages = packages.map(pkg => ({
        variation_id: pkg.code,
        service_name: service_id ? service_id.toUpperCase() : 'Cable TV',
        service_id: service_id || 'dstv',
        package_bouquet: pkg.description,
        price: parseFloat(pkg.price), // Use parseFloat for Showmax decimal prices
        price_formatted: `₦${parseFloat(pkg.price).toLocaleString()}`,
        availability: 'Available'
      }));
      
      logger.info('Cable TV packages fetched successfully from PayBeta (GET)', { 
        service_id: service_id || 'all',
        count: transformedPackages.length 
      });
      
      return res.status(200).json({
        success: true,
        message: service_id ? 
          `${service_id.toUpperCase()} cable TV packages retrieved successfully` : 
          'All cable TV packages retrieved successfully',
        data: {
          packages: transformedPackages,
          total_available_packages: transformedPackages.length,
          total_all_packages: transformedPackages.length,
          filter_applied: service_id || null
        }
      });
      
    } else {
      return res.status(400).json({
        success: false,
        error: 'PAYBETA_API_ERROR',
        message: response.message || 'Failed to fetch cable TV packages'
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
      message: 'An unexpected error occurred while fetching cable TV packages'
    });
  }
});

/**
 * Get available cable TV providers from PayBeta
 * GET /tv/providers - Get list of available cable TV providers
 */
router.get('/providers', async (req, res) => {
  try {
    logger.info('Fetching cable TV providers from PayBeta');
    
    const response = await payBetaAuth.makeRequest('GET', '/v2/cable/providers');
    
    if (response.status === 'successful') {
      const providers = response.data.map(provider => ({
        service_id: provider.slug,
        service_name: provider.name,
        category: provider.category,
        status: provider.status,
        logo: provider.logo,
        description: `${provider.name} cable TV packages`
      }));
      
      logger.info('Cable TV providers fetched successfully from PayBeta', { 
        count: providers.length 
      });
      
      return res.status(200).json({
        success: true,
        message: 'Available cable TV providers retrieved successfully',
        data: {
          providers,
          total_providers: providers.length
        }
      });
    } else {
      return res.status(400).json({
        success: false,
        error: 'PAYBETA_API_ERROR',
        message: response.message || 'Failed to fetch cable TV providers'
      });
    }
    
  } catch (error) {
    logger.error('Fetch cable TV providers error:', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred while fetching cable TV providers'
    });
  }
});

/**
 * Health check endpoint for cable TV service
 */
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'Cable TV API',
    timestamp: new Date().toISOString(),
    payBetaBaseUrl: PAYBETA_BASE_URL,
    version: '2.0.0'
  });
});

module.exports = router;