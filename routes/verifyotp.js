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
        if (parts[0] === 'USDT' && parts[1] === 'BSC') {
          normalizedKey = 'USDT_BSC'; // FIXED: match your schema key
        } else if (parts[0] === 'USDT' && parts[1] === 'TRX') {
          normalizedKey = 'USDT_TRX';
        } else if (parts[0] === 'USDT' && parts[1] === 'ETH') {
          normalizedKey = 'USDT_ETH';
        } else if (parts[0] === 'USDC' && parts[1] === 'BSC') {
          normalizedKey = 'USDC_BSC';
        } else if (parts[0] === 'USDC' && parts[1] === 'ETH') {
          normalizedKey = 'USDC_ETH';
        } else {
          normalizedKey = key; // e.g., BTC_BTC, ETH_ETH, SOL_SOL
        }
      } else {
        normalizedKey = key;
      }

      if (walletData && walletData.address) {
        normalizedWallets[normalizedKey] = {
          address: walletData.address,
          network: walletData.network,
          walletReferenceId: walletData.referenceId || null,
        };
      }
    }

    // Add NGNB placeholder wallet as per your schema
    normalizedWallets["NGNB"] = {
      address: "PLACEHOLDER_FOR_NGNB_WALLET_ADDRESS",
      network: "PLACEHOLDER_FOR_NGNB_NETWORK",
      walletReferenceId: "PLACEHOLDER_FOR_NGNB_REFERENCE",
    };

    // Create user document with KYC Level 1
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
      securitypin, // Make sure this field exists in your schema or remove it
      wallets: normalizedWallets,
      // Set KYC Level 1 upon successful phone verification
      kycLevel: 1,
      kycStatus: 'approved',
      kyc: {
        level1: {
          status: 'approved',
          submittedAt: now,
          approvedAt: now,
          rejectedAt: null,
          rejectionReason: null
        },
        level2: {
          status: 'not_submitted',
          submittedAt: null,
          approvedAt: null,
          rejectedAt: null,
          rejectionReason: null,
          documentType: null,
          documentNumber: null
        },
        level3: {
          status: 'not_submitted',
          submittedAt: null,
          approvedAt: null,
          rejectedAt: null,
          rejectionReason: null,
          addressVerified: false,
          sourceOfFunds: null
        }
      }
    });

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

    // Add refresh token to user before saving once
    newUser.refreshTokens.push({ token: refreshToken, createdAt: new Date() });
    await newUser.save();

    logger.info(`User verified and created with KYC Level 1: ${newUser._id}`);

    // Remove pending user
    await PendingUser.deleteOne({ _id: pendingUser._id });

    res.status(200).json({
      message: "Phone number verified. Account activated with KYC Level 1.",
      user: {
        id: newUser._id,
        username: newUser.username,
        email,
        phonenumber,
        firstname,
        lastname,
        kycLevel: newUser.kycLevel,
        kycStatus: newUser.kycStatus
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
