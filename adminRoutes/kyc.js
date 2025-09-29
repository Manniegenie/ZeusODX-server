const express = require('express');
const router = express.Router();
const User = require('../models/user');
const KYC = require('../models/kyc');
const validator = require('validator');
const logger = require('../utils/logger');

// POST: Cancel user's KYC by phone number
router.post('/cancel', async (req, res) => {
  const { phoneNumber, reason } = req.body;

  if (!phoneNumber || !validator.isMobilePhone(phoneNumber, 'any')) {
    logger.warn('Invalid or missing phone number in cancel KYC request', { phoneNumber });
    return res.status(400).json({ success: false, error: 'Valid phone number is required.' });
  }

  try {
    const user = await User.findOne({ phonenumber: phoneNumber });
    if (!user) {
      logger.warn(`User not found: ${phoneNumber}`);
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const pendingKycs = await KYC.find({
      userId: user._id,
      status: 'PENDING'
    });

    if (pendingKycs.length === 0) {
      logger.warn(`No pending KYC found for user: ${phoneNumber}`);
      return res.status(400).json({ 
        success: false, 
        error: 'No pending KYC documents found for this user.' 
      });
    }

    const now = new Date();
    const cancellationReason = reason || 'Manually cancelled by admin';

    const cancelResult = await KYC.updateMany(
      { userId: user._id, status: 'PENDING' },
      {
        $set: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledReason: cancellationReason,
          lastUpdated: now
        }
      }
    );

    // Use valid enum value 'rejected' instead of 'cancelled'
    await User.findByIdAndUpdate(user._id, {
      $set: {
        'kyc.status': 'rejected',
        'kyc.updatedAt': now,
        'kyc.inProgress': false,
        'kyc.level2.status': 'rejected',
        'kyc.level2.rejectionReason': cancellationReason
      }
    });

    logger.info(`KYC cancelled for user: ${phoneNumber}`, {
      userId: user._id,
      cancelledCount: cancelResult.modifiedCount,
      reason: cancellationReason
    });

    return res.status(200).json({
      success: true,
      message: 'KYC cancelled successfully.',
      data: {
        userId: user._id,
        phoneNumber,
        cancelledCount: cancelResult.modifiedCount,
        reason: cancellationReason
      }
    });

  } catch (error) {
    logger.error('Error cancelling KYC', {
      error: error.message,
      stack: error.stack,
      phoneNumber
    });
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
    try {
      await updatedUser.onIdentityDocumentVerified(idType, idNumber);
    } catch (upgradeError) {
      logger.warn('Error during KYC upgrade after manual approval', {
        error: upgradeError.message,
        userId: user._id
      });
    }

    logger.info(`KYC manually approved for user: ${phoneNumber}`, {
      userId: user._id,
      kycId: kycDoc._id,
      idType,
      idNumber: idNumber.slice(0, 4) + '****'
    });

    return res.status(200).json({
      success: true,
      message: 'KYC approved successfully.',
      data: {
        userId: user._id,
        phoneNumber,
        kycId: kycDoc._id,
        status: 'APPROVED',
        idType,
        kycLevel: updatedUser.kycLevel
      }
    });

  } catch (error) {
    logger.error('Error approving KYC', {
      error: error.message,
      stack: error.stack,
      phoneNumber
    });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// Add this to your admin routes
router.post('/kyc/reset', async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber || !validator.isMobilePhone(phoneNumber, 'any')) {
    logger.warn('Invalid or missing phone number in reset KYC request', { phoneNumber });
    return res.status(400).json({ success: false, error: 'Valid phone number is required.' });
  }

  try {
    const user = await User.findOne({ phonenumber: phoneNumber });
    if (!user) {
      logger.warn(`User not found: ${phoneNumber}`);
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    // Reset to clean state
    await User.findByIdAndUpdate(user._id, {
      $set: {
        'kyc.status': 'not_verified',
        'kyc.inProgress': false,
        'kyc.level2.status': 'not_submitted',
        'kyc.level2.documentSubmitted': false,
        'kyc.level2.documentType': null,
        'kyc.level2.documentNumber': null,
        'kyc.level2.rejectionReason': null,
        'kyc.level2.approvedAt': null,
        'kyc.level2.rejectedAt': null,
        'kyc.level2.submittedAt': null,
        'kycStatus': 'not_verified'
      }
    });

    // Also cancel any pending KYC documents
    await KYC.updateMany(
      { userId: user._id, status: 'PENDING' },
      {
        $set: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledReason: 'Reset by admin',
          lastUpdated: new Date()
        }
      }
    );

    logger.info(`KYC reset for user: ${phoneNumber}`, { userId: user._id });

    return res.status(200).json({
      success: true,
      message: 'KYC reset successfully.',
      data: {
        userId: user._id,
        phoneNumber
      }
    });

  } catch (error) {
    logger.error('Error resetting KYC', {
      error: error.message,
      stack: error.stack,
      phoneNumber
    });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;