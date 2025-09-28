// routes/deposits.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const QRCode = require('qrcode'); // npm install qrcode
const User = require('../models/user');
const logger = require('../utils/logger');

// Import utils from your generatewallets util
const {
  generateWalletBySchemaKey,
  getSchemaKeyFromNetworkId,
  getAvailableNetworks,
  CURRENCY_NETWORK_TO_SCHEMA
} = require('../utils/generatewallets');

// Helper: build a supported tokens map dynamically from getAvailableNetworks
const buildSupportedTokens = () => {
  const map = {};
  // CURRENCY_NETWORK_TO_SCHEMA keys are like "ETH_ARBITRUM", "TRX_TRX", etc.
  // This automatically includes TRX_TRX once CURRENCY_NETWORK_TO_SCHEMA is updated
  Object.keys(CURRENCY_NETWORK_TO_SCHEMA).forEach(key => {
    const [currency, network] = key.split('_');
    if (!map[currency]) map[currency] = new Set();
    map[currency].add(network);
  });
  // convert sets to arrays
  return Object.fromEntries(Object.entries(map).map(([k, set]) => [k, Array.from(set)]));
};

const SUPPORTED_TOKENS = buildSupportedTokens();

// Function to generate a single wallet for a specific token/network and save to user
const generateSingleWalletForUser = async (userId, email, schemaKey) => {
  try {
    logger.info('Starting single wallet generation', {
      userId,
      email,
      schemaKey
    });

    // Generate wallet using util
    const walletData = await generateWalletBySchemaKey(email, userId, schemaKey);

    // Update user with the specific wallet address (save under wallets.<schemaKey>)
    const updateData = {
      [`wallets.${schemaKey}`]: walletData
    };

    await User.findByIdAndUpdate(userId, updateData);

    logger.info('Single wallet generation completed successfully', {
      userId,
      email,
      schemaKey,
      address: walletData.address
    });

    return walletData;
  } catch (error) {
    logger.error('Single wallet generation failed', {
      userId,
      email,
      schemaKey,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
};

// POST: Get deposit address with QR code (with on-demand wallet generation)
router.post(
  '/address',
  [
    body('tokenSymbol')
      .trim()
      .notEmpty()
      .withMessage('Token symbol is required.')
      .isAlpha()
      .withMessage('Token symbol must contain only letters.')
      .isLength({ min: 2, max: 10 })
      .withMessage('Token symbol must be between 2 and 10 characters.')
      .toUpperCase()
      .custom((value) => {
        if (!SUPPORTED_TOKENS[value]) {
          throw new Error(`Unsupported token: ${value}. Supported tokens: ${Object.keys(SUPPORTED_TOKENS).join(', ')}`);
        }
        return true;
      }),
    body('network')
      .trim()
      .notEmpty()
      .withMessage('Network is required.')
      .custom((value, { req }) => {
        // allow letters, numbers, underscores
        if (!/^[A-Za-z0-9_]+$/.test(value)) {
          throw new Error('Network must contain only letters, numbers, and underscores.');
        }
        return true;
      })
      .isLength({ min: 2, max: 15 })
      .withMessage('Network must be between 2 and 15 characters.')
      .toUpperCase()
      .custom((value, { req }) => {
        const tokenSymbol = req.body.tokenSymbol?.toUpperCase();
        if (!tokenSymbol) return true;

        // Use getSchemaKeyFromNetworkId (which will throw if unsupported) for validation
        try {
          // If this throws, it's an unsupported combo
          const schemaKey = getSchemaKeyFromNetworkId(tokenSymbol, value);
          // Ensure schemaKey exists in your canonical map (redundant but explicit)
          if (!CURRENCY_NETWORK_TO_SCHEMA[schemaKey]) {
            throw new Error(`Unsupported network ${value} for token ${tokenSymbol}`);
          }
          return true;
        } catch (err) {
          const supported = SUPPORTED_TOKENS[tokenSymbol] || [];
          throw new Error(`Invalid network ${value} for token ${tokenSymbol}. Supported networks: ${supported.join(', ')}`);
        }
      }),
  ],
  async (req, res) => {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed.',
        errors: errors.array()
      });
    }

    const { tokenSymbol, network } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized. Please provide a valid authentication token.'
      });
    }

    try {
      // 1. Fetch user with only needed fields
      const user = await User.findById(userId).select('wallets username email');

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found.'
        });
      }

      // 2. Determine schemaKey using the canonical util
      let schemaKey;
      try {
        schemaKey = getSchemaKeyFromNetworkId(tokenSymbol, network);
      } catch (err) {
        logger.warn('Invalid token/network combo attempted', { tokenSymbol, network, userId });
        return res.status(400).json({
          success: false,
          message: `Invalid token/network combination: ${tokenSymbol}/${network}`,
          supportedNetworks: SUPPORTED_TOKENS[tokenSymbol] || []
        });
      }

      // 3. Check if wallet exists on user model
      let wallet = user.wallets?.[schemaKey];

      const wasPresentBefore = !!(wallet && wallet.address);

      // 4. If missing or no address, generate on-demand
      if (!wasPresentBefore) {
        logger.info('Wallet address not found, generating on-demand', {
          userId,
          tokenSymbol,
          network,
          schemaKey
        });

        try {
          wallet = await generateSingleWalletForUser(userId, user.email, schemaKey);

          logger.info('Wallet generated successfully on-demand', {
            userId,
            tokenSymbol,
            network,
            schemaKey,
            address: wallet.address
          });
        } catch (generationError) {
          logger.error('Failed to generate wallet on-demand', {
            userId,
            tokenSymbol,
            network,
            error: generationError.message
          });

          return res.status(500).json({
            success: false,
            message: `Failed to generate wallet address for ${tokenSymbol} on ${network} network. Please try again later.`,
            error: process.env.NODE_ENV === 'development' ? generationError.message : 'Wallet generation failed'
          });
        }
      }

      // 5. At this point, we should have a valid wallet
      if (!wallet || !wallet.address) {
        return res.status(500).json({
          success: false,
          message: `Unable to provide wallet address for ${tokenSymbol} on ${network} network.`
        });
      }

      // 6. Generate QR code for the wallet address (best-effort)
      let qrCodeData = null;
      try {
        qrCodeData = await QRCode.toDataURL(wallet.address, {
          type: 'image/png',
          quality: 0.92,
          margin: 1,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          },
          width: 256
        });
      } catch (qrError) {
        logger.error('QR code generation failed:', qrError);
        // don't fail the request
      }

      // 7. Prepare response
      const responseData = {
        token: tokenSymbol,
        network: wallet.network || network,
        address: wallet.address,
        walletReferenceId: wallet.walletReferenceId || null,
        walletKey: schemaKey, // canonical schema key used
        generatedOnDemand: !wasPresentBefore, // true if we generated it now
        qrCode: qrCodeData ? {
          dataUrl: qrCodeData,
          format: 'base64',
          type: 'image/png'
        } : null
      };

      return res.status(200).json({
        success: true,
        message: 'Deposit address retrieved successfully.',
        data: responseData,
        user: {
          id: userId,
          username: user.username
        }
      });

    } catch (err) {
      logger.error('Error fetching/generating deposit address:', err);
      return res.status(500).json({
        success: false,
        message: 'Server error while fetching deposit address.',
        error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
      });
    }
  }
);

// GET: List all supported tokens and networks (derived from canonical util)
router.get('/supported-tokens', (req, res) => {
  const supportedCombinations = Object.keys(CURRENCY_NETWORK_TO_SCHEMA).map(key => {
    const [token, network] = key.split('_');
    return { token, network, walletKey: CURRENCY_NETWORK_TO_SCHEMA[key] };
  });

  return res.status(200).json({
    success: true,
    message: 'Supported token/network combinations retrieved successfully.',
    data: {
      supportedTokens: SUPPORTED_TOKENS,
      supportedCombinations,
      walletKeyMapping: CURRENCY_NETWORK_TO_SCHEMA
    }
  });
});

// GET: Get user's generated wallets status
router.get('/wallet-status', async (req, res) => {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized. Please provide a valid authentication token.'
    });
  }

  try {
    const user = await User.findById(userId).select('wallets username');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.'
      });
    }

    // Get status of all wallets based on canonical mapping
    const walletStatus = {};
    const generatedWallets = [];
    const pendingWallets = [];

    Object.keys(CURRENCY_NETWORK_TO_SCHEMA).forEach(key => {
      const walletKey = CURRENCY_NETWORK_TO_SCHEMA[key];
      const wallet = user.wallets?.[walletKey];

      if (wallet && wallet.address) {
        walletStatus[key] = {
          status: 'generated',
          address: wallet.address,
          network: wallet.network,
          walletReferenceId: wallet.walletReferenceId
        };
        generatedWallets.push(key);
      } else {
        walletStatus[key] = {
          status: 'pending',
          address: null,
          network: null,
          walletReferenceId: null
        };
        pendingWallets.push(key);
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Wallet status retrieved successfully.',
      data: {
        userId,
        username: user.username,
        walletsGenerated: generatedWallets.length,
        totalPossibleWallets: Object.keys(CURRENCY_NETWORK_TO_SCHEMA).length,
        generatedWallets,
        pendingWallets,
        walletStatus
      }
    });
  } catch (err) {
    logger.error('Error fetching wallet status:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error while fetching wallet status.',
      error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
  }
});

// Alternative endpoint for just QR code generation
router.post(
  '/generate-qr',
  [
    body('address')
      .trim()
      .notEmpty()
      .withMessage('Wallet address is required.')
      .isLength({ min: 10, max: 100 })
      .withMessage('Invalid wallet address length.'),
    body('size')
      .optional()
      .isInt({ min: 128, max: 512 })
      .withMessage('QR code size must be between 128 and 512 pixels.')
      .toInt(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed.',
        errors: errors.array()
      });
    }

    const { address, size = 256 } = req.body;

    try {
      // Generate QR code
      const qrCodeData = await QRCode.toDataURL(address, {
        type: 'image/png',
        quality: 0.92,
        margin: 1,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        },
        width: size
      });

      return res.status(200).json({
        success: true,
        message: 'QR code generated successfully.',
        data: {
          address,
          qrCode: {
            dataUrl: qrCodeData,
            format: 'base64',
            type: 'image/png',
            size
          }
        }
      });
    } catch (err) {
      logger.error('QR code generation error:', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to generate QR code.',
        error: process.env.NODE_ENV === 'development' ? err.message : 'QR generation failed'
      });
    }
  }
);

module.exports = router;