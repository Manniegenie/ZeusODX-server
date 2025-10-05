const express = require("express");
const { body, validationResult } = require("express-validator");
const router = express.Router();

const User = require("../models/user");
const logger = require("../utils/logger");

// Simple endpoint to unlock account by phone number
router.post(
  "/unlock-account",
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
  ],
  async (req, res) => {
    // Log the unlock request
    logger.info("Account unlock request", {
      phonenumber: req.body.phonenumber?.slice(0, 5) + "****",
      timestamp: new Date().toISOString(),
    });

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn("Validation errors during unlock", {
        errors: errors.array(),
        phonenumber: req.body.phonenumber?.slice(0, 5) + "****"
      });
      return res.status(400).json({ 
        message: "Validation failed.",
        errors: errors.array()
      });
    }

    const { phonenumber } = req.body;

    try {
      // Find user by phone number
      const user = await User.findOne({ phonenumber });

      if (!user) {
        logger.warn("Unlock attempt for non-existent user", { 
          phonenumber: phonenumber?.slice(0, 5) + "****" 
        });
        return res.status(404).json({ 
          message: "User not found." 
        });
      }

      // Check current lock status
      const isCurrentlyLocked = !!(user.lockUntil && user.lockUntil > Date.now());
      
      logger.info("User found for unlock", {
        userId: user._id,
        phonenumber: phonenumber?.slice(0, 5) + "****",
        currentLoginAttempts: user.loginAttempts,
        isCurrentlyLocked,
        lockUntil: user.lockUntil,
      });

      // Reset all lock-related fields
      const previousAttempts = user.loginAttempts;
      const previousLockUntil = user.lockUntil;

      user.loginAttempts = 0;
      user.lockUntil = null;
      user.failedLoginAttempts = 0;
      user.lastFailedLogin = null;

      // Save the changes
      await user.save();

      logger.info("Account unlocked successfully", {
        userId: user._id,
        phonenumber: phonenumber?.slice(0, 5) + "****",
        previousAttempts,
        previousLockUntil,
        wasLocked: isCurrentlyLocked,
      });

      // Return success response
      res.status(200).json({
        success: true,
        message: "Account unlocked successfully.",
        data: {
          userId: user._id,
          username: user.username,
          phonenumber: user.phonenumber,
          wasLocked: isCurrentlyLocked,
          previousLoginAttempts: previousAttempts,
          newLoginAttempts: 0,
          unlockTime: new Date().toISOString(),
        }
      });

    } catch (error) {
      logger.error("Error unlocking account", {
        error: error.message,
        stack: error.stack,
        phonenumber: phonenumber?.slice(0, 5) + "****",
      });
      
      res.status(500).json({ 
        success: false,
        message: "Server error during account unlock.",
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

module.exports = router;