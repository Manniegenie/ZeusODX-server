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
    const kyc  = buildKycProgress(user);

    // Percent helper
    const toPercent = (completed, total) =>
      total > 0 ? Math.round((completed / total) * 100) : 0;

    return res.status(200).json({
      fiatVerification: {
        totalSteps: fiat.total,
        completedSteps: fiat.completedCount,
        percentage: toPercent(fiat.completedCount, fiat.total),

        // NEW: detailed step objects + easy list of completed IDs
        steps: fiat.steps,                 // [{ id, label, completed, completedAt }]
        completed: fiat.completedIds       // ['bank_account', 'bvn']
      },
      kycVerification: {
        totalSteps: kyc.total,
        completedSteps: kyc.completedCount,
        percentage: toPercent(kyc.completedCount, kyc.total),

        // NEW: detailed step objects + easy list of completed IDs
        steps: kyc.steps,                  // [{ id, label, completed, completedAt, status }]
        completed: kyc.completedIds        // ['level1', 'level2', ...]
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
      // Use the first active account's addedAt as completion timestamp if available
      completedAt: activeBankAccounts.length > 0
        ? activeBankAccounts[0]?.addedAt || null
        : null,
    },
    {
      id: 'bvn',
      label: 'BVN verification',
      completed: !!user.bvnVerified,
      // If you store a BVN approval timestamp, place it here instead of null
      completedAt: null,
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
 * KYC progress = 3 steps (approved statuses only count as completed):
 *  - level1 approved
 *  - level2 approved
 *  - level3 approved
 */
function buildKycProgress(user) {
  const lvl1 = user.kyc?.level1 || {};
  const lvl2 = user.kyc?.level2 || {};
  const lvl3 = user.kyc?.level3 || {};

  const steps = [
    {
      id: 'level1',
      label: 'KYC Level 1',
      status: lvl1.status || 'not_submitted',
      completed: lvl1.status === 'approved',
      completedAt: lvl1.approvedAt || null
    },
    {
      id: 'level2',
      label: 'KYC Level 2',
      status: lvl2.status || 'not_submitted',
      completed: lvl2.status === 'approved',
      completedAt: lvl2.approvedAt || null
    },
    {
      id: 'level3',
      label: 'KYC Level 3',
      status: lvl3.status || 'not_submitted',
      completed: lvl3.status === 'approved',
      completedAt: lvl3.approvedAt || null
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

module.exports = router;
