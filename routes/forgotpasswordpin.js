const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { sendOtpEmail } = require('../services/EmailService');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const logger = require('../utils/logger');
const validator = require('validator');
const bcrypt = require('bcryptjs');

// Generate numeric OTP (same as signup)
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
  if (typeof input !== 'string') return '';
  return validator.stripLow(validator.escape(input.trim()));
}

// Helper to mask email for logs
function maskEmail(email = '') {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return email.replace(/.(?=.{2})/g, '*');
  const maskedLocal = local.length <= 2 ? local[0] + '*' : local.slice(0, 2) + '****';
  return `${maskedLocal}@${domain}`;
}

// Helper to mask phone number for logs
function maskPhoneNumber(phone = '') {
  if (!phone) return '';
  return phone.replace(/\d(?=\d{4})/g, '*');
}

// Helper to validate phone number format
function isValidPhoneNumber(phone) {
  // Adjust regex based on your phone number requirements
  return /^\+?[\d\s\-()]{10,15}$/.test(phone);
}

// Helper to find user by phone number
async function findUserByPhone(phoneNumber) {
  try {
    const user = await User.findOne({ phoneNumber: phoneNumber });
    return user;
  } catch (error) {
    logger.error('Error finding user by phone number', {
      phoneNumber: maskPhoneNumber(phoneNumber),
      error: error.message
    });
    return null;
  }
}

// POST: /initiate - Send OTP via email using phone number
router.post('/initiate', async (req, res) => {
  let { phoneNumber } = req.body;

  // Validate presence of phone number
  if (!phoneNumber) {
    logger.warn('Missing phone number for forgot pin initiation');
    return res.status(400).json({ message: 'Phone number is required.' });
  }

  // Sanitize phone number input
  phoneNumber = sanitizeInput(phoneNumber);

  // Validate phone number format
  if (!isValidPhoneNumber(phoneNumber)) {
    return res.status(400).json({ message: 'Invalid phone number format.' });
  }

  try {
    // Find user in database using phone number
    const user = await findUserByPhone(phoneNumber);
    if (!user) {
      logger.warn('User not found for forgot pin using phone number', { 
        phoneNumber: maskPhoneNumber(phoneNumber) 
      });
      return res.status(404).json({ message: 'User not found with this phone number.' });
    }

    const userId = user._id;

    // Check if 2FA is set up
    if (!user.twoFASecret || !user.is2FAEnabled) {
      return res.status(400).json({
        success: false,
        message: '2FA Setup Required'
      });
    }

    // Ensure user has a valid email
    if (!user.email || !validator.isEmail(user.email)) {
      logger.warn('User has no valid email for forgot pin', { 
        userId, 
        phoneNumber: maskPhoneNumber(phoneNumber) 
      });
      return res.status(400).json({ message: 'No valid email on file for this account.' });
    }

    logger.info('✅ 2FA setup verified for forgot pin initiation', { userId });

    // Simple throttling: prevent repeated requests (e.g., once per 60 seconds)
    const now = new Date();
    const lastSent = user.pinChangeOtpLastSentAt ? new Date(user.pinChangeOtpLastSentAt) : null;
    if (lastSent && (now.getTime() - lastSent.getTime()) < 60 * 1000) {
      logger.warn('Forgot pin OTP requested too frequently', { 
        userId, 
        email: maskEmail(user.email),
        phoneNumber: maskPhoneNumber(phoneNumber)
      });
      return res.status(429).json({ message: 'Please wait before requesting another code.' });
    }

    // Generate OTP and expiration
    const otp = generateOTP();
    const createdAt = now;
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000); // 10 minutes expiration

    // Update user with OTP details for pin change
    user.pinChangeOtp = otp;
    user.pinChangeOtpCreatedAt = createdAt;
    user.pinChangeOtpExpiresAt = expiresAt;
    user.pinChangeOtpVerified = false; // Track OTP verification status
    user.pinChangeOtpLastSentAt = createdAt; // Save last-sent timestamp for throttling
    await user.save();

    // Send OTP via email using your EmailService
    try {
      const fullName = `${user.firstname ?? ''} ${user.lastname ?? ''}`.trim();

      // sendOtpEmail signature assumed: (to, name, otp, minutes)
      const emailResult = await sendOtpEmail(user.email, fullName, otp, 10);

      // emailResult may be provider-specific — attempt to log an identifier if present
      const resultMeta = {};
      if (emailResult && typeof emailResult === 'object') {
        if (emailResult.messageId) resultMeta.messageId = emailResult.messageId;
        if (emailResult.id) resultMeta.id = emailResult.id;
      }

      logger.info('Forgot pin OTP sent successfully', {
        userId,
        email: maskEmail(user.email),
        phoneNumber: maskPhoneNumber(phoneNumber),
        ...resultMeta
      });

      return res.status(200).json({
        message: 'Pin reset verification code sent to your email.',
        email: maskEmail(user.email)
      });

    } catch (emailError) {
      // If email sending fails, clear OTP fields and save
      logger.error('Failed to send forgot pin OTP email', {
        userId,
        email: maskEmail(user.email),
        phoneNumber: maskPhoneNumber(phoneNumber),
        error: emailError?.message,
        stack: emailError?.stack
      });

      // Clean up the OTP from database since email failed
      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      user.pinChangeOtpVerified = undefined;
      user.pinChangeOtpLastSentAt = undefined;
      await user.save();

      return res.status(500).json({ message: 'Failed to send verification code. Please try again.' });
    }

  } catch (err) {
    logger.error('Forgot pin initiation error', {
      phoneNumber: maskPhoneNumber(phoneNumber),
      error: err.message,
      stack: err.stack
    });
    return res.status(500).json({ message: 'Server error while initiating pin reset.' });
  }
});

// POST: /verify-otp - Verify OTP only using phone number
router.post('/verify-otp', async (req, res) => {
  let { otp, phoneNumber } = req.body;

  // Validate presence of required fields
  if (!otp || !phoneNumber) {
    logger.warn('Missing OTP or phone number for forgot pin OTP verification');
    return res.status(400).json({ message: 'Please provide both OTP and phone number.' });
  }

  // Sanitize inputs
  otp = sanitizeInput(otp);
  phoneNumber = sanitizeInput(phoneNumber);

  // Validate phone number format
  if (!isValidPhoneNumber(phoneNumber)) {
    return res.status(400).json({ message: 'Invalid phone number format.' });
  }

  // Validate OTP format
  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ message: 'Invalid OTP format. OTP should be 6 digits.' });
  }

  try {
    // Find user in database using phone number
    const user = await findUserByPhone(phoneNumber);
    if (!user) {
      logger.warn('User not found for forgot pin OTP verification', { 
        phoneNumber: maskPhoneNumber(phoneNumber) 
      });
      return res.status(404).json({ message: 'User not found with this phone number.' });
    }

    const userId = user._id;

    // Check if user has pending pin change OTP
    if (!user.pinChangeOtp) {
      logger.warn('No pending forgot pin request found for OTP verification', { 
        userId, 
        email: maskEmail(user.email),
        phoneNumber: maskPhoneNumber(phoneNumber)
      });
      return res.status(400).json({ message: 'No pending pin reset request. Please initiate pin reset first.' });
    }

    // Check if OTP has expired
    if (new Date() > new Date(user.pinChangeOtpExpiresAt)) {
      logger.warn('Expired forgot pin OTP used', { 
        userId, 
        email: maskEmail(user.email),
        phoneNumber: maskPhoneNumber(phoneNumber)
      });

      // Clean up expired OTP
      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      user.pinChangeOtpVerified = undefined;
      user.pinChangeOtpLastSentAt = undefined;
      await user.save();

      return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
    }

    // Verify OTP
    if (user.pinChangeOtp !== otp) {
      logger.warn('Invalid forgot pin OTP provided', { 
        userId, 
        email: maskEmail(user.email),
        phoneNumber: maskPhoneNumber(phoneNumber)
      });
      return res.status(400).json({ message: 'Invalid OTP.' });
    }

    // Mark OTP as verified but don't clear it yet (will be cleared after 2FA)
    user.pinChangeOtpVerified = true;
    await user.save();

    logger.info('✅ Forgot pin OTP verified successfully', { 
      userId, 
      email: maskEmail(user.email),
      phoneNumber: maskPhoneNumber(phoneNumber)
    });

    return res.status(200).json({
      message: 'OTP verified successfully. Please proceed with two-factor authentication.'
    });

  } catch (err) {
    logger.error('Forgot pin OTP verification error', {
      phoneNumber: maskPhoneNumber(phoneNumber),
      error: err.message,
      stack: err.stack
    });
    return res.status(500).json({ message: 'Server error while verifying OTP.' });
  }
});

// POST: /change-pin - Verify 2FA and change pin using phone number
router.post('/change-pin', async (req, res) => {
  let { newPin, confirmPin, twoFactorCode, phoneNumber } = req.body;

  // Validate presence of required fields
  if (!newPin || !confirmPin || !twoFactorCode || !phoneNumber) {
    logger.warn('Missing required fields for forgot pin 2FA and pin change');
    return res.status(400).json({ message: 'Please provide all required fields: newPin, confirmPin, twoFactorCode, and phoneNumber.' });
  }

  if (!twoFactorCode?.trim()) {
    return res.status(400).json({ message: 'Two-factor authentication code is required.' });
  }

  // Sanitize inputs
  newPin = sanitizeInput(newPin);
  confirmPin = sanitizeInput(confirmPin);
  twoFactorCode = sanitizeInput(twoFactorCode);
  phoneNumber = sanitizeInput(phoneNumber);

  // Validate phone number format
  if (!isValidPhoneNumber(phoneNumber)) {
    return res.status(400).json({ message: 'Invalid phone number format.' });
  }

  // Validate new pin format
  if (!/^\d{4,6}$/.test(newPin)) {
    return res.status(400).json({ message: 'Invalid pin format. Pin should be 4-6 digits.' });
  }

  // Check if new pin and confirm pin match
  if (newPin !== confirmPin) {
    return res.status(400).json({ message: 'New pin and confirm pin do not match.' });
  }

  try {
    // Find user in database using phone number
    const user = await findUserByPhone(phoneNumber);
    if (!user) {
      logger.warn('User not found for forgot pin 2FA verification', { 
        phoneNumber: maskPhoneNumber(phoneNumber) 
      });
      return res.status(404).json({ message: 'User not found with this phone number.' });
    }

    const userId = user._id;

    // Check if 2FA is set up
    if (!user.twoFASecret || !user.is2FAEnabled) {
      return res.status(400).json({
        success: false,
        message: '2FA Setup Required'
      });
    }

    // Check if OTP was verified first
    if (!user.pinChangeOtpVerified) {
      logger.warn('Attempt to change pin without OTP verification', { 
        userId, 
        email: maskEmail(user.email),
        phoneNumber: maskPhoneNumber(phoneNumber)
      });
      return res.status(400).json({ message: 'Please verify OTP first before proceeding with pin change.' });
    }

    // Check if OTP session has expired (even though OTP was verified)
    if (new Date() > new Date(user.pinChangeOtpExpiresAt)) {
      logger.warn('OTP session expired during 2FA verification', { 
        userId, 
        email: maskEmail(user.email),
        phoneNumber: maskPhoneNumber(phoneNumber)
      });

      // Clean up expired session
      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      user.pinChangeOtpVerified = undefined;
      user.pinChangeOtpLastSentAt = undefined;
      await user.save();

      return res.status(400).json({ message: 'Session has expired. Please start the pin reset process again.' });
    }

    // Validate 2FA code
    if (!validateTwoFactorAuth(user, twoFactorCode)) {
      logger.warn('🚫 2FA validation failed for forgot pin completion', {
        userId,
        phoneNumber: maskPhoneNumber(phoneNumber),
        errorType: 'INVALID_2FA'
      });
      return res.status(401).json({
        success: false,
        error: 'INVALID_2FA_CODE',
        message: 'Invalid two-factor authentication code'
      });
    }

    logger.info('✅ 2FA validation successful for forgot pin completion', { 
      userId,
      phoneNumber: maskPhoneNumber(phoneNumber)
    });

    // Hash the new pin manually (schema no longer auto-hashes passwordpin)
    const saltRounds = 10; // Match SALT_WORK_FACTOR from schema
    const hashedNewPin = await bcrypt.hash(newPin, saltRounds);

    // Update user's passwordpin and clear all OTP fields
    user.passwordpin = hashedNewPin;
    user.pinChangeOtp = undefined;
    user.pinChangeOtpCreatedAt = undefined;
    user.pinChangeOtpExpiresAt = undefined;
    user.pinChangeOtpVerified = undefined;
    user.pinChangeOtpLastSentAt = undefined;
    await user.save();

    logger.info('✅ Pin reset successfully after 2FA verification', { 
      userId, 
      email: maskEmail(user.email),
      phoneNumber: maskPhoneNumber(phoneNumber)
    });

    return res.status(200).json({
      message: 'Pin reset successfully.'
    });

  } catch (err) {
    logger.error('Forgot pin 2FA verification and pin change error', {
      phoneNumber: maskPhoneNumber(phoneNumber),
      error: err.message,
      stack: err.stack
    });
    return res.status(500).json({ message: 'Server error while verifying 2FA and resetting pin.' });
  }
});

module.exports = router;