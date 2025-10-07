const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const PendingUser = require('../models/pendinguser');
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

// --- Rate limiter for OTP resend ---
const otpResendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: 3, // limit each IP or phone to 3 requests per window
  keyGenerator: (req, res) => req.body.phonenumber || req.ip,
  handler: (req, res) => {
    logger.warn(`Too many OTP resend attempts for: ${req.body.phonenumber}`);
    return res.status(429).json({ message: 'Too many OTP requests. Please try again later.' });
  }
});

// --- POST /resend-otp ---
router.post('/resend-otp', otpResendLimiter, async (req, res) => {
  let { phonenumber } = req.body;

  if (!phonenumber) {
    logger.warn('Phone number not provided in /resend-otp');
    return res.status(400).json({ message: 'Phone number is required.' });
  }

  phonenumber = sanitizeInput(phonenumber);
  const normalizedPhone = phonenumber.startsWith('+') ? phonenumber.slice(1) : phonenumber;

  try {
    const pendingUser = await PendingUser.findOne({ phonenumber });

    if (!pendingUser) {
      logger.warn(`Pending user not found for phone number: ${phonenumber}`);
      return res.status(404).json({ message: 'User not found or already verified.' });
    }

    const otp = generateOTP();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000); // HARD-CODED 10 minutes

    const sendResult = await sendVerificationCode(normalizedPhone, otp);

    if (!sendResult.success) {
      logger.error('Failed to resend OTP', { phone: normalizedPhone, error: sendResult.error });
      return res.status(500).json({ message: 'Failed to send verification code.' });
    }

    pendingUser.verificationCode = otp;
    pendingUser.verificationCodeCreatedAt = createdAt;
    pendingUser.verificationCodeExpiresAt = expiresAt;

    await pendingUser.save();

    logger.info('OTP resent successfully', { phonenumber });
    res.status(200).json({ message: 'Verification code resent successfully.' });

  } catch (error) {
    logger.error('Error resending OTP', {
      error: error.message,
      stack: error.stack,
      phonenumber: phonenumber.slice(0, 5) + '****'
    });
    res.status(500).json({ message: 'Server error while resending OTP.' });
  }
});

module.exports = router;
