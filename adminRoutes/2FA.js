const express = require('express');
const router = express.Router();
const User = require('../models/user');
const validator = require('validator');
const logger = require('../utils/logger');

// PATCH disable 2FA by email
router.patch('/disable-2fa', async (req, res) => {
  const { email } = req.body;

  if (!email || !validator.isEmail(email)) {
    logger.warn('Invalid or missing email in disable-2fa request', { email });
    return res.status(400).json({ success: false, error: 'Valid email is required.' });
  }

  try {
    const user = await User.findOne({ email });

    if (!user) {
      logger.warn(`User not found for 2FA disable: ${email}`);
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    // Check if user has 2FA enabled
    if (!user.is2FAEnabled && !user.twoFASecret) {
      logger.warn(`2FA disable attempted but not enabled: ${email}`);
      return res.status(400).json({ 
        success: false, 
        error: '2FA is not enabled for this user.',
        user: {
          email: user.email,
          is2FAEnabled: user.is2FAEnabled
        }
      });
    }

    const updatedUser = await User.findOneAndUpdate(
      { email },
      { 
        is2FAEnabled: false,
        is2FAVerified: false,
        twoFASecret: null
      },
      { 
        new: true,
        runValidators: true
      }
    );

    logger.info(`2FA disabled for user: ${email}`, {
      userId: updatedUser._id,
      previousStatus: {
        is2FAEnabled: user.is2FAEnabled,
        is2FAVerified: user.is2FAVerified
      },
      newStatus: {
        is2FAEnabled: updatedUser.is2FAEnabled,
        is2FAVerified: updatedUser.is2FAVerified
      }
    });

    return res.status(200).json({
      success: true,
      message: '2FA disabled successfully.',
      user: {
        id: updatedUser._id,
        email: updatedUser.email,
        is2FAEnabled: updatedUser.is2FAEnabled,
        is2FAVerified: updatedUser.is2FAVerified
      }
    });

  } catch (error) {
    logger.error('Error disabling 2FA', {
      error: error.message,
      stack: error.stack,
      email
    });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;