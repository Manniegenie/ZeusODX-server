const axios = require('axios');
const logger = require('../utils/logger');

/**
 * Timeout presets tuned for Nigerian billers / DISCO realities
 */
const TIMEOUTS = {
  DEFAULT: 90000,        // 90s baseline
  AIRTIME: 60000,        // 60s
  DATA: 60000,
  ELECTRICITY: 180000,   // 3 minutes
  STATUS: 30000          // 30s
};

/**
 * Internal error mapper
 * Never expose third-party providers to frontend
 */
function mapToPublicError(error) {
  // Timeout ≠ failure
  if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
    return new Error(
      'Transaction is taking longer than expected. Please check transaction status before retrying.'
    );
  }

  if (error.response?.status === 401 || error.response?.status === 403) {
    return new Error(
      'Service is temporarily unavailable. Please try again later.'
    );
  }

  if (error.response?.status === 400) {
    return new Error(
      error.response?.data?.message ||
      'Invalid transaction request. Please review your details.'
    );
  }

  if (error.response?.status >= 500) {
    return new Error(
      'Service is currently unavailable. Please try again shortly.'
    );
  }

  return new Error(
    'Transaction could not be completed at this time. Please try again.'
  );
}

/**
 * PayBeta Authentication Class
 * Handles PayBeta API authentication and requests
 */
class PayBetaAuth {
  constructor() {
    this.baseURL = process.env.PAYBETA_API_URL || 'https://api.paybeta.ng';
    this.apiKey = process.env.PAYBETA_API_KEY?.trim();

    if (!this.apiKey) {
      logger.warn('PayBeta API key not configured.');
    }
  }

  /**
   * Build auth headers
   */
  getAuthHeader() {
    if (!this.apiKey) {
      throw new Error('Service configuration error.');
    }

    return {
      'P-API-KEY': this.apiKey,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };
  }

  /**
   * Make authenticated request
   */
  async makeRequest(method, endpoint, data = null, options = {}) {
    try {
      const requestConfig = {
        method: method.toUpperCase(),
        url: `${this.baseURL}${endpoint}`,
        headers: {
          ...this.getAuthHeader(),
          ...options.headers
        },
        timeout: options.timeout ?? TIMEOUTS.DEFAULT,
        ...options
      };

      if (data && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
        requestConfig.data = data;
      }

      logger.info('🔍 Upstream request', {
        provider: 'PayBeta',
        method: requestConfig.method,
        endpoint,
        timeout: requestConfig.timeout,
        payloadKeys: data ? Object.keys(data) : []
      });

      const response = await axios(requestConfig);

      if (!response || response.status < 200 || response.status >= 300) {
        throw new Error(`Unexpected upstream status: ${response?.status}`);
      }

      return response.data;
    } catch (error) {
      // Full upstream visibility — logs only
      logger.error('💥 Upstream provider error', {
        provider: 'PayBeta',
        method,
        endpoint,
        status: error.response?.status,
        message: error.response?.data?.message || error.message,
        data: error.response?.data,
        code: error.code,
        stack: error.stack
      });

      // Never leak provider details
      throw mapToPublicError(error);
    }
  }

  /**
   * Internal connectivity test (not frontend-facing)
   */
  async testConnection() {
    try {
      if (!this.apiKey) {
        return {
          success: false,
          authenticated: false,
          error: 'Missing API configuration'
        };
      }

      await this.makeRequest(
        'POST',
        '/v2/airtime/purchase',
        {
          service: 'mtn_vtu',
          phoneNumber: '08123456789',
          amount: 100,
          reference: 'test_' + Date.now().toString().slice(-8)
        },
        { timeout: TIMEOUTS.AIRTIME }
      );

      return {
        success: true,
        authenticated: true
      };
    } catch (error) {
      return {
        success: false,
        authenticated: false,
        error: error.message
      };
    }
  }
}

// Singleton
const payBetaAuth = new PayBetaAuth();

module.exports = {
  TIMEOUTS,
  PayBetaAuth,
  payBetaAuth,
  makeRequest: (method, endpoint, data, options) =>
    payBetaAuth.makeRequest(method, endpoint, data, options),
  testConnection: () => payBetaAuth.testConnection()
};
