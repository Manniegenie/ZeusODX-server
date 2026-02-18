const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');
const mongoose = require('mongoose');

/**
 * POST /api/user/appsflyer-id
 * Store AppsFlyer UID for S2S tracking
 */
router.post('/appsflyer-id', async (req, res) => {
  const startTime = Date.now();
  let userId = null;

  try {
    userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Authentication required'
      });
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_USER_ID',
        message: 'Invalid user ID format'
      });
    }

    const { appsflyer_id } = req.body;

    if (!appsflyer_id || typeof appsflyer_id !== 'string' || appsflyer_id.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_INPUT',
        message: 'AppsFlyer ID is required'
      });
    }

    // Update user's AppsFlyer ID
    const user = await User.findByIdAndUpdate(
      userId,
      {
        appsflyer_id: appsflyer_id.trim(),
        appsflyer_idUpdatedAt: new Date()
      },
      { new: true, runValidators: true }
    ).select('appsflyer_id appsflyer_idUpdatedAt');

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    const processingTime = Date.now() - startTime;
    logger.info('AppsFlyer ID stored successfully', {
      userId,
      processingTime,
      appsflyer_id: appsflyer_id.substring(0, 10) + '...'
    });

    res.json({
      success: true,
      data: {
        appsflyer_id: user.appsflyer_id,
        updatedAt: user.appsflyer_idUpdatedAt
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error('Error storing AppsFlyer ID', {
      error: error.message,
      userId,
      processingTime
    });

    res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: 'An error occurred while storing AppsFlyer ID. Please try again.'
    });
  }
});

module.exports = router;
