// routes/deposits.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const QRCode = require('qrcode');
const User = require('../models/user');
const { generateWalletBySchemaKey } = require('../utils/generatewallets');
const logger = require('../utils/logger');

// Mapping between token/network combinations and schema wallet keys
const WALLET_KEY_MAPPING = {
  // Bitcoin
  'BTC_BTC': 'BTC_BTC',
  'BTC_BITCOIN': 'BTC_BTC',
  'BTC_BSC': 'BTC_BSC',
  'BTC_BEP20': 'BTC_BSC',
  'BTC_BINANCE': 'BTC_BSC',

  // Ethereum
  'ETH_ETH': 'ETH_ETH',
  'ETH_ETHEREUM': 'ETH_ETH',
  'ETH_ARBITRUM': 'ETH_ARBITRUM',
  'ETH_BASE': 'ETH_BASE',
  'ETH_BSC': 'ETH_BSC',
  'ETH_BEP20': 'ETH_BSC',
  'ETH_BINANCE': 'ETH_BSC',

  // Solana
  'SOL_SOL': 'SOL_SOL',
  'SOL_SOLANA': 'SOL_SOL',

  // USDT variants
  'USDT_ETH': 'USDT_ETH',
  'USDT_ETHEREUM': 'USDT_ETH',
  'USDT_ERC20': 'USDT_ETH',
  'USDT_TRX': 'USDT_TRX',
  'USDT_TRON': 'USDT_TRX',
  'USDT_TRC20': 'USDT_TRX',
  'USDT_BSC': 'USDT_BSC',
  'USDT_BEP20': 'USDT_BSC',
  'USDT_BINANCE': 'USDT_BSC',
  'USDT_ARBITRUM': 'USDT_ARBITRUM',
  'USDT_BASE': 'USDT_BASE',
  'USDT_SOL': 'USDT_SOL',
  'USDT_SOLANA': 'USDT_SOL',

  // USDC variants
  'USDC_ETH': 'USDC_ETH',
  'USDC_ETHEREUM': 'USDC_ETH',
  'USDC_ERC20': 'USDC_ETH',
  'USDC_TRX': 'USDC_TRX',
  'USDC_TRON': 'USDC_TRX',
  'USDC_TRC20': 'USDC_TRX',
  'USDC_BSC': 'USDC_BSC',
  'USDC_BEP20': 'USDC_BSC',
  'USDC_BINANCE': 'USDC_BSC',
  'USDC_ARBITRUM': 'USDC_ARBITRUM',

  // BNB variants
  'BNB_ETH': 'BNB_ETH',
  'BNB_ETHEREUM': 'BNB_ETH',
  'BNB_ERC20': 'BNB_ETH',
  'BNB_BSC': 'BNB_BSC',
  'BNB_BEP20': 'BNB_BSC',
  'BNB_BINANCE': 'BNB_BSC',

  // Polygon (MATIC / POL)
  'MATIC_ETH': 'MATIC_ETH',
  'MATIC_ETHEREUM': 'MATIC_ETH',
  'MATIC_ERC20': 'MATIC_ETH',
  'MATIC_POLYGON': 'MATIC_ETH',
  'POL_ETH': 'POL_ETH',
  'POL_ETHEREUM': 'POL_ETH',

  // Avalanche
  'AVAX_BSC': 'AVAX_BSC',
  'AVAX_BEP20': 'AVAX_BSC',
  'AVAX_BINANCE': 'AVAX_BSC',
  'AVAX_AVALANCHE': 'AVAX_BSC',

  // Tron
  'TRX_TRX': 'TRX_TRX',
  'TRX_TRON': 'TRX_TRX',
  'TRX_TRC20': 'TRX_TRX',

  // TON
  'TON_TON': 'TON_TON',

  // NGNB
  'NGNB_NGNB': 'NGNB',
  'NGNB': 'NGNB',
};

// Supported tokens and their valid networks
const SUPPORTED_TOKENS = {
  'BTC':  ['BTC', 'BITCOIN', 'BSC', 'BEP20', 'BINANCE'],
  'ETH':  ['ETH', 'ETHEREUM', 'ARBITRUM', 'BASE', 'BSC', 'BEP20', 'BINANCE'],
  'SOL':  ['SOL', 'SOLANA'],
  'USDT': ['ETH', 'ETHEREUM', 'ERC20', 'TRX', 'TRON', 'TRC20', 'BSC', 'BEP20', 'BINANCE', 'ARBITRUM', 'BASE', 'SOL', 'SOLANA'],
  'USDC': ['ETH', 'ETHEREUM', 'ERC20', 'TRX', 'TRON', 'TRC20', 'BSC', 'BEP20', 'BINANCE', 'ARBITRUM'],
  'BNB':  ['ETH', 'ETHEREUM', 'ERC20', 'BSC', 'BEP20', 'BINANCE'],
  'MATIC':['ETH', 'ETHEREUM', 'ERC20', 'POLYGON'],
  'POL':  ['ETH', 'ETHEREUM'],
  'AVAX': ['BSC', 'BEP20', 'BINANCE', 'AVALANCHE'],
  'TRX':  ['TRX', 'TRON', 'TRC20'],
  'TON':  ['TON'],
  'NGNB': ['NGNB', ''],
};

function getWalletKey(tokenSymbol, network) {
  const key1 = `${tokenSymbol}_${network}`;
  const key2 = tokenSymbol;
  return WALLET_KEY_MAPPING[key1] || WALLET_KEY_MAPPING[key2] || null;
}

function isValidTokenNetworkCombo(tokenSymbol, network) {
  const supportedNetworks = SUPPORTED_TOKENS[tokenSymbol];
  if (!supportedNetworks) return false;
  if (tokenSymbol === 'NGNB') return network === 'NGNB' || network === '';
  return supportedNetworks.includes(network);
}

const generateSingleWalletForUser = async (userId, email, walletKey) => {
  try {
    logger.info('Starting single wallet generation', { userId, email, walletKey });

    const walletData = await generateWalletBySchemaKey(email, userId, walletKey);

    await User.findByIdAndUpdate(userId, {
      [`wallets.${walletKey}`]: walletData
    });

    logger.info('Single wallet generation completed successfully', {
      userId, email, walletKey, address: walletData.address
    });

    return walletData;
  } catch (error) {
    logger.error('Single wallet generation failed', {
      userId, email, walletKey, error: error.message, stack: error.stack
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
      .custom((value) => {
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
        if (tokenSymbol && !isValidTokenNetworkCombo(tokenSymbol, value)) {
          const supportedNetworks = SUPPORTED_TOKENS[tokenSymbol] || [];
          throw new Error(`Invalid network ${value} for token ${tokenSymbol}. Supported networks: ${supportedNetworks.join(', ')}`);
        }
        return true;
      }),
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

    const { tokenSymbol, network } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized. Please provide a valid authentication token.'
      });
    }

    try {
      const user = await User.findById(userId).select('wallets username email');

      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found.' });
      }

      const walletKey = getWalletKey(tokenSymbol, network);

      if (!walletKey) {
        return res.status(400).json({
          success: false,
          message: `Invalid token/network combination: ${tokenSymbol}/${network}`,
          supportedCombinations: Object.keys(WALLET_KEY_MAPPING)
        });
      }

      let wallet = user.wallets[walletKey];

      if (!wallet || !wallet.address) {
        logger.info('Wallet address not found, generating on-demand', {
          userId, tokenSymbol, network, walletKey
        });

        try {
          wallet = await generateSingleWalletForUser(userId, user.email, walletKey);
          logger.info('Wallet generated successfully on-demand', {
            userId, tokenSymbol, network, walletKey, address: wallet.address
          });
        } catch (generationError) {
          logger.error('Failed to generate wallet on-demand', {
            userId, tokenSymbol, network, error: generationError.message
          });
          return res.status(500).json({
            success: false,
            message: `Failed to generate wallet address for ${tokenSymbol} on ${network} network. Please try again later.`,
            error: process.env.NODE_ENV === 'development' ? generationError.message : 'Wallet generation failed'
          });
        }
      }

      if (!wallet || !wallet.address) {
        return res.status(500).json({
          success: false,
          message: `Unable to provide wallet address for ${tokenSymbol} on ${network} network.`
        });
      }

      let qrCodeData = null;
      try {
        qrCodeData = await QRCode.toDataURL(wallet.address, {
          type: 'image/png',
          quality: 0.92,
          margin: 1,
          color: { dark: '#000000', light: '#FFFFFF' },
          width: 256
        });
      } catch (qrError) {
        logger.error('QR code generation failed:', qrError);
      }

      const responseData = {
        token: tokenSymbol,
        network: wallet.network || network,
        address: wallet.address,
        walletReferenceId: wallet.walletReferenceId || null,
        walletKey: walletKey,
        generatedOnDemand: !user.wallets[walletKey] || !user.wallets[walletKey].address,
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
        user: { id: userId, username: user.username }
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

// GET: List all supported tokens and networks
router.get('/supported-tokens', (req, res) => {
  const supportedCombinations = Object.keys(WALLET_KEY_MAPPING).map(key => {
    const parts = key.includes('_') ? key.split('_') : [key, ''];
    return { token: parts[0], network: parts[1] || '', walletKey: WALLET_KEY_MAPPING[key] };
  });

  return res.status(200).json({
    success: true,
    message: 'Supported token/network combinations retrieved successfully.',
    data: {
      supportedTokens: SUPPORTED_TOKENS,
      supportedCombinations,
      walletKeyMapping: WALLET_KEY_MAPPING
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
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const walletStatus = {};
    const generatedWallets = [];
    const pendingWallets = [];

    Object.keys(WALLET_KEY_MAPPING).forEach(key => {
      const walletKey = WALLET_KEY_MAPPING[key];
      const wallet = user.wallets[walletKey];

      if (wallet && wallet.address) {
        walletStatus[key] = {
          status: 'generated',
          address: wallet.address,
          network: wallet.network,
          walletReferenceId: wallet.walletReferenceId
        };
        generatedWallets.push(key);
      } else {
        walletStatus[key] = { status: 'pending', address: null, network: null, walletReferenceId: null };
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
        totalPossibleWallets: Object.keys(WALLET_KEY_MAPPING).length,
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

// POST: Generate QR code for any address
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
      const qrCodeData = await QRCode.toDataURL(address, {
        type: 'image/png',
        quality: 0.92,
        margin: 1,
        color: { dark: '#000000', light: '#FFFFFF' },
        width: size
      });

      return res.status(200).json({
        success: true,
        message: 'QR code generated successfully.',
        data: {
          address,
          qrCode: { dataUrl: qrCodeData, format: 'base64', type: 'image/png', size }
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
