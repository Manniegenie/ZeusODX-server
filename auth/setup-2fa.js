const express = require('express');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const User = require('../models/user');

const router = express.Router();

// Step 1: Generate 2FA secret and QR code
router.get('/setup-2fa', async (req, res) => {
  try {
    // Add extra validation for user ID
    if (!req.user?.id) {
      return res.status(401).json({ error: 'User authentication required' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      console.log('User not found during 2FA setup:', req.user.id);
      return res.status(404).json({ error: 'User not found' });
    }

    // Generate secret with proper account label format
    const accountLabel = `${user.email}`;
    const secret = speakeasy.generateSecret({
      name: accountLabel,
      issuer: 'ZeusODX',
      length: 32  // Ensure consistent secret length
    });

    // Use atomic update to prevent race conditions
    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      { 
        twoFASecret: secret.base32,
        is2FAEnabled: false,  // Reset to false during setup
        is2FAVerified: false  // Reset to false during setup
      },
      { 
        new: true,
        runValidators: true 
      }
    );

    if (!updatedUser) {
      return res.status(404).json({ error: 'Failed to update user' });
    }

    // Create proper OTP Auth URL format
    const otpAuthUrl = `otpauth://totp/ZeusODX:${encodeURIComponent(user.email)}?secret=${secret.base32}&issuer=ZeusODX`;
    const qrCodeDataURL = await qrcode.toDataURL(otpAuthUrl);

    console.log('2FA setup initiated:', { 
      userId: user._id, 
      email: user.email,
      secretGenerated: !!secret.base32 
    });

    res.json({
      message: 'Scan this QR code with your Authenticator app',
      qrCodeDataURL,
      manualEntryKey: secret.base32,
      issuer: 'ZeusODX',
      accountName: user.email
    });
  } catch (err) {
    console.error('Error generating 2FA secret:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Step 2: Verify token and enable 2FA
router.post('/verify-2fa', async (req, res) => {
  try {
    const { token } = req.body;
    
    // Enhanced validation
    if (!req.user?.id) {
      return res.status(401).json({ error: 'User authentication required' });
    }

    console.log('2FA Verification attempt:', { 
      userId: req.user.id, 
      tokenLength: token?.length,
      tokenType: typeof token 
    });
    
    if (!token || typeof token !== 'string' || !/^\d{6}$/.test(token)) {
      return res.status(400).json({ error: 'Valid 6-digit numeric token is required' });
    }

    // Find user with explicit field selection to ensure we get the latest data
    const user = await User.findById(req.user.id).select('+twoFASecret +is2FAEnabled +is2FAVerified');
    if (!user) {
      console.log('User not found during verification:', req.user.id);
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (!user.twoFASecret) {
      console.log('2FA secret not found for user:', user._id);
      return res.status(400).json({ error: '2FA not set up. Please run setup first.' });
    }

    console.log('Before verification - 2FA status:', { 
      userId: user._id, 
      is2FAEnabled: user.is2FAEnabled,
      is2FAVerified: user.is2FAVerified,
      hasSecret: !!user.twoFASecret 
    });

    // Verify token with expanded window for clock drift
    const verified = speakeasy.totp.verify({
      secret: user.twoFASecret,
      encoding: 'base32',
      token: token.trim(), // Remove any whitespace
      window: 2, // Allow for clock drift (±2 time steps)
      step: 30   // 30-second time step (standard)
    });

    console.log('Token verification result:', { verified, token: token.slice(0, 2) + '****' });

    if (!verified) {
      console.log('Token verification failed for user:', user._id);
      return res.status(401).json({ error: 'Invalid 2FA token. Please check your authenticator app and try again.' });
    }

    // Use atomic update with explicit conditions to prevent race conditions
    const updateResult = await User.updateOne(
      { 
        _id: req.user.id,
        twoFASecret: { $exists: true, $ne: null } // Ensure secret exists
      },
      { 
        $set: {
          is2FAEnabled: true,
          is2FAVerified: true
        }
      }
    );

    console.log('Update result:', updateResult);

    if (updateResult.matchedCount === 0) {
      return res.status(400).json({ error: 'Unable to update 2FA status. Please try setup again.' });
    }

    if (updateResult.modifiedCount === 0) {
      return res.status(400).json({ error: '2FA status was not updated. It may already be enabled.' });
    }

    // Fetch updated user to confirm changes
    const updatedUser = await User.findById(req.user.id).select('is2FAEnabled is2FAVerified email');
    
    console.log('User updated successfully:', { 
      userId: updatedUser._id, 
      is2FAEnabled: updatedUser.is2FAEnabled,
      is2FAVerified: updatedUser.is2FAVerified 
    });

    res.json({ 
      verified: true, 
      message: '2FA enabled successfully',
      is2FAEnabled: updatedUser.is2FAEnabled,
      is2FAVerified: updatedUser.is2FAVerified,
      user: {
        email: updatedUser.email,
        is2FAEnabled: updatedUser.is2FAEnabled,
        is2FAVerified: updatedUser.is2FAVerified
      }
    });

  } catch (err) {
    console.error('Error verifying 2FA token:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Optional: Check 2FA status endpoint
router.get('/2fa-status', async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'User authentication required' });
    }

    const user = await User.findById(req.user.id).select('is2FAEnabled is2FAVerified twoFASecret email');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      is2FAEnabled: user.is2FAEnabled,
      is2FAVerified: user.is2FAVerified,
      hasSecret: !!user.twoFASecret,
      email: user.email
    });
  } catch (err) {
    console.error('Error checking 2FA status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;