const express = require('express');
const router = express.Router();
const User = require('../models/user');
const validator = require('validator');
const logger = require('../utils/logger');

// DELETE user by email
router.delete('/user', async (req, res) => {
  const { email } = req.body;

  if (!email || !validator.isEmail(email)) {
    logger.warn('Invalid or missing email in deleteuser request', { email });
    return res.status(400).json({ success: false, error: 'Valid email is required.' });
  }

  try {
    const deletedUser = await User.findOneAndDelete({ email });

    if (!deletedUser) {
      logger.warn(`User not found: ${email}`);
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    logger.info(`User deleted: ${email}`);
    return res.status(200).json({
      success: true,
      message: 'User deleted successfully.',
      deletedUser
    });
  } catch (error) {
    logger.error('Error deleting user', {
      error: error.message,
      stack: error.stack,
      email
    });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;