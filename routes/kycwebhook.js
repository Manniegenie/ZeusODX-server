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

// Youverify Configuration
const YOUVERIFY_CONFIG = {
  secretKey: process.env.YOUVERIFY_SECRET_KEY || config.youverify?.secretKey,
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

function classifyOutcome({ status, allValidationPassed }) {
  const statusStr = String(status || '').toLowerCase();
  if (statusStr === 'pending') return 'PROVISIONAL';
  if (statusStr === 'found' && allValidationPassed === true) return 'APPROVED';
  return 'REJECTED';
}

function normalize(webhookBody) {
  const { event, apiVersion, data } = webhookBody || {};
  if (!data) return null;

  const addressData = data.address || {};
  const addressString = addressData.addressLine
    ? `${addressData.addressLine}, ${addressData.lga || ''}, ${addressData.state || ''}`.trim()
    : null;

  const validations = data.validations?.data || {};
  const fullName = data.firstName && data.lastName
    ? `${data.firstName} ${data.middleName || ''} ${data.lastName}`.trim().replace(/\s+/g, ' ')
    : null;

  return {
    jobComplete: true,
    jobSuccess: data.status === 'found' && data.allValidationPassed === true,
    status: data.status,
    allValidationPassed: data.allValidationPassed,
    country: data.country || 'NG',
    dob: data.dateOfBirth || null,
    fullName,
    firstName: data.firstName || null,
    lastName: data.lastName || null,
    idNumber: data.idNumber || null,
    idType: data.type || null,
    address: addressString,
    youverifyId: data._id || null,
    imageLinks: {
      document_image: data.image || data.fullDocumentFrontImage || null,
      selfie_image: data.faceImage || null,
    },
    reason: data.reason || data.validations?.validationMessages?.[0] || null,
    environment: process.env.NODE_ENV || 'development',
    event,
    apiVersion
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

    // 1. Signature Verification
    if (YOUVERIFY_CONFIG.secretKey && !verifyYouverifySignature(rawPayload, signature, YOUVERIFY_CONFIG.secretKey)) {
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    // 2. Data Normalization
    const norm = normalize(req.body);
    if (!norm) return res.status(400).json({ success: false, message: 'Missing data' });

    // 3. Find User & KYC Record
    const kycDoc = await KYC.findOne({
      $or: [
        { idNumber: norm.idNumber },
        { youverifyId: norm.youverifyId }
      ],
      status: 'PENDING'
    }).sort({ createdAt: -1 });

    if (!kycDoc) {
      return res.status(200).json({ success: true, ignored: 'no_pending_kyc_found' });
    }

    userId = kycDoc.userId;
    const user = await User.findById(userId);
    if (!user) return res.status(200).json({ success: true, ignored: 'user_not_found' });

    // 4. Update KYC & User Status
    const status = classifyOutcome({ status: norm.status, allValidationPassed: norm.allValidationPassed });
    const frontendIdType = ID_TYPE_MAPPING[norm.idType] || norm.idType?.toLowerCase();
    const isBvn = frontendIdType === 'bvn';

    // Update KYC Record
    await KYC.findByIdAndUpdate(kycDoc._id, {
      status: status === 'PROVISIONAL' ? 'PENDING' : status,
      resultText: norm.status,
      allValidationPassed: norm.allValidationPassed,
      lastUpdated: new Date(),
      errorReason: status === 'REJECTED' ? norm.reason : null
    });

    // Update User Document
    let userUpdate = { 'kyc.updatedAt': new Date() };
    if (status === 'APPROVED') {
      if (isBvn) {
        userUpdate.bvnVerified = true;
      } else {
        userUpdate['kyc.level2.status'] = 'approved';
        userUpdate['kyc.status'] = 'approved';
      }
    } else if (status === 'REJECTED') {
      userUpdate['kyc.status'] = 'rejected';
      userUpdate['kyc.level2.status'] = 'rejected';
      userUpdate['kyc.level2.rejectionReason'] = norm.reason;
    }

    const updatedUser = await User.findByIdAndUpdate(userId, { $set: userUpdate }, { new: true });

    // 5. EMAIL NOTIFICATION LOGIC
    if (status !== 'PROVISIONAL') {
      try {
        const isNIN = ['nin', 'nin_slip', 'national_id'].includes(frontendIdType);
        
        if (isNIN) {
          await sendNINVerificationEmail(
            updatedUser.email,
            updatedUser.firstName || 'User',
            status.toLowerCase(),
            updatedUser.kycLevel,
            status === 'REJECTED' ? norm.reason : null
          );
        } else {
          await sendKycEmail(
            updatedUser.email,
            updatedUser.firstName || 'User',
            status,
            status === 'REJECTED' ? (norm.reason || 'Information mismatch') : 'Your identity verification was successful.'
          );
        }
        logger.info(`KYC Email sent to ${updatedUser.email} for status: ${status}`);
      } catch (emailErr) {
        logger.error('Email notification failed', { userId, error: emailErr.message });
      }
    }

    return res.status(200).json({ success: true, status, processingTime: Date.now() - startTime });

  } catch (error) {
    logger.error('Webhook Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;