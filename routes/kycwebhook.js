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
  sid_server: process.env.SMILE_ID_SERVER || config.smileId?.server || '0',
  callback_url: process.env.SMILE_ID_CALLBACK_URL || config.smileId?.callbackUrl || 'https://your-domain.com/api/smile-id/callback'
};

// Optional: verify Smile signature
let Signature;
try {
  Signature = require('smile-identity-core').Signature;
} catch (_) {
  Signature = null;
}

// Result codes
const APPROVED_CODES = new Set([
  '0810', '0820', '0830', '0840',
  '1012', '1020', '1021',
  '1210', '1220', '1230', '1240',
  '2302'
]);

const PROVISIONAL_CODES = new Set([
  '0812', '0814', '0815', '0816', '0817',
  '0822', '0824', '0825',
  '1212', '1213', '1214', '1215',
  '1222', '1223', '1224', '1225'
]);

const REJECTED_CODES = new Set([
  '0813', '0826', '0827',
  '1011', '1013', '1014', '1015', '1016',
  '1216', '1217', '1218', '1226', '1227', '1228'
]);

// ID type mappings
const ID_TYPE_MAPPING = {
  'BVN': 'bvn',
  'NIN_V2': 'national_id',
  'NIN': 'national_id',
  'NIN_SLIP': 'nin_slip',
  'PASSPORT': 'passport',
  'VOTER_ID': 'voter_id'
};

function classifyOutcome({ job_success, code, text, actions }) {
  if (typeof job_success === 'boolean') {
    return job_success ? 'APPROVED' : 'REJECTED';
  }
  
  const codeStr = String(code || '');
  if (APPROVED_CODES.has(codeStr)) return 'APPROVED';
  if (REJECTED_CODES.has(codeStr)) return 'REJECTED';
  if (PROVISIONAL_CODES.has(codeStr)) return 'PROVISIONAL';

  const t = (text || '').toLowerCase();
  
  if (/(fail|rejected|no.?match|unable|unsupported|error|invalid|not.?found|not.?enabled|cannot|declined)/.test(t)) {
    return 'REJECTED';
  }
  
  if (/(provisional|pending|awaiting|under.?review|partial.?match)/.test(t)) {
    return 'PROVISIONAL';
  }
  
  if (/(pass|approved|verified|valid|exact.?match|enroll.?user|id.?validated|success)/.test(t)) {
    return 'APPROVED';
  }

  if (actions && typeof actions === 'object') {
    const vals = Object.values(actions).map(v => String(v).toLowerCase());
    const criticalActions = ['verify_id_number', 'selfie_to_id_authority_compare', 'human_review_compare'];
    
    const criticalFailed = criticalActions.some(action => {
      const actionValue = actions[action] || actions[action.replace(/_/g, '_')];
      return actionValue && /(fail|rejected|unable|not.applicable)/.test(String(actionValue).toLowerCase());
    });
    
    if (criticalFailed) return 'REJECTED';
    
    const anyFail = vals.some(v => /(fail|rejected|unable)/.test(v));
    const mostPass = vals.filter(v => /(pass|approved|verified|returned|completed)/.test(v)).length > vals.length / 2;
    
    if (anyFail && !mostPass) return 'REJECTED';
    if (mostPass) return 'APPROVED';
  }
  
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
    jobComplete: typeof job_complete === 'boolean' ? job_complete : true,
    jobSuccess: typeof job_success === 'boolean' ? job_success : undefined,
    actions: node.Actions || Actions || null,
    country: node.Country || Country || 'NG',
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

function isValidKycDocument(idType) {
  const normalizedIdType = ID_TYPE_MAPPING[idType] || idType?.toLowerCase();
  const validDocuments = ['bvn', 'national_id', 'passport', 'nin_slip', 'voter_id'];
  return validDocuments.includes(normalizedIdType);
}

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

function extractDocumentMetadata(norm) {
  const metadata = {};
  
  if (norm.actions) {
    metadata.faceMatch = !!(norm.actions.Selfie_To_ID_Authority_Compare === 'Completed' || 
                           norm.actions.Human_Review_Compare === 'Passed');
    metadata.livenessCheck = !!(norm.actions.Liveness_Check === 'Passed' || 
                               norm.actions.Human_Review_Liveness_Check === 'Passed');
    metadata.documentAuthenticity = !!(norm.actions.Verify_ID_Number === 'Verified');
  }
  
  return Object.keys(metadata).length > 0 ? metadata : null;
}

// ---------------- Webhook Handler ----------------
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

  // Signature verification
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

  // User association
  const { user_id: userId, job_id: partnerJobId, job_type: jobType } = norm.partnerParams || {};
  if (!userId) {
    logger.warn('SmileID callback missing user_id; acknowledging without processing', {
      requestId,
      partnerParams: norm.partnerParams,
      smileJobId: norm.smileJobId
    });
    return res.status(200).json({ success: true, ignored: 'missing_user_id' });
  }

  // Fetch user
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

  // Classify outcome
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

  const isValidDocument = isValidKycDocument(norm.idType);
  const frontendIdType = ID_TYPE_MAPPING[norm.idType] || norm.idType?.toLowerCase();

  // Upsert into KYC collection - FIXED to prevent duplicate key errors
  try {
    let kycDoc;
    
    // First, try to find existing document
    const existingDoc = await KYC.findOne({
      $or: [
        { userId, partnerJobId },
        ...(norm.smileJobId ? [{ smileJobId: norm.smileJobId }] : [])
      ]
    });

    const { firstName, lastName } = parseFullName(norm.fullName);
    const documentMetadata = extractDocumentMetadata(norm);

    const updateData = {
      environment: norm.environment,
      partnerJobId,
      jobType: parseInt(jobType) || 1,
      smileJobId: norm.smileJobId,
      jobComplete: norm.jobComplete,
      jobSuccess: norm.jobSuccess,
      status: status === 'PROVISIONAL' ? 'PENDING' : status,
      resultCode: norm.resultCode,
      resultText: norm.resultText,
      actions: norm.actions,
      country: norm.country,
      idType: norm.idType,
      frontendIdType,
      idNumber: norm.idNumber,
      ...(status === 'APPROVED' && {
        fullName: norm.fullName,
        firstName,
        lastName,
        dateOfBirth: norm.dob,
        gender: norm.gender,
        documentExpiryDate: norm.expiresAt,
        verificationDate: new Date()
      }),
      confidenceValue: norm.confidenceValue,
      imageLinks: norm.imageLinks,
      history: norm.history,
      signature: norm.signature,
      signatureValid,
      providerTimestamp: norm.providerTimestamp,
      lastUpdated: new Date(),
      payload: body,
      errorReason: status === 'REJECTED' ? norm.resultText : null,
      provisionalReason: status === 'PROVISIONAL' ? (norm.resultText || 'Under review') : null,
      ...(status === 'APPROVED' && documentMetadata && { documentMetadata })
    };

    if (existingDoc) {
      // Update existing document by _id to avoid duplicate key error
      kycDoc = await KYC.findByIdAndUpdate(
        existingDoc._id,
        { $set: updateData },
        { new: true, runValidators: true }
      );
      
      logger.info('Updated existing KYC document', {
        requestId,
        kycId: kycDoc._id,
        userId,
        partnerJobId,
        smileJobId: norm.smileJobId
      });
    } else {
      // Create new document
      kycDoc = await KYC.create({
        userId,
        provider: 'smile-id',
        createdAt: new Date(),
        ...updateData
      });
      
      logger.info('Created new KYC document', {
        requestId,
        kycId: kycDoc._id,
        userId,
        partnerJobId,
        smileJobId: norm.smileJobId
      });
    }

    // Update User KYC status
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

    if (isValidDocument) {
      if (status === 'APPROVED') {
        userUpdate.$set['kyc.level2.status'] = 'approved';
        userUpdate.$set['kyc.level2.documentSubmitted'] = true;
        userUpdate.$set['kyc.level2.documentType'] = frontendIdType;
        userUpdate.$set['kyc.level2.documentNumber'] = norm.idNumber;
        userUpdate.$set['kyc.level2.approvedAt'] = new Date();
        userUpdate.$set['kyc.level2.rejectionReason'] = null;
        userUpdate.$set['kyc.inProgress'] = false;
        
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
        userUpdate.$set['kyc.inProgress'] = true;
      } else if (status === 'REJECTED') {
        userUpdate.$set['kyc.level2.status'] = 'rejected';
        userUpdate.$set['kyc.level2.documentSubmitted'] = true;
        userUpdate.$set['kyc.level2.documentType'] = frontendIdType;
        userUpdate.$set['kyc.level2.documentNumber'] = norm.idNumber;
        userUpdate.$set['kyc.level2.rejectedAt'] = new Date();
        userUpdate.$set['kyc.level2.rejectionReason'] = norm.resultText || 'ID verification failed';
        userUpdate.$set['kycStatus'] = 'rejected';
        userUpdate.$set['kyc.inProgress'] = false;
      }
    }

    const updatedUser = await User.findByIdAndUpdate(userId, userUpdate, { new: true });

    // Trigger KYC upgrade for approved documents
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

    // CRITICAL: If REJECTED, cancel all other pending KYC and clear in-progress state
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
          const cancelledCount = await KYC.updateMany(pendingFilter, {
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
            cancelledCount: cancelledCount.modifiedCount,
            cancelledIds: pendingDocs.map(d => d._id),
            cancelledJobIds: pendingDocs.map(d => d.partnerJobId)
          });
        }

        // Clear in-progress flag and set final rejected state
        await User.findByIdAndUpdate(userId, {
          $set: {
            'kyc.status': 'rejected',
            'kyc.updatedAt': new Date(),
            'kyc.inProgress': false,
            'kyc.latestKycId': kycDoc._id,
            'kyc.level2.status': 'rejected',
            'kyc.level2.rejectedAt': new Date(),
            'kyc.level2.rejectionReason': norm.resultText || 'ID verification failed',
            'kycStatus': 'rejected'
          }
        });

        logger.info('Cleared in-progress KYC state after rejection - user can submit again', {
          requestId,
          userId,
          rejectionReason: norm.resultText
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
      kycId: kycDoc._id,
      inProgress: (await User.findById(userId)).kyc?.inProgress
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
      smileJobId: norm.smileJobId,
      partnerJobId
    });
    
    return res.status(200).json({ 
      success: false, 
      retriable: true, 
      error: e.message,
      requestId 
    });
  }
});

module.exports = router;