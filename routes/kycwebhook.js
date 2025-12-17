// routes/youverify.webhook.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();

const User = require('../models/user');
const KYC = require('../models/kyc');
const config = require('./config');
const logger = require('../utils/logger');
const { sendKycCompletionNotification } = require('../services/notificationService');

// Youverify Configuration
const YOUVERIFY_CONFIG = {
  publicMerchantKey: process.env.YOUVERIFY_PUBLIC_MERCHANT_KEY || config.youverify?.publicMerchantKey,
  secretKey: process.env.YOUVERIFY_SECRET_KEY || config.youverify?.secretKey,
  callback_url: process.env.YOUVERIFY_CALLBACK_URL || config.youverify?.callbackUrl || 'https://your-domain.com/api/youverify/callback'
};

/**
 * Verify Youverify webhook signature using HMAC SHA256
 * @param {string} payload - Raw JSON payload as string
 * @param {string} signature - x-youverify-signature header value
 * @param {string} secretKey - Youverify secret key
 * @returns {boolean} - True if signature is valid
 */
function verifyYouverifySignature(payload, signature, secretKey) {
  if (!signature || !secretKey) {
    return false;
  }

  try {
    const expectedSignature = crypto
      .createHmac('sha256', secretKey)
      .update(payload, 'utf8')
      .digest('hex');

    // Use timing-safe comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(signature, 'hex')
    );
  } catch (error) {
    logger.error('Youverify signature verification error:', error);
    return false;
  }
}

// Youverify result classification - based on 'passed' field and status

// ID type mappings for Youverify
const ID_TYPE_MAPPING = {
  'passport': 'passport',
  'nin': 'national_id',
  'drivers-license': 'drivers_license',
  'drivers_license': 'drivers_license',
  'bvn': 'bvn',
  'pvc': 'voter_id'
};

function classifyOutcome({ status, allValidationPassed }) {
  // Youverify webhook format
  // status: "found" means successful verification
  // allValidationPassed: true/false indicates if all validations passed
  const statusStr = String(status || '').toLowerCase();

  if (statusStr === 'pending') {
    return 'PROVISIONAL';
  }

  if (statusStr === 'found' && allValidationPassed === true) {
    return 'APPROVED';
  }

  if (statusStr === 'found' && allValidationPassed === false) {
    return 'REJECTED';
  }

  // If status is not "found", treat as rejected
  if (statusStr !== 'found' && statusStr !== 'pending') {
    return 'REJECTED';
  }

  logger.warn('Unknown Youverify verification outcome - defaulting to REJECTED', {
    status: statusStr,
    allValidationPassed
  });
  return 'REJECTED';
}

function normalize(webhookBody) {
  // Youverify webhook format: { event, apiVersion, data }
  const { event, apiVersion, data } = webhookBody || {};

  if (!data) {
    return null;
  }

  // Extract address information
  const addressData = data.address || {};
  const addressString = addressData.addressLine
    ? `${addressData.addressLine}, ${addressData.lga || ''}, ${addressData.state || ''}`.trim()
    : null;

  // Extract validation data
  const validations = data.validations?.data || {};

  // Determine full name from firstName and lastName
  const fullName = data.firstName && data.lastName
    ? `${data.firstName} ${data.middleName || ''} ${data.lastName}`.trim().replace(/\s+/g, ' ')
    : null;

  return {
    jobComplete: true,
    jobSuccess: data.status === 'found' && data.allValidationPassed === true,
    status: data.status, // "found", "pending", etc.
    allValidationPassed: data.allValidationPassed,
    country: data.country || 'NG',
    dob: data.dateOfBirth || null,
    fullName: fullName,
    firstName: data.firstName || null,
    lastName: data.lastName || null,
    middleName: data.middleName || null,
    gender: data.gender === 'f' ? 'Female' : data.gender === 'm' ? 'Male' : data.gender || null,
    idNumber: data.idNumber || null,
    idType: data.type || null, // "nin", "passport", etc.
    address: addressString,
    addressDetails: addressData,
    youverifyId: data._id || null,
    businessId: data.businessId || null,
    requestedById: data.requestedById || null,
    parentId: data.parentId || null,
    providerTimestamp: data.createdAt ? new Date(data.createdAt) : new Date(),
    requestedAt: data.requestedAt ? new Date(data.requestedAt) : null,
    lastModifiedAt: data.lastModifiedAt ? new Date(data.lastModifiedAt) : null,
    imageLinks: {
      image: data.image || null, // Base64 image from Youverify
    },
    validations: {
      firstName: validations.firstName || null,
      lastName: validations.lastName || null,
      dateOfBirth: validations.dateOfBirth || null,
      validationMessages: data.validations?.validationMessages || null,
    },
    additionalData: {
      email: data.email || null,
      mobile: data.mobile || null,
      birthState: data.birthState || null,
      birthLGA: data.birthLGA || null,
      birthCountry: data.birthCountry || null,
      religion: data.religion || null,
      nokState: data.nokState || null,
      dataValidation: data.dataValidation,
      selfieValidation: data.selfieValidation,
      isConsent: data.isConsent,
      adverseMediaReport: data.adverseMediaReport,
    },
    reason: data.reason || null,
    environment: process.env.NODE_ENV || 'development',
    event: event,
    apiVersion: apiVersion,
  };
}

function isValidKycDocument(idType) {
  const normalizedIdType = ID_TYPE_MAPPING[idType] || idType?.toLowerCase();
  const validDocuments = ['bvn', 'national_id', 'passport', 'drivers_license', 'nin_slip', 'voter_id'];
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

  // Extract validation information from Youverify webhook
  if (norm.validations) {
    metadata.firstNameValidated = norm.validations.firstName?.validated || false;
    metadata.lastNameValidated = norm.validations.lastName?.validated || false;
    metadata.dateOfBirthValidated = norm.validations.dateOfBirth?.validated || false;
  }

  if (norm.additionalData) {
    metadata.dataValidation = norm.additionalData.dataValidation || false;
    metadata.selfieValidation = norm.additionalData.selfieValidation || false;
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}

// ---------------- Webhook Handler ----------------
// Use express.raw middleware to get raw body for signature verification
router.post('/callback', express.raw({ type: 'application/json' }), async (req, res) => {
  const startTime = Date.now();
  let webhookData;

  try {
    // Get raw payload for signature verification
    const rawPayload = req.body.toString('utf8');
    const signature = req.headers['x-youverify-signature'];

    // Parse JSON payload
    try {
      webhookData = JSON.parse(rawPayload);
    } catch (parseError) {
      logger.error('Invalid JSON in Youverify webhook:', parseError);
      return res.status(400).json({
        success: false,
        error: 'invalid_json',
        message: 'Invalid JSON payload'
      });
    }

    // Verify webhook signature if secret key is configured
    if (YOUVERIFY_CONFIG.secretKey) {
      if (!signature) {
        logger.warn('Youverify webhook received without signature');
        return res.status(400).json({
          success: false,
          error: 'missing_signature',
          message: 'x-youverify-signature header required'
        });
      }

      if (!verifyYouverifySignature(rawPayload, signature, YOUVERIFY_CONFIG.secretKey)) {
        logger.error('Invalid Youverify webhook signature', {
          signatureReceived: signature.substring(0, 16) + '...'
        });
        return res.status(401).json({
          success: false,
          error: 'invalid_signature',
          message: 'Invalid webhook signature'
        });
      }
      logger.info('Youverify webhook signature verified successfully');
    } else {
      logger.warn('Youverify webhook signature verification skipped - secret key not configured');
    }

    // Normalize webhook data
    const norm = normalize(webhookData);
    if (!norm) {
      logger.warn('Youverify webhook missing data field');
      return res.status(400).json({
        success: false,
        error: 'missing_data',
        message: 'Webhook missing required data field'
      });
    }

    const requestId = `${norm.youverifyId || norm.idNumber || 'unknown'}_${Date.now()}`;

    logger.info('Youverify webhook received', {
      requestId,
      event: norm.event,
      apiVersion: norm.apiVersion,
      youverifyId: norm.youverifyId,
      status: norm.status,
      allValidationPassed: norm.allValidationPassed,
      idType: norm.idType,
      idNumber: norm.idNumber ? norm.idNumber.slice(0, 4) + '****' : null,
      businessId: norm.businessId,
      requestedById: norm.requestedById
    });

    // User association - try multiple methods
    // Method 1: Check if userId was passed in metadata (from frontend SDK)
    // Method 2: Find user by idNumber if available
    // Method 3: Use requestedById if it's a user ID
    let userId = null;
    let partnerJobId = norm.youverifyId;

    // Try to find user by idNumber if we have it
    if (norm.idNumber) {
      try {
        const kycDoc = await KYC.findOne({
          idNumber: norm.idNumber,
          status: 'PENDING'
        }).sort({ createdAt: -1 });

        if (kycDoc) {
          userId = kycDoc.userId.toString();
          partnerJobId = kycDoc.partnerJobId || norm.youverifyId;
          logger.info('Found user from pending KYC document', {
            requestId,
            userId,
            kycId: kycDoc._id,
            partnerJobId
          });
        }
      } catch (findError) {
        logger.warn('Error finding user by idNumber', {
          requestId,
          error: findError.message
        });
      }
    }

    // If still no userId, check requestedById (might be user ID in some cases)
    if (!userId && norm.requestedById) {
      // This might be a user ID, but we can't be sure without checking
      // For now, we'll try to find by pending KYC with this as partnerJobId
      try {
        const kycDoc = await KYC.findOne({
          partnerJobId: norm.requestedById,
          status: 'PENDING'
        }).sort({ createdAt: -1 });

        if (kycDoc) {
          userId = kycDoc.userId.toString();
          partnerJobId = kycDoc.partnerJobId;
        }
      } catch (findError) {
        // Ignore
      }
    }

    if (!userId) {
      logger.warn('Youverify callback: unable to associate with user; acknowledging without processing', {
        requestId,
        idNumber: norm.idNumber ? norm.idNumber.slice(0, 4) + '****' : null,
        youverifyId: norm.youverifyId,
        requestedById: norm.requestedById
      });
      return res.status(200).json({ success: true, ignored: 'unable_to_associate_user' });
    }

    // Fetch user
    let user;
    try {
      user = await User.findById(userId);
      if (!user) {
        logger.warn('Youverify callback: user not found', { requestId, userId });
        return res.status(200).json({ success: true, ignored: 'user_not_found' });
      }
    } catch (e) {
      logger.error('Youverify callback: error fetching user', {
        requestId,
        userId,
        error: e.message
      });
      return res.status(500).json({ success: false, error: 'user_fetch_error' });
    }

    // Classify outcome
    const status = classifyOutcome({
      status: norm.status,
      allValidationPassed: norm.allValidationPassed,
    });

    logger.info('Youverify webhook outcome classified', {
      requestId,
      userId,
      youverifyId: norm.youverifyId,
      status: norm.status,
      allValidationPassed: norm.allValidationPassed,
      classifiedStatus: status,
      idType: norm.idType,
      currentKycLevel: user.kycLevel
    });

    const isValidDocument = isValidKycDocument(norm.idType);
    const frontendIdType = ID_TYPE_MAPPING[norm.idType] || norm.idType?.toLowerCase();
    const isBvnVerification = frontendIdType === 'bvn';

    // Upsert into KYC collection
    try {
      let kycDoc;

      // First, try to find existing document
      const existingDoc = await KYC.findOne({
        $or: [
          { userId, partnerJobId },
          ...(norm.youverifyId ? [{ youverifyId: norm.youverifyId }] : [])
        ]
      });

      const { firstName, lastName } = parseFullName(norm.fullName);
      const documentMetadata = extractDocumentMetadata(norm);

      const updateData = {
        environment: norm.environment,
        partnerJobId,
        jobType: 1,
        youverifyId: norm.youverifyId,
        jobComplete: norm.jobComplete,
        jobSuccess: norm.jobSuccess,
        status: status === 'PROVISIONAL' ? 'PENDING' : status,
        resultCode: norm.status,
        resultText: norm.status === 'found' ? (norm.allValidationPassed ? 'Verified' : 'Validation failed') : norm.status || norm.reason || 'Unknown',
        allValidationPassed: norm.allValidationPassed,
        country: norm.country,
        idType: norm.idType,
        frontendIdType,
        idNumber: norm.idNumber,
        ...(status === 'APPROVED' && {
          fullName: norm.fullName,
          firstName: norm.firstName || firstName,
          lastName: norm.lastName || lastName,
          middleName: norm.middleName || null,
          dateOfBirth: norm.dob,
          gender: norm.gender,
          address: norm.address,
          verificationDate: new Date()
        }),
        imageLinks: norm.imageLinks,
        businessId: norm.businessId,
        requestedById: norm.requestedById,
        parentId: norm.parentId,
        providerTimestamp: norm.providerTimestamp,
        requestedAt: norm.requestedAt,
        lastModifiedAt: norm.lastModifiedAt,
        lastUpdated: new Date(),
        payload: webhookData,
        errorReason: status === 'REJECTED' ? (norm.reason || norm.resultText || 'Verification failed') : null,
        provisionalReason: status === 'PROVISIONAL' ? (norm.reason || 'Under review') : null,
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
          youverifyId: norm.youverifyId
        });
      } else {
        // Create new document
        kycDoc = await KYC.create({
          userId,
          provider: 'youverify',
          createdAt: new Date(),
          ...updateData
        });

        logger.info('Created new KYC document', {
          requestId,
          kycId: kycDoc._id,
          userId,
          partnerJobId,
          youverifyId: norm.youverifyId
        });
      }
    } catch (kycError) {
      logger.error('Error upserting KYC document', {
        requestId,
        userId,
        error: kycError.message,
        stack: kycError.stack
      });
      throw kycError; // Re-throw to be caught by outer catch
    }

    // Update User based on verification type (BVN vs Document KYC)
    const userUpdate = {
      $set: {
        'kyc.updatedAt': new Date(),
        'kyc.latestKycId': kycDoc._id,
      },
    };

    if (isBvnVerification) {
      // BVN verification - update separate BVN fields
      if (status === 'APPROVED') {
        userUpdate.$set['bvn'] = norm.idNumber;
        userUpdate.$set['bvnVerified'] = true;

        logger.info('BVN verification approved', {
          requestId,
          userId,
          bvn: norm.idNumber?.slice(0, 3) + '********',
          allValidationPassed: norm.allValidationPassed
        });
      } else if (status === 'PROVISIONAL') {
        userUpdate.$set['bvn'] = norm.idNumber;
        userUpdate.$set['bvnVerified'] = false;

        logger.info('BVN verification provisional/pending', {
          requestId,
          userId,
          status: norm.status
        });
      } else if (status === 'REJECTED') {
        userUpdate.$set['bvn'] = null;
        userUpdate.$set['bvnVerified'] = false;

        logger.info('BVN verification rejected', {
          requestId,
          userId,
          status: norm.status
        });
      }
    } else if (isValidDocument) {
      // Document KYC verification (NIN, Passport, Driver's License, etc.)
      userUpdate.$set['kyc.provider'] = 'youverify';
      userUpdate.$set['kyc.status'] = status === 'PROVISIONAL' ? 'pending' : status.toLowerCase();
      userUpdate.$set['kyc.resultCode'] = kycDoc.resultCode;
      userUpdate.$set['kyc.resultText'] = kycDoc.resultText;

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
          allValidationPassed: norm.allValidationPassed
        });
      } else if (status === 'PROVISIONAL') {
        userUpdate.$set['kyc.level2.status'] = 'pending';
        userUpdate.$set['kyc.level2.documentSubmitted'] = true;
        userUpdate.$set['kyc.level2.documentType'] = frontendIdType;
        userUpdate.$set['kyc.level2.documentNumber'] = norm.idNumber;
        userUpdate.$set['kyc.level2.submittedAt'] = new Date();
        userUpdate.$set['kyc.level2.rejectionReason'] = `Pending verification: ${norm.status || 'Under review'}`;
        userUpdate.$set['kycStatus'] = 'pending';
        userUpdate.$set['kyc.inProgress'] = true;
      } else if (status === 'REJECTED') {
        userUpdate.$set['kyc.level2.status'] = 'rejected';
        userUpdate.$set['kyc.level2.documentSubmitted'] = true;
        userUpdate.$set['kyc.level2.documentType'] = frontendIdType;
        userUpdate.$set['kyc.level2.documentNumber'] = norm.idNumber;
        userUpdate.$set['kyc.level2.rejectedAt'] = new Date();
        userUpdate.$set['kyc.level2.rejectionReason'] = norm.status || 'ID verification failed';
        userUpdate.$set['kycStatus'] = 'rejected';
        userUpdate.$set['kyc.inProgress'] = false;
      }
    }

    const updatedUser = await User.findByIdAndUpdate(userId, userUpdate, { new: true });

    // Trigger KYC upgrade for approved DOCUMENT verifications only (not BVN)
    if (isValidDocument && !isBvnVerification && status === 'APPROVED') {
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

    // CRITICAL: If REJECTED, cancel all other pending KYC of the SAME TYPE
    if (status === 'REJECTED') {
      try {
        // Build filter based on verification type
        const pendingFilter = {
          userId,
          status: 'PENDING',
          _id: { $ne: kycDoc._id }
        };

        // Only cancel same type of verification
        if (isBvnVerification) {
          pendingFilter.frontendIdType = 'bvn';
        } else {
          // Cancel other document KYC types
          pendingFilter.frontendIdType = { $in: ['national_id', 'passport', 'drivers_license', 'nin', 'nin_slip', 'voter_id'] };
        }

        const pendingDocs = await KYC.find(pendingFilter).select('_id partnerJobId youverifyId createdAt status frontendIdType');

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
            verificationType: isBvnVerification ? 'BVN' : 'Document',
            cancelledCount: cancelledCount.modifiedCount,
            cancelledIds: pendingDocs.map(d => d._id),
            cancelledJobIds: pendingDocs.map(d => d.partnerJobId)
          });
        }

        // Clear in-progress flag for the specific verification type
        if (isBvnVerification) {
          await User.findByIdAndUpdate(userId, {
            $set: {
              'bvn': null,
              'bvnVerified': false,
              'kyc.updatedAt': new Date()
            }
          });

          logger.info('Cleared BVN verification after rejection - user can submit again', {
            requestId,
            userId,
            rejectionReason: norm.status
          });
        } else {
          await User.findByIdAndUpdate(userId, {
            $set: {
              'kyc.status': 'rejected',
              'kyc.updatedAt': new Date(),
              'kyc.inProgress': false,
              'kyc.latestKycId': kycDoc._id,
              'kyc.level2.status': 'rejected',
              'kyc.level2.rejectedAt': new Date(),
              'kyc.level2.rejectionReason': norm.status || 'ID verification failed',
              'kycStatus': 'rejected'
            }
          });

          logger.info('Cleared in-progress KYC state after rejection - user can submit again', {
            requestId,
            userId,
            rejectionReason: norm.status
          });
        }

      } catch (cleanupErr) {
        logger.error('Error cancelling pending KYC documents after rejection', {
          requestId,
          userId,
          error: cleanupErr.message,
          stack: cleanupErr.stack
        });
      }
    }

    logger.info('Youverify webhook: User status updated successfully', {
      requestId,
      userId,
      verificationType: isBvnVerification ? 'BVN' : 'Document',
      status,
      kycId: kycDoc._id,
      bvnVerified: isBvnVerification ? (await User.findById(userId)).bvnVerified : undefined,
      kycStatus: !isBvnVerification ? (await User.findById(userId)).kycStatus : undefined,
      inProgress: !isBvnVerification ? (await User.findById(userId)).kyc?.inProgress : undefined
    });

    // Send KYC completion notification if status is final (not provisional)
    if (status !== 'PROVISIONAL') {
      try {
        await sendKycCompletionNotification(
          userId,
          status,
          isBvnVerification ? 'BVN' : 'Document KYC',
          {
            kycId: kycDoc._id.toString(),
            verificationType: isBvnVerification ? 'bvn' : 'document',
            documentType: frontendIdType,
            status: norm.status,
            allValidationPassed: norm.allValidationPassed
          }
        );
        logger.info('KYC completion notification sent', {
          userId,
          status,
          type: isBvnVerification ? 'BVN' : 'Document KYC'
        });
      } catch (notificationError) {
        logger.error('Failed to send KYC completion notification', {
          userId,
          status,
          error: notificationError.message
        });
      }
    }

    return res.status(200).json({
      success: true,
      kycId: kycDoc._id,
      status: kycDoc.status,
      verificationType: isBvnVerification ? 'bvn' : 'document',
      kycLevel: updatedUser.kycLevel,
      bvnVerified: isBvnVerification ? updatedUser.bvnVerified : undefined,
      allValidationPassed: norm.allValidationPassed,
      youverifyStatus: norm.status,
      documentInfo: status === 'APPROVED' && !isBvnVerification ? kycDoc.getDocumentInfo() : null,
      processingTime: Date.now() - startTime
    });

  } catch (e) {
    logger.error('Youverify webhook database error', {
      requestId,
      error: e.message,
      stack: e.stack,
      userId,
      youverifyId: norm.youverifyId,
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