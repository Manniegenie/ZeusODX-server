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

router.post(
  "/signin-pin",
  [
    body("phonenumber")
      .trim()
      .notEmpty()
      .withMessage("Phone number is required.")
      .isMobilePhone()
      .withMessage("Invalid phone number."),
    body("passwordpin")
      .trim()
      .notEmpty()
      .withMessage("Password pin is required.")
      .isLength({ min: 4, max: 6 })
      .withMessage("Password pin must be between 4 and 6 digits."),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { phonenumber, passwordpin } = req.body;

    try {
      const user = await User.findOne({ phonenumber });

      if (!user) {
        return res.status(404).json({ message: "User not found." });
      }

      // Check if account is locked
      if (user.lockUntil && user.lockUntil > Date.now()) {
        const unlockTime = new Date(user.lockUntil).toLocaleString();
        return res.status(403).json({
          message: `Account is locked due to multiple failed attempts. Try again after ${unlockTime}.`,
        });
      }

      if (!user.passwordpin) {
        return res.status(401).json({ message: "Password pin not set." });
      }

      const isValidPin = await bcrypt.compare(passwordpin, user.passwordpin);

      if (!isValidPin) {
        user.loginAttempts = (user.loginAttempts || 0) + 1;

        if (user.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
          user.lockUntil = Date.now() + LOCK_TIME;
          await user.save();
          logger.warn("Account locked due to failed attempts", { userId: user._id });
          return res.status(403).json({
            message: "Account locked due to too many failed attempts. Try again in 6 hours.",
          });
        }

        await user.save();
        return res.status(401).json({
          message: `Invalid password pin. ${MAX_LOGIN_ATTEMPTS - user.loginAttempts} attempt(s) left.`,
        });
      }

      // Reset login attempts on successful login
      user.loginAttempts = 0;
      user.lockUntil = null;

      const accessToken = jwt.sign(
        { id: user._id, email: user.email, username: user.username },
        config.jwtSecret || process.env.JWT_SECRET,
        { expiresIn: "1h" }
      );

      const refreshToken = jwt.sign(
        { id: user._id },
        config.jwtRefreshSecret || process.env.JWT_REFRESH_SECRET,
        { expiresIn: "7d" }
      );

      user.refreshTokens.push({ token: refreshToken, createdAt: new Date() });
      await user.save();

      const portfolio = await getUserPortfolioBalance(user._id);

      logger.info(`User signed in with PIN: ${user._id}`);

      res.status(200).json({
        message: "Signed in successfully.",
        user: {
          id: user._id,
          username: user.username,
          email: user.email,
          phonenumber: user.phonenumber,
          firstname: user.firstname,
          lastname: user.lastname,
        },
        accessToken,
        refreshToken,
        portfolio,
      });
    } catch (error) {
      logger.error("Error during PIN sign-in", {
        error: error.message,
        stack: error.stack,
        phonenumber: phonenumber?.slice(0, 5) + "****",
      });
      res.status(500).json({ message: "Server error during sign-in." });
    }
  }
);

module.exports = router;
