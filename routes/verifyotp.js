const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const User = require("../models/user");
const PendingUser = require("../models/pendinguser");
const config = require("./config");
const logger = require("../utils/logger");
const generateWallets = require("../utils/generatewallets");

router.post("/verify-otp", async (req, res) => {
  const { phonenumber, code } = req.body;

  if (!phonenumber || !code) {
    logger.warn("Missing phone number or code in verify-otp request");
    return res.status(400).json({ message: "Phone number and code are required." });
  }

  try {
    const pendingUser = await PendingUser.findOne({ phonenumber });

    if (!pendingUser) {
      logger.warn(`Pending user not found for phone number: ${phonenumber}`);
      return res.status(404).json({ message: "User or OTP request not found." });
    }

    // Validate OTP match
    if (pendingUser.verificationCode !== code) {
      logger.warn(`Invalid OTP for phone number: ${phonenumber}`);
      return res.status(401).json({ message: "Invalid verification code." });
    }

    // Check if OTP is expired
    const now = new Date();
    if (pendingUser.verificationCodeExpiresAt < now) {
      logger.warn(`Expired OTP for phone number: ${phonenumber}`);
      return res.status(401).json({ message: "Verification code has expired." });
    }

    // Generate wallets
    let generated = {};
    try {
      generated = await generateWallets(pendingUser.email, pendingUser._id);
    } catch (walletError) {
      logger.warn("Wallet creation failed", {
        error: walletError.message,
        stack: walletError.stack,
        userId: pendingUser._id,
      });
    }

    const rawWallets = generated.wallets || {};

    // Normalize wallet keys to match schema
    const normalizedWallets = {};
    for (const [key, walletData] of Object.entries(rawWallets)) {
      const parts = key.split('_');
      let normalizedKey;

      if (parts.length === 1) {
        normalizedKey = key;
      } else if (parts.length === 2) {
        // Adjust for schema keys (e.g., USDT_BSC -> USDT_BEP20)
        if (parts[0] === 'USDT' && parts[1] === 'BSC') {
          normalizedKey = 'USDT_BEP20';
        } else if (parts[0] === 'USDT' && parts[1] === 'TRX') {
          normalizedKey = 'USDT_TRX';
        } else if (parts[0] === 'USDT' && parts[1] === 'ETH') {
          normalizedKey = 'USDT_ETH';
        } else if (parts[0] === 'USDC' && parts[1] === 'BSC') {
          normalizedKey = 'USDC_BSC';
        } else if (parts[0] === 'USDC' && parts[1] === 'ETH') {
          normalizedKey = 'USDC_ETH';
        } else {
          normalizedKey = parts[0]; // e.g., BTC_BTC -> BTC
        }
      } else {
        normalizedKey = key;
      }

      normalizedWallets[normalizedKey] = {
        address: walletData.address,
        network: walletData.network,
        walletReferenceId: walletData.referenceId, // Include referenceId
      };
    }

    // Add NGNB placeholder wallet
    normalizedWallets["NGNB"] = {
      address: "PLACEHOLDER_FOR_NGNB_WALLET_ADDRESS",
      network: "PLACEHOLDER_FOR_NGNB_NETWORK",
      walletReferenceId: "PLACEHOLDER_FOR_NGNB_REFERENCE",
    };

    // Create user document
    const { email, firstname, lastname, bvn, DoB, securitypin, username } = pendingUser;
    const newUser = new User({
      username: username || null,
      email,
      firstname,
      lastname,
      phonenumber,
      bvn,
      DoB,
      password: null, // Explicitly set to null
      passwordpin: null,
      transactionpin: null,
      securitypin,
      wallets: normalizedWallets,
    });

    await newUser.save();

    // Generate JWT tokens with 2FA info
    const accessToken = jwt.sign(
      {
        id: newUser._id,
        email: newUser.email,
        username: newUser.username,
        is2FAEnabled: newUser.is2FAEnabled || false,
        is2FAVerified: newUser.is2FAVerified || false,
      },
      config.jwtSecret || process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const refreshToken = jwt.sign(
      { id: newUser._id },
      config.refreshjwtSecret || process.env.JWT_REFRESH_SECRET,
      { expiresIn: "7d" }
    );

    newUser.refreshTokens.push({ token: refreshToken, createdAt: new Date() });
    await newUser.save();

    logger.info(`User verified and created: ${newUser._id}`);

    // Remove pending user
    await PendingUser.deleteOne({ _id: pendingUser._id });

    res.status(200).json({
      message: "Phone number verified. Account activated.",
      user: {
        id: newUser._id,
        username: newUser.username,
        email,
        phonenumber,
        firstname,
        lastname,
      },
      accessToken,
      refreshToken,
    });
  } catch (error) {
    const errorMessage = error.message || "Unknown error";
    logger.error("Error during OTP verification flow", {
      error: errorMessage,
      stack: error.stack,
      phonenumber: phonenumber ? phonenumber.slice(0, 5) + "****" : "N/A",
    });
    res.status(500).json({ message: `Server error: ${errorMessage}` });
  }
});

module.exports = router;