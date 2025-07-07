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

    // Generate unique username from firstname + random 3 digits
    const generateUniqueUsername = async (firstname) => {
      const baseUsername = firstname.toLowerCase().replace(/[^a-zA-Z0-9]/g, ''); // Clean the firstname
      let attempts = 0;
      const maxAttempts = 10;
      
      while (attempts < maxAttempts) {
        const randomNumber = Math.floor(100 + Math.random() * 900); // Generate 3-digit number (100-999)
        const username = `${baseUsername}${randomNumber}`;
        
        // Check if username exists (case-insensitive)
        const existingUser = await User.exists({ 
          username: { $regex: new RegExp(`^${username}$`, 'i') }
        });
        
        if (!existingUser) {
          logger.info('Generated unique username', { username, attempts: attempts + 1, source: 'password-pin' });
          return username;
        }
        
        attempts++;
      }
      
      // Fallback if all attempts failed - use timestamp
      const timestamp = Date.now().toString().slice(-3);
      const fallbackUsername = `${baseUsername}${timestamp}`;
      logger.warn('Used fallback username generation', { 
        originalBase: baseUsername, 
        fallbackUsername, 
        source: 'password-pin' 
      });
      return fallbackUsername;
    };

    // Generate username
    const username = await generateUniqueUsername(pendingUser.firstname);

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

    // Add NGNB placeholder wallet as per your schema
    normalizedWallets["NGNB"] = {
      address: "PLACEHOLDER_FOR_NGNB_WALLET_ADDRESS",
      network: "PLACEHOLDER_FOR_NGNB_NETWORK",
      walletReferenceId: "PLACEHOLDER_FOR_NGNB_REFERENCE",
    };

    const now = new Date();
    
    // Create user document with KYC Level 1
    // Only use fields that exist in pendingUser model
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
      username, // Add the generated username
      password: null, // Explicitly set to null
      passwordpin: newPin, // Set the PIN - let the model handle hashing
      transactionpin: null,
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
    };

    const newUser = new User(userFields);

    // JWT tokens
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
    
    // FIXED: Add error handling for save operation
    try {
      await newUser.save();
    } catch (saveError) {
      logger.error('Error saving new user', { 
        error: saveError.message, 
        stack: saveError.stack,
        pendingUserId,
        username,
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

    logger.info('User created successfully with password PIN, username, and KYC Level 1', {
      userId: newUser._id,
      email: newUser.email,
      username: newUser.username, // Log the generated username
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
        email: newUser.email,
        phonenumber: newUser.phonenumber,
        firstname: newUser.firstname,
        lastname: newUser.lastname,
        username: newUser.username, // Include username in response
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
