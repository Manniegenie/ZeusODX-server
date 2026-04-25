// routes/referral.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Referral = require('../models/referral');
const logger = require('../utils/logger');

/**
 * GET /referral/me
 * Returns the authenticated user's referral program data.
 */
router.get('/me', async (req, res) => {
  const userId = req.user?.id;

  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  try {
    const referral = await Referral.findOne({ userId }).lean();

    if (!referral) {
      return res.status(404).json({ success: false, message: 'Referral record not found' });
    }

    return res.json({
      success: true,
      data: {
        referralCode:     referral.referralCode,
        totalReferrals:   referral.totalReferrals,
        totalConversions: referral.totalConversions,
        totalEarnings:    referral.totalEarnings,
        pendingEarnings:  referral.pendingEarnings,
        paidOutEarnings:  referral.paidOutEarnings,
        isActive:         referral.isActive,
      },
    });
  } catch (err) {
    logger.error('GET /referral/me error', { userId, error: err.message });
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
