const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');
// Removed bcrypt import - let the model handle hashing

// POST: /api/admin/password-pin
router.post('/pin', async (req, res) => {
  const { newPin, renewPin } = req.body;
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  if (!newPin || !renewPin) {
    logger.warn('Missing required fields', { userId, source: 'password-pin' });
    return res.status(400).json({ message: 'Fields newPin and renewPin are required' });
  }

  if (newPin !== renewPin) {
    logger.warn('PIN mismatch', { userId, source: 'password-pin' });
    return res.status(400).json({ message: 'PINs do not match' });
  }

  if (!/^\d{6}$/.test(newPin)) {
    logger.warn('Invalid PIN format', { userId, source: 'password-pin' });
    return res.status(400).json({ message: 'Password PIN must be exactly 6 digits' });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found', { userId, source: 'password-pin' });
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.passwordpin) {
      logger.warn('PIN already exists', { userId, source: 'password-pin' });
      return res.status(409).json({ message: 'Password PIN already exists' });
    }

    logger.info('Creating password PIN', {
      userId,
      username: user.username,
      pinLength: newPin.length,
      source: 'password-pin'
    });

    // FIXED: Set the plaintext PIN - let the model's pre-save hook handle hashing
    user.passwordpin = newPin; // Don't hash here, model will hash it automatically
    await user.save();

    logger.info('Password PIN created successfully', { 
      userId, 
      username: user.username,
      source: 'password-pin',
      originalPinLength: newPin.length,
      finalHashLength: user.passwordpin.length, // Shows hashed length after save
      hashCreated: user.passwordpin.startsWith('$2') // Confirms it was hashed
    });
    
    res.status(201).json({ 
      message: 'Password PIN created successfully'
    });

  } catch (error) {
    logger.error('Error creating password PIN', { 
      error: error.message, 
      stack: error.stack,
      userId, 
      source: 'password-pin' 
    });
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;