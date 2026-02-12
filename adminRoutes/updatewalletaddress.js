const express = require('express');
const router = express.Router();
const User = require('../models/user');
const generateWallets = require('../utils/generatewallets');
const logger = require('../utils/logger');

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

// POST: /regenerate-by-phone - Generate/regenerate wallets using phone number
router.patch('/regenerate-by-phone', async (req, res) => {
  try {
    const { phonenumber, tokens, force = false } = req.body;

    if (!phonenumber) {
      logger.warn('Wallet regeneration attempted without phone number');
      return res.status(400).json({ 
        success: false,
        error: 'Phone number is required.' 
      });
    }

    const user = await User.findOne({ phonenumber });
    if (!user) {
      logger.warn('Wallet regeneration attempted for non-existent user', { phonenumber });
      return res.status(404).json({ 
        success: false,
        error: 'User not found with this phone number.',
        phonenumber: phonenumber
      });
    }

    // Check current wallet status
    const hasWallets = user.wallets && Object.values(user.wallets).some(wallet => 
      wallet && wallet.address && wallet.address !== null && 
      wallet.address !== "PLACEHOLDER_FOR_NGNZ_WALLET_ADDRESS"
    );

    // Check if wallets are already generated or in progress (unless force is true)
    if (!force) {
      if (user.walletGenerationStatus === 'completed' && hasWallets) {
        return res.status(400).json({ 
          success: false,
          message: 'Wallets already generated for this user. Use force=true to regenerate.',
          user: {
            id: user._id,
            email: user.email,
            phonenumber: user.phonenumber,
            firstname: user.firstname,
            lastname: user.lastname
          },
          walletGenerationStatus: user.walletGenerationStatus
        });
      }

      if (user.walletGenerationStatus === 'in_progress') {
        return res.status(400).json({ 
          success: false,
          message: 'Wallet generation already in progress for this user',
          user: {
            id: user._id,
            email: user.email,
            phonenumber: user.phonenumber
          },
          walletGenerationStatus: user.walletGenerationStatus
        });
      }
    }

    logger.info('Starting wallet regeneration', { 
      userId: user._id, 
      email: user.email,
      phonenumber: user.phonenumber,
      tokensRequested: tokens || 'all',
      force: force
    });

    // Update user status to indicate regeneration in progress
    await User.findByIdAndUpdate(user._id, {
      walletGenerationStatus: 'in_progress',
      walletGenerationStartedAt: new Date()
    });

    const result = await generateWallets(user.email, user._id);

    if (!result.success) {
      logger.error('Wallet regeneration failed', { 
        userId: user._id, 
        email: user.email,
        phonenumber: user.phonenumber,
        result 
      });
      
      // Update status to failed
      await User.findByIdAndUpdate(user._id, {
        walletGenerationStatus: 'failed',
        walletGenerationCompletedAt: new Date()
      });

      return res.status(500).json({
        success: false,
        error: 'Wallet regeneration failed.',
        result,
      });
    }

    // Normalize wallet keys to match schema - Updated to remove DOGE
    const updatedWallets = {};
    for (const key of Object.keys(result.wallets)) {
      const wallet = result.wallets[key];
      if (wallet.status === 'success') {
        const { currency, network, address, referenceId } = wallet;

        // Map all supported currencies and networks - DOGE REMOVED
        if (currency === 'BTC' && network === 'BTC') {
          updatedWallets.BTC_BTC = { address, network, walletReferenceId: referenceId };
        } else if (currency === 'ETH' && network === 'ETH') {
          updatedWallets.ETH_ETH = { address, network, walletReferenceId: referenceId };
        } else if (currency === 'SOL' && network === 'SOL') {
          updatedWallets.SOL_SOL = { address, network, walletReferenceId: referenceId };
        } else if (currency === 'USDT') {
          if (network === 'TRX') {
            updatedWallets.USDT_TRX = { address, network, walletReferenceId: referenceId };
          } else if (network === 'ETH') {
            updatedWallets.USDT_ETH = { address, network, walletReferenceId: referenceId };
          } else if (network === 'BSC') {
            updatedWallets.USDT_BSC = { address, network, walletReferenceId: referenceId };
          }
        } else if (currency === 'USDC') {
          if (network === 'ETH') {
            updatedWallets.USDC_ETH = { address, network, walletReferenceId: referenceId };
          } else if (network === 'BSC') {
            updatedWallets.USDC_BSC = { address, network, walletReferenceId: referenceId };
          }
        } else if (currency === 'BNB') {
          if (network === 'ETH') {
            updatedWallets.BNB_ETH = { address, network, walletReferenceId: referenceId };
          } else if (network === 'BSC') {
            updatedWallets.BNB_BSC = { address, network, walletReferenceId: referenceId };
          }
        } else if (currency === 'MATIC' && network === 'ETH') {
          updatedWallets.MATIC_ETH = { address, network, walletReferenceId: referenceId };
        } else if (currency === 'AVAX' && network === 'BSC') {
          updatedWallets.AVAX_BSC = { address, network, walletReferenceId: referenceId };
        }
        // DOGE_DOGE case REMOVED
      }
    }

    // If `tokens` are specified, only update those specific wallet keys
    if (Array.isArray(tokens) && tokens.length > 0) {
      const filteredWallets = {};
      for (const tokenKey of tokens) {
        if (updatedWallets[tokenKey]) {
          filteredWallets[tokenKey] = updatedWallets[tokenKey];
        }
      }
      
      logger.info('Filtering wallets for specific tokens', { 
        userId: user._id, 
        requestedTokens: tokens,
        availableUpdates: Object.keys(updatedWallets),
        filteredUpdates: Object.keys(filteredWallets)
      });

      // Update only the specified wallets
      for (const [key, value] of Object.entries(filteredWallets)) {
        user.wallets.set(key, value);
      }
    } else {
      // Update all wallets, preserve NGNZ if it exists
      const existingNGNZ = user.wallets?.NGNZ || null;
      user.wallets = {
        ...user.wallets.toObject(),
        ...updatedWallets,
      };
      // Restore NGNZ if it existed
      if (existingNGNZ) {
        user.wallets.NGNZ = existingNGNZ;
      }
    }

    // Update wallet generation status to completed
    user.walletGenerationStatus = 'completed';
    user.walletGenerationCompletedAt = new Date();

    await user.save();

    const responseData = {
      success: true,
      message: 'Wallet(s) regenerated successfully.',
      user: {
        id: user._id,
        email: user.email,
        phonenumber: user.phonenumber,
        firstname: user.firstname,
        lastname: user.lastname
      },
      updatedWallets: Array.isArray(tokens) && tokens.length > 0 ? 
        Object.fromEntries(Object.entries(updatedWallets).filter(([key]) => tokens.includes(key))) : 
        updatedWallets,
      summary: result.summary,
      walletsGenerated: Object.keys(updatedWallets).length,
      totalRequested: result.totalRequested,
      successfullyCreated: result.successfullyCreated,
      walletGenerationStatus: user.walletGenerationStatus,
      force: force
    };

    logger.info('Wallet regeneration completed successfully', {
      userId: user._id,
      email: user.email,
      phonenumber: user.phonenumber,
      walletsUpdated: Object.keys(responseData.updatedWallets),
      successCount: Object.keys(updatedWallets).length
    });

    return res.json(responseData);

  } catch (err) {
    logger.error('Wallet regeneration error', { 
      error: err.message, 
      stack: err.stack,
      phonenumber: req.body.phonenumber 
    });
    
    // Try to update status to failed if we have user info
    if (req.body.phonenumber) {
      try {
        const user = await User.findOne({ phonenumber: req.body.phonenumber });
        if (user) {
          await User.findByIdAndUpdate(user._id, {
            walletGenerationStatus: 'failed',
            walletGenerationCompletedAt: new Date()
          });
        }
      } catch (updateError) {
        logger.error('Failed to update wallet generation status after error', {
          error: updateError.message
        });
      }
    }

    return res.status(500).json({ 
      success: false,
      error: 'Internal server error.' 
    });
  }
});

// POST: /generate-wallets-by-phone - Generate wallets using phone number (background)
router.post('/generate-wallets-by-phone', async (req, res) => {
  try {
    const { phonenumber, force = false } = req.body;

    if (!phonenumber) {
      return res.status(400).json({ 
        success: false,
        message: 'Phone number is required' 
      });
    }

    const user = await User.findOne({ phonenumber: phonenumber })
      .select('_id email phonenumber firstname lastname walletGenerationStatus wallets walletGenerationStartedAt walletGenerationCompletedAt');

    if (!user) {
      return res.status(404).json({ 
        success: false,
        message: 'User not found with this phone number',
        phonenumber: phonenumber
      });
    }

    const hasWallets = user.wallets && Object.values(user.wallets).some(wallet => 
      wallet && wallet.address && wallet.address !== null && 
      wallet.address !== "PLACEHOLDER_FOR_NGNZ_WALLET_ADDRESS"
    );

    const existingWalletsCount = user.wallets ? Object.keys(user.wallets).filter(key => 
      user.wallets[key] && user.wallets[key].address && 
      user.wallets[key].address !== null && 
      user.wallets[key].address !== "PLACEHOLDER_FOR_NGNZ_WALLET_ADDRESS"
    ).length : 0;

    if (!force) {
      if (user.walletGenerationStatus === 'completed' && hasWallets) {
        return res.status(400).json({ 
          success: false,
          message: 'Wallets already generated for this user',
          user: {
            id: user._id,
            email: user.email,
            phonenumber: user.phonenumber,
            firstname: user.firstname,
            lastname: user.lastname
          },
          walletGenerationStatus: user.walletGenerationStatus,
          existingWalletsCount: existingWalletsCount,
          totalExpectedWallets: 12
        });
      }

      if (user.walletGenerationStatus === 'in_progress') {
        return res.status(400).json({ 
          success: false,
          message: 'Wallet generation already in progress for this user',
          user: {
            id: user._id,
            email: user.email,
            phonenumber: user.phonenumber
          },
          walletGenerationStatus: user.walletGenerationStatus,
          startedAt: user.walletGenerationStartedAt
        });
      }
    }

    logger.info('Wallet generation triggered by phone number', {
      userId: user._id,
      email: user.email,
      phonenumber: user.phonenumber,
      firstname: user.firstname,
      lastname: user.lastname,
      previousStatus: user.walletGenerationStatus,
      existingWalletsCount: existingWalletsCount,
      force: force
    });

    // Start wallet generation in background
    generateWalletsInBackground(user._id, user.email).catch(error => {
      logger.error('Background wallet generation failed to start', {
        userId: user._id,
        email: user.email,
        phonenumber: user.phonenumber,
        error: error.message
      });
    });

    res.status(200).json({
      success: true,
      message: force ? 'Wallet generation restarted in background' : 'Wallet generation started in background',
      user: {
        id: user._id,
        email: user.email,
        phonenumber: user.phonenumber,
        firstname: user.firstname,
        lastname: user.lastname
      },
      walletGenerationStatus: 'in_progress',
      previousStatus: user.walletGenerationStatus,
      existingWalletsCount: existingWalletsCount,
      totalExpectedWallets: 12, // Updated: removed DOGE
      estimatedCompletionTime: '2-5 minutes',
      force: force
    });

  } catch (error) {
    logger.error('Error triggering wallet generation by phone', { 
      error: error.message,
      stack: error.stack,
      phonenumber: req.body.phonenumber 
    });
    res.status(500).json({ 
      success: false,
      message: 'Server error while triggering wallet generation',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// GET: /status-by-phone - Check regeneration status by phone number
router.get('/status-by-phone', async (req, res) => {
  try {
    const { phonenumber } = req.query;

    if (!phonenumber) {
      return res.status(400).json({ 
        success: false,
        message: 'Phone number is required as query parameter' 
      });
    }
    
    const user = await User.findOne({ phonenumber: phonenumber })
      .select('_id email phonenumber firstname lastname walletGenerationStatus walletGenerationStartedAt walletGenerationCompletedAt wallets');
    
    if (!user) {
      return res.status(404).json({ 
        success: false,
        message: 'User not found with this phone number',
        phonenumber: phonenumber
      });
    }

    // Count how many wallets have been generated (excluding NGNZ placeholder)
    const walletCount = user.wallets ? Object.keys(user.wallets).filter(key => 
      key !== 'NGNZ' && user.wallets[key] && user.wallets[key].address && 
      user.wallets[key].address !== null && user.wallets[key].address !== "PLACEHOLDER_FOR_NGNZ_WALLET_ADDRESS"
    ).length : 0;

    // List all supported wallet types - DOGE REMOVED
    const supportedWallets = [
      'BTC_BTC', 'ETH_ETH', 'SOL_SOL', 
      'USDT_ETH', 'USDT_TRX', 'USDT_BSC',
      'USDC_ETH', 'USDC_BSC',
      'BNB_ETH', 'BNB_BSC',
      'MATIC_ETH', 'AVAX_BSC'
    ];

    // Get wallet details
    const walletDetails = {};
    if (user.wallets) {
      supportedWallets.forEach(key => {
        const wallet = user.wallets[key];
        walletDetails[key] = {
          hasAddress: !!(wallet && wallet.address && wallet.address !== null && wallet.address !== "PLACEHOLDER_FOR_NGNZ_WALLET_ADDRESS"),
          network: wallet ? wallet.network : null,
          hasReferenceId: !!(wallet && wallet.walletReferenceId)
        };
      });
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        phonenumber: user.phonenumber,
        firstname: user.firstname,
        lastname: user.lastname
      },
      walletGenerationStatus: user.walletGenerationStatus,
      walletGenerationStartedAt: user.walletGenerationStartedAt,
      walletGenerationCompletedAt: user.walletGenerationCompletedAt,
      walletsGenerated: walletCount,
      totalWallets: supportedWallets.length,
      progress: `${walletCount}/${supportedWallets.length}`,
      supportedWallets,
      walletDetails: walletDetails,
      isComplete: user.walletGenerationStatus === 'completed' && walletCount >= supportedWallets.length - 1
    });

  } catch (error) {
    logger.error('Error checking regeneration status by phone', { 
      error: error.message, 
      phonenumber: req.query.phonenumber 
    });
    res.status(500).json({ 
      success: false,
      message: 'Server error while checking wallet status',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

module.exports = router;