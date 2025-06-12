const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');

// POST: /avatar - Updates user avatar (limited to once every 30 days)
router.post('/avatar', async (req, res) => {
  try {
    const { avatarUrl } = req.body;

    // Validate avatarUrl
    const isValidCloudinaryUrl = typeof avatarUrl === 'string' &&
      /^https:\/\/res\.cloudinary\.com\/[^ "]+$/i.test(avatarUrl);

    if (!isValidCloudinaryUrl) {
      logger.warn('Invalid avatar URL format', { avatarUrl });
      return res.status(400).json({ message: 'Invalid avatar URL. Must be a Cloudinary HTTPS URL.' });
    }

    // Ensure user is authenticated
    const userId = req.user?.id;
    if (!userId) {
      logger.warn('Unauthorized access attempt to update avatar');
      return res.status(401).json({ message: 'Unauthorized. User not authenticated.' });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found while updating avatar', { userId });
      return res.status(404).json({ message: 'User not found.' });
    }

    // Check if avatar was updated in the past 30 days
    const now = new Date();
    if (user.avatarLastUpdated) {
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      if (user.avatarLastUpdated > thirtyDaysAgo) {
        const nextAllowed = new Date(user.avatarLastUpdated.getTime() + 30 * 24 * 60 * 60 * 1000);
        logger.warn('Avatar update blocked: limit reached', { userId, avatarLastUpdated: user.avatarLastUpdated });
        return res.status(429).json({
          message: 'Avatar can only be updated once every 30 days.',
          nextAllowed: nextAllowed.toISOString()
        });
      }
    }

    // Update avatar and timestamp
    user.avatarUrl = avatarUrl;
    user.avatarLastUpdated = now;
    await user.save();

    logger.info('Avatar updated successfully', { userId, avatarUrl });

    return res.status(200).json({
      message: 'Avatar updated successfully.',
      avatarUrl: user.avatarUrl
    });

  } catch (error) {
    logger.error('Error updating avatar', { error: error.message, stack: error.stack });
    return res.status(500).json({ message: 'Internal server error.' });
  }
});

module.exports = router;
