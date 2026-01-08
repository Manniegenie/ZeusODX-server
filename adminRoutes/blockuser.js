const express = require('express');
const router = express.Router();
const User = require('../models/user');
const validator = require('validator');
const logger = require('../utils/logger');

// POST: Block a user
router.post('/block', async (req, res) => {
  const { email, reason } = req.body;

  if (!email || !validator.isEmail(email)) {
    logger.warn('Invalid or missing email in block user request', { email });
    return res.status(400).json({ success: false, error: 'Valid email is required.' });
  }

  try {
    const user = await User.findOne({ email });

    if (!user) {
      logger.warn(`User not found for blocking: ${email}`);
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    if (user.isBlocked) {
      logger.warn(`User already blocked: ${email}`);
      return res.status(400).json({
        success: false,
        error: 'User is already blocked.',
        user: {
          email: user.email,
          isBlocked: user.isBlocked,
          blockReason: user.blockReason,
          blockedAt: user.blockedAt
        }
      });
    }

    const blockReason = reason || 'Account blocked by administrator';
    const now = new Date();

    const updatedUser = await User.findOneAndUpdate(
      { email },
      {
        $set: {
          isBlocked: true,
          blockReason: blockReason,
          blockedAt: now
        }
      },
      {
        new: true,
        runValidators: true
      }
    );

    logger.info(`User blocked: ${email}`, {
      userId: updatedUser._id,
      reason: blockReason,
      blockedAt: now
    });

    return res.status(200).json({
      success: true,
      message: 'User blocked successfully.',
      user: {
        id: updatedUser._id,
        email: updatedUser.email,
        isBlocked: updatedUser.isBlocked,
        blockReason: updatedUser.blockReason,
        blockedAt: updatedUser.blockedAt
      }
    });

  } catch (error) {
    logger.error('Error blocking user', {
      error: error.message,
      stack: error.stack,
      email
    });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// POST: Unblock a user
router.post('/unblock', async (req, res) => {
  const { email } = req.body;

  if (!email || !validator.isEmail(email)) {
    logger.warn('Invalid or missing email in unblock user request', { email });
    return res.status(400).json({ success: false, error: 'Valid email is required.' });
  }

  try {
    const user = await User.findOne({ email });

    if (!user) {
      logger.warn(`User not found for unblocking: ${email}`);
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    if (!user.isBlocked) {
      logger.warn(`User not blocked: ${email}`);
      return res.status(400).json({
        success: false,
        error: 'User is not blocked.',
        user: {
          email: user.email,
          isBlocked: user.isBlocked
        }
      });
    }

    const updatedUser = await User.findOneAndUpdate(
      { email },
      {
        $set: {
          isBlocked: false,
          blockReason: null,
          unblockedAt: new Date()
        }
      },
      {
        new: true,
        runValidators: true
      }
    );

    logger.info(`User unblocked: ${email}`, {
      userId: updatedUser._id,
      previousReason: user.blockReason
    });

    return res.status(200).json({
      success: true,
      message: 'User unblocked successfully.',
      user: {
        id: updatedUser._id,
        email: updatedUser.email,
        isBlocked: updatedUser.isBlocked,
        unblockedAt: updatedUser.unblockedAt
      }
    });

  } catch (error) {
    logger.error('Error unblocking user', {
      error: error.message,
      stack: error.stack,
      email
    });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// GET: Check if user is blocked
router.get('/check', async (req, res) => {
  const { email } = req.query;

  if (!email || !validator.isEmail(email)) {
    return res.status(400).json({ success: false, error: 'Valid email is required.' });
  }

  try {
    const user = await User.findOne({ email }).select('email isBlocked blockReason blockedAt');

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    return res.status(200).json({
      success: true,
      user: {
        email: user.email,
        isBlocked: user.isBlocked || false,
        blockReason: user.blockReason,
        blockedAt: user.blockedAt
      }
    });

  } catch (error) {
    logger.error('Error checking user block status', {
      error: error.message,
      email
    });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;
