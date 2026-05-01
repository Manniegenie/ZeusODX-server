const express = require('express');
const router = express.Router();
const PendingUser = require('../models/pendinguser');
const User = require('../models/user');
const Referral = require('../models/referral');
const { sendVerificationCode } = require('../utils/verifyAT');
const { sendEmailVerificationOTP } = require('../services/EmailService');
const { sendBrevoSMS } = require('../services/BrevoSMSService');
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

// Sanitize name - only allow letters, spaces, hyphens, apostrophes
function sanitizeName(name) {
  return name.replace(/[^a-zA-Z\s\-']/g, '').trim().slice(0, 50);
}

// Validate name format
function isValidName(name) {
  return name.length >= 2 && name.length <= 50 && /^[a-zA-Z\s\-']+$/.test(name);
}

// Normalize Nigerian phone - SAME logic used everywhere
function normalizeNigerianPhone(phone) {
  let cleaned = phone.replace(/[^\d+]/g, '');

  // +234070xxxxxxxx -> +23470xxxxxxxx
  if (cleaned.startsWith('+2340')) {
    cleaned = '+234' + cleaned.slice(5);
  }

  // 234070xxxxxxxx -> +23470xxxxxxxx
  if (cleaned.startsWith('2340') && !cleaned.startsWith('+')) {
    cleaned = '234' + cleaned.slice(4);
  }

  // Force +234 prefix
  if (cleaned.startsWith('234') && !cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }

  return cleaned;
}

// POST: /add-user
router.post('/add-user', async (req, res) => {
  let { email, firstname, middlename, lastname, phonenumber, referralCode } = req.body;

  // Validate presence of all required fields
  if (!email || !firstname || !lastname || !phonenumber) {
    logger.warn('Missing required fields', { body: req.body });
    return res.status(400).json({ message: 'Please fill all required fields.' });
  }

  // Sanitize inputs
  email = sanitizeInput(email.toLowerCase()).slice(0, 100);
  firstname = sanitizeName(firstname);
  middlename = middlename ? sanitizeName(middlename) : '';
  lastname = sanitizeName(lastname);

  // 🔑 Normalize phone ONCE and early
  phonenumber = normalizeNigerianPhone(phonenumber);

  // Validate email format and length
  if (!validator.isEmail(email) || email.length > 100) {
    return res.status(400).json({ message: 'Invalid email address.' });
  }

  // Validate name formats
  if (!isValidName(firstname)) {
    return res.status(400).json({ message: 'Invalid first name. Use only letters (2-50 characters).' });
  }
  if (!isValidName(lastname)) {
    return res.status(400).json({ message: 'Invalid last name. Use only letters (2-50 characters).' });
  }
  if (middlename && !isValidName(middlename)) {
    return res.status(400).json({ message: 'Invalid middle name. Use only letters (2-50 characters).' });
  }

  // Validate phone number format (Nigerian: +234 followed by 10 digits)
  if (!/^\+234[789][01]\d{8}$/.test(phonenumber)) {
    return res.status(400).json({ message: 'Invalid phone number. Use Nigerian format +2348xxxxxxxxx.' });
  }

  // Normalise and validate referral code if provided (optional field)
  let validatedReferralCode = null;
  if (referralCode) {
    const cleaned = String(referralCode).toUpperCase().trim();

    if (!/^[A-Z0-9]{8}$/.test(cleaned)) {
      return res.status(400).json({ message: 'Invalid referral code format.' });
    }

    const referralDoc = await Referral.findOne({ referralCode: cleaned, isActive: true }).lean();
    if (!referralDoc) {
      return res.status(400).json({ message: 'Referral code not found or no longer active.' });
    }

    validatedReferralCode = cleaned;
  }

  try {
    // VerifyAT expects no +
    const phoneForSMS = phonenumber.slice(1);

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
      return res.status(409).json({ message: 'Phone or email already exists' });
    }

    // Generate OTP and expiration
    const otp = generateOTP();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000);

    // Send OTP via Africa's Talking; fall back to Brevo SMS if AT fails
    // const atResult = await sendVerificationCode(phoneForSMS, otp);
    const atResult = { success: false, error: 'AT temporarily disabled' };
    if (!atResult.success) {
      logger.warn('AT SMS failed, attempting Brevo SMS fallback', {
        phone: phoneForSMS.slice(0, 5) + '****',
        error: atResult.error,
      });
      const brevoResult = await sendBrevoSMS(phonenumber, otp);
      if (!brevoResult.success) {
        logger.error('Both AT and Brevo SMS failed — OTP not delivered via SMS', {
          phone: phoneForSMS.slice(0, 5) + '****',
          brevoError: brevoResult.error,
        });
        // Email delivery (below) still proceeds; don't block signup entirely
      }
    }

    // Save pending user (NORMALIZED phone only)
    const pendingUser = new PendingUser({
      email,
      firstname,
      middlename,
      lastname,
      phonenumber,
      verificationCode: otp,
      verificationCodeCreatedAt: createdAt,
      verificationCodeExpiresAt: expiresAt,
      referralCode: validatedReferralCode  // null if not provided
    });

    await pendingUser.save();
    logger.info('Pending user created and OTP sent', { email, phonenumber });

    // Send OTP to email as well — non-blocking so SMS failure doesn't cascade
    sendEmailVerificationOTP(email, firstname, otp, 10).catch(err =>
      logger.warn('Signup: email OTP send failed (non-fatal)', { email: email.slice(0, 3) + '****', error: err.message })
    );

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
