const express = require('express');
const jwt = require("jsonwebtoken");
const router = express.Router();
const User = require('../models/user');
const PendingUser = require("../models/pendinguser");
const config = require("./config");
const logger = require('../utils/logger');
const generateWallets = require("../utils/generatewallets");

// Function to generate unique username from first name
const generateUniqueUsername = async (firstName) => {
  try {
    // Clean and format the first name
    const baseUsername = firstName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '') // Remove special characters and spaces
      .substring(0, 10); // Limit to 10 characters
    
    // If baseUsername is empty or too short, use a default
    const cleanBase = baseUsername.length >= 2 ? baseUsername : 'user';
    
    // Try the base username first
    let attempts = 0;
    const maxAttempts = 50;
    
    while (attempts < maxAttempts) {
      let candidateUsername;
      
      if (attempts === 0) {
        // First attempt: try just the clean first name
        candidateUsername = cleanBase;
      } else {
        // Subsequent attempts: add random numbers
        const randomSuffix = Math.floor(Math.random() * 9999) + 1;
        candidateUsername = `${cleanBase}${randomSuffix}`;
      }
      
      // Check if username already exists
      const existingUser = await User.findOne({ username: candidateUsername });
      
      if (!existingUser) {
        logger.info('Generated unique username', { 
          firstName, 
          generatedUsername: candidateUsername, 
          attempts: attempts + 1 
        });
        return candidateUsername;
      }
      
      attempts++;
    }
    
    // Fallback: use timestamp if all attempts failed
    const fallbackUsername = `${cleanBase}${Date.now().toString().slice(-6)}`;
    logger.warn('Using fallback username generation', { 
      firstName, 
      fallbackUsername, 
      attempts 
    });
    return fallbackUsername;
    
  } catch (error) {
    logger.error('Error generating username', { firstName, error: error.message });
    // Ultimate fallback
    return `user${Date.now().toString().slice(-6)}`;
  }
};

// Background wallet generation function
const generateWalletsInBackground = async (userId, email) => {
  try {
    logger.info('Starting background wallet generation', { userId, email });
    
    // Update user status to in_progress
    await User.findByIdAndUpdate(userId, {
      walletGenerationStatus: 'in_progress',
      walletGenerationStartedAt: new Date()
    });

    // Generate wallets
    const generated = await generateWallets(email, userId);
    const rawWallets = generated.wallets || {};

    // Normalize wallet keys to match schema - DOGE REMOVED
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
        } else if (parts[0] === 'BNB' && parts[1] === 'ETH') {
          normalizedKey = 'BNB_ETH';
        } else if (parts[0] === 'BNB' && parts[1] === 'BSC') {
          normalizedKey = 'BNB_BSC';
        } else if (parts[0] === 'MATIC' && parts[1] === 'ETH') {
          normalizedKey = 'MATIC_ETH';
        } else if (parts[0] === 'AVAX' && parts[1] === 'BSC') {
          normalizedKey = 'AVAX_BSC';
        } else {
          normalizedKey = key; // e.g., BTC_BTC, ETH_ETH, SOL_SOL
        }
        // DOGE_DOGE case REMOVED
      } else {
        normalizedKey = key;
      }

      if (walletData && walletData.address) {
        normalizedWallets[`wallets.${normalizedKey}`] = {
          address: walletData.address,
          network: walletData.network,
          walletReferenceId: walletData.referenceId || null,
        };
      }
    }

    // Update user with wallet addresses
    const updateData = {
      ...normalizedWallets,
      walletGenerationStatus: 'completed',
      walletGenerationCompletedAt: new Date()
    };

    await User.findByIdAndUpdate(userId, updateData);

    logger.info('Background wallet generation completed successfully', {
      userId,
      email,
      successfulWallets: Object.keys(normalizedWallets).length,
      totalRequested: generated.totalRequested,
      successfullyCreated: generated.successfullyCreated
    });

  } catch (error) {
    logger.error('Background wallet generation failed', {
      userId,
      email,
      error: error.message,
      stack: error.stack
    });

    // Update user status to failed
    await User.findByIdAndUpdate(userId, {
      walletGenerationStatus: 'failed',
      walletGenerationCompletedAt: new Date()
    });
  }
};

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

    const now = new Date();
    
    // Create user document with KYC Level 1
    // Only use fields that exist in pendingUser model
    const { 
      email, 
      firstname, 
      lastname, 
      phonenumber 
    } = pendingUser;

    // Generate unique username from first name
    const generatedUsername = await generateUniqueUsername(firstname);

    const userFields = {
      email,
      firstname,
      lastname,
      phonenumber,
      username: generatedUsername, // Set the generated username
      isUsernameCustom: false, // Mark as auto-generated (allows one update)
      password: null, // Explicitly set to null
      passwordpin: newPin, // Set the PIN - let the model handle hashing
      transactionpin: null,
      wallets: {
        // Initialize empty wallet structure - DOGE_DOGE REMOVED
        BTC_BTC: { address: null, network: null, walletReferenceId: null },
        ETH_ETH: { address: null, network: null, walletReferenceId: null },
        SOL_SOL: { address: null, network: null, walletReferenceId: null },
        USDT_ETH: { address: null, network: null, walletReferenceId: null },
        USDT_TRX: { address: null, network: null, walletReferenceId: null },
        USDT_BSC: { address: null, network: null, walletReferenceId: null },
        USDC_ETH: { address: null, network: null, walletReferenceId: null },
        USDC_BSC: { address: null, network: null, walletReferenceId: null },
        BNB_ETH: { address: null, network: null, walletReferenceId: null },
        BNB_BSC: { address: null, network: null, walletReferenceId: null },
        // DOGE_DOGE: REMOVED COMPLETELY
        MATIC_ETH: { address: null, network: null, walletReferenceId: null },
        AVAX_BSC: { address: null, network: null, walletReferenceId: null },
        NGNZ: {
          address: "PLACEHOLDER_FOR_NGNZ_WALLET_ADDRESS",
          network: "PLACEHOLDER_FOR_NGNZ_NETWORK",
          walletReferenceId: "PLACEHOLDER_FOR_NGNZ_REFERENCE",
        }
      },
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
      },
      // Set wallet generation status
      walletGenerationStatus: 'pending',
      walletGenerationStartedAt: null,
      walletGenerationCompletedAt: null
    };

    const newUser = new User(userFields);

    // JWT payload - Now includes the generated username
    const jwtPayload = {
      id: newUser._id,
      email: newUser.email,
      username: newUser.username, // Now includes the generated username
      is2FAEnabled: newUser.is2FAEnabled || false,
      is2FAVerified: newUser.is2FAVerified || false,
    };

    // DEBUG: Log JWT payload being used
    logger.info('JWT payload being generated', {
      userId: newUser._id,
      payload: jwtPayload,
      generatedUsername: generatedUsername,
      hasUsername: !!jwtPayload.username,
      source: 'password-pin'
    });

    // JWT tokens - Now includes username
    const accessToken = jwt.sign(
      jwtPayload,
      config.jwtSecret || process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const refreshToken = jwt.sign(
      { id: newUser._id },
      config.refreshjwtSecret || process.env.JWT_REFRESH_SECRET,
      { expiresIn: "7d" }
    );

    // DEBUG: Log generated tokens (for debugging only - remove in production)
    logger.info('JWT tokens generated', {
      userId: newUser._id,
      email: newUser.email,
      username: generatedUsername,
      accessToken: accessToken,
      refreshToken: refreshToken,
      accessTokenLength: accessToken.length,
      refreshTokenLength: refreshToken.length,
      source: 'password-pin'
    });

    // Add refresh token to user before saving
    newUser.refreshTokens.push({ token: refreshToken, createdAt: new Date() });
    
    // Save user first
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

    logger.info('User created successfully with password PIN and generated username', {
      userId: newUser._id,
      email: newUser.email,
      username: generatedUsername,
      pinLength: newPin.length,
      source: 'password-pin',
      kycLevel: newUser.kycLevel
    });

    // Remove pending user after successful account creation
    await PendingUser.deleteOne({ _id: pendingUser._id });

    // Start wallet generation in background (don't await - this is the key change!)
    generateWalletsInBackground(newUser._id, newUser.email).catch(error => {
      logger.error('Background wallet generation process failed to start', {
        userId: newUser._id,
        email: newUser.email,
        error: error.message
      });
    });

    // DEBUG: Log tokens being sent in response
    logger.info('Sending response with tokens', {
      userId: newUser._id,
      username: generatedUsername,
      accessTokenStart: accessToken.substring(0, 20) + '...',
      refreshTokenStart: refreshToken.substring(0, 20) + '...',
      source: 'password-pin'
    });

    // Respond immediately to frontend - USER GETS RESPONSE RIGHT AWAY
    res.status(201).json({
      message: 'Account created successfully with password PIN and KYC Level 1. Wallet addresses are being generated in the background.',
      user: {
        id: newUser._id,
        email: newUser.email,
        phonenumber: newUser.phonenumber,
        firstname: newUser.firstname,
        lastname: newUser.lastname,
        username: newUser.username, // Now includes generated username
        kycLevel: newUser.kycLevel,
        kycStatus: newUser.kycStatus,
        walletGenerationStatus: newUser.walletGenerationStatus
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

// GET: /api/admin/wallet-status/:userId - Check wallet generation status
router.get('/wallet-status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await User.findById(userId).select('walletGenerationStatus walletGenerationStartedAt walletGenerationCompletedAt wallets');
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Count how many wallets have been generated (excluding NGNZ placeholder)
    const walletCount = user.wallets ? Object.keys(user.wallets).filter(key => 
      key !== 'NGNZ' && user.wallets[key] && user.wallets[key].address && user.wallets[key].address !== null
    ).length : 0;

    res.json({
      walletGenerationStatus: user.walletGenerationStatus,
      walletGenerationStartedAt: user.walletGenerationStartedAt,
      walletGenerationCompletedAt: user.walletGenerationCompletedAt,
      walletsGenerated: walletCount,
      totalWallets: 12, // UPDATED: Total number of wallets expected (was 13, now 12 after removing DOGE)
      wallets: user.wallets
    });

  } catch (error) {
    logger.error('Error checking wallet status', { 
      error: error.message, 
      userId: req.params.userId 
    });
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;