const express = require("express");
const { body, validationResult } = require("express-validator");
const smileIdentityCore = require("smile-identity-core");
const jwt = require("jsonwebtoken");
const router = express.Router();

const User = require("../models/user");
const KYC = require("../models/kyc");
const config = require("./config");
const logger = require("../utils/logger");

// Initialize Smile Identity WebAPI
const WebApi = smileIdentityCore.WebApi;

// Smile ID Configuration
const SMILE_ID_CONFIG = {
  partner_id: process.env.SMILE_ID_PARTNER_ID || config.smileId?.partnerId,
  api_key: process.env.SMILE_ID_API_KEY || config.smileId?.apiKey,
  sid_server: process.env.SMILE_ID_SERVER || config.smileId?.server || '0', // 0 for sandbox, 1 for production
  callback_url: process.env.SMILE_ID_CALLBACK_URL || config.smileId?.callbackUrl || 'https://your-domain.com/api/smile-id/callback'
};

// Nigerian ID type mappings based on Smile ID documentation
// Note: Driver's License uses NIN verification as Nigerian licenses are linked to NIN
const NIGERIAN_ID_TYPES = {
  'passport': 'PASSPORT',
  'national_id': 'NIN_V2',
  'drivers_license': 'DRIVERS_LICENSE', // Separate type - format varies by state
  'bvn': 'BVN',
  'nin': 'NIN_V2',
  'nin_slip': 'NIN_SLIP',
  'voter_id': 'VOTER_ID'
};

// ID Format validation patterns
// Note: Driver's License pattern is flexible as formats vary by Nigerian state
const ID_PATTERNS = {
  'BVN': /^\d{11}$/, // 11 digits
  'NIN_V2': /^\d{11}$/, // 11 digits  
  'NIN_SLIP': /^\d{11}$/, // 11 digits
  'PASSPORT': /^[A-Z]\d{8}$/, // Letter + 8 digits
  'VOTER_ID': /^\d{19}$/, // 19 digits
  'DRIVERS_LICENSE': /^[A-Z0-9]{8,20}$/ // 8-20 alphanumeric (varies by state)
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

// Validate Smile ID configuration
const validateSmileIdConfig = () => {
  if (!SMILE_ID_CONFIG.partner_id) {
    throw new Error('SMILE_ID_PARTNER_ID is not configured');
  }
  if (!SMILE_ID_CONFIG.api_key) {
    throw new Error('SMILE_ID_API_KEY is not configured');
  }
  if (!SMILE_ID_CONFIG.callback_url) {
    throw new Error('SMILE_ID_CALLBACK_URL is not configured');
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

// Background processing function for Smile ID verification
const processSmileIdVerification = async (userData, verificationData, jobId, kycDocId) => {
  const startTime = Date.now();
  
  try {
    logger.info("Starting background Smile ID verification", { 
      userId: userData._id,
      jobId,
      kycDocId,
      idType: verificationData.smileIdType
    });

    // Initialize Smile ID connection
    const connection = new WebApi(
      SMILE_ID_CONFIG.partner_id,
      SMILE_ID_CONFIG.callback_url,
      SMILE_ID_CONFIG.api_key,
      SMILE_ID_CONFIG.sid_server
    );

    // Create partner parameters
    const partner_params = {
      job_id: jobId,
      user_id: userData._id.toString(),
      job_type: 1 // Biometric KYC
    };

    // Prepare image details
    const image_details = [];

    // Add selfie image
    if (verificationData.selfieImage.startsWith('data:image/')) {
      // Base64 encoded image
      const base64Data = verificationData.selfieImage.split(',')[1]; // Remove data:image/jpeg;base64, prefix
      image_details.push({
        image_type_id: 2, // Base64 selfie
        image: base64Data
      });
    } else {
      // File path
      image_details.push({
        image_type_id: 0, // File path selfie
        image: verificationData.selfieImage
      });
    }

    // Add liveness images if provided (8 images for proof of life)
    if (verificationData.livenessImages && verificationData.livenessImages.length === 8) {
      verificationData.livenessImages.forEach((livenessImage, index) => {
        if (livenessImage.startsWith('data:image/')) {
          const base64Data = livenessImage.split(',')[1];
          image_details.push({
            image_type_id: 6, // Base64 liveness
            image: base64Data
          });
        } else {
          image_details.push({
            image_type_id: 4, // File path liveness
            image: livenessImage
          });
        }
      });
    }

    // Create ID information object
    const id_info = {
      first_name: userData.firstname,
      last_name: userData.lastname,
      country: 'NG', // Nigeria
      id_type: verificationData.smileIdType,
      id_number: verificationData.idNumber,
      dob: verificationData.dob || '', // Optional date of birth
      entered: 'true' // Must be string
    };

    // Set job options
    const options = {
      return_job_status: true, // Get result synchronously
      return_history: false, // Don't need history
      return_image_links: true, // Return uploaded images
      signature: true
    };

    // Submit job to Smile ID
    const response = await connection.submit_job(partner_params, image_details, id_info, options);

    logger.info("Background Smile ID response received", { 
      jobId,
      kycDocId,
      success: response.job_success,
      resultCode: response.result?.ResultCode,
      processingTime: Date.now() - startTime
    });

    // Process response using same logic as webhook - LOG ONLY, NO USER UPDATES
    if (response.job_success) {
      const result = response.result;
      
      // Use the same classification logic as webhook
      const status = classifyOutcome({
        job_success: response.job_success,
        code: result.ResultCode,
        text: result.ResultText,
        actions: result.Actions,
      });
      
      logger.info("Background verification completed - webhook will handle all user updates", {
        jobId,
        kycDocId,
        userId: userData._id,
        resultCode: result.ResultCode,
        resultText: result.ResultText,
        status,
        confidenceValue: result.ConfidenceValue,
        jobSuccess: response.job_success,
        smileJobId: result.SmileJobID,
        processingTime: Date.now() - startTime
      });
      
    } else {
      // Job failed in background - webhook will still handle final status
      const status = classifyOutcome({
        job_success: false,
        code: response.code,
        text: response.message || 'Job submission failed',
        actions: null,
      });
      
      logger.info("Background verification failed - webhook will handle final status", { 
        jobId, 
        kycDocId,
        userId: userData._id, 
        error: response.code || 'Unknown error',
        message: response.message || 'No error message provided',
        status,
        processingTime: Date.now() - startTime
      });
    }

  } catch (error) {
    logger.error("Critical error during background biometric verification", { 
      userId: userData._id,
      jobId,
      kycDocId,
      error: error.message, 
      stack: error.stack,
      processingTime: Date.now() - startTime
    });
  }
};

// POST: /biometric-verification - Verify user identity using Smile ID (Background Processing)
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
      // Validate Smile ID configuration
      validateSmileIdConfig();

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

      // Check for existing pending KYC
      const existingPendingKyc = await KYC.findOne({
        userId: user._id,
        status: 'PENDING'
      });
      if (existingPendingKyc) {
        logger.info("KYC verification already in progress", {
          userId: user._id,
          kycId: existingPendingKyc._id
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

      // Map frontend ID type to Smile ID format
      const smileIdType = NIGERIAN_ID_TYPES[idType];
      if (!smileIdType) {
        return res.status(400).json({ 
          success: false, 
          message: `Unsupported ID type: ${idType}` 
        });
      }

      // Validate ID number format
      // Note: Skip strict validation for driver's license as formats vary by Nigerian state
      if (idType !== 'drivers_license') {
        const pattern = ID_PATTERNS[smileIdType];
        if (pattern && !pattern.test(idNumber)) {
          return res.status(400).json({ 
            success: false, 
            message: `Invalid ${idType} format. Please check your ID number.` 
          });
        }
      } else {
        // Light validation for driver's license - just check alphanumeric and length
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
        provider: 'smile-id',
        environment: process.env.NODE_ENV || 'development',
        partnerJobId: jobId,
        jobType: 1,
        status: 'PENDING',
        idType: smileIdType,
        frontendIdType: idType,
        idNumber,
        createdAt: new Date(),
        lastUpdated: new Date(),
        imageLinks: {
          selfie_image: selfieImage,
          liveness_images: livenessImages || []
        }
      });

      // Update user with pending KYC status
      await User.findByIdAndUpdate(user._id, {
        $set: {
          'kyc.status': 'pending',
          'kyc.updatedAt': new Date(),
          'kyc.latestKycId': kycDoc._id
        }
      });

      // Prepare verification data for background processing
      const verificationData = {
        idType,
        idNumber,
        selfieImage,
        livenessImages,
        dob,
        smileIdType
      };

      // Start background processing (fire and forget)
      setImmediate(() => {
        processSmileIdVerification(user, verificationData, jobId, kycDoc._id);
      });

      // Return immediate response to frontend
      logger.info("Biometric verification submitted successfully", { 
        userId: user._id,
        jobId,
        kycId: kycDoc._id,
        idType,
        processingTime: Date.now() - startTime
      });

      return res.status(200).json({
        success: true,
        message: "Submission complete! Your ID verification is being processed.",
        data: {
          jobId,
          kycId: kycDoc._id,
          status: "pending",
          submittedAt: kycDoc.createdAt,
          idType,
          processingTime: Date.now() - startTime
        }
      });

    } catch (error) {
      logger.error("Error during biometric verification submission", { 
        userId: req.user.id,
        error: error.message, 
        stack: error.stack,
        processingTime: Date.now() - startTime
      });

      // Handle specific Smile ID errors
      if (error.message.includes('SMILE_ID')) {
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