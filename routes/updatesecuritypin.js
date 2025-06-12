const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/user');
const logger = require('../utils/logger');
const bcrypt = require('bcryptjs');

// POST: /api/admin/update-pin
router.post('/update-pin', async (req, res) => {
  const { userId, pinType, newPin, renewPin } = req.body;

  if (!userId || !pinType || !newPin || !renewPin) {
    logger.warn('Missing required fields', { userId, pinType, source: 'update-pin' });
    return res.status(400).json({ message: 'All fields (userId, pinType, newPin, renewPin) are required.' });
  }

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    logger.warn('Invalid userId format', { userId, source: 'update-pin' });
    return res.status(400).json({ message: 'Invalid userId format.' });
  }

  if (!['passwordpin', 'transactionpin'].includes(pinType)) {
    logger.warn('Invalid pinType', { pinType, source: 'update-pin' });
    return res.status(400).json({ message: 'Invalid pinType. Must be "passwordpin" or "transactionpin".' });
  }

  if (newPin !== renewPin) {
    logger.warn('PIN mismatch', { userId, source: 'update-pin' });
    return res.status(400).json({ message: 'PINs do not match.' });
  }

  if (pinType === 'passwordpin' && !/^\d{6}$/.test(newPin)) {
    logger.warn('Invalid password PIN format', { userId, source: 'update-pin' });
    return res.status(400).json({ message: 'Password PIN must be exactly 6 digits.' });
  }

  if (pinType === 'transactionpin' && !/^\d{4}$/.test(newPin)) {
    logger.warn('Invalid transaction PIN format', { userId, source: 'update-pin' });
    return res.status(400).json({ message: 'Transaction PIN must be exactly 4 digits.' });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found', { userId, source: 'update-pin' });
      return res.status(404).json({ message: 'User not found.' });
    }

    if (!user[pinType]) {
      logger.warn('No existing pin to update', { userId, pinType, source: 'update-pin' });
      return res.status(409).json({ message: `No existing ${pinType} to update.` });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPin = await bcrypt.hash(newPin, salt);
    user[pinType] = hashedPin;
    await user.save();

    logger.info('PIN updated successfully', { userId, pinType, source: 'update-pin' });
    res.status(200).json({ message: `${pinType} updated successfully.` });

  } catch (error) {
    logger.error('Error updating PIN', { error: error.stack || error.message, userId, source: 'update-pin' });
    res.status(500).json({ message: 'Server error while updating PIN.' });
  }
});

module.exports = router;
