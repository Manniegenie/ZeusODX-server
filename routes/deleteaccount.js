const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { sendOtpEmail } = require('../services/EmailService');
const EmailVerificationService = require('../services/VerifiedEmail');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const logger = require('../utils/logger');
const validator = require('validator');

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

// Function to check if user has funds in any wallet
function checkUserFunds(user) {
  try {
    const balanceFields = [
      'solBalance', 'solPendingBalance',
      'btcBalance', 'btcPendingBalance',
      'usdtBalance', 'usdtPendingBalance',
      'usdcBalance', 'usdcPendingBalance',
      'ethBalance', 'ethPendingBalance',
      'bnbBalance', 'bnbPendingBalance',
      'dogeBalance', 'dogePendingBalance',
      'maticBalance', 'maticPendingBalance',
      'avaxBalance', 'avaxPendingBalance',
      'ngnbBalance', 'ngnbPendingBalance'
    ];

    let totalFunds = 0;
    const fundDetails = {};

    for (const field of balanceFields) {
      const balance = user[field] || 0;
      if (balance > 0) {
        fundDetails[field] = balance;
        totalFunds += balance;
      }
    }

    const hasFunds = totalFunds > 0;
    
    logger.info('User funds check completed', {
      userId: user._id,
      hasFunds,
      totalFunds,
      fundsCount: Object.keys(fundDetails).length
    });

    return {
      hasFunds,
      totalFunds,
      fundDetails
    };
  } catch (error) {
    logger.error('Error checking user funds', {
      userId: user._id,
      error: error.message
    });
    return {
      hasFunds: false,
      totalFunds: 0,
      fundDetails: {}
    };
  }
}

// POST: /initiate
router.post('/initiate', async (req, res) => {
  const userId = req.user.id; // Extract user ID from JWT

  try {
    // Find user in database using JWT user ID
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found for account deletion', { 
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

    logger.info('✅ 2FA setup verified for account deletion initiation', { userId });

    // Check if user is verified using EmailVerificationService
    if (!EmailVerificationService.isEmailVerifiedFromObject(user)) {
      logger.info('Unverified user attempted account deletion', { 
        userId,
        email: user.email?.slice(0, 3) + '****'
      });
      return res.status(403).json({ message: 'Kindly Verify Your Email Address' });
    }

    // Check if user has funds in any wallet
    const fundsCheck = checkUserFunds(user);

    // Generate OTP and expiration
    const otp = generateOTP();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000); // 10 minutes expiration

    // Update user with OTP details for account deletion
    user.pinChangeOtp = otp; // Reusing the same OTP fields
    user.pinChangeOtpCreatedAt = createdAt;
    user.pinChangeOtpExpiresAt = expiresAt;
    await user.save();

    // Send OTP via email
    try {
      const fullName = `${user.firstname} ${user.lastname}`;
      const emailResult = await sendOtpEmail(user.email, fullName, otp, 10);
      
      logger.info('Account deletion OTP sent successfully', { 
        userId,
        email: user.email?.slice(0, 3) + '****',
        messageId: emailResult.messageId,
        hasFunds: fundsCheck.hasFunds
      });

      res.status(200).json({
        message: 'Account deletion verification code sent to your email.',
        fundsAvailable: fundsCheck.hasFunds,
        fundDetails: fundsCheck.hasFunds ? fundsCheck.fundDetails : undefined
      });

    } catch (emailError) {
      logger.error('Failed to send account deletion OTP email', {
        userId,
        email: user.email?.slice(0, 3) + '****',
        error: emailError.message,
        stack: emailError.stack
      });
      
      // Clean up the OTP from database since email failed
      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      await user.save();
      
      return res.status(500).json({ message: 'Failed to send verification code. Please try again.' });
    }

  } catch (err) {
    logger.error('Account deletion initiation error', {
      userId,
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ message: 'Server error while initiating account deletion.' });
  }
});

// POST: /delete
router.post('/delete', async (req, res) => {
  let { otp, twoFactorCode } = req.body;
  const userId = req.user.id; // Extract user ID from JWT

  // Validate presence of required fields
  if (!otp) {
    logger.warn('Missing OTP for account deletion completion', { 
      userId 
    });
    return res.status(400).json({ message: 'Please provide OTP.' });
  }

  if (!twoFactorCode?.trim()) {
    return res.status(400).json({ message: 'Two-factor authentication code is required.' });
  }

  // Sanitize inputs
  otp = sanitizeInput(otp);
  twoFactorCode = sanitizeInput(twoFactorCode);

  // Validate OTP format
  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ message: 'Invalid OTP format. OTP should be 6 digits.' });
  }

  try {
    // Find user in database using JWT user ID
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found for account deletion completion', { 
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

    // Validate 2FA code
    if (!validateTwoFactorAuth(user, twoFactorCode)) {
      logger.warn('🚫 2FA validation failed for account deletion completion', { 
        userId, 
        errorType: 'INVALID_2FA' 
      });
      return res.status(401).json({ 
        success: false, 
        error: 'INVALID_2FA_CODE', 
        message: 'Invalid two-factor authentication code' 
      });
    }

    logger.info('✅ 2FA validation successful for account deletion completion', { userId });

    // Check if user has pending account deletion OTP
    if (!user.pinChangeOtp) {
      logger.warn('No pending account deletion request found', { 
        userId,
        email: user.email?.slice(0, 3) + '****'
      });
      return res.status(400).json({ message: 'No pending account deletion request. Please initiate account deletion first.' });
    }

    // Check if OTP has expired
    if (new Date() > user.pinChangeOtpExpiresAt) {
      logger.warn('Expired account deletion OTP used', { 
        userId,
        email: user.email?.slice(0, 3) + '****'
      });
      
      // Clean up expired OTP
      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      await user.save();
      
      return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
    }

    // Verify OTP
    if (user.pinChangeOtp !== otp) {
      logger.warn('Invalid account deletion OTP provided', { 
        userId,
        email: user.email?.slice(0, 3) + '****'
      });
      return res.status(400).json({ message: 'Invalid OTP.' });
    }

    // Final funds check before deletion
    const fundsCheck = checkUserFunds(user);
    if (fundsCheck.hasFunds) {
      logger.warn('Account deletion attempted with funds present', {
        userId,
        email: user.email?.slice(0, 3) + '****',
        totalFunds: fundsCheck.totalFunds,
        fundDetails: fundsCheck.fundDetails
      });
      
      // Clean up OTP since deletion cannot proceed
      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      await user.save();
      
      return res.status(400).json({ 
        message: 'Cannot delete account with remaining funds. Please withdraw all funds first.',
        fundsAvailable: true,
        fundDetails: fundsCheck.fundDetails
      });
    }

    // Schedule account for deletion (30 days from now)
    const deletionDate = new Date();
    deletionDate.setDate(deletionDate.getDate() + 30);
    
    // Update user account with deletion schedule and clear OTP fields
    user.accountDeletionScheduled = true;
    user.accountDeletionDate = deletionDate;
    user.pinChangeOtp = undefined;
    user.pinChangeOtpCreatedAt = undefined;
    user.pinChangeOtpExpiresAt = undefined;
    await user.save();

    logger.info('Account scheduled for deletion', { 
      userId,
      email: userEmail,
      name: userName,
      scheduledDeletionDate: deletionDate
    });

    res.status(200).json({
      message: 'Account scheduled for deletion in 30 days.',
      scheduledDeletionDate: deletionDate,
      note: 'You can cancel this deletion by logging in before the scheduled date.'
    });

  } catch (err) {
    logger.error('Account deletion completion error', {
      userId,
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ message: 'Server error while deleting account.' });
  }
});

module.exports = router;