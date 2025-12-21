const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { sendEmailVerificationOTP } = require('../services/EmailService');
const EmailVerificationService = require('../services/VerifiedEmail');
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
  return validator.stripLow(validator.escape(input.trim()));
}

// POST: /initiate - Send OTP via email
router.post('/initiate', async (req, res) => {
  const userId = req.user.id; // Extract user ID from JWT

  try {
    // Find user in database using JWT user ID
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found for forgot pin', { 
        userId 
      });
      return res.status(404).json({ message: 'User not found.' });
    }

    // Check if 2FA is set up
    if (!user.twoFASecret || !user.is2FAEnabled) {
      return res.status(400).json({ 
        success: false, 
        message: '2FA Setup Required' 
      });
    }

    logger.info('✅ 2FA setup verified for forgot pin initiation', { userId });

    // Check if user is verified using EmailVerificationService
    if (!EmailVerificationService.isEmailVerifiedFromObject(user)) {
      logger.info('Unverified user attempted forgot pin', { 
        userId,
        email: user.email?.slice(0, 3) + '****'
      });
      return res.status(403).json({ message: 'Kindly Verify Your Email Address' });
    }

    // Generate OTP and expiration
    const otp = generateOTP();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000); // 10 minutes expiration

    // Update user with OTP details for pin change
    user.pinChangeOtp = otp;
    user.pinChangeOtpCreatedAt = createdAt;
    user.pinChangeOtpExpiresAt = expiresAt;
    user.pinChangeOtpVerified = false; // Track OTP verification status
    await user.save();

    // Send OTP via email
    try {
      const fullName = `${user.firstname} ${user.lastname}`;
      const emailResult = await sendEmailVerificationOTP(user.email, fullName, otp, 10);
      
      logger.info('Forgot pin OTP sent successfully', { 
        userId,
        email: user.email?.slice(0, 3) + '****',
        messageId: emailResult.messageId
      });

      res.status(200).json({
        message: 'Pin reset verification code sent to your email.'
      });

    } catch (emailError) {
      logger.error('Failed to send forgot pin OTP email', {
        userId,
        email: user.email?.slice(0, 3) + '****',
        error: emailError.message,
        stack: emailError.stack
      });
      
      // Clean up the OTP from database since email failed
      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      user.pinChangeOtpVerified = undefined;
      await user.save();
      
      return res.status(500).json({ message: 'Failed to send verification code. Please try again.' });
    }

  } catch (err) {
    logger.error('Forgot pin initiation error', {
      userId,
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ message: 'Server error while initiating pin reset.' });
  }
});

// POST: /verify-otp - Verify OTP only
router.post('/verify-otp', async (req, res) => {
  let { otp } = req.body;
  const userId = req.user.id; // Extract user ID from JWT

  // Validate presence of required fields
  if (!otp) {
    logger.warn('Missing OTP for forgot pin OTP verification', { 
      userId 
    });
    return res.status(400).json({ message: 'Please provide OTP.' });
  }

  // Sanitize inputs
  otp = sanitizeInput(otp);

  // Validate OTP format
  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ message: 'Invalid OTP format. OTP should be 6 digits.' });
  }

  try {
    // Find user in database using JWT user ID
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found for forgot pin OTP verification', { 
        userId 
      });
      return res.status(404).json({ message: 'User not found.' });
    }

    // Check if user has pending pin change OTP
    if (!user.pinChangeOtp) {
      logger.warn('No pending forgot pin request found for OTP verification', { 
        userId,
        email: user.email?.slice(0, 3) + '****'
      });
      return res.status(400).json({ message: 'No pending pin reset request. Please initiate pin reset first.' });
    }

    // Check if OTP has expired
    if (new Date() > user.pinChangeOtpExpiresAt) {
      logger.warn('Expired forgot pin OTP used', { 
        userId,
        email: user.email?.slice(0, 3) + '****'
      });
      
      // Clean up expired OTP
      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      user.pinChangeOtpVerified = undefined;
      await user.save();
      
      return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
    }

    // Verify OTP
    if (user.pinChangeOtp !== otp) {
      logger.warn('Invalid forgot pin OTP provided', { 
        userId,
        email: user.email?.slice(0, 3) + '****'
      });
      return res.status(400).json({ message: 'Invalid OTP.' });
    }

    // Mark OTP as verified but don't clear it yet (will be cleared after 2FA)
    user.pinChangeOtpVerified = true;
    await user.save();

    logger.info('✅ Forgot pin OTP verified successfully', { 
      userId,
      email: user.email?.slice(0, 3) + '****'
    });

    res.status(200).json({
      message: 'OTP verified successfully. Please proceed with two-factor authentication.'
    });

  } catch (err) {
    logger.error('Forgot pin OTP verification error', {
      userId,
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ message: 'Server error while verifying OTP.' });
  }
});

// POST: /verify-2fa-and-change-pin - Verify 2FA and change pin
router.post('/change-pin', async (req, res) => {
  let { newPin, confirmPin, twoFactorCode } = req.body;
  const userId = req.user.id; // Extract user ID from JWT

  // Validate presence of required fields
  if (!newPin || !confirmPin || !twoFactorCode) {
    logger.warn('Missing required fields for forgot pin 2FA and pin change', { 
      userId 
    });
    return res.status(400).json({ message: 'Please provide all required fields.' });
  }

  if (!twoFactorCode?.trim()) {
    return res.status(400).json({ message: 'Two-factor authentication code is required.' });
  }

  // Sanitize inputs
  newPin = sanitizeInput(newPin);
  confirmPin = sanitizeInput(confirmPin);
  twoFactorCode = sanitizeInput(twoFactorCode);

  // Validate new pin format
  if (!/^\d{4,6}$/.test(newPin)) {
    return res.status(400).json({ message: 'Invalid pin format. Pin should be 4-6 digits.' });
  }

  // Check if new pin and confirm pin match
  if (newPin !== confirmPin) {
    return res.status(400).json({ message: 'New pin and confirm pin do not match.' });
  }

  try {
    // Find user in database using JWT user ID
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found for forgot pin 2FA verification', { 
        userId 
      });
      return res.status(404).json({ message: 'User not found.' });
    }

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
        email: user.email?.slice(0, 3) + '****'
      });
      return res.status(400).json({ message: 'Please verify OTP first before proceeding with pin change.' });
    }

    // Check if OTP session has expired (even though OTP was verified)
    if (new Date() > user.pinChangeOtpExpiresAt) {
      logger.warn('OTP session expired during 2FA verification', { 
        userId,
        email: user.email?.slice(0, 3) + '****'
      });
      
      // Clean up expired session
      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      user.pinChangeOtpVerified = undefined;
      await user.save();
      
      return res.status(400).json({ message: 'Session has expired. Please start the pin reset process again.' });
    }

    // Validate 2FA code
    if (!validateTwoFactorAuth(user, twoFactorCode)) {
      logger.warn('🚫 2FA validation failed for forgot pin completion', { 
        userId, 
        errorType: 'INVALID_2FA' 
      });
      return res.status(401).json({ 
        success: false, 
        error: 'INVALID_2FA_CODE', 
        message: 'Invalid two-factor authentication code' 
      });
    }

    logger.info('✅ 2FA validation successful for forgot pin completion', { userId });

    // Hash the new pin manually (schema no longer auto-hashes passwordpin)
    const saltRounds = 10; // Match SALT_WORK_FACTOR from schema
    const hashedNewPin = await bcrypt.hash(newPin, saltRounds);

    // Update user's passwordpin and clear all OTP fields
    user.passwordpin = hashedNewPin;
    user.pinChangeOtp = undefined;
    user.pinChangeOtpCreatedAt = undefined;
    user.pinChangeOtpExpiresAt = undefined;
    user.pinChangeOtpVerified = undefined;
    await user.save();

    logger.info('✅ Pin reset successfully after 2FA verification', { 
      userId,
      email: user.email?.slice(0, 3) + '****'
    });

    res.status(200).json({
      message: 'Pin reset successfully.'
    });

  } catch (err) {
    logger.error('Forgot pin 2FA verification and pin change error', {
      userId,
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ message: 'Server error while verifying 2FA and resetting pin.' });
  }
});

module.exports = router;