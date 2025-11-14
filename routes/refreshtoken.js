const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');

const ACCESS_TOKEN_EXPIRES_IN = '1h';
const REFRESH_TOKEN_EXPIRES_IN = '7d';

// Generate access token helper
const generateAccessToken = (user) => {
  return jwt.sign(
    { id: user._id, email: user.email }, // Customize payload as needed
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
  );
};

// Generate refresh token helper
const generateRefreshToken = (userId) => {
  return jwt.sign(
    { id: userId },
    process.env.REFRESH_JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRES_IN }
  );
};

// POST: /auth/refresh - Refresh access and refresh tokens
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    logger.warn('Missing refreshToken during refresh');
    return res.status(400).json({
      success: false,
      message: 'Refresh token is required.'
    });
  }

  try {
    // Verify and decode refresh token to get userId
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.REFRESH_JWT_SECRET);
    } catch (err) {
      logger.warn('Invalid or expired refresh token', { reason: err.message });
      return res.status(403).json({
        success: false,
        message: 'Invalid or expired refresh token.'
      });
    }

    const userId = decoded.id;

    // Find user by userId from token
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found during refresh', { userId });
      return res.status(404).json({
        success: false,
        message: 'User not found.'
      });
    }

    // Check if refresh token exists in user's stored tokens
    const tokenIndex = user.refreshTokens.findIndex(rt => rt.token === refreshToken);
    if (tokenIndex === -1) {
      logger.warn('Unrecognized refresh token', { userId });
      return res.status(403).json({
        success: false,
        message: 'Refresh token not recognized.'
      });
    }

    // Generate new tokens
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user._id);

    // Replace old refresh token with new one and save
    user.refreshTokens[tokenIndex] = {
      token: newRefreshToken,
      createdAt: new Date(),
    };
    await user.save();

    logger.info('Tokens refreshed successfully', { userId });

    res.status(200).json({
      success: true,
      message: 'Tokens refreshed successfully.',
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (error) {
    logger.error('Token refresh error', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      success: false,
      message: 'Server error during token refresh.'
    });
  }
});

module.exports = router;
