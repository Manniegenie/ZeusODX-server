// routes/smileid.webhook.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const smileIdentityCore = require('smile-identity-core');
const jwt = require('jsonwebtoken');
const router = express.Router();

const User = require('../models/user');
const KYC = require('../models/kyc');
const config = require('./config');
const logger = require('../utils/logger');

// Initialize Smile Identity WebAPI
const WebApi = smileIdentityCore.WebApi;

// Smile ID Configuration
const SMILE_ID_CONFIG = {
  partner_id: process.env.SMILE_ID_PARTNER_ID || config.smileId?.partnerId,
  api_key: process.env.SMILE_ID_API_KEY || config.smileId?.apiKey,
  sid_server: process.env.SMILE_ID_SERVER || config.smileId?.server || '0', // 0 for sandbox, 1 for production
  callback_url: process.env.SMILE_ID_CALLBACK_URL || config.smileId?.callbackUrl || 'https://your-domain.com/api/smile-id/callback'
};

// Optional: verify Smile signature using their server SDK
let Signature;
try {
  Signature = require('smile-identity-core').Signature; // npm i smile-identity-core
} catch (_) {
  Signature = null;
}

// ---- helpers ----------------------------------------------------

// Updated result codes based on Smile ID documentation
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

// Nigerian ID type mappings (align with your frontend)
const ID_TYPE_MAPPING = {
  'BVN': 'bvn',
  'NIN_V2': 'national_id',
  'NIN': 'national_id',
  'NIN_SLIP': 'nin_slip',
  'PASSPORT': 'passport',
  'VOTER_ID': 'voter_id'
};

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

function normalize(body) {
  const {
    job_complete,
    job_success,
    code,
    result,
    history,
    image_links,
    Actions,
    Country,
    DOB,
    Document,
    ExpirationDate,
    FullName,
    Gender,
    IDNumber,
    IDType,
    ResultCode,
    ResultText,
    SmileJobID,
    PartnerParams = {},
    ConfidenceValue,
    timestamp,
    signature,
    environment,
  } = body || {};

  const node = result && typeof result === 'object' ? result : body || {};
  
  return {
    jobComplete: typeof job_complete === 'boolean' ? job_complete : true, // Default to complete
    jobSuccess: typeof job_success === 'boolean' ? job_success : undefined,

    actions: node.Actions || Actions || null,
    country: node.Country || Country || 'NG', // Default to Nigeria
    dob: node.DOB || DOB || null,
    expiresAt: node.ExpirationDate || ExpirationDate || null,
    fullName: node.FullName || FullName || null,
    gender: node.Gender || Gender || null,
    idNumber: node.IDNumber || IDNumber || null,
    idType: node.IDType || IDType || null,
    resultCode: node.ResultCode || ResultCode || code || null,
    resultText: node.ResultText || ResultText || null,
    confidenceValue: node.ConfidenceValue || ConfidenceValue || null,

    smileJobId: SmileJobID || body.SmileJobID || null,
    partnerParams: PartnerParams || {},
    providerTimestamp: timestamp ? new Date(timestamp) : new Date(),
    signature: signature || null,
    imageLinks: image_links || null,
    history: history || null,
    environment: environment || process.env.NODE_ENV || 'development',
  };
}

// Check if this is a valid KYC document type
function isValidKycDocument(idType) {
  const normalizedIdType = ID_TYPE_MAPPING[idType] || idType?.toLowerCase();
  const validDocuments = ['bvn', 'national_id', 'passport', 'nin_slip', 'voter_id'];
  return validDocuments.includes(normalizedIdType);
}

// Parse full name into first and last name
function parseFullName(fullName) {
  if (!fullName) return { firstName: null, lastName: null };
  
  const nameParts = fullName.trim().split(' ').filter(part => part.length > 0);
  if (nameParts.length === 0) return { firstName: null, lastName: null };
  if (nameParts.length === 1) return { firstName: nameParts[0], lastName: null };
  
  return {
    firstName: nameParts[0],
    lastName: nameParts.slice(1).join(' ')
  };
}

// Extract document metadata from SmileID response
function extractDocumentMetadata(norm) {
  const metadata = {};
  
  if (norm.actions) {
    // Check various verification flags
    metadata.faceMatch = !!(norm.actions.Selfie_To_ID_Authority_Compare === 'Completed' || 
                           norm.actions.Human_Review_Compare === 'Passed');
    metadata.livenessCheck = !!(norm.actions.Liveness_Check === 'Passed' || 
                               norm.actions.Human_Review_Liveness_Check === 'Passed');
    metadata.documentAuthenticity = !!(norm.actions.Verify_ID_Number === 'Verified');
  }
  
  return Object.keys(metadata).length > 0 ? metadata : null;
}

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

// ---------------- Webhook Handler ----------------
/**
 * Mount this at: app.use('/webhooks', require('./routes/smileid.webhook'))
 * Ensure JSON body size: app.use(express.json({ limit: '2mb' }))
 */
router.post('/callback', async (req, res) => {
  const body = req.body || {};
  const norm = normalize(body);
  
  const requestId = `${norm.smileJobId || 'unknown'}_${Date.now()}`;

  logger.info('SmileID webhook received', {
    requestId,
    smileJobId: norm.smileJobId,
    userId: norm.partnerParams?.user_id,
    resultCode: norm.resultCode,
    resultText: norm.resultText,
    idType: norm.idType,
    hasSignature: !!body.signature,
    hasTimestamp: !!body.timestamp,
    confidenceValue: norm.confidenceValue
  });

  // 1) Signature verification
  let signatureValid = false;
  try {
    if (Signature && SMILE_ID_CONFIG.partner_id && SMILE_ID_CONFIG.api_key && body.timestamp && body.signature) {
      const sig = new Signature(SMILE_ID_CONFIG.partner_id, SMILE_ID_CONFIG.api_key);
      signatureValid = sig.confirm_signature(body.timestamp, body.signature);
      
      if (!signatureValid) {
        logger.warn('SmileID webhook: signature INVALID', {
          requestId,
          partnerId: SMILE_ID_CONFIG.partner_id,
          timestampAge: Date.now() - new Date(body.timestamp).getTime()
        });
      } else {
        logger.info('SmileID webhook: signature verified successfully', { requestId });
      }
    } else {
      const missing = [];
      if (!Signature) missing.push('Signature SDK');
      if (!SMILE_ID_CONFIG.partner_id) missing.push('SMILE_ID_PARTNER_ID');
      if (!SMILE_ID_CONFIG.api_key) missing.push('SMILE_ID_API_KEY');
      if (!body.timestamp) missing.push('timestamp');
      if (!body.signature) missing.push('signature');
      
      logger.warn('SmileID webhook: signature verification skipped', {
        requestId,
        missing,
        reason: 'Missing required components'
      });
    }
  } catch (e) {
    logger.error('SmileID signature verification error', { 
      requestId,
      error: e.message,
      partnerId: SMILE_ID_CONFIG.partner_id,
      hasApiKey: !!SMILE_ID_CONFIG.api_key
    });
  }

  // 2) User association
  const { user_id: userId, job_id: partnerJobId, job_type: jobType } = norm.partnerParams || {};
  if (!userId) {
    logger.warn('SmileID callback missing user_id; acknowledging without processing', {
      requestId,
      partnerParams: norm.partnerParams,
      smileJobId: norm.smileJobId
    });
    return res.status(200).json({ success: true, ignored: 'missing_user_id' });
  }

  // 3) Fetch user for updates
  let user;
  try {
    user = await User.findById(userId);
    if (!user) {
      logger.warn('SmileID callback: user not found', { requestId, userId });
      return res.status(200).json({ success: true, ignored: 'user_not_found' });
    }
  } catch (e) {
    logger.error('SmileID callback: error fetching user', { 
      requestId, 
      userId, 
      error: e.message 
    });
    return res.status(500).json({ success: false, error: 'user_fetch_error' });
  }

  // 4) Compute outcome using classification
  const status = classifyOutcome({
    job_success: norm.jobSuccess,
    code: norm.resultCode,
    text: norm.resultText,
    actions: norm.actions,
  });

  logger.info('SmileID webhook outcome classified', {
    requestId,
    userId,
    smileJobId: norm.smileJobId,
    resultCode: norm.resultCode,
    resultText: norm.resultText,
    idType: norm.idType,
    status,
    jobSuccess: norm.jobSuccess,
    confidenceValue: norm.confidenceValue,
    currentKycLevel: user.kycLevel
  });

  // 5) Check if this is a valid KYC document
  const isValidDocument = isValidKycDocument(norm.idType);
  const frontendIdType = ID_TYPE_MAPPING[norm.idType] || norm.idType?.toLowerCase();

  // 6) Upsert into KYC collection with enhanced document storage
  try {
    const filter = norm.smileJobId
      ? { smileJobId: norm.smileJobId }
      : { userId, partnerJobId };

    // Parse name components
    const { firstName, lastName } = parseFullName(norm.fullName);
    const documentMetadata = extractDocumentMetadata(norm);

    const update = {
      $setOnInsert: {
        userId,
        provider: 'smile-id',
        createdAt: new Date(),
      },
      $set: {
        environment: norm.environment,
        partnerJobId,
        jobType: parseInt(jobType) || 1,

        smileJobId: norm.smileJobId,
        jobComplete: norm.jobComplete,
        jobSuccess: norm.jobSuccess,

        status: status === 'PROVISIONAL' ? 'PENDING' : status, // Map PROVISIONAL to PENDING
        resultCode: norm.resultCode,
        resultText: norm.resultText,
        actions: norm.actions,

        // Document Information
        country: norm.country,
        idType: norm.idType, // Original SmileID type
        frontendIdType, // Our frontend type
        idNumber: norm.idNumber,

        // Personal Information (only store if approved)
        ...(status === 'APPROVED' && {
          fullName: norm.fullName,
          firstName,
          lastName,
          dateOfBirth: norm.dob,
          gender: norm.gender,
          documentExpiryDate: norm.expiresAt,
          verificationDate: new Date()
        }),

        // Verification metadata
        confidenceValue: norm.confidenceValue,
        imageLinks: norm.imageLinks,
        history: norm.history,

        // Security and validation
        signature: norm.signature,
        signatureValid,
        providerTimestamp: norm.providerTimestamp,
        lastUpdated: new Date(),

        // Raw payload for debugging
        payload: body,
        errorReason: status === 'REJECTED' ? norm.resultText : null,
        provisionalReason: status === 'PROVISIONAL' ? (norm.resultText || 'Under review') : null,

        // Document metadata (only for approved documents)
        ...(status === 'APPROVED' && documentMetadata && { documentMetadata })
      },
    };

    const kycDoc = await KYC.findOneAndUpdate(filter, update, {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
      runValidators: true,
    });

    // 7) Update User KYC status using user model methods
    const userUpdate = {
      $set: {
        'kyc.provider': 'smile-id',
        'kyc.status': status === 'PROVISIONAL' ? 'pending' : status.toLowerCase(),
        'kyc.updatedAt': new Date(),
        'kyc.latestKycId': kycDoc._id,
        'kyc.resultCode': kycDoc.resultCode,
        'kyc.resultText': kycDoc.resultText,
      },
    };

    // Update document verification status
    if (isValidDocument) {
      if (status === 'APPROVED') {
        userUpdate.$set['kyc.level2.status'] = 'approved';
        userUpdate.$set['kyc.level2.documentSubmitted'] = true;
        userUpdate.$set['kyc.level2.documentType'] = frontendIdType;
        userUpdate.$set['kyc.level2.documentNumber'] = norm.idNumber;
        userUpdate.$set['kyc.level2.approvedAt'] = new Date();
        userUpdate.$set['kyc.level2.rejectionReason'] = null;
        
        logger.info('Document verification approved', {
          requestId,
          userId,
          idType: frontendIdType,
          idNumber: norm.idNumber?.slice(0, 4) + '****',
          fullName: norm.fullName,
          confidenceValue: norm.confidenceValue
        });
      } else if (status === 'PROVISIONAL') {
        userUpdate.$set['kyc.level2.status'] = 'pending';
        userUpdate.$set['kyc.level2.documentSubmitted'] = true;
        userUpdate.$set['kyc.level2.documentType'] = frontendIdType;
        userUpdate.$set['kyc.level2.documentNumber'] = norm.idNumber;
        userUpdate.$set['kyc.level2.submittedAt'] = new Date();
        userUpdate.$set['kyc.level2.rejectionReason'] = `Pending verification: ${norm.resultText}`;
        userUpdate.$set['kycStatus'] = 'pending';
      } else if (status === 'REJECTED') {
        userUpdate.$set['kyc.level2.status'] = 'rejected';
        userUpdate.$set['kyc.level2.documentSubmitted'] = true;
        userUpdate.$set['kyc.level2.documentType'] = frontendIdType;
        userUpdate.$set['kyc.level2.documentNumber'] = norm.idNumber;
        userUpdate.$set['kyc.level2.rejectedAt'] = new Date();
        userUpdate.$set['kyc.level2.rejectionReason'] = norm.resultText || 'ID verification failed';
        userUpdate.$set['kycStatus'] = 'rejected';
      }
    }

    // Update user document
    const updatedUser = await User.findByIdAndUpdate(userId, userUpdate, { new: true });

    // Trigger the user model's KYC upgrade methods for approved documents
    if (isValidDocument && status === 'APPROVED') {
      try {
        await updatedUser.onIdentityDocumentVerified(frontendIdType, norm.idNumber);
        logger.info('Triggered identity document verification and KYC upgrade check', {
          requestId,
          userId,
          documentType: frontendIdType,
          documentNumber: norm.idNumber?.slice(0, 4) + '****'
        });
      } catch (upgradeError) {
        logger.error('Error during KYC upgrade process', {
          requestId,
          userId,
          error: upgradeError.message,
          documentType: frontendIdType
        });
      }
    }

    // ------------------------------
    // NEW: If the outcome is REJECTED, cancel any other in-progress / pending KYC records for this user.
    // ------------------------------
    if (status === 'REJECTED') {
      try {
        const pendingFilter = {
          userId,
          status: 'PENDING',
          _id: { $ne: kycDoc._id }
        };

        const pendingDocs = await KYC.find(pendingFilter).select('_id partnerJobId smileJobId createdAt status');

        if (pendingDocs && pendingDocs.length > 0) {
          const now = new Date();
          await KYC.updateMany(pendingFilter, {
            $set: {
              status: 'CANCELLED',
              cancelledAt: now,
              cancelledReason: 'Superseded by final REJECTED result',
              lastUpdated: now
            }
          });

          logger.info('Cancelled other pending KYC documents due to final rejection', {
            requestId,
            userId,
            cancelledCount: pendingDocs.length,
            cancelledIds: pendingDocs.map(d => d._id)
          });
        } else {
          logger.debug('No other pending KYC docs to cancel', { requestId, userId });
        }

        // Ensure user's kyc flags reflect final rejected state and clear any inProgress flags
        await User.findByIdAndUpdate(userId, {
          $set: {
            'kyc.status': 'rejected',
            'kyc.updatedAt': new Date(),
            'kyc.inProgress': false,
            'kyc.latestKycId': kycDoc._id
          }
        });
      } catch (cleanupErr) {
        logger.error('Error cancelling pending KYC documents after rejection', {
          requestId,
          userId,
          error: cleanupErr.message,
          stack: cleanupErr.stack
        });
      }
    }

    logger.info('SmileID webhook: User KYC status updated successfully', {
      requestId,
      userId,
      kycStatus: (await User.findById(userId)).kycStatus,
      status,
      kycId: kycDoc._id
    });

    logger.info('SmileID KYC record stored successfully', {
      requestId,
      userId,
      partnerJobId,
      smileJobId: norm.smileJobId,
      status: kycDoc.status,
      resultCode: kycDoc.resultCode,
      signatureValid,
      kycId: kycDoc._id,
      confidenceValue: norm.confidenceValue
    });

    return res.status(200).json({ 
      success: true, 
      kycId: kycDoc._id, 
      status: kycDoc.status,
      kycLevel: updatedUser.kycLevel,
      signatureValid,
      confidenceValue: norm.confidenceValue,
      documentInfo: status === 'APPROVED' ? kycDoc.getDocumentInfo() : null
    });

  } catch (e) {
    logger.error('SmileID webhook database error', { 
      requestId,
      error: e.message,
      stack: e.stack,
      userId,
      smileJobId: norm.smileJobId
    });
    
    // Still acknowledge to prevent retries, but mark as retriable for monitoring
    return res.status(200).json({ 
      success: false, 
      retriable: true, 
      error: e.message,
      requestId 
    });
  }
});

// ---------------- Biometric submission route (unchanged behavior) ----------------
// This is your POST /biometric-verification route which creates a PENDING KYC
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
      .isLength({ min: 8, max: 19 })
      .withMessage("ID number must be between 8-19 characters"),
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
      const NIGERIAN_ID_TYPES = {
        'passport': 'PASSPORT',
        'national_id': 'NIN_V2',
        'drivers_license': 'NIN_V2',
        'bvn': 'BVN',
        'nin': 'NIN_V2',
        'nin_slip': 'NIN_SLIP',
        'voter_id': 'VOTER_ID'
      };
      const ID_PATTERNS = {
        'BVN': /^\d{11}$/,
        'NIN_V2': /^\d{11}$/,
        'NIN_SLIP': /^\d{11}$/,
        'PASSPORT': /^[A-Z]\d{8}$/,
        'VOTER_ID': /^\d{19}$/
      };

      const smileIdType = NIGERIAN_ID_TYPES[idType];
      if (!smileIdType) {
        return res.status(400).json({ 
          success: false, 
          message: `Unsupported ID type: ${idType}` 
        });
      }

      // Validate ID number format
      const pattern = ID_PATTERNS[smileIdType];
      if (pattern && !pattern.test(idNumber)) {
        return res.status(400).json({ 
          success: false, 
          message: `Invalid ${idType} format. Please check your ID number.` 
        });
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

      // Update user with pending KYC status and flag inProgress
      await User.findByIdAndUpdate(user._id, {
        $set: {
          'kyc.status': 'pending',
          'kyc.updatedAt': new Date(),
          'kyc.latestKycId': kycDoc._id,
          'kyc.inProgress': true
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
      if (error.message && error.message.includes('SMILE_ID')) {
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
