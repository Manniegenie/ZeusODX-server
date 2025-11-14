const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');
const mongoose = require('mongoose');

// GET: /api/user/profile - Get user profile information
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

    // Fetch user from database with required fields
    // Use lean() for better performance and add timeout
    const user = await User.findById(userId)
      .select('username firstname lastname email phonenumber is2FAEnabled avatarUrl avatarLastUpdated')
      .lean()
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
