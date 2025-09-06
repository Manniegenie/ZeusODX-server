const crypto = require('crypto');
const axios = require('axios');
const User = require('../models/user');
const logger = require('../utils/logger');

/**
 * Smile ID NIN Verification Service
 * Handles Nigerian National Identification Number verification via Smile ID API
 */
class SmileIDNINService {
  constructor() {
    this.partnerId = process.env.SMILE_ID_PARTNER_ID;
    this.apiKey = process.env.SMILE_ID_API_KEY;
    this.callbackUrl = process.env.SMILE_ID_CALLBACK_URL;
    this.isProduction = process.env.NODE_ENV === 'production';
    
    // API URLs
    this.sandboxURL = 'https://testapi.smileidentity.com/v1';
    this.prodURL = 'https://api.smileidentity.com/v1';
    this.apiURL = this.isProduction ? this.prodURL : this.sandboxURL;

    // Validate required environment variables
    if (!this.partnerId || !this.apiKey) {
      logger.error('SmileIDNINService: Missing required environment variables', {
        hasPartnerId: !!this.partnerId,
        hasApiKey: !!this.apiKey
      });
    }
  }

  /**
   * Generate signature for Smile ID API authentication
   * @param {string} timestamp - ISO timestamp
   * @param {string} partnerId - Partner ID
   * @param {string} requestType - Type of request
   * @returns {string} - Generated signature
   */
  generateSignature(timestamp, partnerId, requestType = 'sid_request') {
    try {
      const signatureString = `${timestamp}${partnerId}${requestType}`;
      return crypto
        .createHmac('sha256', this.apiKey)
        .update(signatureString)
        .digest('base64');
    } catch (error) {
      logger.error('SmileIDNINService: Error generating signature', {
        error: error.message
      });
      throw new Error('Failed to generate API signature');
    }
  }

  /**
   * Generate timestamp in ISO format
   * @returns {string} - ISO timestamp
   */
  generateTimestamp() {
    return new Date().toISOString();
  }

  /**
   * Validate NIN format (11 digits)
   * @param {string} nin - National Identification Number
   * @returns {boolean} - True if valid format
   */
  validateNINFormat(nin) {
    if (!nin || typeof nin !== 'string') {
      return false;
    }
    const ninRegex = /^\d{11}$/;
    return ninRegex.test(nin.trim());
  }

  /**
   * Perform Basic KYC verification with NIN
   * @param {Object} verificationData - User data for verification
   * @returns {Promise<Object>} - Verification response
   */
  async verifyNIN(verificationData) {
    try {
      const {
        userId,
        nin,
        firstName,
        lastName,
        middleName = '',
        dateOfBirth, // YYYY-MM-DD format
        gender, // M or F
        phoneNumber,
        jobId = null
      } = verificationData;

      // Validate required fields
      if (!userId || !nin || !firstName || !lastName || !dateOfBirth || !gender) {
        throw new Error('Missing required fields for NIN verification');
      }

      // Validate NIN format
      if (!this.validateNINFormat(nin)) {
        throw new Error('Invalid NIN format. NIN must be exactly 11 digits.');
      }

      // Validate environment setup
      if (!this.partnerId || !this.apiKey) {
        throw new Error('Smile ID credentials not configured');
      }

      // Generate authentication data
      const timestamp = this.generateTimestamp();
      const signature = this.generateSignature(timestamp, this.partnerId);
      const uniqueJobId = jobId || `nin_${userId}_${Date.now()}`;

      // Prepare request payload for Basic KYC
      const payload = {
        source_sdk: 'rest_api',
        source_sdk_version: '1.0.0',
        partner_id: this.partnerId,
        signature: signature,
        timestamp: timestamp,
        country: 'NG', // Nigeria
        id_type: 'NIN_V2', // Using NIN V2 for better reliability
        id_number: nin.trim(),
        callback_url: this.callbackUrl,
        partner_params: {
          user_id: userId,
          job_id: uniqueJobId,
          job_type: 1, // Basic KYC
          verification_type: 'nin_verification'
        },
        first_name: firstName.trim(),
        middle_name: middleName?.trim() || '',
        last_name: lastName.trim(),
        dob: dateOfBirth, // YYYY-MM-DD format
        gender: gender.toUpperCase(),
        phone_number: phoneNumber?.trim() || ''
      };

      logger.info('SmileIDNINService: Initiating NIN verification', {
        userId,
        jobId: uniqueJobId,
        ninMasked: nin.slice(0, 3) + '********',
        apiUrl: this.apiURL,
        isProduction: this.isProduction,
        partnerId: this.partnerId,
        timestamp: timestamp,
        hasApiKey: !!this.apiKey,
        signatureLength: signature?.length
      });

      // Make API request to Smile ID (using asynchronous endpoint)
      const response = await axios.post(
        `${this.apiURL}/async_basic_kyc`,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'ZeusODX-NIN-Service/1.0',
            // Authentication headers - this is the key fix
            'SmileApiKey': this.apiKey,
            'signature': signature,
            'timestamp': timestamp,
            'partner_id': this.partnerId
          },
          timeout: 30000, // 30 seconds timeout
          validateStatus: (status) => status < 500 // Don't throw on 4xx errors
        }
      );

      // Handle response
      if (response.status === 200 && response.data) {
        logger.info('SmileIDNINService: NIN verification request submitted successfully', {
          userId,
          jobId: uniqueJobId,
          smileJobId: response.data.SmileJobID,
          responseStatus: response.status
        });

        return {
          success: true,
          message: 'NIN verification submitted successfully',
          jobId: uniqueJobId,
          smileJobId: response.data.SmileJobID,
          status: 'pending',
          submittedAt: new Date().toISOString()
        };

      } else {
        logger.error('SmileIDNINService: Unexpected response from Smile ID', {
          userId,
          status: response.status,
          data: response.data
        });
        throw new Error(`Smile ID API returned status: ${response.status}`);
      }

    } catch (error) {
      logger.error('SmileIDNINService: NIN verification failed', {
        error: error.message,
        stack: error.stack,
        userId: verificationData?.userId,
        isAxiosError: error.isAxiosError,
        responseStatus: error.response?.status,
        responseData: error.response?.data
      });

      // Handle specific error types
      if (error.isAxiosError) {
        if (error.code === 'ECONNABORTED') {
          throw new Error('NIN verification request timed out. Please try again.');
        }
        if (error.response?.status === 401 || error.response?.status === 403) {
          throw new Error('Authentication failed with Smile ID. Please check credentials.');
        }
        if (error.response?.status === 400) {
          throw new Error('Invalid NIN verification request. Please check your information.');
        }
      }

      throw new Error(`NIN verification failed: ${error.message}`);
    }
  }

  /**
   * Handle webhook callback from Smile ID
   * @param {Object} callbackData - Webhook payload from Smile ID
   * @returns {Promise<Object>} - Processing result
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
      } = callbackData;

      const userId = PartnerParams?.user_id;
      const jobId = PartnerParams?.job_id;

      if (!userId) {
        throw new Error('User ID not found in callback data');
      }

      logger.info('SmileIDNINService: Processing NIN verification callback', {
        userId,
        jobId,
        smileJobId: SmileJobID,
        resultCode: ResultCode,
        resultText: ResultText
      });

      // Optional: Verify signature for additional security
      if (signature && timestamp) {
        try {
          const expectedSignature = this.generateSignature(timestamp, this.partnerId, 'sid_response');
          if (signature !== expectedSignature) {
            logger.warn('SmileIDNINService: Invalid signature in callback', { 
              userId, 
              smileJobId: SmileJobID 
            });
          }
        } catch (sigError) {
          logger.warn('SmileIDNINService: Could not verify callback signature', {
            error: sigError.message,
            userId,
            smileJobId: SmileJobID
          });
        }
      }

      // Find user
      const user = await User.findById(userId);
      if (!user) {
        throw new Error(`User not found: ${userId}`);
      }

      // Process verification result based on Smile ID result codes
      const isVerified = ResultCode === '1012'; // 1012 = Identity Verified
      const isPartialMatch = ResultCode === '1013'; // 1013 = Partial Identity Verified
      const isFailed = !isVerified && !isPartialMatch;

      const now = new Date();

      if (isVerified) {
        // Full verification success
        user.kyc.level2.status = 'approved';
        user.kyc.level2.documentSubmitted = true;
        user.kyc.level2.documentType = 'NIN';
        user.kyc.level2.documentNumber = id_number || user.kyc.level2.documentNumber;
        user.kyc.level2.approvedAt = now;
        user.kyc.level2.rejectionReason = null;

        // Auto-upgrade to KYC Level 2 if email is also verified
        if (user.emailVerified) {
          user.kycLevel = 2;
          user.kycStatus = 'approved';
          user.kyc.level2.emailVerified = true;
        } else {
          user.kycStatus = 'under_review'; // Waiting for email verification
        }

        await user.save();

        logger.info('SmileIDNINService: NIN verification successful', {
          userId,
          smileJobId: SmileJobID,
          newKycLevel: user.kycLevel,
          emailVerified: user.emailVerified
        });

      } else if (isPartialMatch) {
        // Partial match - requires manual review
        user.kyc.level2.status = 'under_review';
        user.kyc.level2.documentSubmitted = true;
        user.kyc.level2.documentType = 'NIN';
        user.kyc.level2.submittedAt = now;
        user.kyc.level2.rejectionReason = `Partial match: ${ResultText}`;
        user.kycStatus = 'under_review';

        await user.save();

        logger.info('SmileIDNINService: NIN verification returned partial match', {
          userId,
          smileJobId: SmileJobID,
          resultText: ResultText
        });

      } else {
        // Verification failed
        user.kyc.level2.status = 'rejected';
        user.kyc.level2.rejectedAt = now;
        user.kyc.level2.rejectionReason = ResultText || 'NIN verification failed';
        user.kycStatus = 'rejected';

        await user.save();

        logger.warn('SmileIDNINService: NIN verification failed', {
          userId,
          smileJobId: SmileJobID,
          resultCode: ResultCode,
          resultText: ResultText
        });
      }

      return {
        success: true,
        userId,
        verification_status: isVerified ? 'verified' : (isPartialMatch ? 'partial' : 'failed'),
        kyc_level: user.kycLevel,
        kyc_status: user.kycStatus,
        result_code: ResultCode,
        result_text: ResultText,
        processed_at: now.toISOString()
      };

    } catch (error) {
      logger.error('SmileIDNINService: Error processing NIN verification callback', {
        error: error.message,
        stack: error.stack,
        callbackData: JSON.stringify(callbackData)
      });

      throw error;
    }
  }

  /**
   * Get verification status by job ID or user ID
   * @param {string} identifier - Job ID or User ID
   * @param {string} type - 'job' or 'user'
   * @returns {Promise<Object>} - Verification status
   */
  async getVerificationStatus(identifier, type = 'user') {
    try {
      let user;

      if (type === 'job') {
        // Find user by job ID (stored in documentNumber or custom field)
        user = await User.findOne({
          $or: [
            { 'kyc.level2.documentNumber': identifier },
            { 'partnerParams.job_id': identifier }
          ]
        });
      } else {
        // Find user by user ID
        user = await User.findById(identifier);
      }

      if (!user) {
        return {
          success: false,
          message: 'Verification record not found',
          status: 'not_found'
        };
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
        limits: user.getKycLimits()
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
   * Get sandbox test data for development/testing
   * @returns {Object} - Test data for sandbox environment
   */
  getSandboxTestData() {
    return {
      environment: 'sandbox',
      note: 'These are test NINs provided by Smile ID for sandbox testing only',
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
        '2303': 'ID Verification Failed'
      }
    };
  }

  /**
   * Health check for the service
   * @returns {Object} - Service health status
   */
  getHealthStatus() {
    return {
      service: 'SmileIDNINService',
      status: 'operational',
      environment: this.isProduction ? 'production' : 'sandbox',
      api_url: this.apiURL,
      has_credentials: !!(this.partnerId && this.apiKey),
      has_callback_url: !!this.callbackUrl,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = SmileIDNINService;