const express = require('express');
const router = express.Router();

const User = require('../models/user');
const KYC = require('../models/kyc');
const logger = require('../utils/logger');

// Optional: verify Smile signature using their server SDK
let Signature;
try {
  Signature = require('smile-identity-core').Signature; // npm i smile-identity-core
} catch (_) {
  Signature = null;
}

// Use the same environment variables as your main service
const PARTNER_ID = process.env.SMILE_ID_PARTNER_ID;
const API_KEY = process.env.SMILE_ID_API_KEY;

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

// ---- webhook ----------------------------------------------------

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
    if (Signature && PARTNER_ID && API_KEY && body.timestamp && body.signature) {
      const sig = new Signature(PARTNER_ID, API_KEY);
      signatureValid = sig.confirm_signature(body.timestamp, body.signature);
      
      if (!signatureValid) {
        logger.warn('SmileID webhook: signature INVALID', {
          requestId,
          partnerId: PARTNER_ID,
          timestampAge: Date.now() - new Date(body.timestamp).getTime()
        });
      } else {
        logger.info('SmileID webhook: signature verified successfully', { requestId });
      }
    } else {
      const missing = [];
      if (!Signature) missing.push('Signature SDK');
      if (!PARTNER_ID) missing.push('SMILE_ID_PARTNER_ID');
      if (!API_KEY) missing.push('SMILE_ID_API_KEY');
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
      partnerId: PARTNER_ID,
      hasApiKey: !!API_KEY
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

    logger.info('SmileID webhook: User KYC status updated successfully', {
      requestId,
      userId,
      kycStatus: updatedUser.kycStatus,
      idType: frontendIdType,
      smileIdType: norm.idType,
      status,
      documentVerified: isValidDocument && status === 'APPROVED',
      level2Status: updatedUser.kyc?.level2?.status
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
      confidenceValue: norm.confidenceValue,
      documentStored: status === 'APPROVED'
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

module.exports = router;