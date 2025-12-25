const express = require('express');
const router = express.Router();
const User = require('../models/user');
const KYC = require('../models/kyc');
const validator = require('validator');
const logger = require('../utils/logger');

// Import the email service
const { sendKycEmail, sendNINVerificationEmail } = require('../services/EmailService');

// POST: Disable user's KYC by phone number (permanent admin override)
router.post('/cancel', async (req, res) => {
  const { phoneNumber, reason } = req.body;

  if (!phoneNumber || !validator.isMobilePhone(phoneNumber, 'any')) {
    logger.warn('Invalid or missing phone number in disable KYC request', { phoneNumber });
    return res.status(400).json({ success: false, error: 'Valid phone number is required.' });
  }

  try {
    const user = await User.findOne({ phonenumber: phoneNumber });
    if (!user) {
      logger.warn(`User not found: ${phoneNumber}`);
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const now = new Date();
    const cancellationReason = reason || 'KYC disabled by admin (permanent override)';

    // Cancel ALL KYC records
    const cancelResult = await KYC.updateMany(
      { userId: user._id, status: { $ne: 'CANCELLED' } },
      {
        $set: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledReason: cancellationReason,
          lastUpdated: now
        }
      }
    );

    // Permanently update user KYC status to rejected
    await User.findByIdAndUpdate(user._id, {
      $set: {
        'kyc.status': 'rejected',
        'kyc.updatedAt': now,
        'kyc.inProgress': false,
        'kyc.level2.status': 'rejected',
        'kyc.level2.rejectionReason': cancellationReason,
        'kycStatus': 'rejected'
      }
    });

    // --- SEND REJECTION EMAIL ---
    try {
      await sendKycEmail(
        user.email,
        user.firstname || 'User',
        'REJECTED',
        cancellationReason
      );
    } catch (emailErr) {
      logger.error('Failed to send KYC cancellation email', { userId: user._id, error: emailErr.message });
    }

    logger.info(`KYC permanently disabled for user: ${phoneNumber}`, {
      userId: user._id,
      cancelledCount: cancelResult.modifiedCount,
      reason: cancellationReason
    });

    return res.status(200).json({
      success: true,
      message: 'KYC disabled successfully (permanent admin override).',
      data: {
        userId: user._id,
        phoneNumber,
        cancelledCount: cancelResult.modifiedCount,
        reason: cancellationReason
      }
    });

  } catch (error) {
    logger.error('Error disabling KYC', { error: error.message, stack: error.stack, phoneNumber });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// POST: Approve user's KYC by phone number  
router.post('/approve', async (req, res) => {
  const { phoneNumber, idType, idNumber, fullName } = req.body;

  if (!phoneNumber || !validator.isMobilePhone(phoneNumber, 'any')) {
    logger.warn('Invalid or missing phone number in approve KYC request', { phoneNumber });
    return res.status(400).json({ success: false, error: 'Valid phone number is required.' });
  }

  if (!idType || !idNumber) {
    logger.warn('Missing idType or idNumber in approve KYC request', { phoneNumber });
    return res.status(400).json({ success: false, error: 'idType and idNumber are required.' });
  }

  try {
    const user = await User.findOne({ phonenumber: phoneNumber });
    if (!user) {
      logger.warn(`User not found: ${phoneNumber}`);
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const latestKyc = await KYC.findOne({
      userId: user._id,
      status: { $in: ['PENDING', 'REJECTED'] }
    }).sort({ createdAt: -1 });

    const now = new Date();
    let kycDoc;

    if (latestKyc) {
      kycDoc = await KYC.findByIdAndUpdate(
        latestKyc._id,
        {
          $set: {
            status: 'APPROVED',
            jobSuccess: true,
            resultCode: '1012',
            resultText: 'Manually approved by admin',
            frontendIdType: idType,
            idNumber,
            fullName: fullName || `${user.firstname} ${user.lastname}`,
            verificationDate: now,
            lastUpdated: now
          }
        },
        { new: true }
      );
    } else {
      kycDoc = await KYC.create({
        userId: user._id,
        provider: 'manual-admin',
        environment: process.env.NODE_ENV || 'production',
        partnerJobId: `manual_${user._id}_${Date.now()}`,
        jobType: 1,
        status: 'APPROVED',
        jobSuccess: true,
        resultCode: '1012',
        resultText: 'Manually approved by admin',
        idType: idType.toUpperCase(),
        frontendIdType: idType,
        idNumber,
        fullName: fullName || `${user.firstname} ${user.lastname}`,
        country: 'NG',
        verificationDate: now,
        lastUpdated: now,
        createdAt: now
      });
    }

    await User.findByIdAndUpdate(user._id, {
      $set: {
        'kyc.provider': 'manual-admin',
        'kyc.status': 'approved',
        'kyc.updatedAt': now,
        'kyc.latestKycId': kycDoc._id,
        'kyc.inProgress': false,
        'kyc.level2.status': 'approved',
        'kyc.level2.documentSubmitted': true,
        'kyc.level2.documentType': idType,
        'kyc.level2.documentNumber': idNumber,
        'kyc.level2.approvedAt': now,
        'kyc.level2.rejectionReason': null,
        'kycStatus': 'approved'
      }
    });

    const updatedUser = await User.findById(user._id);
    
    // --- SEND APPROVAL EMAIL ---
    try {
      const isNIN = ['nin', 'nin_slip', 'national_id'].includes(idType.toLowerCase());
      if (isNIN) {
        await sendNINVerificationEmail(updatedUser.email, updatedUser.firstname, 'approved', updatedUser.kycLevel);
      } else {
        await sendKycEmail(updatedUser.email, updatedUser.firstname, 'APPROVED', 'Your identity document has been manually verified by our team.');
      }
    } catch (emailErr) {
      logger.error('Failed to send Manual KYC approval email', { userId: user._id, error: emailErr.message });
    }

    try {
      await updatedUser.onIdentityDocumentVerified(idType, idNumber);
    } catch (upgradeError) {
      logger.warn('Error during KYC upgrade after manual approval', { error: upgradeError.message, userId: user._id });
    }

    logger.info(`KYC manually approved for user: ${phoneNumber}`, { userId: user._id, kycId: kycDoc._id, idType });

    return res.status(200).json({
      success: true,
      message: 'KYC approved successfully.',
      data: { userId: user._id, phoneNumber, kycId: kycDoc._id, status: 'APPROVED', idType, kycLevel: updatedUser.kycLevel }
    });

  } catch (error) {
    logger.error('Error approving KYC', { error: error.message, stack: error.stack, phoneNumber });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// POST: Reset KYC (Clean state)
router.post('/reset', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber || !validator.isMobilePhone(phoneNumber, 'any')) {
    return res.status(400).json({ success: false, error: 'Valid phone number is required.' });
  }

  try {
    const user = await User.findOne({ phonenumber: phoneNumber });
    if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

    await User.findByIdAndUpdate(user._id, {
      $set: {
        'kyc.status': 'not_verified',
        'kyc.inProgress': false,
        'kyc.level2.status': 'not_submitted',
        'kyc.level2.documentSubmitted': false,
        'kycStatus': 'not_verified'
      }
    });

    await KYC.updateMany({ userId: user._id, status: 'PENDING' }, {
      $set: { status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: 'Reset by admin' }
    });

    // Optional: Send an email about reset
    try {
      await sendKycEmail(user.email, user.firstname, 'RESET', 'Your KYC status has been reset. You can now re-submit your documents.');
    } catch (e) {}

    logger.info(`KYC reset for user: ${phoneNumber}`, { userId: user._id });
    return res.status(200).json({ success: true, message: 'KYC reset successfully.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// GET: List KYC Entries (Truncated for brevity, logic remains same)
router.get('/list', async (req, res) => { /* ... Keep your existing list logic ... */ });

// POST: Manually approve BVN for a user
router.post('/approve-bvn', async (req, res) => {
  const { phoneNumber, bvn } = req.body;

  if (!phoneNumber || !validator.isMobilePhone(phoneNumber, 'any') || !bvn) {
    return res.status(400).json({ success: false, error: 'Phone and BVN required.' });
  }

  try {
    const user = await User.findOne({ phonenumber: phoneNumber });
    if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

    await User.findByIdAndUpdate(user._id, { $set: { bvn: bvn, bvnVerified: true } });

    // Handle KYC record creation/update (Manual approval)
    const now = new Date();
    await KYC.create({
      userId: user._id, provider: 'manual-admin', status: 'APPROVED', 
      frontendIdType: 'bvn', idNumber: bvn, verificationDate: now
    });

    // --- SEND EMAIL ---
    try {
      await sendKycEmail(user.email, user.firstname, 'APPROVED', 'Your BVN has been manually verified.');
    } catch (e) {}

    return res.status(200).json({ success: true, message: 'BVN approved successfully.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// POST: Manually upgrade user KYC level
router.post('/upgrade', async (req, res) => {
  const { phoneNumber, kycLevel, reason } = req.body;

  if (!phoneNumber || !['level1', 'level2', 'level3'].includes(kycLevel)) {
    return res.status(400).json({ success: false, error: 'Invalid data.' });
  }

  try {
    const user = await User.findOne({ phonenumber: phoneNumber });
    if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

    const now = new Date();
    const upgradeReason = reason || 'Manually upgraded by admin';

    const updateData = {
      kycLevel,
      'kyc.status': 'approved',
      'kyc.updatedAt': now,
      'kycStatus': 'approved'
    };

    if (kycLevel === 'level2' || kycLevel === 'level3') {
      updateData['kyc.level2.status'] = 'approved';
      updateData['kyc.level2.approvedAt'] = now;
    }

    await User.findByIdAndUpdate(user._id, { $set: updateData });

    // --- SEND EMAIL ---
    try {
      await sendKycEmail(user.email, user.firstname, 'APPROVED', `Your account has been upgraded to ${kycLevel}. ${upgradeReason}`);
    } catch (e) {}

    return res.status(200).json({ success: true, message: `Upgraded to ${kycLevel}.` });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;