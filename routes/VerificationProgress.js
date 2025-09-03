// routes/verification-status.js
const express = require('express');
const User = require('../models/user');
const router = express.Router();

router.get('/status', async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Build detailed progress for each track with granular steps
    const fiat = buildFiatProgress(user);
    const kyc = buildKycProgress(user);

    // Percent helper
    const toPercent = (completed, total) =>
      total > 0 ? Math.round((completed / total) * 100) : 0;

    return res.status(200).json({
      fiatVerification: {
        totalSteps: fiat.total,
        completedSteps: fiat.completedCount,
        percentage: toPercent(fiat.completedCount, fiat.total),
        steps: fiat.steps,
        completed: fiat.completedIds
      },
      kycVerification: {
        totalSteps: kyc.total,
        completedSteps: kyc.completedCount,
        percentage: toPercent(kyc.completedCount, kyc.total),
        steps: kyc.steps,
        completed: kyc.completedIds
      }
    });

  } catch (error) {
    console.error('Error fetching verification status:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

/**
 * Fiat progress = 2 steps:
 *  - bank_account: any active bank account added
 *  - bvn: BVN verified
 */
function buildFiatProgress(user) {
  const activeBankAccounts = user.getActiveBankAccounts?.() || [];

  const steps = [
    {
      id: 'bank_account',
      label: 'Add bank account',
      completed: activeBankAccounts.length > 0,
      completedAt: activeBankAccounts.length > 0
        ? activeBankAccounts[0]?.addedAt || null
        : null,
    },
    {
      id: 'bvn',
      label: 'BVN verification',
      completed: !!user.bvnVerified,
      completedAt: user.bvnVerifiedAt || null,
    }
  ];

  const completedIds = steps.filter(s => s.completed).map(s => s.id);
  return {
    total: steps.length,
    completedCount: completedIds.length,
    completedIds,
    steps
  };
}

/**
 * KYC progress = GRANULAR STEPS (not just 3 levels):
 *  - email: Email verification 
 *  - identity: Identity verification (part of level2)
 *  - address: Address verification (level3)
 * 
 * Mapping:
 * - Level 1: Auto-approved (not shown to user)
 * - Level 2: Email + Identity verification
 * - Level 3: Address verification
 */
function buildKycProgress(user) {
  const lvl1 = user.kyc?.level1 || {};
  const lvl2 = user.kyc?.level2 || {};
  const lvl3 = user.kyc?.level3 || {};

  // Check individual components within level2
  const emailVerified = user.emailVerified || false;
  const identityVerified = checkIdentityVerification(user, lvl2);
  const addressVerified = lvl3.status === 'approved';

  const steps = [
    {
      id: 'email',
      label: 'Email Verification',
      completed: emailVerified,
      completedAt: user.emailVerifiedAt || null,
      status: emailVerified ? 'approved' : 'not_submitted'
    },
    {
      id: 'identity',
      label: 'Identity Verification',
      completed: identityVerified,
      completedAt: lvl2.approvedAt || null,
      status: getIdentityVerificationStatus(user, lvl2)
    },
    {
      id: 'address',
      label: 'Address Verification', 
      completed: addressVerified,
      completedAt: lvl3.approvedAt || null,
      status: lvl3.status || 'not_submitted'
    }
  ];

  const completedIds = steps.filter(s => s.completed).map(s => s.id);
  return {
    total: steps.length,
    completedCount: completedIds.length,
    completedIds,
    steps
  };
}

/**
 * Helper: Check if identity verification is complete
 * This might depend on your specific implementation - adjust as needed
 */
function checkIdentityVerification(user, lvl2) {
  // Option 1: Identity is complete if level2 is approved AND email is verified
  if (lvl2.status === 'approved' && user.emailVerified) {
    return true;
  }

  // Option 2: Check for specific identity documents/selfie
  // Adjust based on how you store identity verification data
  const hasIdentityDocs = user.kyc?.identityDocuments?.length > 0;
  const hasSelfie = user.kyc?.selfiePhoto != null;
  
  // Return true if both documents and selfie are provided and approved
  return hasIdentityDocs && hasSelfie && lvl2.status === 'approved';
}

/**
 * Helper: Get identity verification status
 */
function getIdentityVerificationStatus(user, lvl2) {
  // If level2 is approved, identity is approved
  if (lvl2.status === 'approved') return 'approved';
  
  // If level2 is submitted/pending, identity is pending
  if (lvl2.status === 'pending' || lvl2.status === 'submitted') return 'pending';
  
  // Check if user has started identity verification
  const hasIdentityDocs = user.kyc?.identityDocuments?.length > 0;
  const hasSelfie = user.kyc?.selfiePhoto != null;
  
  if (hasIdentityDocs || hasSelfie) {
    return 'submitted';
  }
  
  return 'not_submitted';
}

module.exports = router;