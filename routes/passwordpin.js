const express = require('express');
const jwt = require("jsonwebtoken");
const router = express.Router();
const User = require('../models/user');
const PendingUser = require("../models/pendinguser");
const config = require("./config");
const logger = require('../utils/logger');
const { trackEvent } = require('../utils/appsFlyerHelper');

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
      middlename,
      lastname,
      phonenumber
    } = pendingUser;

    // Generate unique username from first name (placeholder - can be changed once via username endpoint)
    const generatedUsername = await generateUniqueUsername(firstname);

    const userFields = {
      email,
      firstname,
      middlename,
      lastname,
      phonenumber,
      username: generatedUsername, // Auto-generated placeholder (can be changed once via username endpoint)
      isUsernameCustom: false, // Mark as auto-generated (allows one update)
      password: null, // Explicitly set to null
      passwordpin: newPin, // Set the PIN - let the model handle hashing
      transactionpin: null,
      wallets: {
        // Initialize empty wallet structure - wallets will be generated on-demand
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
          phoneVerified: true,        // NEW: Mark phone as verified
          verifiedAt: now,           // NEW: Record verification time
          submittedAt: now,
          approvedAt: now,
          rejectedAt: null,
          rejectionReason: null
        },
        level2: {
          status: 'not_submitted',
          emailVerified: false,      // NEW: Email not yet verified
          documentSubmitted: false,  // NEW: Document not yet submitted
          documentType: null,
          documentNumber: null,
          submittedAt: null,
          approvedAt: null,
          rejectedAt: null,
          rejectionReason: null
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
      // Remove wallet generation status fields since wallets are generated on-demand
    };

    const newUser = new User(userFields);
    
    // Save user first (before generating JWT tokens to ensure username is final)
    try {
      await newUser.save();
    } catch (saveError) {
      logger.error('Error saving new user', { 
        error: saveError.message, 
        stack: saveError.stack,
        pendingUserId,
        username: generatedUsername,
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
      
      // Handle duplicate key errors (race condition - username taken between check and save)
      if (saveError.code === 11000) {
        const duplicateField = Object.keys(saveError.keyPattern || {})[0];
        if (duplicateField === 'username') {
          // Username was taken by another user between our check and save
          // Regenerate username from firstname as fallback
          logger.warn('Username collision during signup, regenerating', { 
            requestedUsername: generatedUsername, 
            pendingUserId 
          });
          const fallbackUsername = await generateUniqueUsername(firstname);
          newUser.username = fallbackUsername;
          newUser.isUsernameCustom = false;
          try {
            await newUser.save();
            logger.info('User saved with fallback username after collision', {
              userId: newUser._id,
              fallbackUsername,
              pendingUserId
            });
          } catch (retryError) {
            logger.error('Failed to save user even with fallback username', {
              error: retryError.message,
              pendingUserId
            });
            return res.status(500).json({ 
              message: 'Failed to create account. Please try again.' 
            });
          }
        } else {
          return res.status(400).json({ 
            message: `${duplicateField} already exists` 
          });
        }
      } else {
        throw saveError; // Re-throw if not handled
      }
    }

    // JWT payload - Now includes the final username (after save is successful)
    const jwtPayload = {
      id: newUser._id,
      email: newUser.email,
      username: newUser.username, // Use the actual saved username
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

    // Add refresh token to user and save again
    newUser.refreshTokens.push({ token: refreshToken, createdAt: new Date() });
    await newUser.save();

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

    logger.info('User created successfully with password PIN, phone verification, and KYC Level 1', {
      userId: newUser._id,
      email: newUser.email,
      username: generatedUsername,
      phoneVerified: true,
      pinLength: newPin.length,
      source: 'password-pin',
      kycLevel: newUser.kycLevel
    });

    // Remove pending user after successful account creation
    await PendingUser.deleteOne({ _id: pendingUser._id });

    // Track AppsFlyer sign_up event (non-blocking)
    trackEvent(newUser._id, 'sign_up', { registrationMethod: 'phone' }, req).catch(err => {
      logger.warn('Failed to track AppsFlyer sign_up event', { userId: newUser._id, error: err.message });
    });

    // NO BACKGROUND WALLET GENERATION - Wallets will be generated on-demand when requested

    // DEBUG: Log tokens being sent in response
    logger.info('Sending response with tokens', {
      userId: newUser._id,
      username: generatedUsername,
      accessTokenStart: accessToken.substring(0, 20) + '...',
      refreshTokenStart: refreshToken.substring(0, 20) + '...',
      source: 'password-pin'
    });

    // Respond immediately to frontend
    res.status(201).json({
      message: 'Account created successfully with password PIN, phone verification, and KYC Level 1. Wallet addresses will be generated when you request deposit addresses.',
      user: {
        id: newUser._id,
        email: newUser.email,
        phonenumber: newUser.phonenumber,
        firstname: newUser.firstname,
        middlename: newUser.middlename,
        lastname: newUser.lastname,
        username: newUser.username, // Now includes generated username
        kycLevel: newUser.kycLevel,
        kycStatus: newUser.kycStatus,
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

// GET: /api/admin/wallet-status/:userId - Check individual wallet status (optional - can be removed if not needed)
router.get('/wallet-status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await User.findById(userId).select('wallets');
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Count how many wallets have been generated (excluding NGNZ placeholder)
    const walletsWithAddresses = user.wallets ? Object.keys(user.wallets).filter(key => 
      key !== 'NGNZ' && user.wallets[key] && user.wallets[key].address && user.wallets[key].address !== null
    ) : [];

    const walletsGenerated = walletsWithAddresses.length;

    res.json({
      message: 'Wallets are generated on-demand when deposit addresses are requested',
      walletsGenerated: walletsGenerated,
      totalPossibleWallets: 12, // Total number of wallets that can be generated
      generatedWallets: walletsWithAddresses,
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