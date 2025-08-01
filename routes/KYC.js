// routes/kyc.js - Cleaned KYC Routes
const express = require('express');
const router = express.Router();
const User = require('../models/user');
const KYC = require('../models/kyc');
const { kycLimitService } = require('../services/kyccheckservice');

// ==========================================
// 1. INITIATE KYC PROCESS
// ==========================================
router.post('/initiate', async (req, res) => {
  try {
    const { kycLevel, documentType } = req.body;
    const userId = req.user.id;

    // Check current KYC status
    const currentLimits = await kycLimitService.checkLimitsOnly(userId);
    if (!currentLimits) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Validate KYC level
    if (!kycLevel || ![1, 2, 3].includes(parseInt(kycLevel))) {
      return res.status(400).json({ success: false, error: 'Valid KYC level (1, 2, or 3) is required' });
    }

    // Check if user already has this KYC level
    if (currentLimits.kycLevel >= parseInt(kycLevel)) {
      return res.status(409).json({
        success: false,
        error: `KYC Level ${kycLevel} already completed or higher level active`,
        data: {
          currentKycLevel: currentLimits.kycLevel,
          currentLimits: currentLimits.limits,
          currentSpending: currentLimits.currentSpending
        }
      });
    }

    // Check prerequisites for Level 2 & 3
    if (parseInt(kycLevel) > 1 && currentLimits.kycLevel < parseInt(kycLevel) - 1) {
      const requiredLevel = parseInt(kycLevel) - 1;
      return res.status(400).json({
        success: false,
        error: `Please complete KYC Level ${requiredLevel} first`,
        data: {
          currentKycLevel: currentLimits.kycLevel,
          requiredLevel,
          upgradeRecommendation: kycLimitService.getUpgradeRecommendation(currentLimits.kycLevel)
        }
      });
    }

    // Get user details
    const user = await User.findById(userId);

    // Check for pending KYC
    const pendingKyc = await KYC.findOne({
      userId,
      kycLevel: parseInt(kycLevel),
      kycStatus: { $in: ['pending', 'under_review'] }
    });
    if (pendingKyc) {
      return res.status(400).json({
        success: false,
        error: `KYC Level ${kycLevel} is already in progress`,
        data: {
          kycId: pendingKyc._id,
          customerReference: pendingKyc.qoreIdData.customerReference,
          submittedAt: pendingKyc.submittedAt,
          status: pendingKyc.kycStatus
        }
      });
    }

    // Generate unique customer reference
    const customerReference = `KYC_${userId}_L${kycLevel}_${Date.now()}`;

    // Create new KYC record
    const kycRecord = new KYC({
      userId,
      userEmail: user.email,
      kycLevel: parseInt(kycLevel),
      kycStatus: 'pending',
      qoreIdData: {
        customerReference,
        documentType: documentType || null
      },
      integration: {
        method: 'sdk',
        clientIp: req.ip,
        userAgent: req.get('User-Agent')
      },
      statusHistory: [{
        status: 'pending',
        reason: 'KYC process initiated',
        changedAt: new Date()
      }]
    });
    await kycRecord.save();

    // Generate SDK configuration
    const sdkConfig = {
      flowId: 0,
      clientId: process.env.QOREID_CLIENT_ID,
      productCode: getProductCode(parseInt(kycLevel), documentType),
      customerReference,
      applicantData: {
        firstName: user.firstname || "",
        middleName: "",
        lastName: user.lastname || "",
        gender: "",
        phoneNumber: user.phonenumber || "",
        email: user.email,
      },
      identityData: {
        idType: documentType || "",
        idNumber: "",
      },
      addressData: { address: "", city: "", lga: "" },
      ocrAcceptedDocuments: getAcceptedDocuments(documentType)
    };

    // Log final SDK config
    console.log("🛠 Final SDK Config to be sent to frontend:", sdkConfig);

    res.json({
      success: true,
      message: 'KYC process initiated successfully',
      data: {
        kycId: kycRecord._id,
        customerReference,
        kycLevel: parseInt(kycLevel),
        sdkConfig,
        currentStatus: {
          currentKycLevel: currentLimits.kycLevel,
          currentLimits: currentLimits.limits,
          remaining: currentLimits.remaining
        }
      }
    });

  } catch (error) {
    console.error('KYC initiation error:', error);
    res.status(500).json({ success: false, error: 'Failed to initiate KYC process' });
  }
});

// ==========================================
// 2. PROCESS OCR RESULTS
// ==========================================
router.post('/process-ocr', async (req, res) => {
  try {
    const { customerReference, ocrData } = req.body;
    const userId = req.user.id;
    if (!customerReference || !ocrData) {
      return res.status(400).json({ success: false, error: 'Customer reference and OCR data are required' });
    }

    const kycRecord = await KYC.findOne({
      userId,
      'qoreIdData.customerReference': customerReference,
      kycStatus: { $in: ['pending', 'under_review'] }
    });
    if (!kycRecord) {
      return res.status(404).json({ success: false, error: 'KYC record not found or already processed' });
    }

    // Update with OCR data
    kycRecord.qoreIdData = {
      ...kycRecord.qoreIdData,
      success: ocrData.success || false,
      status: ocrData.status || 'failed',
      documentType: ocrData.documentType || kycRecord.qoreIdData.documentType,
      confidence: ocrData.confidence || 0,
      verificationId: ocrData.verificationId || null,
      extractedInfo: ocrData.extractedInfo || {}
    };
    kycRecord.processedAt = new Date();

    let newStatus = 'failed';
    let approvalReason = '';
    if (ocrData.success && ocrData.confidence >= 0.9) {
      newStatus = 'approved'; approvalReason = 'High confidence OCR verification'; kycRecord.approvedAt = new Date();
    } else if (ocrData.success && ocrData.confidence >= 0.7) {
      newStatus = 'under_review'; approvalReason = 'Medium confidence - requires manual review';
    } else {
      newStatus = 'rejected'; approvalReason = 'Low confidence or failed OCR verification'; kycRecord.rejectedAt = new Date(); kycRecord.rejectionReason = 'Insufficient document quality or confidence';
    }

    kycRecord.kycStatus = newStatus;
    kycRecord.statusHistory.push({ status: newStatus, reason: approvalReason, changedAt: new Date() });

    if (ocrData.extractedInfo) {
      kycRecord.verificationResults = validateExtractedInfo(ocrData.extractedInfo, kycRecord.kycLevel);
    }

    await kycRecord.save();

    let updatedLimits = null;
    if (newStatus === 'approved') {
      await updateUserKycStatus(userId, kycRecord);
      updatedLimits = await kycLimitService.checkLimitsOnly(userId);
      kycLimitService.clearUserCache(userId);
    }

    res.json({
      success: true,
      message: 'OCR data processed successfully',
      data: {
        kycId: kycRecord._id,
        kycStatus: kycRecord.kycStatus,
        kycLevel: kycRecord.kycLevel,
        confidence: kycRecord.qoreIdData.confidence,
        verificationId: kycRecord.qoreIdData.verificationId,
        extractedInfo: kycRecord.qoreIdData.extractedInfo,
        approvalReason,
        updatedLimits: updatedLimits ? {
          newKycLevel: updatedLimits.kycLevel,
          newLimits: updatedLimits.limits,
          newRemaining: updatedLimits.remaining
        } : null
      }
    });

  } catch (error) {
    console.error('OCR processing error:', error);
    res.status(500).json({ success: false, error: 'Failed to process OCR data' });
  }
});

// ==========================================
// 3. GET KYC STATUS
// ==========================================
router.get('/status', async (req, res) => {
  try {
    const userId = req.user.id;
    const currentLimits = await kycLimitService.checkLimitsOnly(userId);
    if (!currentLimits) return res.status(404).json({ success: false, error: 'User not found' });

    const kycRecords = await KYC.find({ userId }).sort({ submittedAt: -1 }).limit(10);
    const user = await User.findById(userId);
    let currentPrices = null;
    try { currentPrices = await kycLimitService.getCurrentPrices(); } catch (error) { console.warn('Could not fetch current prices:', error.message); }

    res.json({
      success: true,
      data: {
        userId: user._id,
        currentKycLevel: currentLimits.kycLevel,
        kycStatus: user.kycStatus,
        limits: currentLimits.limits,
        currentSpending: currentLimits.currentSpending,
        remaining: currentLimits.remaining,
        utilizationPercentage: {
          daily: (currentLimits.currentSpending.daily / currentLimits.limits.daily * 100).toFixed(1),
          monthly: (currentLimits.currentSpending.monthly / currentLimits.limits.monthly * 100).toFixed(1)
        },
        kyc: { level1: user.kyc.level1, level2: user.kyc.level2, level3: user.kyc.level3 },
        recentRecords: kycRecords.map(record => ({
          id: record._id,
          level: record.kycLevel,
          status: record.kycStatus,
          documentType: record.qoreIdData?.documentType,
          confidence: record.qoreIdData?.confidence,
          submittedAt: record.submittedAt,
          processedAt: record.processedAt
        })),
        upgradeInfo: {
          canUpgrade: currentLimits.kycLevel < 3,
          nextLevel: currentLimits.kycLevel < 3 ? currentLimits.kycLevel + 1 : null,
          upgradeRecommendation: kycLimitService.getUpgradeRecommendation(currentLimits.kycLevel)
        },
        currentPrices
      }
    });
  } catch (error) {
    console.error('KYC status error:', error);
    res.status(500).json({ success: false, error: 'Failed to get KYC status' });
  }
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================
function getProductCode(kycLevel, documentType) {
  const normalized = {
    'DRIVERS_LICENSE_NGA': 'DRIVERS_LICENSE',
    'VOTERS_CARD_NGA': 'VOTERS_CARD',
    'NIN_SLIP_NGA': 'NIN',
    'PASSPORT_NGA': 'PASSPORT'
  };
  const productCodes = {
    1: 'identity_basic',
    2: {
      'DRIVERS_LICENSE': 'identity_ng_dl',
      'VOTERS_CARD': 'identity_ng_vc',
      'NIN': 'identity_ng_nin',
      'PASSPORT': 'identity_ng_passport'
    },
    3: 'identity_enhanced'
  };
  const normalizedType = normalized[documentType] || documentType;
  if (kycLevel === 2 && normalizedType && productCodes[2][normalizedType]) {
    return productCodes[2][normalizedType];
  }
  return typeof productCodes[kycLevel] === 'string' ? productCodes[kycLevel] : 'identity_ng_multi';
}

function getAcceptedDocuments(documentType) {
  const documentMappings = {
    'DRIVERS_LICENSE_NGA': ['DRIVERS_LICENSE_NGA'],
    'VOTERS_CARD_NGA': ['VOTERS_CARD_NGA'],
    'NIN_SLIP_NGA': ['NIN_SLIP_NGA'],
    'PASSPORT_NGA': ['PASSPORT_NGA']
  };
  return documentMappings[documentType] || ['DRIVERS_LICENSE_NGA', 'VOTERS_CARD_NGA', 'NIN_SLIP_NGA', 'PASSPORT_NGA'];
}

function validateExtractedInfo(extractedInfo, kycLevel) {
  const validations = {
    firstName: { valid: !!(extractedInfo.firstName && extractedInfo.firstName.length > 1), confidence: extractedInfo.firstName ? 0.9 : 0.1 },
    lastName: { valid: !!(extractedInfo.lastName && extractedInfo.lastName.length > 1), confidence: extractedInfo.lastName ? 0.9 : 0.1 },
    dateOfBirth: { valid: !!(extractedInfo.dateOfBirth && isValidDate(extractedInfo.dateOfBirth)), confidence: extractedInfo.dateOfBirth ? 0.85 : 0.1 },
    documentNumber: { valid: !!(extractedInfo.licenseNumber || extractedInfo.vinNumber || extractedInfo.ninNumber || extractedInfo.passportNumber), confidence: 0.8 }
  };
  if (kycLevel >= 3) validations.address = { valid: !!(extractedInfo.address && extractedInfo.address.length > 10), confidence: extractedInfo.address ? 0.7 : 0.1 };
  return { documentValid: Object.values(validations).every(v => v.valid), personalInfoMatch: validations.firstName.valid && validations.lastName.valid, fieldValidations: validations };
}
function isValidDate(dateString) { const date = new Date(dateString); return date instanceof Date && !isNaN(date.getTime()) && date.getFullYear() > 1900 && date.getFullYear() < new Date().getFullYear(); }
async function updateUserKycStatus(userId, kycRecord) {
  try {
    const user = await User.findById(userId);
    if (!user) return;
    const extractedInfo = kycRecord.qoreIdData.extractedInfo;
    user.kycLevel = Math.max(user.kycLevel, kycRecord.kycLevel);
    user.kycStatus = 'approved';
    const levelKey = `level${kycRecord.kycLevel}`;
    user.kyc[levelKey].status = 'approved';
    user.kyc[levelKey].approvedAt = new Date();
    user.kyc[levelKey].submittedAt = kycRecord.submittedAt;
    if (extractedInfo) {
      if (!user.firstname && extractedInfo.firstName) user.firstname = extractedInfo.firstName;
      if (!user.lastname && extractedInfo.lastName) user.lastname = extractedInfo.lastName;
      if (!user.DoB && extractedInfo.dateOfBirth) user.DoB = extractedInfo.dateOfBirth;
      if (kycRecord.kycLevel >= 2) {
        user.kyc.level2.documentType = kycRecord.qoreIdData.documentType;
        user.kyc.level2.documentNumber = extractedInfo.licenseNumber || extractedInfo.vinNumber || extractedInfo.ninNumber || extractedInfo.passportNumber || null;
      }
      if (kycRecord.kycLevel >= 3 && extractedInfo.address) user.kyc.level3.addressVerified = true;
    }
    await user.save();
    console.log(`✅ User KYC updated: ${user.email} - Level ${kycRecord.kycLevel} approved`);
  } catch (error) { console.error('❌ Error updating user KYC status:', error); }
}

module.exports = router;
