const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');
const bcrypt = require('bcryptjs');

// POST: /api/admin/transaction-pin
router.post('/pin', async (req, res) => {
  const { newPin, renewPin } = req.body;
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  if (!newPin || !renewPin) {
    logger.warn('Missing required fields', { userId, source: 'transaction-pin' });
    return res.status(400).json({ message: 'Fields newPin and renewPin are required' });
  }

  if (newPin !== renewPin) {
    logger.warn('PIN mismatch', { userId, source: 'transaction-pin' });
    return res.status(400).json({ message: 'PINs do not match' });
  }

  if (!/^\d{4}$/.test(newPin)) {
    logger.warn('Invalid PIN format', { userId, source: 'transaction-pin' });
    return res.status(400).json({ message: 'Transaction PIN must be exactly 4 digits' });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found', { userId, source: 'transaction-pin' });
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.transactionpin) {
      logger.warn('PIN already exists', { userId, source: 'transaction-pin' });
      return res.status(409).json({ message: 'Transaction PIN already exists' });
    }

    const hashedPin = await bcrypt.hash(newPin, 10);
    user.transactionpin = hashedPin;
    await user.save();

    logger.info('Transaction PIN created', { userId, source: 'transaction-pin' });
    res.status(201).json({ message: 'Transaction PIN created successfully' });

  } catch (error) {
    logger.error('Error creating transaction PIN', { 
      error: error.message, 
      userId, 
      source: 'transaction-pin' 
    });
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;