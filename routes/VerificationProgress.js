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

    // Build detailed progress for each track
    const fiat = buildFiatProgress(user);
    const kyc = buildKycProgress(user);

    // Calculate overall progress across all steps
    const totalSteps = fiat.total + kyc.total;
    const completedSteps = fiat.completedCount + kyc.completedCount;
    const overallPercentage = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

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
      },
      // Overall progress across all verification types
      overallProgress: {
        totalSteps: totalSteps,
        completedSteps: completedSteps,
        percentage: overallPercentage
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
 *  - bvn: BVN verified
 *  - bank_account: Bank account added
 */
function buildFiatProgress(user) {
  const activeBankAccounts = user.getActiveBankAccounts?.() || [];

  const steps = [
    {
      id: 'bvn',
      label: 'BVN verification',
      completed: !!user.bvnVerified,
      completedAt: user.bvnVerifiedAt || null,
    },
    {
      id: 'bank_account',
      label: 'Add bank account',
      completed: activeBankAccounts.length > 0,
      completedAt: activeBankAccounts.length > 0
        ? activeBankAccounts[0]?.addedAt || null
        : null,
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
 * KYC progress = 3 steps (KYC1 is auto-approved, not shown):
 *  - email: Email verification (part of KYC2)
 *  - identity: Identity verification (part of KYC2) 
 *  - address: Address verification (KYC3 only)
 */
function buildKycProgress(user) {
  const lvl2 = user.kyc?.level2 || {};
  const lvl3 = user.kyc?.level3 || {};

  // KYC2 components: Email + Identity
  const emailVerified = user.emailVerified || false;
  const identityVerified = checkIdentityVerification(user, lvl2);
  
  // KYC3 component: Address only
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
 */
function checkIdentityVerification(user, lvl2) {
  // Identity is complete if level2 is approved
  return lvl2.status === 'approved';
}

/**
 * Helper: Get identity verification status
 */
function getIdentityVerificationStatus(user, lvl2) {
  // Return the level2 status directly since identity = level2
  return lvl2.status || 'not_submitted';
}

module.exports = router;