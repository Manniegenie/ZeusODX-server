const express = require("express");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const router = express.Router();

const User = require("../models/user");
const config = require("./config");
const logger = require("../utils/logger");
// const { sendLoginEmail } = require("../services/EmailService"); // COMMENTED OUT

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_TIME = 6 * 60 * 60 * 1000; // 6 hours in milliseconds

// JWT secrets validation function
const validateJWTSecrets = () => {
  const jwtSecret = config.jwtSecret || process.env.JWT_SECRET;
  const jwtRefreshSecret = config.jwtRefreshSecret || process.env.REFRESH_JWT_SECRET;
  
  if (!jwtSecret) throw new Error('JWT_SECRET is not configured. Set JWT_SECRET in environment variables or config.');
  if (!jwtRefreshSecret) throw new Error('REFRESH_JWT_SECRET is not configured. Set REFRESH_JWT_SECRET in environment variables or config.');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET should be at least 32 characters long for security.');
  
  return { jwtSecret, jwtRefreshSecret };
};

// POST: /signin-pin - Sign in with PIN
router.post(
  "/signin-pin",
  [
    body("phonenumber")
      .trim()
      .notEmpty()
      .withMessage("Phone number is required.")
      .custom((value) => {
        const phoneRegex = /^\+?\d{10,15}$/;
        if (!phoneRegex.test(value)) throw new Error("Invalid phone number format. Use format like +2348100000000 or 2348100000000.");
        return true;
      }),
    body("passwordpin")
      .trim()
      .customSanitizer((value) => String(value).padStart(6, '0'))
      .custom((value) => {
        if (!/^\d{6}$/.test(value)) throw new Error("Password pin must be 5-6 digits (will be padded to 6).");
        return true;
      }),
  ],
  async (req, res) => {
    const startTime = Date.now();
    logger.info("PIN sign-in request initiated", { phonenumber: req.body.phonenumber?.slice(0, 5) + "****" });

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: "Validation failed.", errors: errors.array() });
    }

    const { phonenumber, passwordpin } = req.body;

    try {
      const user = await User.findOne({ phonenumber }).lean(false);
      if (!user) return res.status(404).json({ success: false, message: "User not found." });

      // Check if account is locked
      if (user.lockUntil && user.lockUntil > Date.now()) {
        const unlockTime = new Date(user.lockUntil);
        const timeRemaining = Math.ceil((user.lockUntil - Date.now()) / (60 * 1000));
        return res.status(423).json({
          success: false,
          message: `Account is locked due to multiple failed attempts. Try again after ${unlockTime.toLocaleString()}.`,
          lockedUntil: unlockTime.toISOString(),
          minutesRemaining: timeRemaining
        });
      }

      if (!user.passwordpin) return res.status(401).json({ success: false, message: "Password PIN not set. Please set up your PIN first." });

      let isValidPin = false;
      try {
        isValidPin = await user.comparePasswordPin(passwordpin);
      } catch (bcryptError) {
        logger.error("PIN comparison failed", { userId: user._id, error: bcryptError.message });
        return res.status(500).json({ success: false, message: "Authentication system error. Please try again." });
      }

      if (!isValidPin) {
        const newAttemptCount = (user.loginAttempts || 0) + 1;
        user.loginAttempts = newAttemptCount;
        user.lastFailedLogin = new Date();
        if (newAttemptCount >= MAX_LOGIN_ATTEMPTS) {
          user.lockUntil = new Date(Date.now() + LOCK_TIME);
          await user.save();
          return res.status(423).json({
            success: false,
            message: "Account locked due to too many failed attempts. Try again in 6 hours.",
            lockedUntil: user.lockUntil.toISOString()
          });
        }
        await user.save();
        return res.status(401).json({ success: false, message: `Invalid PIN. ${MAX_LOGIN_ATTEMPTS - newAttemptCount} attempt(s) remaining.` });
      }

      // Reset attempts
      user.loginAttempts = 0;
      user.lockUntil = null;
      user.lastFailedLogin = null;
      await user.save();

      // Validate JWT configuration
      let jwtSecrets;
      try {
        jwtSecrets = validateJWTSecrets();
      } catch (jwtError) {
        return res.status(500).json({ success: false, message: "Authentication configuration error. Please contact support." });
      }

      const tokenPayload = { id: user._id, email: user.email, username: user.username, kycLevel: user.kycLevel };
      const accessToken = jwt.sign(tokenPayload, jwtSecrets.jwtSecret, { expiresIn: "1h" });
      const refreshToken = jwt.sign({ id: user._id }, jwtSecrets.jwtRefreshSecret, { expiresIn: "7d" });

      // Store refresh token (keep only last 5 tokens)
      user.refreshTokens.push({ token: refreshToken, createdAt: new Date() });
      if (user.refreshTokens.length > 5) user.refreshTokens = user.refreshTokens.slice(-5);
      await user.save();

      // **Send login email** - COMMENTED OUT
      /*
      try {
        const device = req.get('User-Agent') || "Unknown Device";
        const location = req.ip || "Unknown Location";
        const time = new Date().toLocaleString();
        await sendLoginEmail(user.email, user.firstname || user.username || "User", device, location, time);
        logger.info("Login email sent", { userId: user._id, email: user.email });
      } catch (emailError) {
        logger.error("Failed to send login email", { userId: user._id, error: emailError.message });
      }
      */

      res.status(200).json({
        success: true,
        message: "Sign-in successful",
        accessToken,
        refreshToken,
        user: {
          id: user._id,
          email: user.email,
          firstname: user.firstname,
          lastname: user.lastname,
          username: user.username,
          phonenumber: user.phonenumber,
          kycLevel: user.kycLevel,
          kycStatus: user.kycStatus,
          walletGenerationStatus: user.walletGenerationStatus,
          avatarUrl: user.avatarUrl
        }
      });
    } catch (error) {
      logger.error("Critical error during PIN sign-in", { error: error.message, stack: error.stack });
      res.status(500).json({ success: false, message: "Server error during sign-in. Please try again." });
    }
  }
);

module.exports = router;