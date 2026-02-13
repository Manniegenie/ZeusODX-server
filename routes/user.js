const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');
const mongoose = require('mongoose');

/**
 * POST /api/user/appsflyer-id
 * Store AppsFlyer UID for a user
 * This is CRITICAL for backend S2S tracking
 */
router.post('/appsflyer-id', async (req, res) => {
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
      logger.warn('Invalid user ID format', { userId, source: 'appsflyer-id' });
      return res.status(400).json({ 
        success: false,
        error: 'INVALID_USER_ID',
        message: 'Invalid user ID format' 
      });
    }

    // Validate AppsFlyer ID from request body
    const { appsflyer_id } = req.body;
    
    if (!appsflyer_id || typeof appsflyer_id !== 'string' || appsflyer_id.trim().length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'INVALID_INPUT',
        message: 'AppsFlyer ID is required and must be a non-empty string' 
      });
    }

    // Check database connection
    if (mongoose.connection.readyState !== 1) {
      logger.error('Database not connected', { 
        readyState: mongoose.connection.readyState,
        source: 'appsflyer-id' 
      });
      return res.status(503).json({ 
        success: false,
        error: 'DATABASE_ERROR',
        message: 'Database connection unavailable. Please try again.' 
      });
    }

    // Update user with AppsFlyer ID
    const user = await User.findByIdAndUpdate(
      userId,
      { 
        appsflyer_id: appsflyer_id.trim(),
        appsflyer_idUpdatedAt: new Date()
      },
      { 
        new: true,
        runValidators: true 
      }
    ).select('appsflyer_id appsflyer_idUpdatedAt').lean();

    if (!user) {
      logger.warn('User not found', { userId, source: 'appsflyer-id' });
      return res.status(404).json({ 
        success: false,
        error: 'USER_NOT_FOUND',
        message: 'User not found' 
      });
    }

    const processingTime = Date.now() - startTime;
    logger.info('AppsFlyer ID stored successfully', { 
      userId, 
      appsflyer_id: appsflyer_id.trim(),
      processingTime,
      source: 'appsflyer-id'
    });

    // Return success response
    res.json({
      success: true,
      message: 'AppsFlyer ID stored successfully',
      data: {
        appsflyer_id: user.appsflyer_id,
        updatedAt: user.appsflyer_idUpdatedAt
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    // Handle specific error types
    if (error.name === 'CastError') {
      logger.error('Invalid user ID format', { 
        error: error.message,
        userId,
        source: 'appsflyer-id',
        processingTime
      });
      return res.status(400).json({ 
        success: false,
        error: 'INVALID_USER_ID',
        message: 'Invalid user ID format' 
      });
    }

    if (error.name === 'ValidationError') {
      logger.error('Validation error', { 
        error: error.message,
        userId,
        source: 'appsflyer-id',
        processingTime
      });
      return res.status(400).json({ 
        success: false,
        error: 'VALIDATION_ERROR',
        message: error.message 
      });
    }

    if (error.name === 'MongoTimeoutError' || error.message?.includes('timeout')) {
      logger.error('Database query timeout', { 
        error: error.message,
        userId,
        source: 'appsflyer-id',
        processingTime
      });
      return res.status(504).json({ 
        success: false,
        error: 'REQUEST_TIMEOUT',
        message: 'Request timed out. Please try again.' 
      });
    }

    // Generic error handler
    logger.error('Error storing AppsFlyer ID', { 
      error: error.message, 
      stack: error.stack,
      userId,
      source: 'appsflyer-id',
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
