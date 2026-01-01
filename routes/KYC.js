const express = require("express");
const { body, validationResult } = require("express-validator");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const router = express.Router();

const User = require("../models/user");
const KYC = require("../models/kyc");
const config = require("./config");
const logger = require("../utils/logger");

// Youverify Configuration
const YOUVERIFY_CONFIG = {
  publicMerchantKey: process.env.YOUVERIFY_PUBLIC_MERCHANT_KEY || config.youverify?.publicMerchantKey,
  secretKey: process.env.YOUVERIFY_SECRET_KEY || config.youverify?.secretKey,
  callbackUrl: process.env.YOUVERIFY_CALLBACK_URL || config.youverify?.callbackUrl || 'https://your-domain.com/kyc-webhook/callback',
  apiBaseUrl: process.env.YOUVERIFY_API_URL || config.youverify?.apiBaseUrl || 'https://api.youverify.co'
};

// Nigerian ID type mappings for Youverify
const NIGERIAN_ID_TYPES = {
  'passport': 'passport',
  'national_id': 'nin',
  'drivers_license': 'drivers-license',
  'bvn': 'bvn',
  'nin': 'nin',
  'nin_slip': 'nin',
  'voter_id': 'pvc'
};

// ID Format validation patterns
const ID_PATTERNS = {
  'bvn': /^\d{11}$/, // 11 digits
  'nin': /^\d{11}$/, // 11 digits  
  'passport': /^[A-Z]\d{8}$/, // Letter + 8 digits
  'pvc': /^\d{19}$/, // 19 digits
  'drivers-license': /^[A-Z0-9]{8,20}$/ // 8-20 alphanumeric (varies by state)
};

// Middleware to authenticate JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: 'Access token required' });
  }

  const jwtSecret = config.jwtSecret || process.env.JWT_SECRET;
  jwt.verify(token, jwtSecret, (err, decoded) => {
    if (err) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    }
    req.user = decoded;
    next();
  });
};

// Validate Youverify configuration
const validateYouverifyConfig = () => {
  if (!YOUVERIFY_CONFIG.publicMerchantKey) {
    throw new Error('YOUVERIFY_PUBLIC_MERCHANT_KEY is not configured');
  }
};

// Updated result codes to match webhook
const APPROVED_CODES = new Set([
  '0810', '0820', '0830', '0840', // Enhanced KYC approved
  '1012', '1020', '1021', // Basic KYC approved
  '1210', '1220', '1230', '1240', // Biometric KYC approved
  '2302' // Job completed successfully
]);

const PROVISIONAL_CODES = new Set([
  '0812', '0814', '0815', '0816', '0817', // Enhanced KYC provisional
  '0822', '0824', '0825', // Enhanced KYC under review
  '1212', '1213', '1214', '1215', // Biometric KYC provisional
  '1222', '1223', '1224', '1225'  // Biometric KYC under review
]);

const REJECTED_CODES = new Set([
  '0813', '0826', '0827', // Enhanced KYC rejected
  '1011', '1013', '1014', '1015', '1016', // Basic KYC rejected
  '1216', '1217', '1218', '1226', '1227', '1228' // Biometric KYC rejected
]);

// Classify outcome function (same as webhook)
function classifyOutcome({ job_success, code, text, actions }) {
  // First check explicit job_success flag
  if (typeof job_success === 'boolean') {
    return job_success ? 'APPROVED' : 'REJECTED';
  }

  // Check result codes FIRST - this is most reliable
  const codeStr = String(code || '');
  if (APPROVED_CODES.has(codeStr)) return 'APPROVED';
  if (REJECTED_CODES.has(codeStr)) return 'REJECTED';
  if (PROVISIONAL_CODES.has(codeStr)) return 'PROVISIONAL';

  // More strict text-based classification - check for explicit failures first
  const t = (text || '').toLowerCase();

  // Explicit failure indicators - check these FIRST
  if (/(fail|rejected|no.?match|unable|unsupported|error|invalid|not.?found|not.?enabled|cannot|declined)/.test(t)) {
    return 'REJECTED';
  }

  // Provisional indicators
  if (/(provisional|pending|awaiting|under.?review|partial.?match)/.test(t)) {
    return 'PROVISIONAL';
  }

  // Success indicators - only after ruling out failures
  if (/(pass|approved|verified|valid|exact.?match|enroll.?user|id.?validated|success)/.test(t)) {
    return 'APPROVED';
  }

  // Actions-based classification
  if (actions && typeof actions === 'object') {
    const vals = Object.values(actions).map(v => String(v).toLowerCase());
    const criticalActions = ['verify_id_number', 'selfie_to_id_authority_compare', 'human_review_compare'];

    // Check critical actions first
    const criticalFailed = criticalActions.some(action => {
      const actionValue = actions[action] || actions[action.replace(/_/g, '_')];
      return actionValue && /(fail|rejected|unable|not.applicable)/.test(String(actionValue).toLowerCase());
    });

    if (criticalFailed) return 'REJECTED';

    // Check all actions
    const anyFail = vals.some(v => /(fail|rejected|unable)/.test(v));
    const mostPass = vals.filter(v => /(pass|approved|verified|returned|completed)/.test(v)).length > vals.length / 2;

    if (anyFail && !mostPass) return 'REJECTED';
    if (mostPass) return 'APPROVED';
  }

  // Default to REJECTED for unknown cases (security-first approach)
  logger.warn('Unknown verification outcome - defaulting to REJECTED', {
    code: codeStr,
    text: t,
    job_success
  });
  return 'REJECTED';
}

/**
 * Submit verification request to Youverify API
 * @param {Object} params - Verification parameters
 * @returns {Promise<Object>} Youverify API response
 */
async function submitToYouverify({
  idType,
  idNumber,
  firstName,
  lastName,
  selfieImage,
  dob,
  userId,
  partnerJobId
}) {
  try {
    logger.info('Submitting verification to Youverify', { idType, userId, partnerJobId });

    // Youverify API endpoint for identity verification
    const apiUrl = `${YOUVERIFY_CONFIG.apiBaseUrl}/v2/identities/verifications`;

    // Prepare request payload according to Youverify API spec
    const payload = {
      type: idType, // e.g., 'nin', 'passport', 'drivers-license', 'bvn'
      id_number: idNumber,
      first_name: firstName,
      last_name: lastName,
      isSubjectConsent: true, // Required by Youverify
      validations: {
        match_first_name: true,
        match_last_name: true
      }
    };

    // Add selfie for biometric verification (if not BVN)
    if (selfieImage && idType !== 'bvn') {
      // Remove base64 prefix if present
      const base64Image = selfieImage.replace(/^data:image\/\w+;base64,/, '');
      payload.face_image = base64Image;
      payload.validations.selfie_to_id_authority_compare = true;
    }

    // Add DOB if provided
    if (dob) {
      payload.dob = dob; // YYYY-MM-DD format
      payload.validations.match_dob = true;
    }

    // Add callback URL and metadata
    payload.callback_url = YOUVERIFY_CONFIG.callbackUrl;
    payload.metadata = {
      user_id: userId.toString(),
      partner_job_id: partnerJobId,
      source: 'zeusodx-mobile-app'
    };

    // Make API request to Youverify
    const response = await axios.post(apiUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Token': YOUVERIFY_CONFIG.publicMerchantKey
      },
      timeout: 30000 // 30 second timeout
    });

    logger.info('Youverify API response received', {
      status: response.status,
      data: response.data,
      partnerJobId
    });

    return {
      success: true,
      data: response.data,
      youverifyId: response.data?.id || response.data?.data?.id
    };

  } catch (error) {
    logger.error('Youverify API error', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
      partnerJobId
    });

    // Return error details
    return {
      success: false,
      error: error.response?.data || error.message,
      status: error.response?.status || 500
    };
  }
}

// POST: /biometric-verification - Verify user identity using Youverify
router.post(
  "/biometric-verification",
  authenticateToken,
  [
    body("idType")
      .trim()
      .notEmpty()
      .withMessage("ID type is required")
      .isIn(['passport', 'national_id', 'drivers_license', 'bvn', 'nin', 'nin_slip', 'voter_id'])
      .withMessage("Invalid ID type. Supported: passport, national_id, drivers_license, bvn, nin, nin_slip, voter_id"),
    body("idNumber")
      .trim()
      .notEmpty()
      .withMessage("ID number is required")
      .isLength({ min: 8, max: 20 })
      .withMessage("ID number must be between 8-20 characters"),
    body("selfieImage")
      .notEmpty()
      .withMessage("Selfie image is required")
      .custom((value) => {
        // Check if it's a base64 string
        if (typeof value === 'string' && value.startsWith('data:image/')) {
          return true;
        }
        // Check if it's a file path (for file upload)
        if (typeof value === 'string' && value.length > 10) {
          return true;
        }
        throw new Error("Selfie must be a valid base64 image or file path");
      }),
    body("livenessImages")
      .optional()
      .isArray()
      .withMessage("Liveness images must be an array")
      .custom((value) => {
        if (value && value.length > 0 && value.length !== 8) {
          throw new Error("Liveness images must contain exactly 8 images or be empty");
        }
        return true;
      }),
    body("dob")
      .optional()
      .isISO8601()
      .withMessage("Date of birth must be in YYYY-MM-DD format"),
  ],
  async (req, res) => {
    const startTime = Date.now();
    logger.info("Biometric verification request initiated", {
      userId: req.user.id,
      idType: req.body.idType
    });

    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: errors.array()
      });
    }

    const { idType, idNumber, selfieImage, livenessImages, dob } = req.body;

    try {
      // Validate Youverify configuration
      validateYouverifyConfig();

      // Get user from database
      const user = await User.findById(req.user.id).select('firstname lastname email username phonenumber kycLevel kycStatus');
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      // Check if user has required fields
      if (!user.firstname || !user.lastname) {
        return res.status(400).json({
          success: false,
          message: "User profile incomplete. First name and last name are required for ID verification."
        });
      }

      // BVN verification is separate from document KYC
      const isBvnVerification = idType === 'bvn';

      if (isBvnVerification) {
        // Check for existing pending BVN verification
        const existingPendingBvn = await KYC.findOne({
          userId: user._id,
          frontendIdType: 'bvn',
          status: 'PENDING'
        });
        if (existingPendingBvn) {
          logger.info("BVN verification already in progress", {
            userId: user._id,
            kycId: existingPendingBvn._id
          });
          return res.status(400).json({
            success: false,
            message: "BVN verification already in progress",
            data: {
              kycId: existingPendingBvn._id,
              status: existingPendingBvn.status,
              submittedAt: existingPendingBvn.createdAt
            }
          });
        }
      } else {
        // Check for existing pending document KYC (NIN, Passport, Driver's License)
        const existingPendingKyc = await KYC.findOne({
          userId: user._id,
          frontendIdType: { $in: ['national_id', 'passport', 'drivers_license', 'nin', 'nin_slip', 'voter_id'] },
          status: 'PENDING'
        });
        if (existingPendingKyc) {
          logger.info("KYC verification already in progress", {
            userId: user._id,
            kycId: existingPendingKyc._id,
            type: existingPendingKyc.frontendIdType
          });
          return res.status(400).json({
            success: false,
            message: "KYC verification already in progress",
            data: {
              kycId: existingPendingKyc._id,
              status: existingPendingKyc.status,
              submittedAt: existingPendingKyc.createdAt
            }
          });
        }
      }

      // Map frontend ID type to Youverify format
      const youverifyIdType = NIGERIAN_ID_TYPES[idType];
      if (!youverifyIdType) {
        return res.status(400).json({
          success: false,
          message: `Unsupported ID type: ${idType}`
        });
      }

      // Validate ID number format
      if (idType !== 'drivers_license') {
        const pattern = ID_PATTERNS[youverifyIdType];
        if (pattern && !pattern.test(idNumber)) {
          return res.status(400).json({
            success: false,
            message: `Invalid ${idType} format. Please check your ID number.`
          });
        }
      } else {
        // Light validation for driver's license
        const dlPattern = /^[A-Z0-9]{8,20}$/;
        if (!dlPattern.test(idNumber.toUpperCase())) {
          return res.status(400).json({
            success: false,
            message: `Driver's license must be 8-20 alphanumeric characters.`
          });
        }
      }

      // Generate unique job ID
      const jobId = `${user._id}_${Date.now()}`;

      // Create pending KYC record
      const kycDoc = await KYC.create({
        userId: user._id,
        provider: 'youverify',
        environment: process.env.NODE_ENV || 'development',
        partnerJobId: jobId,
        jobType: 1,
        status: 'PENDING',
        idType: youverifyIdType,
        frontendIdType: idType,
        idNumber,
        createdAt: new Date(),
        lastUpdated: new Date(),
        imageLinks: {
          selfie_image: selfieImage,
          liveness_images: livenessImages || []
        }
      });

      // Submit verification to Youverify API
      logger.info("Submitting to Youverify API", { userId: user._id, jobId, idType });

      const youverifyResult = await submitToYouverify({
        idType: youverifyIdType,
        idNumber,
        firstName: user.firstname,
        lastName: user.lastname,
        selfieImage,
        dob,
        userId: user._id,
        partnerJobId: jobId
      });

      // Update KYC record with Youverify ID
      if (youverifyResult.success && youverifyResult.youverifyId) {
        await KYC.findByIdAndUpdate(kycDoc._id, {
          $set: {
            youverifyId: youverifyResult.youverifyId,
            lastUpdated: new Date()
          }
        });
        logger.info("Youverify submission successful", {
          kycId: kycDoc._id,
          youverifyId: youverifyResult.youverifyId
        });
      } else {
        // Log error but don't fail the request - webhook might still work
        logger.warn("Youverify API submission failed, but KYC record created", {
          kycId: kycDoc._id,
          error: youverifyResult.error,
          status: youverifyResult.status
        });

        // If Youverify submission completely fails, we might want to mark as provisional
        if (youverifyResult.status >= 400) {
          await KYC.findByIdAndUpdate(kycDoc._id, {
            $set: {
              status: 'PROVISIONAL',
              errorReason: `Youverify API error: ${JSON.stringify(youverifyResult.error)}`,
              lastUpdated: new Date()
            }
          });
        }
      }

      // Update user status based on verification type
      if (isBvnVerification) {
        // For BVN, update bvn field and set pending status
        await User.findByIdAndUpdate(user._id, {
          $set: {
            bvn: idNumber,
            bvnVerified: false, // Will be set to true by webhook on approval
            'kyc.updatedAt': new Date(),
            'kyc.latestKycId': kycDoc._id
          }
        });
      } else {
        // For document KYC, update kyc.level2 status
        await User.findByIdAndUpdate(user._id, {
          $set: {
            'kyc.status': 'pending',
            'kyc.updatedAt': new Date(),
            'kyc.latestKycId': kycDoc._id
          }
        });
      }

      // Return immediate response to frontend
      logger.info("Biometric verification submitted successfully", {
        userId: user._id,
        jobId,
        kycId: kycDoc._id,
        idType,
        verificationType: isBvnVerification ? 'BVN' : 'Document KYC',
        processingTime: Date.now() - startTime
      });

      const successMessage = isBvnVerification
        ? "BVN verification submitted! Your Bank Verification Number is being verified with NIMC."
        : "Submission complete! Your ID verification is being processed with Youverify.";

      return res.status(200).json({
        success: true,
        message: successMessage,
        data: {
          jobId,
          kycId: kycDoc._id,
          youverifyId: youverifyResult.youverifyId || null,
          status: youverifyResult.status >= 400 ? "provisional" : "pending",
          submittedAt: kycDoc.createdAt,
          idType,
          verificationType: isBvnVerification ? 'bvn' : 'document',
          processingTime: Date.now() - startTime,
          youverifySubmitted: youverifyResult.success
        }
      });

    } catch (error) {
      logger.error("Error during biometric verification submission", {
        userId: req.user.id,
        error: error.message,
        stack: error.stack,
        processingTime: Date.now() - startTime
      });

      // Handle specific Youverify errors
      if (error.message.includes('YOUVERIFY')) {
        return res.status(500).json({
          success: false,
          message: "ID verification service configuration error. Please contact support."
        });
      }

      return res.status(500).json({
        success: false,
        message: "Server error during ID verification submission. Please try again."
      });
    }
  }
);

module.exports = router;