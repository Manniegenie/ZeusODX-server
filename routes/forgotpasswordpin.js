// routes/forgotpin.js
const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { sendEmailVerificationOTP } = require('../services/EmailService'); // Fixed import
const logger = require('../utils/logger');
const validator = require('validator');
// bcrypt removed - no longer needed for manual hashing

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

// Normalize Nigerian phone - SAME logic as signup.js
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

  // 0xxxxxxxxxx -> +234xxxxxxxxx (local format)
  if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = '+234' + cleaned.slice(1);
  }

  // Force +234 prefix
  if (cleaned.startsWith('234') && !cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }

  return cleaned;
}

// Helper to find user by phone number - Note: schema uses 'phonenumber' not 'phoneNumber'
async function findUserByPhone(phoneNumber) {
  try {
    // Normalize phone before lookup
    const normalizedPhone = normalizeNigerianPhone(phoneNumber);
    const user = await User.findOne({ phonenumber: normalizedPhone });
    return user;
  } catch (error) {
    logger.error('Error finding user by phone number', {
      phoneNumber: maskPhoneNumber(phoneNumber),
      error: error.message
    });
    return null;
  }
}

/**
 * POST: /initiate
 * Sends an OTP to the user's email for forgot-pin flow.
 * Request body: { phoneNumber }
 */
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

    // Ensure user has a valid email
    if (!user.email || !validator.isEmail(user.email)) {
      logger.warn('User has no valid email for forgot pin', { 
        userId, 
        phoneNumber: maskPhoneNumber(phoneNumber) 
      });
      return res.status(400).json({ message: 'No valid email on file for this account.' });
    }

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

    // Send OTP via email using EmailService
    try {
      const fullName = `${user.firstname ?? ''} ${user.lastname ?? ''}`.trim();

      // Use sendEmailVerificationOTP with PIN reset context
      const emailResult = await sendEmailVerificationOTP(
        user.email, 
        fullName || 'User', 
        otp, 
        10, // 10 minutes expiry
        {
          ctaText: 'Reset PIN',
          companyName: 'ZeusODX',
          supportEmail: 'support@zeusodx.com'
        }
      );

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
        // return masked email so frontend can show an acknowledgement if needed
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

/**
 * POST: /verify-otp
 * Verify OTP only. Request body: { otp, phoneNumber }
 */
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

    // Mark OTP as verified so the user can reset their pin
    user.pinChangeOtpVerified = true;
    await user.save();

    logger.info('✅ Forgot pin OTP verified successfully', { 
      userId, 
      email: maskEmail(user.email),
      phoneNumber: maskPhoneNumber(phoneNumber)
    });

    return res.status(200).json({
      message: 'OTP verified successfully. You may now reset your PIN.'
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

/**
 * POST: /reset-pin
 * Complete forgot-pin flow: set a new pin after OTP was verified.
 * Request body: { newPin, confirmPin, phoneNumber }
 */
router.post('/reset-pin', async (req, res) => {
  let { newPin, confirmPin, phoneNumber } = req.body;

  // Validate presence of required fields
  if (!newPin || !confirmPin || !phoneNumber) {
    logger.warn('Missing required fields for pin reset');
    return res.status(400).json({ message: 'Please provide newPin, confirmPin and phoneNumber.' });
  }

  // Sanitize inputs
  newPin = sanitizeInput(newPin);
  confirmPin = sanitizeInput(confirmPin);
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
      logger.warn('User not found for pin reset', { 
        phoneNumber: maskPhoneNumber(phoneNumber) 
      });
      return res.status(404).json({ message: 'User not found with this phone number.' });
    }

    const userId = user._id;

    // Ensure OTP was verified first
    if (!user.pinChangeOtpVerified) {
      logger.warn('Attempt to reset pin without OTP verification', { 
        userId, 
        email: maskEmail(user.email),
        phoneNumber: maskPhoneNumber(phoneNumber)
      });
      return res.status(400).json({ message: 'Please verify OTP first before proceeding with pin reset.' });
    }

    // Check if OTP session has expired
    if (new Date() > new Date(user.pinChangeOtpExpiresAt)) {
      logger.warn('OTP session expired during pin reset', { 
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

    // Let the schema handle hashing - just assign the plain PIN
    user.passwordpin = newPin; // Schema will auto-hash this via pre-save hook
    
    // Clear all OTP fields
    user.pinChangeOtp = undefined;
    user.pinChangeOtpCreatedAt = undefined;
    user.pinChangeOtpExpiresAt = undefined;
    user.pinChangeOtpVerified = undefined;
    user.pinChangeOtpLastSentAt = undefined;
    
    await user.save(); // Schema pre-save hook will hash the PIN

    logger.info('✅ Pin reset successfully', { 
      userId, 
      email: maskEmail(user.email),
      phoneNumber: maskPhoneNumber(phoneNumber)
    });

    return res.status(200).json({
      message: 'Pin reset successfully.'
    });

  } catch (err) {
    logger.error('Pin reset error', {
      phoneNumber: maskPhoneNumber(phoneNumber),
      error: err.message,
      stack: err.stack
    });
    return res.status(500).json({ message: 'Server error while resetting pin.' });
  }
});

/**
 * POST: /update-pin
 * Change current pin to new pin (requires current pin).
 * Request body: { phoneNumber, currentPin, newPin, confirmPin }
 */
router.post('/update-pin', async (req, res) => {
  let { phoneNumber, currentPin, newPin, confirmPin } = req.body;

  // Validate presence of required fields
  if (!phoneNumber || !currentPin || !newPin || !confirmPin) {
    logger.warn('Missing required fields for pin update');
    return res.status(400).json({ 
      message: 'Please provide phoneNumber, currentPin, newPin and confirmPin.' 
    });
  }

  // Sanitize inputs
  phoneNumber = sanitizeInput(phoneNumber);
  currentPin = sanitizeInput(currentPin);
  newPin = sanitizeInput(newPin);
  confirmPin = sanitizeInput(confirmPin);

  // Validate phone number format
  if (!isValidPhoneNumber(phoneNumber)) {
    return res.status(400).json({ message: 'Invalid phone number format.' });
  }

  // Validate current pin format
  if (!/^\d{4,6}$/.test(currentPin)) {
    return res.status(400).json({ message: 'Invalid current pin format. Pin should be 4-6 digits.' });
  }

  // Validate new pin format
  if (!/^\d{4,6}$/.test(newPin)) {
    return res.status(400).json({ message: 'Invalid new pin format. Pin should be 4-6 digits.' });
  }

  // Check if new pin and confirm pin match
  if (newPin !== confirmPin) {
    return res.status(400).json({ message: 'New pin and confirm pin do not match.' });
  }

  // Check if new pin is different from current pin
  if (currentPin === newPin) {
    return res.status(400).json({ message: 'New pin must be different from current pin.' });
  }

  try {
    // Find user in database using phone number
    const user = await findUserByPhone(phoneNumber);
    if (!user) {
      logger.warn('User not found for pin update', { 
        phoneNumber: maskPhoneNumber(phoneNumber) 
      });
      return res.status(404).json({ message: 'User not found with this phone number.' });
    }

    const userId = user._id;

    // Check if user has a current pin set
    if (!user.passwordpin) {
      logger.warn('User has no current pin set for pin update', { 
        userId,
        phoneNumber: maskPhoneNumber(phoneNumber)
      });
      return res.status(400).json({ message: 'No current pin found. Please set up a pin first.' });
    }

    // Verify current pin using the schema method
    const isCurrentPinValid = await user.comparePasswordPin(currentPin);
    if (!isCurrentPinValid) {
      logger.warn('Invalid current pin provided for pin update', { 
        userId,
        phoneNumber: maskPhoneNumber(phoneNumber)
      });
      return res.status(400).json({ message: 'Current pin is incorrect.' });
    }

    // Let the schema handle hashing - just assign the plain PIN
    user.passwordpin = newPin; // Schema will auto-hash this via pre-save hook
    await user.save(); // Schema pre-save hook will hash the PIN

    logger.info('✅ Pin updated successfully', { 
      userId, 
      phoneNumber: maskPhoneNumber(phoneNumber)
    });

    return res.status(200).json({
      message: 'Pin updated successfully.'
    });

  } catch (err) {
    logger.error('Pin update error', {
      phoneNumber: maskPhoneNumber(phoneNumber),
      error: err.message,
      stack: err.stack
    });
    return res.status(500).json({ message: 'Server error while updating pin.' });
  }
});

module.exports = router;