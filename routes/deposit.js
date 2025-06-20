const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const QRCode = require('qrcode'); // npm install qrcode
const User = require('../models/user');



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
      .toUpperCase(),
    body('network')
      .trim()
      .notEmpty()
      .withMessage('Network is required.')
      .isAlphanumeric()
      .withMessage('Network must contain only letters and numbers.')
      .isLength({ min: 2, max: 10 })
      .withMessage('Network must be between 2 and 10 characters.')
      .toUpperCase(),

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
      // 1. Fetch user
      const user = await User.findById(userId).select('wallets username email');

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found.'
        });
      }

      // 2. Get the wallet key in the format used in the DB (e.g. USDT_BEP20)
      const walletKey = network === tokenSymbol ? tokenSymbol : `${tokenSymbol}_${network}`;
      const wallet = user.wallets[walletKey];

      if (!wallet || !wallet.address) {
        return res.status(404).json({
          success: false,
          message: `Wallet address for ${tokenSymbol} on ${network} network not found.`,
          walletKey: walletKey,
          availableWallets: Object.keys(user.wallets).filter(key => user.wallets[key]?.address)
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