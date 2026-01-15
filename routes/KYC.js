const express = require("express");
const { body, validationResult } = require("express-validator");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const router = express.Router();

const User = require("../models/user");
const KYC = require("../models/kyc");
const config = require("./config");
const logger = require("../utils/logger");
const { classifyOutcome } = require("../utils/kycHelpers");
const { sendKycEmail, sendNINVerificationEmail } = require("../services/EmailService");

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

// Classification logic now in utils/kycHelpers.js

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

    // Map idType to Youverify-specific endpoint paths
    const endpointMap = {
      'nin': '/v2/api/identity/ng/nin',
      'national_id': '/v2/api/identity/ng/nin',
      'bvn': '/v2/api/identity/ng/bvn',
      'passport': '/v2/api/identity/ng/passport',
      'drivers_license': '/v2/api/identity/ng/drivers-license',
      'drivers-license': '/v2/api/identity/ng/drivers-license'
    };

    // Get the correct endpoint path for this ID type
    const endpointPath = endpointMap[idType.toLowerCase()];

    if (!endpointPath) {
      throw new Error(`Unsupported ID type: ${idType}`);
    }

    const apiUrl = `${YOUVERIFY_CONFIG.apiBaseUrl}${endpointPath}`;

    // Prepare request payload according to Youverify API spec v2
    const payload = {
      id: idNumber, // The ID number to verify
      isSubjectConsent: true, // Required - must be true
      metadata: {
        user_id: userId.toString(),
        partner_job_id: partnerJobId,
        source: 'zeusodx-mobile-app'
      }
    };

    // Build validations object for data matching and/or selfie
    const validations = {};

    // Add personal data validation if firstName, lastName, or DOB provided
    if (firstName || lastName || dob) {
      validations.data = {};
      if (firstName) validations.data.firstName = firstName;
      if (lastName) validations.data.lastName = lastName;
      if (dob) validations.data.dateOfBirth = dob; // YYYY-MM-DD format
    }

    // Add selfie validation if image provided
    if (selfieImage) {
      // Youverify expects a data URI, not raw base64
      // If it already has the data URI prefix, use as-is
      // Otherwise, add the data URI prefix (default to JPEG)
      let imageUri = selfieImage;
      if (!selfieImage.startsWith('data:image/')) {
        imageUri = `data:image/jpeg;base64,${selfieImage}`;
      }
      validations.selfie = {
        image: imageUri
      };
    }

    // Only add validations if we have any
    if (Object.keys(validations).length > 0) {
      payload.validations = validations;
    }

    logger.info('Youverify API request', {
      endpoint: apiUrl,
      idType,
      idNumber: idNumber,
      hasData: !!validations.data,
      hasSelfie: !!validations.selfie,
      hasFirstName: !!firstName,
      hasLastName: !!lastName,
      hasDob: !!dob,
      jobId: partnerJobId,
      payloadStructure: {
        hasId: !!payload.id,
        hasValidations: !!payload.validations,
        validationKeys: Object.keys(validations),
        dataValidationKeys: validations.data ? Object.keys(validations.data) : []
      }
    });

    // Make API request to Youverify
    // Note: Youverify v2 API uses capitalized 'Token' header with API key (NOT public merchant key)
    const response = await axios.post(apiUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Token': YOUVERIFY_CONFIG.secretKey || YOUVERIFY_CONFIG.publicMerchantKey
      },
      timeout: 30000 // 30 second timeout
    });

    // Log detailed response for debugging
    logger.info('Youverify response', {
      status: response.status,
      success: !!response.data?.id,
      jobId: partnerJobId,
      responseData: JSON.stringify(response.data) // Full response body
    });

    // Check if we got a Youverify ID
    const youverifyId = response.data?.id || response.data?.data?.id;
    if (!youverifyId) {
      logger.warn('Youverify returned no ID', {
        jobId: partnerJobId,
        responseStatus: response.status,
        responseBody: JSON.stringify(response.data),
        message: response.data?.message || 'No message provided'
      });
    }

    // Extract verification result details from response
    // According to Youverify docs, the structure is: response.data.data
    const dataObj = response.data?.data || response.data;

    // Extract validation messages if available
    const validationMessages = dataObj?.validations?.validationMessages || '';

    const verificationResult = {
      allValidationPassed: dataObj?.allValidationPassed,
      status: dataObj?.status,
      firstName: dataObj?.firstName,
      lastName: dataObj?.lastName,
      dateOfBirth: dataObj?.dateOfBirth,
      gender: dataObj?.gender,
      idNumber: dataObj?.idNumber,
      validationMessages: validationMessages,
      // Extract selfie validation details if available
      selfieMatch: dataObj?.validations?.selfie?.selfieVerification?.match,
      selfieConfidence: dataObj?.validations?.selfie?.selfieVerification?.confidenceLevel
    };

    logger.info('Youverify verification result', {
      jobId: partnerJobId,
      youverifyId,
      allValidationPassed: verificationResult.allValidationPassed,
      status: verificationResult.status,
      validationMessages: validationMessages,
      selfieMatch: verificationResult.selfieMatch,
      hasVerificationData: verificationResult.allValidationPassed !== undefined
    });

    return {
      success: true,
      data: response.data,
      youverifyId,
      verificationResult
    };

  } catch (error) {
    logger.error('Youverify API error', {
      message: error.message,
      status: error.response?.status,
      errorData: JSON.stringify(error.response?.data || {}),
      jobId: partnerJobId,
      endpoint: apiUrl
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

    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: errors.array()
      });
    }

    const { idType, idNumber, selfieImage, livenessImages, dob, firstName: reqFirstName, lastName: reqLastName } = req.body;

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
        // Check for existing BVN verification (pending OR approved)
        const existingBvn = await KYC.findOne({
          userId: user._id,
          frontendIdType: 'bvn',
          status: { $in: ['PENDING', 'PROVISIONAL', 'APPROVED'] }
        }).sort({ createdAt: -1 });

        if (existingBvn) {
          if (existingBvn.status === 'APPROVED') {
            return res.status(400).json({
              success: false,
              message: "BVN already verified",
              data: {
                kycId: existingBvn._id,
                status: existingBvn.status,
                verifiedAt: existingBvn.verificationDate
              }
            });
          } else {
            return res.status(400).json({
              success: false,
              message: "BVN verification already in progress. Please wait for the current verification to complete.",
              data: {
                kycId: existingBvn._id,
                status: existingBvn.status,
                submittedAt: existingBvn.createdAt
              }
            });
          }
        }
      } else {
        // Check for existing document KYC (pending OR approved)
        const existingKyc = await KYC.findOne({
          userId: user._id,
          frontendIdType: { $in: ['national_id', 'passport', 'drivers_license', 'nin', 'nin_slip', 'voter_id'] },
          status: { $in: ['PENDING', 'PROVISIONAL', 'APPROVED'] }
        }).sort({ createdAt: -1 });

        if (existingKyc) {
          if (existingKyc.status === 'APPROVED') {
            return res.status(400).json({
              success: false,
              message: "Identity document already verified",
              data: {
                kycId: existingKyc._id,
                status: existingKyc.status,
                idType: existingKyc.frontendIdType,
                verifiedAt: existingKyc.verificationDate
              }
            });
          } else {
            return res.status(400).json({
              success: false,
              message: "KYC verification already in progress. Please wait for the current verification to complete.",
              data: {
                kycId: existingKyc._id,
                status: existingKyc.status,
                idType: existingKyc.frontendIdType,
                submittedAt: existingKyc.createdAt
              }
            });
          }
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
      const jobId = `${user._id}_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      // Create pending KYC record (with race condition protection via unique index)
      let kycDoc;
      try {
        kycDoc = await KYC.create({
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
      } catch (dbError) {
        // If duplicate key error (race condition), find the existing record
        if (dbError.code === 11000) {
          logger.warn("Duplicate KYC submission detected (race condition)", {
            userId: user._id,
            idType,
            error: dbError.message
          });

          const existing = await KYC.findOne({
            userId: user._id,
            frontendIdType: idType,
            status: { $in: ['PENDING', 'PROVISIONAL', 'APPROVED'] }
          }).sort({ createdAt: -1 });

          if (existing) {
            return res.status(400).json({
              success: false,
              message: "Verification already submitted. Please wait for processing.",
              data: {
                kycId: existing._id,
                status: existing.status,
                submittedAt: existing.createdAt
              }
            });
          }
        }

        // Re-throw other database errors
        throw dbError;
      }

      // Submit verification to Youverify API

      // Use firstName/lastName from request body if provided, otherwise fall back to user profile
      const verifyFirstName = reqFirstName || user.firstname;
      const verifyLastName = reqLastName || user.lastname;

      const youverifyResult = await submitToYouverify({
        idType: youverifyIdType,
        idNumber,
        firstName: verifyFirstName,
        lastName: verifyLastName,
        selfieImage,
        dob,
        userId: user._id,
        partnerJobId: jobId
      });

      // Process immediate verification result from Youverify
      if (youverifyResult.success && youverifyResult.youverifyId) {
        const verification = youverifyResult.verificationResult || {};
        const kycUpdateData = {
          youverifyId: youverifyResult.youverifyId,
          lastUpdated: new Date()
        };

        // Check if we got an immediate verification result
        if (verification.allValidationPassed !== undefined) {
          // Determine status based on validation result
          if (verification.allValidationPassed === true) {
            kycUpdateData.status = 'APPROVED';
            kycUpdateData.jobSuccess = true;
            kycUpdateData.allValidationPassed = true;
            kycUpdateData.verificationDate = new Date();
            kycUpdateData.resultText = 'Verification successful - all validations passed';
          } else {
            kycUpdateData.status = 'REJECTED';
            kycUpdateData.jobSuccess = false;
            kycUpdateData.allValidationPassed = false;
            // Use generic rejection message
            kycUpdateData.resultText = 'Verification failed - incorrect data provided';
            // Store detailed validation messages in payload for admin review
            if (verification.validationMessages) {
              kycUpdateData.payload = kycUpdateData.payload || {};
              kycUpdateData.payload.validationMessages = verification.validationMessages;
            }
          }

          // Add personal info if available
          if (verification.firstName) kycUpdateData.firstName = verification.firstName;
          if (verification.lastName) kycUpdateData.lastName = verification.lastName;
          if (verification.dateOfBirth) kycUpdateData.dateOfBirth = verification.dateOfBirth;
          if (verification.gender) kycUpdateData.gender = verification.gender;
          if (verification.idNumber) kycUpdateData.idNumber = verification.idNumber;

          logger.info("Youverify immediate result processed", {
            kycId: kycDoc._id,
            userId: user._id,
            status: kycUpdateData.status,
            allValidationPassed: verification.allValidationPassed
          });
        }

        await KYC.findByIdAndUpdate(kycDoc._id, { $set: kycUpdateData });

        // Send email notification based on verification result
        if (verification.allValidationPassed !== undefined) {
          try {
            if (verification.allValidationPassed === true) {
              // Send approval email
              await sendKycEmail(user.email, user.firstname, 'APPROVED', 'Your identity verification has been successfully completed.');
              logger.info('KYC approval email sent', { userId: user._id, kycId: kycDoc._id });
            } else {
              // Send rejection email with generic reason
              const rejectionReason = 'Incorrect data provided. Please ensure your selfie clearly shows your face and matches your ID document.';
              await sendKycEmail(user.email, user.firstname, 'REJECTED', rejectionReason);
              logger.info('KYC rejection email sent', { userId: user._id, kycId: kycDoc._id });
            }
          } catch (emailErr) {
            logger.error('Failed to send KYC result email', {
              userId: user._id,
              kycId: kycDoc._id,
              error: emailErr.message
            });
          }
        }
      } else {
        logger.warn("Youverify submission failed", {
          kycId: kycDoc._id,
          userId: user._id,
          status: youverifyResult.status,
          error: JSON.stringify(youverifyResult.error),
          hasYouverifyId: !!youverifyResult.youverifyId,
          responseData: JSON.stringify(youverifyResult.data || {})
        });

        // If Youverify submission completely fails, mark as provisional
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

      // Update user status based on verification result
      const verification = youverifyResult.verificationResult || {};
      const finalStatus = verification.allValidationPassed === true ? 'approved' :
                         verification.allValidationPassed === false ? 'rejected' : 'pending';

      if (isBvnVerification) {
        // For BVN, update bvn field and status
        await User.findByIdAndUpdate(user._id, {
          $set: {
            bvn: idNumber,
            bvnVerified: verification.allValidationPassed === true,
            'kyc.updatedAt': new Date(),
            'kyc.latestKycId': kycDoc._id
          }
        });
      } else {
        // For document KYC, update kyc.level2 status
        const userUpdate = {
          'kyc.status': finalStatus,
          'kyc.updatedAt': new Date(),
          'kyc.latestKycId': kycDoc._id,
          'kyc.level2.status': finalStatus,
          'kycStatus': finalStatus
        };

        // Add approval/rejection details
        if (verification.allValidationPassed === true) {
          userUpdate['kyc.level2.documentSubmitted'] = true;
          userUpdate['kyc.level2.documentType'] = idType;
          userUpdate['kyc.level2.documentNumber'] = idNumber;
          userUpdate['kyc.level2.approvedAt'] = new Date();
          userUpdate['kyc.level2.rejectionReason'] = null;
        } else if (verification.allValidationPassed === false) {
          userUpdate['kyc.level2.rejectionReason'] = 'Incorrect data provided. Please ensure your selfie clearly shows your face and matches your ID document.';
        }

        await User.findByIdAndUpdate(user._id, { $set: userUpdate });

        // If approved, trigger the user's identity document verified hook
        if (verification.allValidationPassed === true) {
          try {
            const updatedUser = await User.findById(user._id);
            await updatedUser.onIdentityDocumentVerified(idType, idNumber);
            logger.info('User KYC level upgraded after verification', { userId: user._id });
          } catch (upgradeError) {
            logger.warn('Error during KYC upgrade after verification', {
              error: upgradeError.message,
              userId: user._id
            });
          }
        }
      }

      // Return immediate response to frontend
      logger.info("KYC submitted", {
        userId: user._id,
        kycId: kycDoc._id,
        type: isBvnVerification ? 'BVN' : idType,
        time: `${Date.now() - startTime}ms`
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
      logger.error("KYC submission error", {
        userId: req.user.id,
        error: error.message
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