// services/SmileIDService.js
const axios = require('axios');
const User = require('../models/user');
const logger = require('../utils/logger');
const SmileIDAuth = require('../utils/SmileIDauth');

/**
 * Smile ID NIN Verification Service (v2 /verify_async)
 * - Uses v2 endpoints from SmileIDauth.getEndpoints()
 * - Basic KYC job_type = 5
 */
class SmileIDNINService {
  constructor(options = {}) {
    this.auth = new SmileIDAuth(options);

    const config = this.auth.getConfig();
    this.apiURL = config.apiURL;            // base, e.g. https://testapi.smileidentity.com
    this.callbackUrl = config.callbackUrl;  // your webhook URL
    this.isProduction = config.isProduction;
    this.partnerId = config.partnerId;

    logger.info('SmileIDNINService: Initialized', {
      environment: config.environment,
      apiBase: this.apiURL,
      hasCallbackUrl: !!this.callbackUrl,
      partnerId: this.partnerId
    });
  }

  /**
   * Validate NIN format (exactly 11 digits)
   */
  validateNINFormat(nin) {
    if (!nin || typeof nin !== 'string') return false;
    return /^\d{11}$/.test(nin.trim());
  }

  /**
   * Submit Basic KYC verification with NIN (async)
   * Expects: userId, nin, firstName, lastName, dateOfBirth (YYYY-MM-DD), gender (M/F)
   */
  async verifyNIN(verificationData) {
    try {
      const {
        userId,
        nin,
        firstName,
        lastName,
        middleName = '',
        dateOfBirth,   // YYYY-MM-DD
        gender,        // M or F
        phoneNumber,
        jobId = null
      } = verificationData || {};

      // Required checks
      if (!userId || !nin || !firstName || !lastName || !dateOfBirth || !gender) {
        throw new Error('Missing required fields for NIN verification');
      }

      if (!this.validateNINFormat(nin)) {
        throw new Error('Invalid NIN format. NIN must be exactly 11 digits.');
      }

      // Auth trio for body
      const authData = this.auth.generateAuthData();
      const uniqueJobId = jobId || `nin_${userId}_${Date.now()}`;

      // Compose payload to match Smile v2 verify_async (Basic KYC)
      const payload = {
        source_sdk: 'rest_api',
        source_sdk_version: '1.0.0',
        partner_id: authData.partner_id,
        signature: authData.signature,
        timestamp: authData.timestamp,

        country: 'NG',
        id_type: 'NIN',
        id_number: nin.trim(),

        // Async requires callback_url
        callback_url: this.callbackUrl,

        // Personal info (recommended for NIN)
        first_name: firstName.trim(),
        middle_name: middleName?.trim() || '',
        last_name: lastName.trim(),
        dob: dateOfBirth, // YYYY-MM-DD
        gender: String(gender).toUpperCase(),
        phone_number: phoneNumber?.trim() || '',

        // Legacy mapping still used by Smile: Basic KYC = 5
        partner_params: {
          user_id: userId,
          job_id: uniqueJobId,
          job_type: 5
        }
      };

      const headers = this.auth.generateAuthHeaders(); // minimal headers

      const { basicKycAsync } = this.auth.getEndpoints();
      const url = basicKycAsync;

      logger.info('SmileIDNINService: Sending Basic KYC (NIN) request', {
        userId,
        jobId: uniqueJobId,
        ninMasked: nin.slice(0, 3) + '********',
        url,
        environment: this.isProduction ? 'production' : 'sandbox',
        partnerId: this.partnerId,
        timestamp: authData.timestamp
      });

      const response = await axios.post(url, payload, {
        headers,
        timeout: 30000,
        validateStatus: (s) => s < 500 // capture 4xx for our own error messages
      });

      if (response.status === 200 && response.data) {
        // Smile can return different keys; normalize a few common ones
        const data = response.data || {};
        const smileJobId =
          data.SmileJobID ||
          data.smile_job_id ||
          data.job_id ||
          data.SmileJobId ||
          null;

        logger.info('SmileIDNINService: Verification submitted', {
          userId,
          jobId: uniqueJobId,
          smileJobId,
          status: response.status
        });

        return {
          success: true,
          message: 'NIN verification submitted successfully',
          jobId: uniqueJobId,
          smileJobId,
          status: 'pending',
          submittedAt: new Date().toISOString(),
          raw: data
        };
      }

      // Non-200 (but <500) → log and throw
      logger.error('SmileIDNINService: Unexpected response from Smile ID', {
        userId,
        status: response.status,
        data: response.data,
        headers: response.headers
      });
      throw new Error(`Smile ID API returned status: ${response.status}`);
    } catch (error) {
      logger.error('SmileIDNINService: NIN verification failed', {
        error: error.message,
        stack: error.stack,
        userId: verificationData?.userId,
        isAxiosError: !!error.isAxiosError,
        responseStatus: error.response?.status,
        responseData: error.response?.data,
        responseHeaders: error.response?.headers
      });

      // Better developer-facing messages
      if (error.isAxiosError) {
        if (error.code === 'ECONNABORTED') {
          throw new Error('NIN verification request timed out. Please try again.');
        }
        const st = error.response?.status;
        if (st === 401 || st === 403) {
          // Commonly hit when the PATH/METHOD is wrong; with v2 url fixed this should go away
          throw new Error('Authentication failed with Smile ID. Please check credentials and endpoint.');
        }
        if (st === 400) {
          throw new Error('Invalid NIN verification request. Please check the submitted information.');
        }
      }

      throw new Error(`NIN verification failed: ${error.message}`);
    }
  }

  /**
   * Process Smile ID webhook callback (async results)
   * Persist results into the user.kyc structure.
   */
  async handleVerificationCallback(callbackData) {
    try {
      const {
        PartnerParams,
        ResultCode,
        ResultText,
        Actions,
        SmileJobID,
        signature,
        timestamp,
        id_number
      } = callbackData || {};

      const userId = PartnerParams?.user_id;
      const jobId = PartnerParams?.job_id;

      if (!userId) {
        throw new Error('User ID not found in callback data');
      }

      // Optional: verify callback signature
      if (signature && timestamp) {
        const ok = this.auth.verifyCallbackSignature(signature, timestamp);
        if (!ok) {
          logger.warn('SmileIDNINService: Invalid callback signature', {
            userId,
            smileJobId: SmileJobID
          });
          // proceed with caution
        }
      }

      const user = await User.findById(userId);
      if (!user) throw new Error(`User not found: ${userId}`);

      // Smile codes (commonly used)
      const VERIFIED = '1012';       // Identity Verified
      const PARTIAL  = '1013';       // Partial match (manual review)
      const now = new Date();

      logger.info('SmileIDNINService: Callback received', {
        userId,
        jobId,
        smileJobId: SmileJobID,
        resultCode: ResultCode,
        resultText: ResultText
      });

      if (ResultCode === VERIFIED) {
        user.kyc.level2.status = 'approved';
        user.kyc.level2.documentSubmitted = true;
        user.kyc.level2.documentType = 'NIN';
        if (id_number) user.kyc.level2.documentNumber = id_number;
        user.kyc.level2.approvedAt = now;
        user.kyc.level2.rejectionReason = null;

        // If email already verified, lift overall flags
        if (user.emailVerified) {
          user.kycLevel = Math.max(user.kycLevel ?? 0, 2);
          user.kycStatus = 'approved';
          user.kyc.level2.emailVerified = true;
        } else {
          user.kycStatus = 'under_review';
        }

        await user.save();

        return {
          success: true,
          userId,
          verification_status: 'verified',
          kyc_level: user.kycLevel,
          kyc_status: user.kycStatus,
          result_code: ResultCode,
          result_text: ResultText,
          processed_at: now.toISOString()
        };
      }

      if (ResultCode === PARTIAL) {
        user.kyc.level2.status = 'under_review';
        user.kyc.level2.documentSubmitted = true;
        user.kyc.level2.documentType = 'NIN';
        user.kyc.level2.submittedAt = now;
        user.kyc.level2.rejectionReason = `Partial match: ${ResultText || ''}`.trim();
        user.kycStatus = 'under_review';

        await user.save();

        return {
          success: true,
          userId,
          verification_status: 'partial',
          kyc_level: user.kycLevel,
          kyc_status: user.kycStatus,
          result_code: ResultCode,
          result_text: ResultText,
          processed_at: now.toISOString()
        };
      }

      // Any other code → failed
      user.kyc.level2.status = 'rejected';
      user.kyc.level2.rejectedAt = now;
      user.kyc.level2.rejectionReason = ResultText || 'NIN verification failed';
      user.kycStatus = 'rejected';

      await user.save();

      return {
        success: true,
        userId,
        verification_status: 'failed',
        kyc_level: user.kycLevel,
        kyc_status: user.kycStatus,
        result_code: ResultCode,
        result_text: ResultText,
        processed_at: now.toISOString()
      };
    } catch (error) {
      logger.error('SmileIDNINService: Error processing callback', {
        error: error.message,
        stack: error.stack,
        callbackData: JSON.stringify(callbackData)
      });
      throw error;
    }
  }

  /**
   * Query verification status from your DB (by user or job id)
   */
  async getVerificationStatus(identifier, type = 'user') {
    try {
      let user;

      if (type === 'job') {
        // Example of job lookup if you persisted job ids elsewhere
        user = await User.findOne({
          $or: [
            { 'kyc.level2.documentNumber': identifier },
            { 'partnerParams.job_id': identifier }
          ]
        });
      } else {
        user = await User.findById(identifier);
      }

      if (!user) {
        return { success: false, message: 'Verification record not found', status: 'not_found' };
      }

      return {
        success: true,
        userId: user._id,
        kycLevel: user.kycLevel,
        kycStatus: user.kycStatus,
        level2Status: user.kyc.level2.status,
        documentType: user.kyc.level2.documentType,
        documentSubmitted: user.kyc.level2.documentSubmitted,
        submittedAt: user.kyc.level2.submittedAt,
        approvedAt: user.kyc.level2.approvedAt,
        rejectedAt: user.kyc.level2.rejectedAt,
        rejectionReason: user.kyc.level2.rejectionReason,
        emailVerified: user.emailVerified,
        limits: user.getKycLimits?.()
      };
    } catch (error) {
      logger.error('SmileIDNINService: Error getting verification status', {
        error: error.message,
        identifier,
        type
      });
      throw new Error(`Failed to get verification status: ${error.message}`);
    }
  }

  /**
   * Sandbox test data helper
   */
  getSandboxTestData() {
    return {
      environment: this.isProduction ? 'production' : 'sandbox',
      note: 'Sandbox-only test NINs',
      test_data: [
        {
          nin: '12345678901',
          first_name: 'Test',
          last_name: 'User',
          middle_name: 'Middle',
          dob: '1990-01-01',
          gender: 'M',
          phone_number: '08012345678',
          expected_result: 'verified'
        },
        {
          nin: '12345678902',
          first_name: 'Partial',
          last_name: 'Match',
          middle_name: '',
          dob: '1985-05-15',
          gender: 'F',
          phone_number: '08087654321',
          expected_result: 'partial_match'
        },
        {
          nin: '12345678903',
          first_name: 'Failed',
          last_name: 'Verification',
          middle_name: 'Test',
          dob: '1992-12-25',
          gender: 'M',
          phone_number: '08099887766',
          expected_result: 'failed'
        },
        {
          nin: '12345678904',
          first_name: 'Invalid',
          last_name: 'Format',
          middle_name: '',
          dob: '1988-08-08',
          gender: 'F',
          phone_number: '08011223344',
          expected_result: 'invalid_format'
        }
      ],
      result_codes: {
        '1012': 'Identity Verified (Success)',
        '1013': 'Partial Identity Verified (Manual Review)',
        '2302': 'ID Not Found',
        '2303': 'ID Verification Failed',
        '2212': 'Invalid job type (use 5 for Basic KYC)'
      }
    };
  }

  testAuthentication() {
    return this.auth.testAuthentication();
  }

  getHealthStatus() {
    const authHealth = this.auth.getHealthStatus();
    return {
      service: 'SmileIDNINService',
      status: 'operational',
      auth_service: authHealth,
      environment: this.isProduction ? 'production' : 'sandbox',
      api_url: this.apiURL,
      has_callback_url: !!this.callbackUrl,
      timestamp: new Date().toISOString()
    };
  }

  getAuthUtility() {
    return this.auth;
  }
}

module.exports = SmileIDNINService;
