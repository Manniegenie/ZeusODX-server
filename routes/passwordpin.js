const express = require('express');
const jwt = require("jsonwebtoken");
const router = express.Router();
const User = require('../models/user');
const PendingUser = require("../models/pendinguser");
const config = require("./config");
const logger = require('../utils/logger');
const generateWallets = require("../utils/generatewallets");

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
    const pendingUser = await PendingUser.findById(pendingUserId);
    if (!pendingUser) {
      logger.warn('Pending user not found', { pendingUserId, source: 'password-pin' });
      return res.status(404).json({ message: 'Pending user not found' });
    }

    if (!pendingUser.otpVerified) {
      logger.warn('OTP not verified', { pendingUserId, source: 'password-pin' });
      return res.status(400).json({ message: 'Phone number must be verified before setting PIN' });
    }

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
    const normalizedWallets = {};

    for (const [key, walletData] of Object.entries(rawWallets)) {
      const parts = key.split('_');
      let normalizedKey;

      if (parts.length === 2) {
        if (key === 'USDT_BSC' || key === 'USDT_TRX' || key === 'USDT_ETH') {
          normalizedKey = key;
        } else if (key === 'USDC_BSC' || key === 'USDC_ETH') {
          normalizedKey = key;
        } else {
          normalizedKey = key;
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

    normalizedWallets["NGNB"] = {
      address: "PLACEHOLDER_FOR_NGNB_WALLET_ADDRESS",
      network: "PLACEHOLDER_FOR_NGNB_NETWORK",
      walletReferenceId: "PLACEHOLDER_FOR_NGNB_REFERENCE",
    };

    const now = new Date();
    const { email, firstname, lastname, bvn, DoB, securitypin, username, phonenumber } = pendingUser;

    const userData = {
      email,
      firstname,
      lastname,
      phonenumber,
      bvn,
      DoB,
      password: null,
      passwordpin: newPin,
      transactionpin: null,
      securitypin,
      wallets: normalizedWallets,
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
    };

    // ✅ Only assign username if it’s truthy (not null or undefined)
    if (username) {
      userData.username = username;
    }

    const newUser = new User(userData);

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

    logger.info('User created successfully with password PIN and KYC Level 1', {
      userId: newUser._id,
      username: newUser.username,
      email: newUser.email,
      pinLength: newPin.length,
      source: 'password-pin',
      kycLevel: newUser.kycLevel
    });

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
