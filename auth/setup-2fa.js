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
      name: `ZeusODX (${user.email})`, // This will show "ZeusODX" in authenticator apps
    });

    user.twoFASecret = secret.base32;
    user.is2FAEnabled = false;
    user.is2FAVerified = false; // Reset verification status during setup
    await user.save();

    // Use the built-in otpauth_url from speakeasy
    const otpAuthUrl = secret.otpauth_url;
    const qrCodeDataURL = await qrcode.toDataURL(otpAuthUrl);

    console.log('2FA setup completed for user:', { 
      userId: user._id, 
      email: user.email 
    });

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

    console.log('Verifying 2FA token for user:', { 
      userId: user._id,
      tokenLength: token.length 
    });

    const verified = speakeasy.totp.verify({
      secret: user.twoFASecret,
      encoding: 'base32',
      token,
      window: 2, // Allow for clock drift
    });

    if (!verified) {
      console.log('2FA verification failed for user:', user._id);
      return res.status(401).json({ error: 'Invalid 2FA token' });
    }

    // Simple direct assignment and save
    user.is2FAEnabled = true;
    user.is2FAVerified = true;
    await user.save();

    console.log('2FA enabled successfully for user:', { 
      userId: user._id,
      is2FAEnabled: user.is2FAEnabled,
      is2FAVerified: user.is2FAVerified
    });

    res.json({ 
      verified: true, 
      message: '2FA enabled successfully',
      is2FAEnabled: user.is2FAEnabled,
      is2FAVerified: user.is2FAVerified
    });
  } catch (err) {
    console.error('Error verifying 2FA token:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check 2FA status
router.get('/2fa-status', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      is2FAEnabled: user.is2FAEnabled || false,
      is2FAVerified: user.is2FAVerified || false,
      hasSecret: !!user.twoFASecret,
    });
  } catch (err) {
    console.error('Error checking 2FA status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Disable 2FA
router.post('/disable-2fa', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.is2FAEnabled = false;
    user.is2FAVerified = false;
    user.twoFASecret = null;
    await user.save();

    console.log('2FA disabled for user:', user._id);

    res.json({ message: '2FA disabled' });
  } catch (err) {
    console.error('Error disabling 2FA:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;