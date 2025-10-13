const express = require('express');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const AdminUser = require('../models/admin');
const logger = require('../utils/logger');

const router = express.Router();

// Step 1: Generate 2FA secret and QR code
router.post('/setup-2fa', async (req, res) => {
  try {
    const { email, passwordPin } = req.body;

    if (!email || !passwordPin) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email and password PIN are required' 
      });
    }

    const admin = await AdminUser.findOne({ email });
    if (!admin) {
      return res.status(404).json({ 
        success: false, 
        message: 'Admin not found' 
      });
    }

    // Verify password PIN before allowing 2FA setup
    const isValidPin = await admin.comparePasswordPin(passwordPin);
    if (!isValidPin) {
      logger.warn('Invalid PIN during admin 2FA setup attempt', { 
        adminId: admin._id, 
        email: admin.email 
      });
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid password PIN' 
      });
    }

    const secret = speakeasy.generateSecret({
      name: `ZeusODX Admin (${admin.email})`,
    });

    admin.twoFASecret = secret.base32;
    admin.is2FAEnabled = false;
    admin.is2FAVerified = false;
    await admin.save();

    const otpAuthUrl = secret.otpauth_url;
    const qrCodeDataURL = await qrcode.toDataURL(otpAuthUrl);

    logger.info('Admin 2FA setup initiated', { 
      adminId: admin._id, 
      email: admin.email 
    });

    res.json({
      success: true,
      message: 'Scan this QR code with your Authenticator app',
      qrCodeDataURL,
      manualEntryKey: secret.base32,
    });
  } catch (err) {
    logger.error('Error generating admin 2FA secret:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
});

// Step 2: Verify token and enable 2FA
router.post('/verify-2fa', async (req, res) => {
  try {
    const { email, passwordPin, token } = req.body;

    if (!email || !passwordPin || !token) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email, password PIN, and token are required' 
      });
    }

    if (typeof token !== 'string' || token.length !== 6) {
      return res.status(400).json({ 
        success: false, 
        message: 'Valid 6-digit token is required' 
      });
    }

    const admin = await AdminUser.findOne({ email });
    if (!admin) {
      return res.status(404).json({ 
        success: false, 
        message: 'Admin not found' 
      });
    }

    // Verify password PIN
    const isValidPin = await admin.comparePasswordPin(passwordPin);
    if (!isValidPin) {
      logger.warn('Invalid PIN during admin 2FA verification', { 
        adminId: admin._id, 
        email: admin.email 
      });
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid password PIN' 
      });
    }

    if (!admin.twoFASecret) {
      return res.status(400).json({ 
        success: false, 
        message: '2FA not set up. Please set up 2FA first.' 
      });
    }

    const verified = speakeasy.totp.verify({
      secret: admin.twoFASecret,
      encoding: 'base32',
      token,
      window: 2, // Allow for clock drift
    });

    if (!verified) {
      logger.warn('Admin 2FA verification failed', { 
        adminId: admin._id, 
        email: admin.email 
      });
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid 2FA token' 
      });
    }

    admin.is2FAEnabled = true;
    admin.is2FAVerified = true;
    await admin.save();

    logger.info('Admin 2FA enabled successfully', { 
      adminId: admin._id,
      email: admin.email,
      is2FAEnabled: admin.is2FAEnabled,
      is2FAVerified: admin.is2FAVerified
    });

    res.json({ 
      success: true, 
      message: '2FA enabled successfully',
      is2FAEnabled: admin.is2FAEnabled,
      is2FAVerified: admin.is2FAVerified
    });
  } catch (err) {
    logger.error('Error verifying admin 2FA token:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
});

// Check 2FA status
router.post('/2fa-status', async (req, res) => {
  try {
    const { email, passwordPin } = req.body;

    if (!email || !passwordPin) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email and password PIN are required' 
      });
    }

    const admin = await AdminUser.findOne({ email });
    if (!admin) {
      return res.status(404).json({ 
        success: false, 
        message: 'Admin not found' 
      });
    }

    // Verify password PIN
    const isValidPin = await admin.comparePasswordPin(passwordPin);
    if (!isValidPin) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid password PIN' 
      });
    }

    res.json({
      success: true,
      is2FAEnabled: admin.is2FAEnabled || false,
      is2FAVerified: admin.is2FAVerified || false,
      hasSecret: !!admin.twoFASecret,
    });
  } catch (err) {
    logger.error('Error checking admin 2FA status:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
});

// Disable 2FA (requires super admin)
router.post('/disable-2fa', async (req, res) => {
  try {
    const { email, passwordPin, adminId } = req.body;

    if (!email || !passwordPin || !adminId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email, password PIN, and target admin ID are required' 
      });
    }

    // Find requesting admin (must be super admin)
    const requestingAdmin = await AdminUser.findOne({ email });
    if (!requestingAdmin) {
      return res.status(404).json({ 
        success: false, 
        message: 'Admin not found' 
      });
    }

    // Verify password PIN
    const isValidPin = await requestingAdmin.comparePasswordPin(passwordPin);
    if (!isValidPin) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid password PIN' 
      });
    }

    // Check if requesting admin is super admin
    if (requestingAdmin.role !== 'super_admin') {
      return res.status(403).json({ 
        success: false, 
        message: 'Only super admins can disable 2FA for other admins' 
      });
    }

    // Find target admin
    const targetAdmin = await AdminUser.findById(adminId);
    if (!targetAdmin) {
      return res.status(404).json({ 
        success: false, 
        message: 'Target admin not found' 
      });
    }

    targetAdmin.is2FAEnabled = false;
    targetAdmin.is2FAVerified = false;
    targetAdmin.twoFASecret = null;
    await targetAdmin.save();

    logger.info('Admin 2FA disabled by super admin', { 
      superAdminId: requestingAdmin._id,
      targetAdminId: targetAdmin._id,
      targetAdminEmail: targetAdmin.email
    });

    res.json({ 
      success: true, 
      message: '2FA disabled successfully' 
    });
  } catch (err) {
    logger.error('Error disabling admin 2FA:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
});

module.exports = router;
