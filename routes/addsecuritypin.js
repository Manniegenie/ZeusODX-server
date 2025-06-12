const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');
const bcrypt = require('bcryptjs');

// POST: /api/admin/add-pin
router.post('/add-pin', async (req, res) => {
  const { phoneNumber, pinType, newPin, renewPin } = req.body;

  if (!phoneNumber || !pinType || !newPin || !renewPin) {
    logger.warn('Missing required fields', { phoneNumber, pinType, source: 'add-pin' });
    return res.status(400).json({ message: 'Fields phoneNumber, pinType, newPin, and renewPin are required.' });
  }

  if (!['passwordpin', 'transactionpin'].includes(pinType)) {
    logger.warn('Invalid pinType', { pinType, source: 'add-pin' });
    return res.status(400).json({ message: 'Invalid pinType. Must be "passwordpin" or "transactionpin".' });
  }

  if (newPin !== renewPin) {
    logger.warn('PIN mismatch', { phoneNumber, source: 'add-pin' });
    return res.status(400).json({ message: 'PINs do not match.' });
  }

  if (pinType === 'passwordpin' && !/^\d{6}$/.test(newPin)) {
    logger.warn('Invalid password PIN format', { phoneNumber, source: 'add-pin' });
    return res.status(400).json({ message: 'Password PIN must be exactly 6 digits.' });
  }

  if (pinType === 'transactionpin' && !/^\d{4}$/.test(newPin)) {
    logger.warn('Invalid transaction PIN format', { phoneNumber, source: 'add-pin' });
    return res.status(400).json({ message: 'Transaction PIN must be exactly 4 digits.' });
  }

  try {
    const user = await User.findOne({ phonenumber: phoneNumber });
    if (!user) {
      logger.warn('User not found', { phoneNumber, source: 'add-pin' });
      return res.status(404).json({ message: 'User not found.' });
    }

    if (user[pinType]) {
      logger.warn('PIN already exists', { phoneNumber, pinType, source: 'add-pin' });
      return res.status(409).json({ message: `${pinType} already exists. Use /update-pin to modify.` });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPin = await bcrypt.hash(newPin, salt);
    user[pinType] = hashedPin;
    await user.save();

    logger.info('PIN added successfully', { phoneNumber, pinType, source: 'add-pin' });
    res.status(201).json({ message: `${pinType} created successfully.` });

  } catch (error) {
    logger.error('Error adding PIN', { error: error.stack || error.message, phoneNumber, source: 'add-pin' });
    res.status(500).json({ message: 'Server error while creating PIN.' });
  }
});

module.exports = router;
