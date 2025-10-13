const express = require("express");
const jwt = require("jsonwebtoken");
const speakeasy = require("speakeasy");
const { body, validationResult } = require("express-validator");
const router = express.Router();

const AdminUser = require("../models/admin");
const logger = require("../utils/logger");

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_TIME = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

// Admin JWT secrets validation function
const validateAdminJWTSecrets = () => {
  const adminJwtSecret = process.env.ADMIN_JWT_SECRET;
  const adminJwtRefreshSecret = process.env.ADMIN_REFRESH_JWT_SECRET;
  
  if (!adminJwtSecret) throw new Error('ADMIN_JWT_SECRET is not configured.');
  if (!adminJwtRefreshSecret) throw new Error('ADMIN_REFRESH_JWT_SECRET is not configured.');
  if (adminJwtSecret.length < 32) throw new Error('ADMIN_JWT_SECRET should be at least 32 characters long.');
  
  return { adminJwtSecret, adminJwtRefreshSecret };
};

// POST: /adminsignin/signin - Admin sign in with email and password pin
router.post(
  "/signin",
  [
    body("email")
      .trim()
      .notEmpty()
      .withMessage("Email is required.")
      .isEmail()
      .withMessage("Invalid email format.")
      .normalizeEmail(),
    body("passwordPin")
      .trim()
      .notEmpty()
      .withMessage("Password PIN is required.")
      .customSanitizer((value) => String(value).padStart(6, '0'))
      .custom((value) => {
        if (!/^\d{6}$/.test(value)) throw new Error("Password PIN must be exactly 6 digits.");
        return true;
      }),
    body("twoFactorCode")
      .trim()
      .notEmpty()
      .withMessage("2FA code is required.")
      .isLength({ min: 6, max: 6 })
      .withMessage("2FA code must be exactly 6 digits.")
      .matches(/^\d{6}$/)
      .withMessage("2FA code must contain only digits."),
  ],
  async (req, res) => {
    const startTime = Date.now();
    logger.info("Admin sign-in request initiated", { 
      email: req.body.email ? req.body.email.substring(0, 3) + "***@" + req.body.email.split('@')[1] : "unknown",
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn("Admin sign-in validation failed", { errors: errors.array() });
      return res.status(400).json({ 
        success: false, 
        message: "Validation failed.", 
        errors: errors.array() 
      });
    }

    const { email, passwordPin, twoFactorCode } = req.body;

    try {
      // Find admin user and validate 2FA
      const admin = await AdminUser.findOne({ email }).lean(false);
      if (!admin) {
        logger.warn("Admin sign-in attempt with non-existent email", { email });
        return res.status(404).json({ 
          success: false, 
          message: "Invalid admin credentials." 
        });
      }

      // Check if admin account is active
      if (!admin.isActive) {
        logger.warn("Sign-in attempt with deactivated admin account", { 
          adminId: admin._id, 
          email: admin.email 
        });
        return res.status(403).json({ 
          success: false, 
          message: "Admin account is deactivated. Contact super admin." 
        });
      }

      // Check if account is locked
      if (admin.lockUntil && admin.lockUntil > Date.now()) {
        const unlockTime = new Date(admin.lockUntil);
        const timeRemaining = Math.ceil((admin.lockUntil - Date.now()) / (60 * 1000));
        logger.warn("Sign-in attempt with locked admin account", { 
          adminId: admin._id, 
          unlockTime, 
          timeRemaining 
        });
        return res.status(423).json({
          success: false,
          message: `Admin account is locked due to multiple failed attempts. Try again after ${unlockTime.toLocaleString()}.`,
          lockedUntil: unlockTime.toISOString(),
          minutesRemaining: timeRemaining
        });
      }

      // Check if 2FA is enabled
      if (!admin.is2FAEnabled || !admin.twoFASecret) {
        logger.warn("Admin sign-in attempt without 2FA setup", { 
          adminId: admin._id, 
          email: admin.email 
        });
        return res.status(403).json({ 
          success: false, 
          message: "2FA is not set up. Please set up 2FA first.",
          require2FASetup: true
        });
      }

      // Validate password PIN
      let isValidPin = false;
      try {
        isValidPin = await admin.comparePasswordPin(passwordPin);
      } catch (bcryptError) {
        logger.error("Admin PIN comparison failed", { 
          adminId: admin._id, 
          error: bcryptError.message 
        });
        return res.status(500).json({ 
          success: false, 
          message: "Authentication system error. Please try again." 
        });
      }

      if (!isValidPin) {
        // Increment login attempts
        await admin.incLoginAttempts();
        
        const updatedAdmin = await AdminUser.findById(admin._id);
        const attemptsRemaining = MAX_LOGIN_ATTEMPTS - updatedAdmin.loginAttempts;
        
        logger.warn("Invalid admin PIN attempt", { 
          adminId: admin._id, 
          attempts: updatedAdmin.loginAttempts,
          attemptsRemaining 
        });

        if (updatedAdmin.lockUntil) {
          return res.status(423).json({
            success: false,
            message: "Admin account locked due to too many failed attempts. Try again in 2 hours.",
            lockedUntil: updatedAdmin.lockUntil.toISOString()
          });
        }

        return res.status(401).json({ 
          success: false, 
          message: `Invalid PIN. ${attemptsRemaining} attempt(s) remaining.` 
        });
      }

      // Validate 2FA token
      const verified = speakeasy.totp.verify({
        secret: admin.twoFASecret,
        encoding: 'base32',
        token: twoFactorCode,
        window: 2 // Allow for clock drift
      });

      if (!verified) {
        logger.warn("Invalid 2FA code during admin sign-in", { 
          adminId: admin._id, 
          email: admin.email 
        });
        return res.status(401).json({ 
          success: false, 
          message: "Invalid 2FA code" 
        });
      }

      // Reset login attempts on successful authentication
      await admin.resetLoginAttempts();

      // Validate JWT configuration
      let adminJwtSecrets;
      try {
        adminJwtSecrets = validateAdminJWTSecrets();
      } catch (jwtError) {
        logger.error("Admin JWT configuration error", { error: jwtError.message });
        return res.status(500).json({ 
          success: false, 
          message: "Authentication configuration error. Please contact support." 
        });
      }

      // Create token payload with admin-specific data
      const tokenPayload = { 
        id: admin._id, 
        email: admin.email, 
        adminName: admin.adminName,
        role: 'admin', // This identifies it as an admin token
        adminRole: admin.role, // This is the specific admin role (admin, super_admin, moderator)
        permissions: admin.permissions,
        isActive: admin.isActive
      };

      // Generate tokens
      const accessToken = jwt.sign(tokenPayload, adminJwtSecrets.adminJwtSecret, { expiresIn: "1h" });
      const refreshToken = jwt.sign(
        { id: admin._id, type: 'admin' }, 
        adminJwtSecrets.adminJwtRefreshSecret, 
        { expiresIn: "7d" }
      );

      // Store refresh token
      await admin.addRefreshToken(refreshToken);

      // Log successful admin login
      logger.info("Admin sign-in successful", { 
        adminId: admin._id, 
        email: admin.email,
        role: admin.role,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        duration: Date.now() - startTime 
      });

      // Return success response
      res.status(200).json({
        success: true,
        message: "Admin sign-in successful",
        accessToken,
        refreshToken,
        admin: {
          id: admin._id,
          adminName: admin.adminName,
          email: admin.email,
          role: admin.role,
          permissions: admin.permissions,
          lastSuccessfulLogin: admin.lastSuccessfulLogin,
          createdAt: admin.createdAt
        }
      });

    } catch (error) {
      logger.error("Critical error during admin sign-in", { 
        error: error.message, 
        stack: error.stack,
        email: req.body.email,
        duration: Date.now() - startTime 
      });
      
      res.status(500).json({ 
        success: false, 
        message: "Server error during admin sign-in. Please try again." 
      });
    }
  }
);

// POST: /adminsignin/refresh-token - Refresh admin access token
router.post("/refresh-token", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return res.status(401).json({ 
        success: false, 
        message: "Refresh token is required" 
      });
    }

    const adminJwtSecrets = validateAdminJWTSecrets();
    
    // Verify refresh token
    const decoded = jwt.verify(refreshToken, adminJwtSecrets.adminJwtRefreshSecret);
    
    if (decoded.type !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        message: "Invalid admin refresh token" 
      });
    }

    // Find admin and verify token exists
    const admin = await AdminUser.findById(decoded.id);
    if (!admin || !admin.isActive) {
      return res.status(404).json({ 
        success: false, 
        message: "Admin not found or deactivated" 
      });
    }

    const tokenExists = admin.refreshTokens.some(t => t.token === refreshToken);
    if (!tokenExists) {
      return res.status(403).json({ 
        success: false, 
        message: "Invalid refresh token" 
      });
    }

    // Generate new access token
    const tokenPayload = { 
      id: admin._id, 
      email: admin.email, 
      adminName: admin.adminName,
      role: 'admin',
      adminRole: admin.role,
      permissions: admin.permissions,
      isActive: admin.isActive
    };

    const newAccessToken = jwt.sign(tokenPayload, adminJwtSecrets.adminJwtSecret, { expiresIn: "1h" });

    res.json({
      success: true,
      accessToken: newAccessToken
    });

  } catch (error) {
    logger.error("Admin refresh token error", { error: error.message });
    res.status(403).json({ 
      success: false, 
      message: "Invalid or expired refresh token" 
    });
  }
});

// POST: /adminsignin/logout - Logout admin
router.post("/logout", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const authHeader = req.headers["authorization"];
    const accessToken = authHeader && authHeader.split(" ")[1];

    if (!accessToken) {
      return res.status(401).json({ 
        success: false, 
        message: "Access token required" 
      });
    }

    // Decode token to get admin ID (don't verify since it might be expired)
    const decoded = jwt.decode(accessToken);
    if (!decoded || decoded.role !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        message: "Invalid admin token" 
      });
    }

    const admin = await AdminUser.findById(decoded.id);
    if (admin && refreshToken) {
      await admin.removeRefreshToken(refreshToken);
      logger.info("Admin logged out", { adminId: admin._id, email: admin.email });
    }

    res.json({
      success: true,
      message: "Admin logged out successfully"
    });

  } catch (error) {
    logger.error("Admin logout error", { error: error.message });
    res.status(500).json({ 
      success: false, 
      message: "Logout error" 
    });
  }
});

module.exports = router;