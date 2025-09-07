const crypto = require('crypto');
const logger = require('./logger');

/**
 * SmileID Authentication Utility (v2 endpoints)
 */
class SmileIDAuth {
  constructor(options = {}) {
    // Credentials & config
    this.partnerId   = options.partnerId  || process.env.SMILE_ID_PARTNER_ID;
    this.apiKey      = options.apiKey     || process.env.SMILE_ID_API_KEY;
    this.callbackUrl = options.callbackUrl|| process.env.SMILE_ID_CALLBACK_URL;
    this.isProduction = options.isProduction ?? (process.env.NODE_ENV === 'production');

    // v2 base URLs (no trailing /v1)
    this.sandboxBase = 'https://testapi.smileidentity.com';
    this.prodBase    = 'https://api.smileidentity.com';
    this.apiBase     = this.isProduction ? this.prodBase : this.sandboxBase;

    this.validateCredentials();
  }

  validateCredentials() {
    const missing = [];
    if (!this.partnerId) missing.push('SMILE_ID_PARTNER_ID');
    if (!this.apiKey)    missing.push('SMILE_ID_API_KEY');

    if (missing.length) {
      const msg = `SmileIDAuth: Missing required credentials: ${missing.join(', ')}`;
      logger.error(msg, {
        hasPartnerId: !!this.partnerId,
        hasApiKey: !!this.apiKey,
        hasCallbackUrl: !!this.callbackUrl,
        environment: this.isProduction ? 'production' : 'sandbox'
      });
      throw new Error(msg);
    }

    logger.info('SmileIDAuth: Credentials validated', {
      environment: this.isProduction ? 'production' : 'sandbox',
      apiBase: this.apiBase,
      hasCallbackUrl: !!this.callbackUrl
    });
  }

  generateTimestamp() {
    return new Date().toISOString();
  }

  /**
   * HMAC-SHA256 over `${timestamp}${partner_id}${requestType}`
   * requestType: 'sid_request' for requests, 'sid_response' for callbacks
   */
  generateSignature(timestamp, partnerId = null, requestType = 'sid_request') {
    try {
      const pid = partnerId || this.partnerId;
      if (!pid || !this.apiKey) throw new Error('Partner ID and API Key are required for signature generation');

      const str = `${timestamp}${pid}${requestType}`;
      const signature = crypto.createHmac('sha256', this.apiKey).update(str).digest('base64');

      logger.debug('SmileIDAuth: Signature generated', {
        timestamp, partnerId: pid, requestType, signatureLength: signature.length
      });
      return signature;
    } catch (err) {
      logger.error('SmileIDAuth: Signature generation failed', {
        error: err.message, timestamp, partnerId: partnerId || this.partnerId, requestType
      });
      throw new Error(`Failed to generate API signature: ${err.message}`);
    }
  }

  /**
   * Most v2 verify endpoints expect auth in the BODY (partner_id, timestamp, signature).
   * Keep headers minimal.
   */
  generateAuthHeaders(timestamp = null) {
    // Kept for consistency; NOT sending API key as a header to verify endpoints.
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'ZeusODX-SmileID-Service/1.0'
    };
  }

  generateAuthData(timestamp = null) {
    const ts = timestamp || this.generateTimestamp();
    const signature = this.generateSignature(ts, this.partnerId, 'sid_request');
    return { partner_id: this.partnerId, signature, timestamp: ts };
  }

  verifyCallbackSignature(receivedSignature, timestamp, partnerId = null) {
    try {
      const pid = partnerId || this.partnerId;
      const expected = this.generateSignature(timestamp, pid, 'sid_response');
      const ok = receivedSignature === expected;

      if (!ok) {
        logger.warn('SmileIDAuth: Invalid callback signature', {
          timestamp, partnerId: pid,
          receivedSignatureLength: receivedSignature?.length,
          expectedSignatureLength: expected?.length
        });
      } else {
        logger.debug('SmileIDAuth: Callback signature OK', { timestamp, partnerId: pid });
      }
      return ok;
    } catch (err) {
      logger.error('SmileIDAuth: Error verifying callback signature', {
        error: err.message, timestamp, partnerId: partnerId || this.partnerId
      });
      return false;
    }
  }

  getConfig() {
    return {
      apiURL: this.apiBase,
      partnerId: this.partnerId,
      callbackUrl: this.callbackUrl,
      isProduction: this.isProduction,
      environment: this.isProduction ? 'production' : 'sandbox',
      hasApiKey: !!this.apiKey,
      hasCallbackUrl: !!this.callbackUrl
    };
  }

  /**
   * v2 endpoints map
   * - Basic KYC (async): /v2/verify_async
   * - Basic KYC (sync):  /v2/verify
   * - Job status (async result fetch): /v2/job_status
   * Add/adjust others only when you actively use them.
   */
  getEndpoints() {
    const base = this.apiBase;
    return {
      basicKycAsync: `${base}/v2/verify_async`,
      basicKycSync:  `${base}/v2/verify`,
      jobStatus:     `${base}/v2/job_status`,
      // Add others you truly need later, mapped to v2:
      // e.g., `documentVerification`, `enhancedKyc`, etc., when you implement them.
    };
  }

  createInstance(newCredentials) {
    return new SmileIDAuth({ ...this.getConfig(), ...newCredentials });
  }

  getHealthStatus() {
    return {
      service: 'SmileIDAuth',
      status: 'operational',
      environment: this.isProduction ? 'production' : 'sandbox',
      api_url: this.apiBase,
      has_credentials: !!(this.partnerId && this.apiKey),
      has_callback_url: !!this.callbackUrl,
      partner_id: this.partnerId,
      timestamp: new Date().toISOString()
    };
  }

  testAuthentication() {
    try {
      const timestamp = this.generateTimestamp();
      const signature = this.generateSignature(timestamp, this.partnerId, 'sid_request');
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
      return { success: false, message: 'Authentication test failed', error: error.message };
    }
  }
}

module.exports = SmileIDAuth;
