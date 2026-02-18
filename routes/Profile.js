const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');
const mongoose = require('mongoose');
const { clearUserCaches } = require('../utils/cacheManager');

/**
 * GET /api/user/profile/complete
 * Consolidated profile endpoint - returns all profile data in a single call
 * This prevents concurrent API calls that can cause issues on real devices
 */
router.get('/complete', async (req, res) => {
  const startTime = Date.now();
  let userId = null;

  try {
    userId = req.user?.id;

    // Validate user ID from token
    if (!userId) {
      return res.status(401).json({ 
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Authentication required' 
      });
    }

    // Validate MongoDB ObjectId format
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      logger.warn('Invalid user ID format', { userId, source: 'profile-complete' });
      return res.status(400).json({ 
        success: false,
        error: 'INVALID_USER_ID',
        message: 'Invalid user ID format' 
      });
    }

    // Check database connection
    if (mongoose.connection.readyState !== 1) {
      logger.error('Database not connected', { 
        readyState: mongoose.connection.readyState,
        source: 'profile-complete' 
      });
      return res.status(503).json({ 
        success: false,
        error: 'DATABASE_ERROR',
        message: 'Database connection unavailable. Please try again.' 
      });
    }

    // Clear caches to ensure fresh data
    clearUserCaches(userId);

    // Fetch all profile data in one query
    const user = await User.findById(userId)
      .select('username firstname lastname email phonenumber is2FAEnabled avatarUrl avatarLastUpdated kycLevel kycStatus kyc')
      .lean({ virtuals: false })
      .maxTimeMS(5000);

    if (!user) {
      logger.warn('User not found', { userId, source: 'profile-complete' });
      return res.status(404).json({ 
        success: false,
        error: 'USER_NOT_FOUND',
        message: 'User not found' 
      });
    }

    // Build response data
    const fullName = [user.firstname, user.lastname].filter(Boolean).join(' ').trim() || null;
    const isKycActive = user.kycLevel > 0 && user.kycStatus === 'approved';

    const processingTime = Date.now() - startTime;
    logger.info('Profile fetched successfully', { 
      userId, 
      processingTime,
      hasKyc: user.kycLevel > 0
    });

    // Return consistent response structure
    res.json({
      success: true,
      data: {
        profile: {
          username: user.username || null,
          fullName: fullName,
          email: user.email || null,
          phoneNumber: user.phonenumber || null,
          is2FAEnabled: Boolean(user.is2FAEnabled),
          avatar: {
            url: user.avatarUrl || null,
            lastUpdated: user.avatarLastUpdated || null
          },
          kyc: {
            level: user.kycLevel || 0,
            status: user.kycStatus || 'not_verified',
            isActive: isKycActive,
            level1: user.kyc?.level1 || null,
            level2: user.kyc?.level2 || null
          }
        }
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    // Handle specific error types
    if (error.name === 'CastError') {
      logger.error('Invalid user ID format', { 
        error: error.message,
        userId,
        source: 'profile-complete',
        processingTime
      });
      return res.status(400).json({ 
        success: false,
        error: 'INVALID_USER_ID',
        message: 'Invalid user ID format' 
      });
    }

    if (error.name === 'MongoTimeoutError' || error.message?.includes('timeout')) {
      logger.error('Database query timeout', { 
        error: error.message,
        userId,
        source: 'profile-complete',
        processingTime
      });
      return res.status(504).json({ 
        success: false,
        error: 'REQUEST_TIMEOUT',
        message: 'Request timed out. Please try again.' 
      });
    }

    // Generic error handler
    logger.error('Error fetching profile', { 
      error: error.message, 
      stack: error.stack,
      userId,
      source: 'profile-complete',
      processingTime
    });
    
    res.status(500).json({ 
      success: false,
      error: 'SERVER_ERROR',
      message: 'An error occurred while fetching your profile. Please try again.' 
    });
  }
});

/**
 * GET /api/user/profile
 * Legacy endpoint for backward compatibility
 * @deprecated Use /profile/complete instead
 */
router.get('/', async (req, res) => {
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

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ 
        success: false,
        error: 'DATABASE_ERROR',
        message: 'Database connection unavailable. Please try again.' 
      });
    }

    clearUserCaches(userId);

    const user = await User.findById(userId)
      .select('username firstname lastname email phonenumber is2FAEnabled avatarUrl avatarLastUpdated')
      .lean({ virtuals: false })
      .maxTimeMS(5000);

    if (!user) {
      return res.status(404).json({ 
        success: false,
        error: 'USER_NOT_FOUND',
        message: 'User not found' 
      });
    }

    const fullName = [user.firstname, user.lastname].filter(Boolean).join(' ').trim() || null;

    res.json({
      success: true,
      profile: {
        username: user.username || null,
        fullName: fullName,
        email: user.email || null,
        phoneNumber: user.phonenumber || null,
        is2FAEnabled: Boolean(user.is2FAEnabled),
        avatar: {
          url: user.avatarUrl || null,
          lastUpdated: user.avatarLastUpdated || null
        }
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error('Error fetching profile (legacy)', { 
      error: error.message, 
      userId,
      processingTime
    });
    
    res.status(500).json({ 
      success: false,
      error: 'SERVER_ERROR',
      message: 'An error occurred while fetching your profile. Please try again.' 
    });
  }
});

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
