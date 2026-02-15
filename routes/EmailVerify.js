// routes/emailVerification.js
const express = require("express");
const router = express.Router();
const User = require("../models/user");
// FIXED import case to match file name
const { sendEmailVerificationOTP } = require("../services/EmailService");
const logger = require("../utils/logger");
const { trackEvent } = require("../utils/appsFlyerHelper");

function generateOTP(length = 6) {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) otp += digits[Math.floor(Math.random() * digits.length)];
  return otp;
}

router.post("/initiate", async (req, res) => {
  try {
    const userId = req.user.id;
    const { email } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      logger.warn("User not found for email verification initiate", { userId });
      return res.status(404).json({ message: "User not found" });
    }

    const targetEmail = email || user.email;
    if (!targetEmail) return res.status(400).json({ message: "Email address is required" });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(targetEmail)) return res.status(400).json({ message: "Invalid email format" });

    if (user.emailVerified && user.email === targetEmail) {
      return res.status(400).json({ message: "Email address is already verified" });
    }

    const otp = generateOTP();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000);

    user.pinChangeOtp = otp;
    user.pinChangeOtpCreatedAt = createdAt;
    user.pinChangeOtpExpiresAt = expiresAt;
    user.pinChangeOtpVerified = false;

    const emailChanged = email && email !== user.email;
    if (emailChanged) {
      user.email = email;
      user.emailVerified = false;
      user.kyc.level2.emailVerified = false;
    }

    await user.save();

    // NEW: include explicit verify route/deeplink in the email params
    const WEB_BASE = (process.env.APP_WEB_BASE_URL || process.env.FRONTEND_BASE_URL || '').replace(/\/$/, '');
    const DEEP = (process.env.APP_DEEP_LINK || 'zeusodx://').replace(/\/$/, '');
    const qs = `email=${encodeURIComponent(targetEmail)}`;

    const extras = {
      verifyUrl: `${WEB_BASE}/kyc/verify-email?${qs}`,
      appDeepLink: `${DEEP}/kyc/verify-email?${qs}`,
      ctaText: 'Verify email',
      companyName: process.env.COMPANY_NAME,
      supportEmail: process.env.SUPPORT_EMAIL,
    };

    try {
      const fullName = user.fullName || `${user.firstname || ''} ${user.lastname || ''}`.trim() || 'User';
      await sendEmailVerificationOTP(targetEmail, fullName, otp, 10, extras);

      logger.info("Email verification OTP sent successfully", {
        userId,
        email: targetEmail.slice(0, 3) + "****",
        emailChanged
      });

      return res.status(200).json({
        success: true,
        message: "Verification code sent to your email address",
        currentEmail: targetEmail,
        emailChanged,
        // return these for client-side convenience (optional)
        verifyUrl: extras.verifyUrl,
        expiresIn: 10
      });
    } catch (emailError) {
      logger.error("Failed to send email verification OTP", {
        userId,
        email: targetEmail.slice(0, 3) + "****",
        error: emailError.message,
      });

      // rollback otp fields
      user.pinChangeOtp = null;
      user.pinChangeOtpCreatedAt = null;
      user.pinChangeOtpExpiresAt = null;
      user.pinChangeOtpVerified = false;
      await user.save();

      return res.status(500).json({ message: "Failed to send verification code. Please try again." });
    }
  } catch (error) {
    logger.error("Email verification initiate error", { userId: req.user?.id, error: error.message });
    return res.status(500).json({ message: "Server error while initiating email verification" });
  }
});

router.post("/verify", async (req, res) => {
  try {
    const userId = req.user.id;
    const { otp, email } = req.body;

    // Validate required fields
    if (!otp) {
      return res.status(400).json({ message: "Verification code is required" });
    }

    const user = await User.findById(userId);
    if (!user) {
      logger.warn("User not found for email verification verify", { userId });
      return res.status(404).json({ message: "User not found" });
    }

    // Check if OTP exists
    if (!user.pinChangeOtp) {
      return res.status(400).json({ 
        message: "No verification code found. Please request a new verification code." 
      });
    }

    // Check if OTP has expired
    const now = new Date();
    if (!user.pinChangeOtpExpiresAt || now > user.pinChangeOtpExpiresAt) {
      // Clear expired OTP
      user.pinChangeOtp = null;
      user.pinChangeOtpCreatedAt = null;
      user.pinChangeOtpExpiresAt = null;
      user.pinChangeOtpVerified = false;
      await user.save();

      return res.status(400).json({ 
        message: "Verification code has expired. Please request a new verification code." 
      });
    }

    // Verify OTP
    if (user.pinChangeOtp !== otp.toString()) {
      logger.warn("Invalid OTP provided for email verification", { 
        userId, 
        email: user.email.slice(0, 3) + "****" 
      });
      return res.status(400).json({ message: "Invalid verification code" });
    }

    // Optional: If email parameter is provided, validate it matches user's email
    if (email && email !== user.email) {
      return res.status(400).json({ 
        message: "Email mismatch. Please use the email address associated with this verification code." 
      });
    }

    // Mark email as verified
    user.emailVerified = true;
    user.pinChangeOtpVerified = true;
    
    // Update KYC level 2 email verification if applicable
    if (user.kyc && user.kyc.level2) {
      user.kyc.level2.emailVerified = true;
    }

    // Clear OTP fields after successful verification
    user.pinChangeOtp = null;
    user.pinChangeOtpCreatedAt = null;
    user.pinChangeOtpExpiresAt = null;

    await user.save();

    logger.info("Email verification completed successfully", {
      userId,
      email: user.email.slice(0, 3) + "****"
    });

    trackEvent(user._id.toString(), 'Email Verified', {}, req).catch(err => {
      logger.warn('Failed to track AppsFlyer Email Verified event', { userId, error: err.message });
    });

    return res.status(200).json({
      success: true,
      message: "Email address verified successfully",
      emailVerified: true,
      verifiedEmail: user.email
    });

  } catch (error) {
    logger.error("Email verification verify error", { 
      userId: req.user?.id, 
      error: error.message 
    });
    return res.status(500).json({ 
      message: "Server error while verifying email. Please try again." 
    });
  }
});

module.exports = router;