const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const QRCode = require('qrcode'); // npm install qrcode
const User = require('../models/user');

// Mapping between token/network combinations and schema wallet keys
const WALLET_KEY_MAPPING = {
  // Bitcoin
  'BTC_BTC': 'BTC_BTC',
  'BTC_BITCOIN': 'BTC_BTC',
  
  // Ethereum
  'ETH_ETH': 'ETH_ETH',
  'ETH_ETHEREUM': 'ETH_ETH',
  
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
  
  // USDC variants
  'USDC_ETH': 'USDC_ETH',
  'USDC_ETHEREUM': 'USDC_ETH',
  'USDC_ERC20': 'USDC_ETH',
  'USDC_BSC': 'USDC_BSC',
  'USDC_BEP20': 'USDC_BSC',
  'USDC_BINANCE': 'USDC_BSC',
  
  // BNB variants
  'BNB_ETH': 'BNB_ETH',
  'BNB_ETHEREUM': 'BNB_ETH',
  'BNB_ERC20': 'BNB_ETH',
  'BNB_BSC': 'BNB_BSC',
  'BNB_BEP20': 'BNB_BSC',
  'BNB_BINANCE': 'BNB_BSC',
  
  // Dogecoin
  'DOGE_DOGE': 'DOGE_DOGE',
  'DOGE_DOGECOIN': 'DOGE_DOGE',
  
  // Polygon (MATIC)
  'MATIC_ETH': 'MATIC_ETH',
  'MATIC_ETHEREUM': 'MATIC_ETH',
  'MATIC_ERC20': 'MATIC_ETH',
  'MATIC_POLYGON': 'MATIC_ETH',
  
  // Avalanche
  'AVAX_BSC': 'AVAX_BSC',
  'AVAX_BEP20': 'AVAX_BSC',
  'AVAX_BINANCE': 'AVAX_BSC',
  'AVAX_AVALANCHE': 'AVAX_BSC',
  
  // NGNB (no network suffix in schema)
  'NGNB_NGNB': 'NGNB',
  'NGNB': 'NGNB',
};

// Supported tokens and their networks
const SUPPORTED_TOKENS = {
  'BTC': ['BTC', 'BITCOIN'],
  'ETH': ['ETH', 'ETHEREUM'],
  'SOL': ['SOL', 'SOLANA'],
  'USDT': ['ETH', 'ETHEREUM', 'ERC20', 'TRX', 'TRON', 'TRC20', 'BSC', 'BEP20', 'BINANCE'],
  'USDC': ['ETH', 'ETHEREUM', 'ERC20', 'BSC', 'BEP20', 'BINANCE'],
  'BNB': ['ETH', 'ETHEREUM', 'ERC20', 'BSC', 'BEP20', 'BINANCE'],
  'DOGE': ['DOGE', 'DOGECOIN'],
  'MATIC': ['ETH', 'ETHEREUM', 'ERC20', 'POLYGON'],
  'AVAX': ['BSC', 'BEP20', 'BINANCE', 'AVALANCHE'],
  'NGNB': ['NGNB', ''] // NGNB can be without network or with NGNB as network
};

// Helper function to get the correct wallet key from schema
function getWalletKey(tokenSymbol, network) {
  const key1 = `${tokenSymbol}_${network}`;
  const key2 = tokenSymbol; // For tokens like NGNB that don't have network suffix
  
  return WALLET_KEY_MAPPING[key1] || WALLET_KEY_MAPPING[key2] || null;
}

// Helper function to validate token and network combination
function isValidTokenNetworkCombo(tokenSymbol, network) {
  const supportedNetworks = SUPPORTED_TOKENS[tokenSymbol];
  if (!supportedNetworks) return false;
  
  // Special case for NGNB
  if (tokenSymbol === 'NGNB') {
    return network === 'NGNB' || network === '';
  }
  
  return supportedNetworks.includes(network);
}

// POST: Get deposit address with QR code
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
        // Allow alphanumeric characters and underscores for network names
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

      // 2. Get the correct wallet key from schema mapping
      const walletKey = getWalletKey(tokenSymbol, network);
      
      if (!walletKey) {
        return res.status(400).json({
          success: false,
          message: `Invalid token/network combination: ${tokenSymbol}/${network}`,
          supportedCombinations: Object.keys(WALLET_KEY_MAPPING)
        });
      }

      const wallet = user.wallets[walletKey];

      if (!wallet || !wallet.address) {
        // Get list of available wallets for better error response
        const availableWallets = Object.keys(user.wallets)
          .filter(key => user.wallets[key]?.address)
          .map(key => {
            const wallet = user.wallets[key];
            return {
              key,
              network: wallet.network,
              hasAddress: !!wallet.address
            };
          });

        return res.status(404).json({
          success: false,
          message: `Wallet address for ${tokenSymbol} on ${network} network not found.`,
          requestedWalletKey: walletKey,
          availableWallets: availableWallets
        });
      }

      // 3. Generate QR code for the wallet address
      let qrCodeData = null;
      try {
        // Generate QR code as base64 data URL
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
        console.error('QR code generation failed:', qrError);
        // Continue without QR code rather than failing the request
      }

      // 4. Create response data with QR code
      const responseData = {
        token: tokenSymbol,
        network: wallet.network || network,
        address: wallet.address,
        walletReferenceId: wallet.walletReferenceId || null,
        walletKey: walletKey, // Include the actual schema key used
        qrCode: qrCodeData ? {
          dataUrl: qrCodeData,
          format: 'base64',
          type: 'image/png'
        } : null
      };

      // 5. Return deposit address info with QR code
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
      console.error('Error fetching deposit address:', err);
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
    const [token, network] = key.includes('_') ? key.split('_') : [key, ''];
    return { token, network, walletKey: WALLET_KEY_MAPPING[key] };
  });

  return res.status(200).json({
    success: true,
    message: 'Supported token/network combinations retrieved successfully.',
    data: {
      supportedTokens: SUPPORTED_TOKENS,
      supportedCombinations: supportedCombinations,
      walletKeyMapping: WALLET_KEY_MAPPING
    }
  });
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
          address: address,
          qrCode: {
            dataUrl: qrCodeData,
            format: 'base64',
            type: 'image/png',
            size: size
          }
        }
      });

    } catch (err) {
      console.error('QR code generation error:', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to generate QR code.',
        error: process.env.NODE_ENV === 'development' ? err.message : 'QR generation failed'
      });
    }
  }
);

module.exports = router;