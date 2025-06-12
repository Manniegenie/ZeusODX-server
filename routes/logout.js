const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const User = require('../models/user'); // ✅ Your model path
const logger = require('../utils/logger'); // ✅ Import your logger

// POST: /logout - Logs out a user by removing a refresh token
router.post('/logout', async (req, res) => {
  const { userId, refreshToken } = req.body;

  if (!userId || !refreshToken) {
    logger.warn('Logout attempt with missing fields', { userId, refreshToken });
    return res.status(400).json({ message: 'userId and refreshToken are required.' });
  }

  try {
    // Find user
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('Logout failed: User not found', { userId });
      return res.status(404).json({ message: 'User not found.' });
    }

    // Remove the provided refresh token
    const tokensBefore = user.refreshTokens.length;
    user.refreshTokens = user.refreshTokens.filter(
      (rt) => rt.token !== refreshToken
    );

    // Only save if token was actually removed
    if (user.refreshTokens.length < tokensBefore) {
      await user.save();
      logger.info('User logged out successfully', { userId });
    } else {
      logger.warn('Logout token not found in user record', { userId, refreshToken });
    }

    res.status(200).json({ message: 'Logged out successfully.' });
  } catch (error) {
    logger.error('Error during logout', { userId, error: error.message, stack: error.stack });
    res.status(500).json({ message: 'Server error during logout.' });
  }
});

module.exports = router;
