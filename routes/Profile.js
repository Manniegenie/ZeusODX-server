const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');

// GET: /api/user/profile - Get user profile information
router.get('/profile', async (req, res) => {
  try {
    const userId = req.user.id; // From global JWT middleware

    if (!userId) {
      logger.warn('No user ID found in token', { source: 'get-profile' });
      return res.status(400).json({ message: 'Invalid token payload' });
    }

    // Fetch user from database with only required fields
    const user = await User.findById(userId).select(
      'username firstname lastname email phonenumber avatarUrl avatarLastUpdated'
    );

    if (!user) {
      logger.warn('User not found', { userId, source: 'get-profile' });
      return res.status(404).json({ message: 'User not found' });
    }

    logger.info('Profile fetched successfully', { 
      userId, 
      username: user.username,
      email: user.email,
      source: 'get-profile' 
    });

    // Return profile information
    res.json({
      success: true,
      profile: {
        username: user.username || null,
        fullName: user.fullName, // This uses the virtual from the schema
        email: user.email,
        phoneNumber: user.phonenumber || null,
        avatar: {
          url: user.avatarUrl || null,
          lastUpdated: user.avatarLastUpdated || null
        }
      }
    });

  } catch (error) {
    logger.error('Error fetching user profile', { 
      error: error.message, 
      stack: error.stack,
      userId: req.user?.id,
      source: 'get-profile' 
    });
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;