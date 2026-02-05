/**
 * VerificationLevel - Bramp-style tier/KYC details (Youverify flow).
 * GET /tier - Fetch user tier/KYC details for frontend.
 */
const express = require('express');
const User = require('../models/user');
const router = express.Router();

router.get('/tier', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const user = await User.findById(userId).select('kycLevel kyc email emailVerified');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const mapKycStatus = (status) => {
      switch (status) {
        case 'approved':
          return 'verified';
        case 'pending':
        case 'under_review':
          return 'pending';
        case 'not_submitted':
        case 'rejected':
        default:
          return 'unverified';
      }
    };

    let tierLevel = '1';
    if (user.kyc?.level3?.status === 'approved') {
      tierLevel = '3';
    } else if (user.kyc?.level2?.status === 'approved' || (user.kyc?.level2?.documentSubmitted && user.kyc?.level2?.status === 'approved')) {
      tierLevel = '2';
    }

    const emailVerification = user.emailVerified ? 'verified' : 'unverified';
    const documentUpload = mapKycStatus(user.kyc?.level2?.status || 'not_submitted');
    const addressVerification = user.kyc?.level3 ? mapKycStatus(user.kyc.level3.status) : 'unverified';

    const tierDetails = {
      tierLevel,
      emailVerification,
      documentUpload,
      addressVerification
    };

    res.status(200).json({ success: true, data: tierDetails });
  } catch (error) {
    console.error('Error fetching tier details:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;
