const express = require("express");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const bcrypt = require("bcryptjs");
const router = express.Router();

const User = require("../models/user");
const config = require("./config");
const logger = require("../utils/logger");
const { getUserPortfolioBalance } = require("../services/portfolio");

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
      .notEmpty()
      .withMessage("Password pin is required.")
      .isLength({ min: 4, max: 6 })
      .withMessage("Password pin must be between 4 and 6 digits.")
      .isNumeric()
      .withMessage("Password pin must contain only numbers."),
  ],
  async (req, res) => {
    const startTime = Date.now();
    
    // Enhanced request logging
    logger.info("PIN sign-in request initiated", {
      phonenumber: req.body.phonenumber?.slice(0, 5) + "****",
      pinLength: req.body.passwordpin?.length,
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

      // Log user details for debugging
      logger.info("User located for PIN authentication", {
        userId: user._id,
        username: user.username,
        kycLevel: user.kycLevel,
        currentLoginAttempts: user.loginAttempts || 0,
        hasPasswordPin: !!user.passwordpin,
        passwordPinExists: user.passwordpin ? true : false,
        isAccountCurrentlyLocked: !!(user.lockUntil && user.lockUntil > Date.now()),
        lockUntil: user.lockUntil
      });

      // Check account lock status
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

      // Verify PIN exists
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

      // Detailed PIN comparison logging
      logger.info("Attempting PIN verification", {
        userId: user._id,
        inputPinLength: passwordpin.length,
        inputPinType: typeof passwordpin,
        storedHashLength: user.passwordpin.length,
        storedHashPrefix: user.passwordpin.substring(0, 7),
        // Remove in production - for debugging only
        inputPinSample: passwordpin.substring(0, 2) + "****"
      });

      // Compare PIN with stored hash
      let isValidPin = false;
      try {
        isValidPin = await bcrypt.compare(passwordpin.toString(), user.passwordpin);
        
        logger.info("PIN comparison completed", {
          userId: user._id,
          comparisonResult: isValidPin,
          pinMatched: isValidPin
        });
      } catch (bcryptError) {
        logger.error("Bcrypt comparison failed", {
          userId: user._id,
          error: bcryptError.message,
          inputType: typeof passwordpin,
          hashType: typeof user.passwordpin
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
          willLockAccount: newAttemptCount >= MAX_LOGIN_ATTEMPTS
        });

        // Update login attempts
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

        await user.save();
        
        return res.status(401).json({
          success: false,
          message: `Invalid PIN. ${attemptsRemaining} attempt(s) remaining.`,
          attemptsRemaining
        });
      }

      // Successful PIN verification - reset login attempts
      logger.info("PIN verification successful - resetting attempts", {
        userId: user._id,
        previousAttempts: user.loginAttempts || 0
      });

      user.loginAttempts = 0;
      user.lockUntil = null;
      user.lastFailedLogin = null;
      await user.save();

      // Validate JWT secrets before token generation
      let jwtSecrets;
      try {
        jwtSecrets = validateJWTSecrets();
        logger.info("JWT secrets validated successfully", {
          userId: user._id,
          secretsConfigured: true
        });
      } catch (jwtError) {
        logger.error("JWT configuration error", {
          userId: user._id,
          error: jwtError.message,
          jwtSecretExists: !!(config.jwtSecret || process.env.JWT_SECRET),
          refreshJwtSecretExists: !!(config.jwtRefreshSecret || process.env.REFRESH_JWT_SECRET)
        });
        
        return res.status(500).json({
          success: false,
          message: "Authentication configuration error. Please contact support.",
          errorId: Date.now().toString(36)
        });
      }

      // Generate JWT tokens with validated secrets
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
          accessTokenLength: accessToken.length,
          refreshTokenLength: refreshToken.length
        });

      } catch (tokenError) {
        logger.error("JWT token generation failed", {
          userId: user._id,
          error: tokenError.message,
          tokenPayload: {
            id: !!tokenPayload.id,
            email: !!tokenPayload.email,
            username: !!tokenPayload.username,
            kycLevel: tokenPayload.kycLevel
          }
        });
        
        return res.status(500).json({
          success: false,
          message: "Failed to generate authentication tokens. Please try again.",
          errorId: Date.now().toString(36)
        });
      }

      // Store refresh token
      user.refreshTokens.push({ 
        token: refreshToken, 
        createdAt: new Date() 
      });

      // Clean up old refresh tokens (keep last 5)
      if (user.refreshTokens.length > 5) {
        user.refreshTokens = user.refreshTokens.slice(-5);
      }

      await user.save();

      // Get user portfolio
      let portfolio = null;
      try {
        portfolio = await getUserPortfolioBalance(user._id);
        logger.info("Portfolio retrieved successfully", {
          userId: user._id,
          totalBalance: portfolio?.totalPortfolioUSD || 0,
          tokenCount: portfolio?.tokens?.length || 0
        });
      } catch (portfolioError) {
        logger.error("Failed to retrieve portfolio", {
          userId: user._id,
          error: portfolioError.message
        });
        // Continue without portfolio - don't fail the login
      }

      const processingTime = Date.now() - startTime;
      
      logger.info("PIN sign-in completed successfully", { 
        userId: user._id,
        username: user.username,
        processingTimeMs: processingTime,
        portfolioRetrieved: !!portfolio,
        refreshTokenCount: user.refreshTokens.length
      });

      // Return success response
      res.status(200).json({
        success: true,
        message: "Signed in successfully.",
        user: {
          id: user._id,
          username: user.username,
          email: user.email,
          phonenumber: user.phonenumber,
          firstname: user.firstname,
          lastname: user.lastname,
          kycLevel: user.kycLevel,
          kycStatus: user.kycStatus
        },
        accessToken,
        refreshToken,
        portfolio: portfolio || {
          totalPortfolioUSD: 0,
          tokens: [],
          lastUpdated: null
        },
        loginTime: new Date().toISOString()
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
        errorId: Date.now().toString(36) // For tracking
      });
    }
  }
);

module.exports = router;