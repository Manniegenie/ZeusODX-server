const express = require('express');
const router = express.Router();
const User = require('../models/user.js');
const logger = require('../utils/logger');

// Utility function to validate username
const isValidUsername = (username) => {
  const maxLength = 15;
  const usernameRegex = /^(?=.{1,15}$)[a-zA-Z][a-zA-Z0-9]*(?:[._]?[a-zA-Z0-9]+)*$/;

  // Disallow double dots or double underscores, and trailing/leading dot or underscore
  const hasInvalidPattern = /[._]{2,}|^[._]|[._]$/.test(username);

  return username.length <= maxLength &&
         usernameRegex.test(username) &&
         !hasInvalidPattern;
};

router.post('/update-username', async (req, res) => {
  const userId = req.user?.id; // Extracted from JWT middleware
  const { username } = req.body;

  if (!userId || !username) {
    logger.warn('Input validation failed', { errors: 'Missing userId (JWT) or username' });
    return res.status(400).json({ message: "Username is required." });
  }

  if (!isValidUsername(username)) {
    logger.warn('Invalid username format', { username });
    return res.status(400).json({
      message: "Invalid username. Only letters, numbers, underscores, and periods allowed. Max 15 characters. No emojis or special characters.",
    });
  }

  try {
    const usernameExists = await User.findOne({ username });
    if (usernameExists && usernameExists._id.toString() !== userId) {
      logger.info('Username already in use', { username });
      return res.status(409).json({ message: "Username already taken." });
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { username },
      { new: true }
    );

    if (!updatedUser) {
      logger.warn('User not found', { userId });
      return res.status(404).json({ message: "User not found." });
    }

    // Clear all user caches to ensure profile data is fresh
    const { clearUserCaches } = require('../utils/cacheManager');
    clearUserCaches(userId);

    logger.info('Username updated successfully', { userId, newUsername: username });
    res.status(200).json({ message: "Username updated successfully.", user: updatedUser });
  } catch (error) {
    logger.error('Error updating username', { error: error.message });
    res.status(500).json({ message: "Server error while updating username." });
  }
});

module.exports = router;
