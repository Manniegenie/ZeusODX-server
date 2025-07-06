const express = require('express');
const router = express.Router();
const PendingUser = require('../models/pendinguser');
const User = require('../models/user'); // Added User model import
const { sendVerificationCode } = require('../utils/verifyAT');
const logger = require('../utils/logger');
const validator = require('validator');

// Generate numeric OTP
function generateOTP(length = 6) {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) {
    otp += digits[Math.floor(Math.random() * digits.length)];
  }
  return otp;
}

// Sanitize input
function sanitizeInput(input) {
  return validator.stripLow(validator.escape(input.trim()));
}

// POST: /add-user
router.post('/add-user', async (req, res) => {
  let { email, firstname, lastname, phonenumber } = req.body;

  // Validate presence
  if (!email || !firstname || !lastname || !phonenumber) {
    logger.warn('Missing required fields', { body: req.body });
    return res.status(400).json({ message: 'Please fill all required fields.' });
  }

  // Sanitize inputs
  email = sanitizeInput(email.toLowerCase());
  firstname = sanitizeInput(firstname);
  lastname = sanitizeInput(lastname);
  phonenumber = sanitizeInput(phonenumber);

  // Validate formats
  if (!validator.isEmail(email)) {
    return res.status(400).json({ message: 'Invalid email address.' });
  }

  if (!/^\+?\d{10,15}$/.test(phonenumber)) {
    return res.status(400).json({ message: 'Invalid phone number. Use format like +2348100000000.' });
  }

  try {
    // Normalize phone number for SMS (remove + if present)
    const normalizedPhone = phonenumber.startsWith('+') ? phonenumber.slice(1) : phonenumber;

    // Check if user already exists in main User database
    const existingMainUser = await User.findOne({
      $or: [{ email }, { phonenumber }]
    });

    if (existingMainUser) {
      logger.info('User already exists in main database', { 
        email: email.slice(0, 3) + '****',
        phonenumber: phonenumber.slice(0, 5) + '****'
      });
      return res.status(409).json({ message: 'User already Exists' });
    }

    // Check if user already exists in pending users
    const existingPendingUser = await PendingUser.findOne({
      $or: [{ email }, { phonenumber }]
    });

    if (existingPendingUser) {
      logger.info('User already exists in pending database', { 
        email: email.slice(0, 3) + '****',
        phonenumber: phonenumber.slice(0, 5) + '****'
      });
      return res.status(409).json({ message: 'Phone or already Exists' });
    }

    // Generate OTP and expiration
    const otp = generateOTP();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 5 * 60 * 1000); // expires in 5 mins

    // Send OTP via Africa's Talking
    const sendResult = await sendVerificationCode(normalizedPhone, otp);
    if (!sendResult.success) {
      logger.error('Failed to send OTP', { phone: normalizedPhone, error: sendResult.error });
      return res.status(500).json({ message: 'Failed to send verification code.' });
    }

    // Save pending user
    const pendingUser = new PendingUser({
      email,
      firstname,
      lastname,
      phonenumber, // Store original format
      verificationCode: otp,
      verificationCodeCreatedAt: createdAt,
      verificationCodeExpiresAt: expiresAt
    });

    await pendingUser.save();
    logger.info('Pending user created and OTP sent', { email, phonenumber });

    res.status(201).json({
      message: 'User created successfully. Verification code sent.',
      user: {
        email,
        phonenumber
      }
    });

  } catch (err) {
    logger.error('Signup error', {
      error: err.message,
      phonenumber: phonenumber?.slice(0, 5) + '****',
      stack: err.stack
    });
    res.status(500).json({ message: 'Server error while creating user.' });
  }
});

module.exports = router;