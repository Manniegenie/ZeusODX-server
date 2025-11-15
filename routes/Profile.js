const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');
const mongoose = require('mongoose');
const { clearUserCaches } = require('../utils/cacheManager');

// GET: /api/user/profile/complete - Consolidated profile endpoint (returns all profile data in one call)
// This prevents concurrent API calls that can cause issues on real devices
router.get('/profile/complete', async (req, res) => {
  const startTime = Date.now();
  let userId = null;

  try {
    userId = req.user?.id;

    if (!userId) {
      return res.status(400).json({ 
        success: false,
        error: 'INVALID_TOKEN',
        message: 'Invalid token payload' 
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

    // Clear caches to ensure fresh data
    clearUserCaches(userId);

    // Fetch all profile data in one query
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

    const processingTime = Date.now() - startTime;
    logger.info('Complete profile fetched successfully', { userId, processingTime });

    // Return all profile data in one response
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
          }
        }
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error('Error fetching complete profile', { 
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

// GET: /api/user/profile - Get user profile information (backward compatibility)
router.get('/profile', async (req, res) => {
  const startTime = Date.now();
  let userId = null;

  try {
    userId = req.user?.id; // From global JWT middleware

    // Validate user ID exists in token
    if (!userId) {
      logger.warn('No user ID found in token', { 
        source: 'get-profile',
        hasUser: !!req.user,
        userObject: req.user
      });
      return res.status(400).json({ 
        success: false,
        error: 'INVALID_TOKEN',
        message: 'Invalid token payload' 
      });
    }

    // Validate MongoDB ObjectId format
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      logger.warn('Invalid user ID format', { userId, source: 'get-profile' });
      return res.status(400).json({ 
        success: false,
        error: 'INVALID_USER_ID',
        message: 'Invalid user ID format' 
      });
    }

    // Check database connection before querying
    if (mongoose.connection.readyState !== 1) {
      logger.error('Database not connected', { 
        readyState: mongoose.connection.readyState,
        source: 'get-profile' 
      });
      return res.status(503).json({ 
        success: false,
        error: 'DATABASE_ERROR',
        message: 'Database connection unavailable. Please try again.' 
      });
    }

    // Clear any cached user data to ensure fresh profile data
    // This prevents stale data from other routes' caches (airtime, data, cabletv, etc.)
    clearUserCaches(userId);

    // Fetch user from database with required fields
    // Use lean() for better performance (returns plain JS object, not Mongoose document)
    // This ensures we get fresh data from the database, not from Mongoose's internal cache
    // The lean() method bypasses Mongoose document caching
    const user = await User.findById(userId)
      .select('username firstname lastname email phonenumber is2FAEnabled avatarUrl avatarLastUpdated')
      .lean({ virtuals: false }) // Explicitly disable virtuals to ensure consistency
      .maxTimeMS(5000); // 5 second timeout

    if (!user) {
      logger.warn('User not found in database', { 
        userId, 
        source: 'get-profile',
        timestamp: new Date().toISOString()
      });
      return res.status(404).json({ 
        success: false,
        error: 'USER_NOT_FOUND',
        message: 'User not found' 
      });
    }

    // Validate essential fields exist
    if (!user.email && !user.username) {
      logger.warn('User missing essential fields', { 
        userId, 
        hasEmail: !!user.email,
        hasUsername: !!user.username,
        source: 'get-profile' 
      });
    }

    const processingTime = Date.now() - startTime;
    logger.info('Profile fetched successfully', { 
      userId, 
      username: user.username,
      email: user.email,
      processingTime,
      source: 'get-profile' 
    });

    // Calculate fullName (handle both virtual and manual calculation)
    const fullName = user.fullName || 
      [user.firstname, user.lastname].filter(Boolean).join(' ').trim() || 
      null;

    // Return profile information with consistent structure
    // Maintain backward compatibility with existing frontend
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
    
    // Handle specific error types
    if (error.name === 'CastError') {
      logger.error('Invalid user ID format in query', { 
        error: error.message,
        userId,
        source: 'get-profile',
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
        source: 'get-profile',
        processingTime
      });
      return res.status(504).json({ 
        success: false,
        error: 'REQUEST_TIMEOUT',
        message: 'Request timed out. Please try again.' 
      });
    }

    if (error.name === 'MongoNetworkError' || error.message?.includes('connection')) {
      logger.error('Database connection error', { 
        error: error.message,
        userId,
        source: 'get-profile',
        processingTime
      });
      return res.status(503).json({ 
        success: false,
        error: 'DATABASE_ERROR',
        message: 'Database connection error. Please try again.' 
      });
    }

    // Generic error handler
    logger.error('Error fetching user profile', { 
      error: error.message, 
      stack: error.stack,
      userId: userId || req.user?.id,
      source: 'get-profile',
      processingTime
    });
    
    res.status(500).json({ 
      success: false,
      error: 'SERVER_ERROR',
      message: 'An error occurred while fetching your profile. Please try again.' 
    });
  }
});

module.exports = router;
