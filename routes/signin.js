const express = require("express");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const router = express.Router();

const User = require("../models/user");
const config = require("./config");
const logger = require("../utils/logger");

const MAX_LOGIN_ATTEMPTS = 3;
const LOCK_TIME = 6 * 60 * 60 * 1000; // 6 hours in milliseconds

// JWT secrets validation function
const validateJWTSecrets = () => {
  const jwtSecret = config.jwtSecret || process.env.JWT_SECRET;
  const jwtRefreshSecret = config.jwtRefreshSecret || process.env.REFRESH_JWT_SECRET;
  
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is not configured. Set JWT_SECRET in environment variables or config.');
  }
  
  if (!jwtRefreshSecret) {
    throw new Error('REFRESH_JWT_SECRET is not configured. Set REFRESH_JWT_SECRET in environment variables or config.');
  }
  
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET should be at least 32 characters long for security.');
  }
  
  return { jwtSecret, jwtRefreshSecret };
};

// POST: /signin-pin - Sign in with PIN (handles leading zeros)
router.post(
  "/signin-pin",
  [
    body("phonenumber")
      .trim()
      .notEmpty()
      .withMessage("Phone number is required.")
      .custom((value) => {
        const phoneRegex = /^\+?\d{10,15}$/;
        if (!phoneRegex.test(value)) {
          throw new Error("Invalid phone number format. Use format like +2348100000000 or 2348100000000.");
        }
        return true;
      }),
    body("passwordpin")
      .trim()
      .customSanitizer((value) => {
        // Convert to string and pad with leading zeros to make it 6 digits
        return String(value).padStart(6, '0');
      })
      .custom((value) => {
        // After sanitization, verify it's exactly 6 digits
        if (!/^\d{6}$/.test(value)) {
          throw new Error("Password pin must be 5-6 digits (will be padded to 6).");
        }
        return true;
      }),
  ],
  async (req, res) => {
    const startTime = Date.now();

    // Log signin attempt with masked phone number
    logger.info("PIN sign-in request initiated", {
      phonenumber: req.body.phonenumber?.slice(0, 5) + "****",
      originalPinLength: req.body.passwordpin?.toString().length,
      sanitizedPinLength: req.body.passwordpin?.length,
      userAgent: req.get('User-Agent'),
      ip: req.ip || req.connection.remoteAddress,
      timestamp: new Date().toISOString()
    });

    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn("Input validation failed", {
        errors: errors.array(),
        phonenumber: req.body.phonenumber?.slice(0, 5) + "****"
      });
      return res.status(400).json({ 
        success: false,
        message: "Validation failed.",
        errors: errors.array()
      });
    }

    const { phonenumber, passwordpin } = req.body;

    // Log the PIN processing details
    logger.info("PIN processing details", {
      phonenumber: phonenumber?.slice(0, 5) + "****",
      processedPin: passwordpin,
      pinLength: passwordpin.length,
      isString: typeof passwordpin === 'string'
    });

    try {
      // Find user by phone number
      const user = await User.findOne({ phonenumber }).lean(false);

      if (!user) {
        logger.warn("User not found for PIN sign-in", { 
          phonenumber: phonenumber?.slice(0, 5) + "****" 
        });
        return res.status(404).json({ 
          success: false,
          message: "User not found." 
        });
      }

      // Check if account is locked
      if (user.lockUntil && user.lockUntil > Date.now()) {
        const unlockTime = new Date(user.lockUntil);
        const timeRemaining = Math.ceil((user.lockUntil - Date.now()) / (60 * 1000));
        
        logger.warn("Sign-in blocked - account locked", { 
          userId: user._id,
          lockUntil: user.lockUntil,
          unlockTime: unlockTime.toISOString(),
          minutesRemaining: timeRemaining
        });
        
        return res.status(423).json({
          success: false,
          message: `Account is locked due to multiple failed attempts. Try again after ${unlockTime.toLocaleString()}.`,
          lockedUntil: unlockTime.toISOString(),
          minutesRemaining: timeRemaining
        });
      }

      // Check if PIN is set
      if (!user.passwordpin) {
        logger.warn("PIN not set for user attempting sign-in", { 
          userId: user._id,
          hasRegularPassword: !!user.password 
        });
        return res.status(401).json({ 
          success: false,
          message: "Password PIN not set. Please set up your PIN first." 
        });
      }

      // Verify PIN using model method
      let isValidPin = false;
      try {
        isValidPin = await user.comparePasswordPin(passwordpin);
        
        logger.info("PIN comparison completed", {
          userId: user._id,
          comparisonResult: isValidPin,
          pinMethod: 'comparePasswordPin',
          inputPinLength: passwordpin.length
        });
      } catch (bcryptError) {
        logger.error("PIN comparison failed", {
          userId: user._id,
          error: bcryptError.message,
          stack: bcryptError.stack
        });
        
        return res.status(500).json({
          success: false,
          message: "Authentication system error. Please try again."
        });
      }

      // Handle invalid PIN
      if (!isValidPin) {
        const newAttemptCount = (user.loginAttempts || 0) + 1;
        const attemptsRemaining = MAX_LOGIN_ATTEMPTS - newAttemptCount;
        
        logger.warn("PIN authentication failed", {
          userId: user._id,
          previousAttempts: user.loginAttempts || 0,
          newAttemptCount,
          attemptsRemaining,
          willLockAccount: newAttemptCount >= MAX_LOGIN_ATTEMPTS,
          inputPin: passwordpin,
          inputPinLength: passwordpin.length
        });

        // Update failed attempt count
        user.loginAttempts = newAttemptCount;
        user.lastFailedLogin = new Date();

        // Lock account if max attempts reached
        if (newAttemptCount >= MAX_LOGIN_ATTEMPTS) {
          user.lockUntil = new Date(Date.now() + LOCK_TIME);
          await user.save();
          
          logger.warn("Account locked due to failed PIN attempts", { 
            userId: user._id,
            totalAttempts: newAttemptCount,
            lockedUntil: user.lockUntil.toISOString()
          });
          
          return res.status(423).json({
            success: false,
            message: "Account locked due to too many failed attempts. Try again in 6 hours.",
            lockedUntil: user.lockUntil.toISOString()
          });
        }

        // Save updated attempt count
        await user.save();
        
        return res.status(401).json({
          success: false,
          message: `Invalid PIN. ${attemptsRemaining} attempt(s) remaining.`,
          attemptsRemaining
        });
      }

      // PIN is valid - reset login attempts
      logger.info("PIN verification successful - resetting attempts", {
        userId: user._id,
        previousAttempts: user.loginAttempts || 0
      });

      user.loginAttempts = 0;
      user.lockUntil = null;
      user.lastFailedLogin = null;
      await user.save();

      // Validate JWT configuration
      let jwtSecrets;
      try {
        jwtSecrets = validateJWTSecrets();
        logger.info("JWT secrets validated successfully", {
          userId: user._id
        });
      } catch (jwtError) {
        logger.error("JWT configuration error", {
          userId: user._id,
          error: jwtError.message,
        });
        
        return res.status(500).json({
          success: false,
          message: "Authentication configuration error. Please contact support.",
          errorId: Date.now().toString(36)
        });
      }

      // Create JWT tokens
      const tokenPayload = { 
        id: user._id,
        email: user.email,
        username: user.username,
        kycLevel: user.kycLevel
      };

      let accessToken, refreshToken;
      try {
        accessToken = jwt.sign(
          tokenPayload,
          jwtSecrets.jwtSecret,
          { expiresIn: "1h" }
        );

        refreshToken = jwt.sign(
          { id: user._id },
          jwtSecrets.jwtRefreshSecret,
          { expiresIn: "7d" }
        );

        logger.info("JWT tokens generated successfully", {
          userId: user._id,
          tokenPayloadKeys: Object.keys(tokenPayload)
        });

      } catch (tokenError) {
        logger.error("JWT token generation failed", {
          userId: user._id,
          error: tokenError.message,
        });
        
        return res.status(500).json({
          success: false,
          message: "Failed to generate authentication tokens. Please try again.",
          errorId: Date.now().toString(36)
        });
      }

      // Store refresh token (keep only last 5 tokens)
      user.refreshTokens.push({ 
        token: refreshToken, 
        createdAt: new Date() 
      });

      if (user.refreshTokens.length > 5) {
        user.refreshTokens = user.refreshTokens.slice(-5);
      }

      await user.save();

      const processingTime = Date.now() - startTime;

      logger.info("PIN sign-in completed successfully", {
        userId: user._id,
        email: user.email,
        username: user.username,
        kycLevel: user.kycLevel,
        processingTimeMs: processingTime
      });

      // Return success response
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
      const processingTime = Date.now() - startTime;
      
      logger.error("Critical error during PIN sign-in", {
        error: error.message,
        stack: error.stack,
        phonenumber: phonenumber?.slice(0, 5) + "****",
        processingTimeMs: processingTime,
        errorType: error.constructor.name
      });
      
      res.status(500).json({ 
        success: false,
        message: "Server error during sign-in. Please try again.",
        errorId: Date.now().toString(36)
      });
    }
  }
);

module.exports = router;