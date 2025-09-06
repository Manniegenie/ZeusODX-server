const express = require("express");
const router = express.Router();
const User = require("../models/user");
const { sendEmailVerificationOTP } = require("../services/EmailService");
const logger = require("../utils/logger");

// Generate 6-digit OTP
function generateOTP(length = 6) {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) {
    otp += digits[Math.floor(Math.random() * digits.length)];
  }
  return otp;
}

// POST: /api/email-verification/initiate - Send OTP to email
router.post("/initiate", async (req, res) => {
  try {
    const userId = req.user.id;
    const { email } = req.body;

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      logger.warn("User not found for email verification initiate", { userId });
      return res.status(404).json({ message: "User not found" });
    }

    // Use provided email or user's current email
    const targetEmail = email || user.email;
    
    if (!targetEmail) {
      return res.status(400).json({ message: "Email address is required" });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(targetEmail)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    // Check if user already has email verified and is trying to verify the same email
    if (user.emailVerified && user.email === targetEmail) {
      return res.status(400).json({ message: "Email address is already verified" });
    }

    // Generate OTP
    const otp = generateOTP();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000); // 10 minutes

    // Store OTP in user document
    user.pinChangeOtp = otp;
    user.pinChangeOtpCreatedAt = createdAt;
    user.pinChangeOtpExpiresAt = expiresAt;
    user.pinChangeOtpVerified = false;

    // If new email is provided and different from current, update it
    const emailChanged = email && email !== user.email;
    if (emailChanged) {
      user.email = email;
      user.emailVerified = false;
      user.kyc.level2.emailVerified = false;
    }

    await user.save();

    // Send OTP email
    try {
      const fullName = user.fullName || `${user.firstname} ${user.lastname}`;
      await sendEmailVerificationOTP(targetEmail, fullName, otp, 10);

      logger.info("Email verification OTP sent successfully", {
        userId,
        email: targetEmail.slice(0, 3) + "****",
        emailChanged
      });

      res.status(200).json({
        message: "Verification code sent to your email address",
        currentEmail: targetEmail,
        emailChanged,
        expiresIn: 10
      });

    } catch (emailError) {
      logger.error("Failed to send email verification OTP", {
        userId,
        email: targetEmail.slice(0, 3) + "****",
        error: emailError.message,
        stack: emailError.stack
      });

      // Clean up OTP from database since email failed
      user.pinChangeOtp = null;
      user.pinChangeOtpCreatedAt = null;
      user.pinChangeOtpExpiresAt = null;
      user.pinChangeOtpVerified = false;
      await user.save();

      return res.status(500).json({ message: "Failed to send verification code. Please try again." });
    }

  } catch (error) {
    logger.error("Email verification initiate error", {
      userId: req.user?.id,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ message: "Server error while initiating email verification" });
  }
});

// POST: /api/email-verification/complete - Verify OTP and complete email verification
router.post("/complete", async (req, res) => {
  try {
    const userId = req.user.id;
    const { email, otp } = req.body;

    // Validate required fields
    if (!email || !otp) {
      return res.status(400).json({ message: "Email and verification code are required" });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    // Validate OTP format
    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ message: "Invalid verification code format" });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      logger.warn("User not found for email verification complete", { userId });
      return res.status(404).json({ message: "User not found" });
    }

    // Check if user has pending email verification
    if (!user.pinChangeOtp) {
      logger.warn("No pending email verification found", { 
        userId,
        email: email.slice(0, 3) + "****"
      });
      return res.status(400).json({ message: "No pending email verification. Please request a new verification code." });
    }

    // Check if OTP has expired
    const now = new Date();
    if (now > user.pinChangeOtpExpiresAt) {
      logger.warn("Expired email verification OTP", { 
        userId,
        email: email.slice(0, 3) + "****"
      });

      // Clean up expired OTP
      user.pinChangeOtp = null;
      user.pinChangeOtpCreatedAt = null;
      user.pinChangeOtpExpiresAt = null;
      user.pinChangeOtpVerified = false;
      await user.save();

      return res.status(400).json({ message: "Verification code has expired. Please request a new one." });
    }

    // Verify OTP
    if (user.pinChangeOtp !== otp) {
      logger.warn("Invalid email verification OTP", { 
        userId,
        email: email.slice(0, 3) + "****"
      });
      return res.status(400).json({ message: "Invalid verification code" });
    }

    // Update email if it's different from current
    const emailChanged = email !== user.email;
    if (emailChanged) {
      user.email = email;
    }

    // Mark email as verified
    user.emailVerified = true;
    user.kyc.level2.emailVerified = true;

    // Clear OTP fields
    user.pinChangeOtp = null;
    user.pinChangeOtpCreatedAt = null;
    user.pinChangeOtpExpiresAt = null;
    user.pinChangeOtpVerified = false;

    // Check if user can be auto-upgraded to KYC Level 2
    const wasUpgraded = await user.autoUpgradeKYC();

    await user.save();

    logger.info("Email verification completed successfully", {
      userId,
      email: email.slice(0, 3) + "****",
      emailChanged,
      kycUpgraded: wasUpgraded,
      newKycLevel: user.kycLevel
    });

    res.status(200).json({
      message: "Email verified successfully",
      emailChanged,
      kycLevel: user.kycLevel,
      kycStatus: user.kycStatus,
      kycUpgraded: wasUpgraded
    });

  } catch (error) {
    logger.error("Email verification complete error", {
      userId: req.user?.id,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ message: "Server error while completing email verification" });
  }
});

// GET: /api/email-verification/status - Get current email verification status
router.get("/status", async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId).select('email emailVerified kyc pinChangeOtpExpiresAt');
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const hasPendingVerification = !!(user.pinChangeOtpExpiresAt && user.pinChangeOtpExpiresAt > new Date());

    res.status(200).json({
      email: user.email,
      emailVerified: user.emailVerified,
      kycEmailVerified: user.kyc?.level2?.emailVerified || false,
      hasPendingVerification,
      pendingVerificationExpires: hasPendingVerification ? user.pinChangeOtpExpiresAt : null
    });

  } catch (error) {
    logger.error("Email verification status error", {
      userId: req.user?.id,
      error: error.message
    });
    res.status(500).json({ message: "Server error while fetching email verification status" });
  }
});

module.exports = router;