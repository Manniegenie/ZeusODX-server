const express = require('express');
const crypto = require('crypto');
const router = express.Router();

// Models & Config
const User = require('../models/user');
const KYC = require('../models/kyc');
const config = require('./config');
const logger = require('../utils/logger');

// Services
const { sendKycCompletionNotification } = require('../services/notificationService');
const { sendKycEmail, sendNINVerificationEmail } = require('../services/EmailService');

// KYC Helpers
const { classifyOutcome, parseFullName, isBvnIdType, isNinIdType } = require('../utils/kycHelpers');
const { trackEvent } = require('../utils/appsFlyerHelper');

// Youverify Configuration
const YOUVERIFY_CONFIG = {
  webhookSigningKey: process.env.YOUVERIFY_WEBHOOK_SIGNING_KEY || config.youverify?.webhookSigningKey,
};

// ID type mappings for Youverify
const ID_TYPE_MAPPING = {
  'passport': 'passport',
  'nin': 'national_id',
  'drivers-license': 'drivers_license',
  'drivers_license': 'drivers_license',
  'bvn': 'bvn',
  'pvc': 'voter_id'
};

/**
 * Verify Youverify webhook signature
 */
function verifyYouverifySignature(payload, signature, secretKey) {
  if (!signature || !secretKey) return false;
  try {
    const expectedSignature = crypto
      .createHmac('sha256', secretKey)
      .update(payload, 'utf8')
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature.toLowerCase(), 'hex'),
      Buffer.from(signature.toLowerCase(), 'hex')
    );
  } catch (error) {
    logger.error('Youverify signature verification error:', error);
    return false;
  }
}

// Classification logic now handled by utils/kycHelpers.js

function normalize(webhookBody) {
  const { event, apiVersion, data } = webhookBody || {};
  if (!data || typeof data !== 'object') return null;

  // Sanitize function to prevent injection attacks
  const sanitize = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/[<>$]/g, '').trim().substring(0, 500); // Limit length
  };

  const addressData = data.address || {};
  const addressString = addressData.addressLine
    ? `${sanitize(addressData.addressLine)}, ${sanitize(addressData.lga || '')}, ${sanitize(addressData.state || '')}`.trim()
    : null;

  const validations = data.validations?.data || {};
  const fullName = data.firstName && data.lastName
    ? `${sanitize(data.firstName)} ${sanitize(data.middleName || '')} ${sanitize(data.lastName)}`.trim().replace(/\s+/g, ' ')
    : null;

  // Extract metadata for job matching
  const metadata = data.metadata || {};

  return {
    jobComplete: true,
    jobSuccess: data.status === 'found' && data.allValidationPassed === true,
    status: sanitize(data.status),
    allValidationPassed: data.allValidationPassed,
    country: sanitize(data.country) || 'NG',
    dob: sanitize(data.dateOfBirth) || null,
    fullName,
    firstName: sanitize(data.firstName) || null,
    middleName: sanitize(data.middleName) || null,
    lastName: sanitize(data.lastName) || null,
    gender: sanitize(data.gender) || null,
    idNumber: sanitize(data.idNumber) || null,
    idType: sanitize(data.type) || null,
    address: addressString,
    youverifyId: sanitize(data._id) || null,
    imageLinks: {
      document_image: data.image || data.fullDocumentFrontImage || null,
      selfie_image: data.faceImage || null,
      fullDocumentBackImage: data.fullDocumentBackImage || null,
      signatureImage: data.signatureImage || null
    },
    reason: sanitize(data.reason || data.validations?.validationMessages?.[0]) || null,
    environment: process.env.NODE_ENV || 'development',
    event: sanitize(event),
    apiVersion: sanitize(apiVersion),
    // Metadata fields for job matching
    partnerJobId: sanitize(metadata.partner_job_id) || null,
    userId: sanitize(metadata.user_id) || null,
    // Store raw payload for debugging
    rawPayload: data
  };
}

function isValidKycDocument(idType) {
  const normalizedIdType = ID_TYPE_MAPPING[idType] || idType?.toLowerCase();
  const validDocuments = ['bvn', 'national_id', 'passport', 'drivers_license', 'nin_slip', 'voter_id', 'nin'];
  return validDocuments.includes(normalizedIdType);
}

// ---------------- Webhook Handler ----------------
router.post('/callback', async (req, res) => {
  const startTime = Date.now();
  let userId = null;

  try {
    const rawPayload = req.rawBody || JSON.stringify(req.body);
    const signature = req.headers['x-youverify-signature'];

    // 1. Signature Verification - REQUIRED FOR SECURITY
    if (!YOUVERIFY_CONFIG.webhookSigningKey) {
      logger.error('Youverify webhook signing key not configured - rejecting webhook');
      return res.status(500).json({ success: false, message: 'Server configuration error' });
    }

    if (!verifyYouverifySignature(rawPayload, signature, YOUVERIFY_CONFIG.webhookSigningKey)) {
      logger.warn('Invalid webhook signature detected', { signature: signature?.substring(0, 10) + '...' });
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    // 2. Data Normalization
    const norm = normalize(req.body);
    if (!norm) {
      logger.warn('Webhook received with missing or invalid data');
      return res.status(400).json({ success: false, message: 'Missing data' });
    }

    logger.info('Youverify webhook received', {
      event: norm.event,
      youverifyId: norm.youverifyId,
      partnerJobId: norm.partnerJobId,
      idType: norm.idType,
      status: norm.status,
      allValidationPassed: norm.allValidationPassed,
      jobSuccess: norm.jobSuccess,
      reason: norm.reason,
      fullPayload: JSON.stringify(req.body)
    });

    // 3. Find KYC Record - IMPROVED MATCHING
    // Priority 1: Match by partnerJobId (most reliable)
    // Priority 2: Match by youverifyId
    // Priority 3: Match by idNumber + userId (as fallback)
    let kycDoc = null;

    if (norm.partnerJobId) {
      kycDoc = await KYC.findOne({
        partnerJobId: norm.partnerJobId,
        status: { $in: ['PENDING', 'PROVISIONAL'] }
      }).sort({ createdAt: -1 });

      if (kycDoc) {
        logger.info('KYC record found by partnerJobId', { kycId: kycDoc._id, partnerJobId: norm.partnerJobId });
      }
    }

    // Fallback to youverifyId
    if (!kycDoc && norm.youverifyId) {
      kycDoc = await KYC.findOne({
        youverifyId: norm.youverifyId,
        status: { $in: ['PENDING', 'PROVISIONAL'] }
      }).sort({ createdAt: -1 });

      if (kycDoc) {
        logger.info('KYC record found by youverifyId', { kycId: kycDoc._id, youverifyId: norm.youverifyId });
      }
    }

    // Fallback to idNumber + userId
    if (!kycDoc && norm.idNumber && norm.userId) {
      kycDoc = await KYC.findOne({
        userId: norm.userId,
        idNumber: norm.idNumber,
        status: { $in: ['PENDING', 'PROVISIONAL'] }
      }).sort({ createdAt: -1 });

      if (kycDoc) {
        logger.info('KYC record found by userId+idNumber', { kycId: kycDoc._id, userId: norm.userId });
      }
    }

    if (!kycDoc) {
      logger.warn('No matching pending KYC record found', {
        partnerJobId: norm.partnerJobId,
        youverifyId: norm.youverifyId,
        idNumber: norm.idNumber ? `${norm.idNumber.substring(0, 4)}****` : null
      });
      return res.status(200).json({ success: true, ignored: 'no_pending_kyc_found' });
    }

    userId = kycDoc.userId;
    const user = await User.findById(userId);
    if (!user) {
      logger.error('User not found for KYC record', { userId, kycId: kycDoc._id });
      return res.status(200).json({ success: true, ignored: 'user_not_found' });
    }

    // 4. Classify Outcome using shared helper
    const status = classifyOutcome({
      status: norm.status,
      allValidationPassed: norm.allValidationPassed,
      job_success: norm.jobSuccess,
      code: null, // Webhooks don't send result codes
      text: norm.reason
    });

    logger.info('KYC outcome classified', {
      userId,
      kycId: kycDoc._id,
      status,
      webhookStatus: norm.status,
      allValidationPassed: norm.allValidationPassed
    });

    const frontendIdType = ID_TYPE_MAPPING[norm.idType] || kycDoc.frontendIdType || norm.idType?.toLowerCase();
    const isBvn = isBvnIdType(frontendIdType);
    const isNIN = isNinIdType(frontendIdType);

    // Parse name if available
    const parsedName = parseFullName(norm.fullName);

    // 5. Update KYC Record with ALL available data
    const kycUpdate = {
      status: status === 'PROVISIONAL' ? 'PENDING' : status,
      jobComplete: norm.jobComplete,
      jobSuccess: norm.jobSuccess,
      resultText: norm.status,
      allValidationPassed: norm.allValidationPassed,
      lastUpdated: new Date(),
      verificationDate: status === 'APPROVED' ? new Date() : kycDoc.verificationDate,

      // Personal data from webhook
      fullName: norm.fullName || kycDoc.fullName,
      firstName: norm.firstName || parsedName.firstName || kycDoc.firstName,
      middleName: norm.middleName || parsedName.middleName || kycDoc.middleName,
      lastName: norm.lastName || parsedName.lastName || kycDoc.lastName,
      dateOfBirth: norm.dob || kycDoc.dateOfBirth,
      gender: norm.gender || kycDoc.gender,
      address: norm.address || kycDoc.address,
      country: norm.country || kycDoc.country,

      // ID information
      idNumber: norm.idNumber || kycDoc.idNumber,
      idType: norm.idType || kycDoc.idType,
      frontendIdType: frontendIdType || kycDoc.frontendIdType,

      // Images
      imageLinks: {
        ...kycDoc.imageLinks,
        ...norm.imageLinks,
        document_image: norm.imageLinks?.document_image || kycDoc.imageLinks?.document_image,
        selfie_image: norm.imageLinks?.selfie_image || kycDoc.imageLinks?.selfie_image,
        fullDocumentBackImage: norm.imageLinks?.fullDocumentBackImage || kycDoc.imageLinks?.fullDocumentBackImage,
        signatureImage: norm.imageLinks?.signatureImage || kycDoc.imageLinks?.signatureImage
      },

      // Youverify ID
      youverifyId: norm.youverifyId || kycDoc.youverifyId,

      // Error/rejection reason
      errorReason: status === 'REJECTED' ? norm.reason : null,
      provisionalReason: status === 'PROVISIONAL' ? norm.reason : null,

      // Store raw payload for debugging
      payload: norm.rawPayload
    };

    await KYC.findByIdAndUpdate(kycDoc._id, { $set: kycUpdate });

    logger.info('KYC record updated', {
      kycId: kycDoc._id,
      status,
      hasFullName: !!norm.fullName,
      hasDob: !!norm.dob,
      hasAddress: !!norm.address
    });

    // 6. Update User Document with comprehensive status
    const now = new Date();
    let userUpdate = {
      'kyc.updatedAt': now,
      'kyc.latestKycId': kycDoc._id
    };

    if (status === 'APPROVED') {
      if (isBvn) {
        // Only set BVN if not already set by KYC.js
        if (!user.bvn) {
          userUpdate.bvn = norm.idNumber || kycDoc.idNumber;
          userUpdate.bvnVerified = true;
          logger.info('BVN set via webhook', { userId });
        } else {
          logger.info('BVN already set, skipping', { userId });
        }
      } else {
        // Document KYC (Level 2) - only set if not already approved
        if (user.kyc?.level2?.status !== 'approved') {
          userUpdate['kyc.status'] = 'approved';
          userUpdate['kycStatus'] = 'approved';
          userUpdate['kyc.level2.status'] = 'approved';
          userUpdate['kyc.level2.documentSubmitted'] = true;
          userUpdate['kyc.level2.documentType'] = frontendIdType;
          userUpdate['kyc.level2.documentNumber'] = norm.idNumber || kycDoc.idNumber;
          userUpdate['kyc.level2.approvedAt'] = now;
          userUpdate['kyc.level2.rejectionReason'] = null;

          if (user.kycLevel < 2) {
            userUpdate.kycLevel = 2;
            logger.info('User upgraded to KYC Level 2 via webhook', { userId });
          }
        } else {
          logger.info('Document KYC already approved, skipping', { userId });
        }
      }
    } else if (status === 'REJECTED') {
      // Only update rejection if not already approved
      if (user.kyc?.level2?.status !== 'approved' && !user.bvnVerified) {
        userUpdate['kyc.status'] = 'rejected';
        userUpdate['kycStatus'] = 'rejected';
        userUpdate['kyc.level2.status'] = 'rejected';
        userUpdate['kyc.level2.rejectionReason'] = norm.reason;
        userUpdate['kyc.level2.rejectedAt'] = now;

        if (isBvn) {
          userUpdate.bvnVerified = false;
        }

        logger.info('KYC rejected for user', { userId, reason: norm.reason });
      } else {
        logger.info('KYC already approved, ignoring rejection webhook', { userId });
      }
    } else if (status === 'PROVISIONAL' || status === 'PENDING') {
      // Only update pending if not already approved
      if (user.kyc?.level2?.status !== 'approved' && !user.bvnVerified) {
        userUpdate['kyc.status'] = 'pending';
        userUpdate['kycStatus'] = 'pending';
        userUpdate['kyc.level2.status'] = 'pending';
      }
    }

    const updatedUser = await User.findByIdAndUpdate(userId, { $set: userUpdate }, { new: true });

    logger.info('User status updated', {
      userId,
      kycStatus: updatedUser.kycStatus,
      kycLevel: updatedUser.kycLevel
    });

    // 7. Call upgrade hook if approved (for document KYC)
    if (status === 'APPROVED' && !isBvn) {
      try {
        if (typeof updatedUser.onIdentityDocumentVerified === 'function') {
          await updatedUser.onIdentityDocumentVerified(frontendIdType, norm.idNumber || kycDoc.idNumber);
          logger.info('onIdentityDocumentVerified hook called', { userId });
        }
      } catch (hookError) {
        logger.error('Error calling onIdentityDocumentVerified hook', {
          userId,
          error: hookError.message
        });
      }
      trackEvent(userId, 'KYC_2', {}, null).catch(err => {
        logger.warn('Failed to track AppsFlyer KYC_2 event', { userId, error: err.message });
      });
    }

    // 8. Send Email Notifications
    if (status !== 'PROVISIONAL' && status !== 'PENDING') {
      try {
        if (isNIN) {
          await sendNINVerificationEmail(
            updatedUser.email,
            updatedUser.firstname || 'User',
            status.toLowerCase(),
            updatedUser.kycLevel,
            status === 'REJECTED' ? norm.reason : null
          );
        } else if (isBvn) {
          await sendKycEmail(
            updatedUser.email,
            updatedUser.firstname || 'User',
            status,
            status === 'REJECTED'
              ? (norm.reason || 'BVN verification failed')
              : 'Your BVN has been successfully verified.'
          );
        } else {
          await sendKycEmail(
            updatedUser.email,
            updatedUser.firstname || 'User',
            status,
            status === 'REJECTED'
              ? (norm.reason || 'Information mismatch')
              : 'Your identity verification was successful.'
          );
        }
        logger.info(`KYC Email sent to ${updatedUser.email} for status: ${status}`);
      } catch (emailErr) {
        logger.error('Email notification failed', { userId, error: emailErr.message });
      }
    }

    logger.info('Webhook processed successfully', {
      userId,
      kycId: kycDoc._id,
      status,
      processingTime: Date.now() - startTime
    });

    return res.status(200).json({
      success: true,
      status,
      kycId: kycDoc._id,
      processingTime: Date.now() - startTime
    });

  } catch (error) {
    logger.error('Webhook processing error', {
      error: error.message,
      stack: error.stack,
      userId
    });
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;