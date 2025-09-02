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

    const fiatTotal = 2;
    const kycTotal = 3;

    const fiatSteps = calculateFiatSteps(user);
    const kycSteps = calculateKycSteps(user);

    const toPercent = (completed, total) =>
      Math.round((completed / total) * 100);

    return res.status(200).json({
      fiatVerification: {
        totalSteps: fiatTotal,
        completedSteps: fiatSteps,
        percentage: toPercent(fiatSteps, fiatTotal)
      },
      kycVerification: {
        totalSteps: kycTotal,
        completedSteps: kycSteps,
        percentage: toPercent(kycSteps, kycTotal)
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

function calculateFiatSteps(user) {
  let completedSteps = 0;

  const activeBankAccounts = user.getActiveBankAccounts?.() || [];
  if (activeBankAccounts.length > 0) completedSteps++;

  if (user.bvnVerified) completedSteps++;

  return completedSteps;
}

function calculateKycSteps(user) {
  let completedSteps = 0;

  if (user.kyc?.level1?.status === 'approved') {
    completedSteps++;
    if (user.kyc?.level2?.status === 'approved') {
      completedSteps++;
      if (user.kyc?.level3?.status === 'approved') {
        completedSteps++;
      }
    }
  }

  return completedSteps;
}

module.exports = router;
