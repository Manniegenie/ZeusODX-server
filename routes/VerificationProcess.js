/**
 * VerificationProcess - Bramp-style verification status (Youverify flow).
 * GET /status - Returns fiat and KYC verification completion counts.
 */
const express = require('express');
const User = require('../models/user');
const router = express.Router();

function calculateFiatSteps(user) {
  let completedSteps = 0;
  const activeBankAccounts = user.getActiveBankAccounts?.() || [];
  if (activeBankAccounts.length > 0) completedSteps++;
  if (user.bvnVerified) completedSteps++;
  return completedSteps;
}

function calculateKycSteps(user) {
  let completedSteps = 0;
  if (user.kyc?.level1?.status === 'approved' || user.kyc?.level1?.phoneVerified) {
    completedSteps++;
    if (user.kyc?.level2?.status === 'approved' || (user.kyc?.level2?.documentSubmitted && user.kyc?.level2?.status === 'approved')) {
      completedSteps++;
      if (user.kyc?.level3?.status === 'approved') completedSteps++;
    }
  }
  return completedSteps;
}

router.get('/status', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const fiatSteps = calculateFiatSteps(user);
    const kycSteps = calculateKycSteps(user);

    return res.status(200).json({
      fiatVerification: { totalSteps: 2, completedSteps: fiatSteps },
      kycVerification: { totalSteps: 3, completedSteps: kycSteps }
    });
  } catch (error) {
    console.error('Error fetching verification status:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
