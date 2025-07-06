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
          normalizedKey = 'USDT_BSC';
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

    // Only add NGNB if you have a real address, otherwise skip it
    // This prevents setting placeholder values that caused the original error
    if (generated.ngnbWallet && generated.ngnbWallet.address) {
      normalizedWallets["NGNB"] = {
        address: generated.ngnbWallet.address,
        network: generated.ngnbWallet.network || "NGNB_NETWORK",
        walletReferenceId: generated.ngnbWallet.referenceId || null,
      };
    }

    // Create user document with only essential fields from PendingUser
    const { 
      email, 
      firstname, 
      lastname, 
      phonenumber 
    } = pendingUser;

    const userFields = {
      email,
      firstname,
      lastname,
      phonenumber,
      passwordpin: newPin, // Set the PIN - let the model handle hashing
      wallets: normalizedWallets, // Include generated wallets
    };

    const newUser = new User(userFields);

    // JWT tokens - username not included since it's not set yet
    const accessToken = jwt.sign(
      {
        id: newUser._id,
        email: newUser.email,
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
    
    // Save user with error handling
    try {
      await newUser.save();
    } catch (saveError) {
      logger.error('Error saving new user', { 
        error: saveError.message, 
        stack: saveError.stack,
        pendingUserId,
        validationErrors: saveError.errors ? Object.keys(saveError.errors) : null,
        source: 'password-pin' 
      });
      
      // Handle specific validation errors
      if (saveError.name === 'ValidationError') {
        const errorMessages = Object.values(saveError.errors).map(err => err.message);
        return res.status(400).json({ 
          message: 'Validation failed', 
          errors: errorMessages 
        });
      }
      
      // Handle duplicate key errors
      if (saveError.code === 11000) {
        const duplicateField = Object.keys(saveError.keyPattern || {})[0];
        return res.status(400).json({ 
          message: `${duplicateField} already exists` 
        });
      }
      
      throw saveError; // Re-throw if not handled
    }

    logger.info('User created successfully with password PIN', {
      userId: newUser._id,
      email: newUser.email,
      pinLength: newPin.length,
      source: 'password-pin'
    });

    // Remove pending user after successful account creation
    await PendingUser.deleteOne({ _id: pendingUser._id });

    res.status(201).json({
      message: 'Account created successfully with password PIN.',
      user: {
        id: newUser._id,
        email: newUser.email,
        phonenumber: newUser.phonenumber,
        firstname: newUser.firstname,
        lastname: newUser.lastname
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