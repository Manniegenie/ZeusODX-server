const crypto = require('crypto');
const logger = require('./logger');

/**
 * SmileID Authentication Utility
 * Handles authentication, signature generation, and API configuration for Smile ID
 */
class SmileIDAuth {
  constructor(options = {}) {
    // Environment variables with fallbacks
    this.partnerId = options.partnerId || process.env.SMILE_ID_PARTNER_ID;
    this.apiKey = options.apiKey || process.env.SMILE_ID_API_KEY;
    this.callbackUrl = options.callbackUrl || process.env.SMILE_ID_CALLBACK_URL;
    this.isProduction = options.isProduction ?? (process.env.NODE_ENV === 'production');
    
    // API URLs
    this.sandboxURL = 'https://testapi.smileidentity.com/v1';
    this.prodURL = 'https://api.smileidentity.com/v1';
    this.apiURL = this.isProduction ? this.prodURL : this.sandboxURL;

    // Validate required credentials
    this.validateCredentials();
  }

  /**
   * Validate required environment variables/credentials
   * @throws {Error} If required credentials are missing
   */
  validateCredentials() {
    const missing = [];
    
    if (!this.partnerId) missing.push('SMILE_ID_PARTNER_ID');
    if (!this.apiKey) missing.push('SMILE_ID_API_KEY');
    
    if (missing.length > 0) {
      const errorMsg = `SmileIDAuth: Missing required credentials: ${missing.join(', ')}`;
      logger.error(errorMsg, {
        hasPartnerId: !!this.partnerId,
        hasApiKey: !!this.apiKey,
        hasCallbackUrl: !!this.callbackUrl,
        environment: this.isProduction ? 'production' : 'sandbox'
      });
      throw new Error(errorMsg);
    }

    logger.info('SmileIDAuth: Credentials validated successfully', {
      environment: this.isProduction ? 'production' : 'sandbox',
      apiUrl: this.apiURL,
      hasCallbackUrl: !!this.callbackUrl
    });
  }

  /**
   * Generate timestamp in ISO format with milliseconds (required by Smile ID)
   * @returns {string} ISO timestamp in format "yyyy-MM-dd'T'HH:mm:ss.fffZ"
   */
  generateTimestamp() {
    const now = new Date();
    return now.toISOString(); // This already gives us the correct format: 2024-09-07T09:02:15.887Z
  }

  /**
   * Generate HMAC signature for Smile ID API authentication
   * @param {string} timestamp - ISO timestamp
   * @param {string} partnerId - Partner ID (optional, uses instance partnerId if not provided)
   * @param {string} requestType - Type of request ('sid_request' for requests, 'sid_response' for callbacks)
   * @returns {string} Base64 encoded signature
   * @throws {Error} If signature generation fails
   */
  generateSignature(timestamp, partnerId = null, requestType = 'sid_request') {
    try {
      const partnerIdToUse = partnerId || this.partnerId;
      
      if (!partnerIdToUse || !this.apiKey) {
        throw new Error('Partner ID and API Key are required for signature generation');
      }

      const signatureString = `${timestamp}${partnerIdToUse}${requestType}`;
      const signature = crypto
        .createHmac('sha256', this.apiKey)
        .update(signatureString)
        .digest('base64');

      logger.debug('SmileIDAuth: Signature generated successfully', {
        timestamp,
        partnerId: partnerIdToUse,
        requestType,
        signatureLength: signature.length
      });

      return signature;
    } catch (error) {
      logger.error('SmileIDAuth: Error generating signature', {
        error: error.message,
        timestamp,
        partnerId: partnerId || this.partnerId,
        requestType
      });
      throw new Error(`Failed to generate API signature: ${error.message}`);
    }
  }

  /**
   * Generate authentication headers for Smile ID API requests
   * @param {string} timestamp - Optional timestamp (will generate if not provided)
   * @param {string} requestType - Type of request ('sid_request' for requests, 'sid_response' for callbacks)
   * @returns {Object} Headers object with authentication
   */
  generateAuthHeaders(timestamp = null, requestType = 'sid_request') {
    const ts = timestamp || this.generateTimestamp();
    const signature = this.generateSignature(ts, this.partnerId, requestType);

    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'ZeusODX-SmileID-Service/1.0',
      'SmileApiKey': this.apiKey,
      'signature': signature,
      'timestamp': ts,
      'partner_id': this.partnerId
    };
  }

  /**
   * Generate authentication data object for API payloads
   * @param {string} timestamp - Optional timestamp (will generate if not provided)
   * @returns {Object} Authentication data object
   */
  generateAuthData(timestamp = null) {
    const ts = timestamp || this.generateTimestamp();
    const signature = this.generateSignature(ts, this.partnerId);

    return {
      partner_id: this.partnerId,
      signature: signature,
      timestamp: ts
    };
  }

  /**
   * Verify signature from callback (for webhook validation)
   * @param {string} receivedSignature - Signature received in callback
   * @param {string} timestamp - Timestamp from callback
   * @param {string} partnerId - Partner ID from callback (optional)
   * @returns {boolean} True if signature is valid
   */
  verifyCallbackSignature(receivedSignature, timestamp, partnerId = null) {
    try {
      const partnerIdToUse = partnerId || this.partnerId;
      const expectedSignature = this.generateSignature(timestamp, partnerIdToUse, 'sid_response');
      
      const isValid = receivedSignature === expectedSignature;
      
      if (!isValid) {
        logger.warn('SmileIDAuth: Invalid callback signature detected', {
          timestamp,
          partnerId: partnerIdToUse,
          receivedSignatureLength: receivedSignature?.length,
          expectedSignatureLength: expectedSignature?.length
        });
      } else {
        logger.debug('SmileIDAuth: Callback signature verified successfully', {
          timestamp,
          partnerId: partnerIdToUse
        });
      }

      return isValid;
    } catch (error) {
      logger.error('SmileIDAuth: Error verifying callback signature', {
        error: error.message,
        timestamp,
        partnerId: partnerId || this.partnerId
      });
      return false;
    }
  }

  /**
   * Get current API configuration
   * @returns {Object} Current configuration
   */
  getConfig() {
    return {
      apiURL: this.apiURL,
      partnerId: this.partnerId,
      callbackUrl: this.callbackUrl,
      isProduction: this.isProduction,
      environment: this.isProduction ? 'production' : 'sandbox',
      hasApiKey: !!this.apiKey,
      hasCallbackUrl: !!this.callbackUrl
    };
  }

  /**
   * Get API endpoints for different services
   * @returns {Object} Available API endpoints
   */
  getEndpoints() {
    return {
      basicKyc: `${this.apiURL}/async_basic_kyc`,
      documentVerification: `${this.apiURL}/document_verification`,
      biometricKyc: `${this.apiURL}/biometric_kyc`,
      amlCheck: `${this.apiURL}/aml_check`,
      enhancedKyc: `${this.apiURL}/enhanced_kyc`,
      idVerification: `${this.apiURL}/id_verification`,
      jobStatus: `${this.apiURL}/job_status`
    };
  }

  /**
   * Create a new auth instance with different credentials
   * Useful for multi-tenant applications
   * @param {Object} newCredentials - New credentials to use
   * @returns {SmileIDAuth} New auth instance
   */
  createInstance(newCredentials) {
    return new SmileIDAuth({
      ...this.getConfig(),
      ...newCredentials
    });
  }

  /**
   * Health check for authentication service
   * @returns {Object} Health status
   */
  getHealthStatus() {
    return {
      service: 'SmileIDAuth',
      status: 'operational',
      environment: this.isProduction ? 'production' : 'sandbox',
      api_url: this.apiURL,
      has_credentials: !!(this.partnerId && this.apiKey),
      has_callback_url: !!this.callbackUrl,
      partner_id: this.partnerId,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Test authentication by generating a sample signature
   * @returns {Object} Test result
   */
  testAuthentication() {
    try {
      const timestamp = this.generateTimestamp();
      const signature = this.generateSignature(timestamp);
      const headers = this.generateAuthHeaders(timestamp);

      return {
        success: true,
        message: 'Authentication test successful',
        test_data: {
          timestamp,
          signature_length: signature.length,
          headers_count: Object.keys(headers).length,
          partner_id: this.partnerId,
          environment: this.isProduction ? 'production' : 'sandbox'
        }
      };
    } catch (error) {
      return {
        success: false,
        message: 'Authentication test failed',
        error: error.message
      };
    }
  }
}

module.exports = SmileIDAuth;