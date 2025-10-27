const axios = require('axios');
const logger = require('../utils/logger');

/**
 * PayBeta Authentication Class
 * Handles PayBeta API authentication and requests
 * Based on PayBeta API documentation
 */
class PayBetaAuth {
  constructor() {
    this.baseURL = process.env.PAYBETA_API_URL || 'https://api.paybeta.ng';
    this.apiKey = process.env.PAYBETA_API_KEY?.trim();
    
    if (!this.apiKey) {
      logger.warn('PayBeta API key not configured. Set PAYBETA_API_KEY environment variable.');
    }
  }

  /**
   * Get authorization header with API key
   * @returns {Object} Authorization header object
   */
  getAuthHeader() {
    if (!this.apiKey) {
      throw new Error('PayBeta API key not configured. Please set PAYBETA_API_KEY environment variable.');
    }

    return {
      'P-API-KEY': this.apiKey,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };
  }

  /**
   * Make authenticated request to PayBeta API
   * @param {string} method - HTTP method (GET, POST, etc.)
   * @param {string} endpoint - API endpoint (e.g., '/airtime/purchase')
   * @param {Object} data - Request data for POST/PUT requests
   * @param {Object} options - Additional axios options
   * @returns {Promise<Object>} API response
   */
  async makeRequest(method, endpoint, data = null, options = {}) {
    try {
      const authHeader = this.getAuthHeader();
      
      const requestConfig = {
        method: method.toUpperCase(),
        url: `${this.baseURL}${endpoint}`,
        headers: {
          ...authHeader,
          ...options.headers
        },
        timeout: options.timeout || 30000,
        ...options
      };

      if (data && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
        requestConfig.data = data;
      }

      logger.info(`🔍 PayBeta API Request Debug:`, {
        method: method.toUpperCase(),
        endpoint,
        fullURL: `${this.baseURL}${endpoint}`,
        hasApiKey: !!this.apiKey,
        apiKeyLength: this.apiKey?.length,
        dataKeys: data ? Object.keys(data) : [],
        data: data,
        headers: requestConfig.headers,
        timeout: requestConfig.timeout
      });
      
      const response = await axios(requestConfig);
      
      if (!response || response.status < 200 || response.status >= 300) {
        throw new Error(`Unexpected response status: ${response?.status}`);
      }

      return response.data;

    } catch (error) {
      logger.error(`💥 PayBeta API request failed - COMPREHENSIVE DEBUG:`, {
        method: method.toUpperCase(),
        endpoint,
        fullURL: `${this.baseURL}${endpoint}`,
        status: error.response?.status,
        statusText: error.response?.statusText,
        message: error.response?.data?.message || error.message,
        data: error.response?.data,
        headers: error.response?.headers,
        requestData: data,
        errorCode: error.code,
        errorMessage: error.message,
        stack: error.stack,
        axiosError: {
          isAxiosError: error.isAxiosError,
          config: error.config,
          response: error.response
        }
      });
      
      if (error.response?.status === 401) {
        throw new Error('PayBeta API authentication failed. Check your API key.');
      }
      
      if (error.response?.status === 403) {
        throw new Error('PayBeta API access denied. Check your API key permissions.');
      }
      
      if (error.response?.status === 400) {
        const errorMsg = error.response.data?.message || 'Bad request';
        throw new Error(`PayBeta API validation error: ${errorMsg}`);
      }
      
      if (error.code === 'ETIMEDOUT') {
        throw new Error('PayBeta API request timed out. The service may be slow or unavailable.');
      }
      
      throw error;
    }
  }

  /**
   * Test PayBeta API connection
   * @returns {Promise<Object>} Test results
   */
  async testConnection() {
    try {
      logger.info('Testing PayBeta API connection...');
      
      if (!this.apiKey) {
        return {
          success: false,
          authenticated: false,
          error: 'API key not configured',
          suggestion: 'Set PAYBETA_API_KEY environment variable'
        };
      }

      // Test with a simple request (you might need to adjust this based on available endpoints)
      const response = await this.makeRequest('POST', '/v2/airtime/purchase', {
        service: 'mtn_vtu',
        phoneNumber: '08123456789',
        amount: 100,
        reference: 'test_' + Date.now().toString().slice(-8) // Keep under 40 chars
      });

      return {
        success: true,
        authenticated: true,
        message: 'PayBeta API connection successful'
      };
      
    } catch (error) {
      logger.error('PayBeta API test failed:', error.message);
      return {
        success: false,
        authenticated: false,
        error: error.message,
        suggestion: this.getSuggestionForError(error.message)
      };
    }
  }

  /**
   * Get suggestions for common errors
   * @param {string} errorMessage - Error message
   * @returns {string} Suggestion
   */
  getSuggestionForError(errorMessage) {
    if (errorMessage.includes('API key not configured')) {
      return 'Set PAYBETA_API_KEY environment variable with your PayBeta API key.';
    }
    
    if (errorMessage.includes('authentication failed') || errorMessage.includes('401')) {
      return 'Check your PayBeta API key. Ensure it is correct and active.';
    }
    
    if (errorMessage.includes('access denied') || errorMessage.includes('403')) {
      return 'Check your PayBeta account permissions. Ensure your API key has the required access.';
    }
    
    if (errorMessage.includes('validation error') || errorMessage.includes('400')) {
      return 'Check your request parameters. Ensure all required fields are provided and valid.';
    }
    
    if (errorMessage.includes('timeout')) {
      return 'PayBeta API is slow or unavailable. Try again later.';
    }
    
    return 'Check PayBeta service status and your API configuration.';
  }
}

// Create singleton instance
const payBetaAuth = new PayBetaAuth();

module.exports = {
  PayBetaAuth,
  payBetaAuth,
  
  // Convenience methods
  makeRequest: (method, endpoint, data, options) => payBetaAuth.makeRequest(method, endpoint, data, options),
  testConnection: () => payBetaAuth.testConnection()
};
