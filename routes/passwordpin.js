const express = require('express');
const jwt = require("jsonwebtoken");
const router = express.Router();
const User = require('../models/user');
const PendingUser = require("../models/pendinguser");
const config = require("./config");
const logger = require('../utils/logger');
const generateWallets = require("../utils/generatewallets");

// POST: /api/admin/password-pin
router.post('/password-pin', async (req, res) => {
  const { newPin, renewPin, pendingUserId } = req.body;

  if (!pendingUserId) {
    return res.status(400).json({ message: 'Pending user ID is required' });
  }

  if (!newPin || !renewPin) {
    logger.warn('Missing required fields', { pendingUserId, source: 'password-pin' });
    return res.status(400).json({ message: 'Fields newPin and renewPin are required' });
  }

  if (newPin !== renewPin) {
    logger.warn('PIN mismatch', { pendingUserId, source: 'password-pin' });
    return res.status(400).json({ message: 'PINs do not match' });
  }

  if (!/^\d{6}$/.test(newPin)) {
    logger.warn('Invalid PIN format', { pendingUserId, source: 'password-pin' });
    return res.status(400).json({ message: 'Password PIN must be exactly 6 digits' });
  }

  try {
    // Find the pending user
    const pendingUser = await PendingUser.findById(pendingUserId);
    if (!pendingUser) {
      logger.warn('Pending user not found', { pendingUserId, source: 'password-pin' });
      return res.status(404).json({ message: 'Pending user not found' });
    }

    // Check if OTP was verified
    if (!pendingUser.otpVerified) {
      logger.warn('OTP not verified', { pendingUserId, source: 'password-pin' });
      return res.status(400).json({ message: 'Phone number must be verified before setting PIN' });
    }

    // No need to check if user exists - signup route already handled this

    // Generate wallets
    let generated = {};
    try {
      generated = await generateWallets(pendingUser.email, pendingUser._id);
    } catch (walletError) {
      logger.warn("Wallet creation failed", {
        error: walletError.message,
        stack: walletError.stack,
        pendingUserId: pendingUser._id,
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

    const now = new Date();
    
    // Create user document with KYC Level 1
    const { email, firstname, lastname, bvn, DoB, securitypin, username, phonenumber } = pendingUser;
    const newUser = new User({
      username: username || null,
      email,
      firstname,
      lastname,
      phonenumber,
      bvn,
      DoB,
      password: null, // Explicitly set to null
      passwordpin: newPin, // Set the PIN - let the model handle hashing
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

    // Add refresh token to user before saving
    newUser.refreshTokens.push({ token: refreshToken, createdAt: new Date() });
    await newUser.save();

    logger.info('User created successfully with password PIN and KYC Level 1', {
      userId: newUser._id,
      username: newUser.username,
      email: newUser.email,
      pinLength: newPin.length,
      source: 'password-pin',
      kycLevel: newUser.kycLevel
    });

    // Remove pending user after successful account creation
    await PendingUser.deleteOne({ _id: pendingUser._id });

    res.status(201).json({
      message: 'Account created successfully with password PIN and KYC Level 1.',
      user: {
        id: newUser._id,
        username: newUser.username,
        email: newUser.email,
        phonenumber: newUser.phonenumber,
        firstname: newUser.firstname,
        lastname: newUser.lastname,
        kycLevel: newUser.kycLevel,
        kycStatus: newUser.kycStatus
      },
      accessToken,
      refreshToken,
    });

  } catch (error) {
    logger.error('Error creating user account with password PIN', { 
      error: error.message, 
      stack: error.stack,
      pendingUserId, 
      source: 'password-pin' 
    });
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;