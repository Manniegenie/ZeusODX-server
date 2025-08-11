const express = require('express');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const User = require('../models/user');

const router = express.Router();

// Step 1: Generate 2FA secret and QR code
router.get('/setup-2fa', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const secret = speakeasy.generateSecret({
      name: user.email,           // Account name (user's email)
      issuer: 'ZeusODX'          // Service name that appears in authenticator apps
    });

    user.twoFASecret = secret.base32;
    user.is2FAEnabled = false;
    await user.save();

    const otpAuthUrl = secret.otpauth_url;
    const qrCodeDataURL = await qrcode.toDataURL(otpAuthUrl);

    res.json({
      message: 'Scan this QR code with your Authenticator app',
      qrCodeDataURL,
      manualEntryKey: secret.base32,
    });
  } catch (err) {
    console.error('Error generating 2FA secret:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Step 2: Verify token and enable 2FA
router.post('/verify-2fa', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string' || token.length !== 6) {
      return res.status(400).json({ error: 'Valid 6-digit token is required' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.twoFASecret) return res.status(400).json({ error: '2FA not set up' });

    const verified = speakeasy.totp.verify({
      secret: user.twoFASecret,
      encoding: 'base32',
      token,
      window: 1,
    });

    if (!verified) {
      return res.status(401).json({ error: 'Invalid 2FA token' });
    }

    user.is2FAEnabled = true;
    await user.save();

    res.json({ verified: true, message: '2FA enabled successfully' });
  } catch (err) {
    console.error('Error verifying 2FA token:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Disable 2FA
router.post('/disable-2fa', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.is2FAEnabled = false;
    user.twoFASecret = null;
    await user.save();

    res.json({ message: '2FA disabled' });
  } catch (err) {
    console.error('Error disabling 2FA:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
