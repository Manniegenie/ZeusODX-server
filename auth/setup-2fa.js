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
    console.log('2FA Verification attempt:', { userId: req.user.id, token: token?.slice(0, 2) + '****' });
    
    if (!token || typeof token !== 'string' || token.length !== 6) {
      return res.status(400).json({ error: 'Valid 6-digit token is required' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      console.log('User not found:', req.user.id);
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (!user.twoFASecret) {
      console.log('2FA secret not found for user:', user._id);
      return res.status(400).json({ error: '2FA not set up' });
    }

    console.log('Before verification - 2FA status:', { 
      userId: user._id, 
      is2FAEnabled: user.is2FAEnabled,
      is2FAVerified: user.is2FAVerified,
      hasSecret: !!user.twoFASecret 
    });

    const verified = speakeasy.totp.verify({
      secret: user.twoFASecret,
      encoding: 'base32',
      token,
      window: 1,
    });

    console.log('Token verification result:', verified);

    if (!verified) {
      console.log('Token verification failed for user:', user._id);
      return res.status(401).json({ error: 'Invalid 2FA token' });
    }

    // Use findByIdAndUpdate instead of save()
    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      { 
        is2FAEnabled: true,
        is2FAVerified: true 
      },
      { 
        new: true,  // Return the updated document
        runValidators: true  // Run schema validators
      }
    );

    console.log('User updated successfully:', { 
      userId: updatedUser._id, 
      is2FAEnabled: updatedUser.is2FAEnabled,
      is2FAVerified: updatedUser.is2FAVerified 
    });

    res.json({ 
      verified: true, 
      message: '2FA enabled successfully',
      is2FAEnabled: updatedUser.is2FAEnabled,
      is2FAVerified: updatedUser.is2FAVerified
    });

  } catch (err) {
    console.error('Error verifying 2FA token:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});
module.exports = router;
