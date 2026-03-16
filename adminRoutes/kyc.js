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

    // Send rejection email
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
    
    // Send approval email
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

    // Send reset email
    try {
      await sendKycEmail(user.email, user.firstname, 'RESET', 'Your KYC status has been reset. You can now re-submit your documents.');
    } catch (emailErr) {
      logger.error('Failed to send KYC reset email', { userId: user._id, error: emailErr.message });
    }

    logger.info(`KYC reset for user: ${phoneNumber}`, { userId: user._id });
    return res.status(200).json({ success: true, message: 'KYC reset successfully.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// GET: List KYC Entries with filtering and pagination
router.get('/list', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      idType,
      searchTerm,
      dateFrom,
      dateTo,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Build filter object
    const filter = {};
    
    if (status) {
      filter.status = status.toUpperCase();
    }
    
    if (idType) {
      filter.frontendIdType = idType;
    }
    
    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) {
        filter.createdAt.$gte = new Date(dateFrom);
      }
      if (dateTo) {
        filter.createdAt.$lte = new Date(dateTo);
      }
    }

    // Build aggregation pipeline
    const pipeline = [
      { $match: filter },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'user',
          // Only fetch necessary user fields for better performance
          pipeline: [
            {
              $project: {
                _id: 1,
                firstname: 1,
                lastname: 1,
                email: 1,
                phonenumber: 1,
                kycLevel: 1,
                kycStatus: 1
              }
            }
          ]
        }
      },
      { $unwind: '$user' }
    ];

    // Add search functionality
    if (searchTerm) {
      pipeline.push({
        $match: {
          $or: [
            { idNumber: { $regex: searchTerm, $options: 'i' } },
            { fullName: { $regex: searchTerm, $options: 'i' } },
            { 'user.firstname': { $regex: searchTerm, $options: 'i' } },
            { 'user.lastname': { $regex: searchTerm, $options: 'i' } },
            { 'user.email': { $regex: searchTerm, $options: 'i' } },
            { 'user.phonenumber': { $regex: searchTerm, $options: 'i' } }
          ]
        }
      });
    }

    // Add sorting
    const sortObj = {};
    sortObj[sortBy] = sortOrder === 'desc' ? -1 : 1;
    pipeline.push({ $sort: sortObj });

    // Get total count
    const countPipeline = [...pipeline, { $count: 'total' }];
    const totalResult = await KYC.aggregate(countPipeline);
    const total = totalResult.length > 0 ? totalResult[0].total : 0;

    // Add pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    pipeline.push(
      { $skip: skip },
      { $limit: parseInt(limit) }
    );

    // Project fields (exclude images for performance)
    pipeline.push({
      $project: {
        _id: 1,
        userId: 1,
        status: 1,
        idType: 1,
        frontendIdType: 1,
        idNumber: 1,
        fullName: 1,
        firstName: 1,
        lastName: 1,
        dateOfBirth: 1,
        gender: 1,
        country: 1,
        resultCode: 1,
        resultText: 1,
        confidenceValue: 1,
        verificationDate: 1,
        createdAt: 1,
        lastUpdated: 1,
        // Exclude imageLinks for performance (use /details endpoint to get images)
        hasImages: { $cond: [{ $ifNull: ['$imageLinks', false] }, true, false] },
        'user._id': 1,
        'user.firstname': 1,
        'user.lastname': 1,
        'user.email': 1,
        'user.phonenumber': 1,
        'user.kycLevel': 1,
        'user.kycStatus': 1
      }
    });

    const kycEntries = await KYC.aggregate(pipeline);

    // Calculate pagination
    const totalPages = Math.ceil(total / parseInt(limit));
    const hasNextPage = parseInt(page) < totalPages;
    const hasPrevPage = parseInt(page) > 1;

    logger.info('KYC entries retrieved', {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      resultsCount: kycEntries.length
    });

    return res.status(200).json({
      success: true,
      data: {
        kycEntries,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          total,
          hasNextPage,
          hasPrevPage,
          limit: parseInt(limit)
        }
      }
    });

  } catch (error) {
    logger.error('Error retrieving KYC entries', { error: error.message, stack: error.stack });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// GET: Get KYC details by ID
router.get('/details/:kycId', async (req, res) => {
  try {
    const { kycId } = req.params;

    if (!kycId || !validator.isMongoId(kycId)) {
      return res.status(400).json({ success: false, error: 'Valid KYC ID is required.' });
    }

    const kycEntry = await KYC.findById(kycId).populate('userId', 
      'firstname lastname email phonenumber kycLevel kycStatus createdAt bvn bvnVerified'
    );

    if (!kycEntry) {
      return res.status(404).json({ success: false, error: 'KYC entry not found.' });
    }

    return res.status(200).json({
      success: true,
      data: { kyc: kycEntry, user: kycEntry.userId }
    });

  } catch (error) {
    logger.error('Error retrieving KYC details', { error: error.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// POST: Approve BVN
router.post('/approve-bvn', async (req, res) => {
  const { phoneNumber, bvn } = req.body;

  if (!phoneNumber || !validator.isMobilePhone(phoneNumber, 'any') || !bvn) {
    return res.status(400).json({ success: false, error: 'Phone and BVN required.' });
  }

  try {
    const user = await User.findOne({ phonenumber: phoneNumber });
    if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

    await User.findByIdAndUpdate(user._id, { $set: { bvn: bvn, bvnVerified: true } });

    const now = new Date();
    await KYC.create({
      userId: user._id, provider: 'manual-admin', status: 'APPROVED', 
      frontendIdType: 'bvn', idNumber: bvn, verificationDate: now
    });

    // Send approval email
    try {
      await sendKycEmail(user.email, user.firstname, 'APPROVED', 'Your BVN has been manually verified.');
    } catch (emailErr) {
      logger.error('Failed to send BVN approval email', { userId: user._id, error: emailErr.message });
    }

    return res.status(200).json({ success: true, message: 'BVN approved successfully.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// POST: Verify BVN
router.post('/verify-bvn', async (req, res) => {
  const { phoneNumber, bvn } = req.body;

  if (!phoneNumber || !validator.isMobilePhone(phoneNumber, 'any')) {
    return res.status(400).json({ success: false, error: 'Valid phone number is required.' });
  }

  try {
    const user = await User.findOne({ phonenumber: phoneNumber });
    if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

    const bvnToUse = bvn || user.bvn;
    if (!bvnToUse || !/^\d{11}$/.test(bvnToUse)) {
      return res.status(400).json({ success: false, error: 'Valid 11-digit BVN is required.' });
    }

    const now = new Date();
    await User.findByIdAndUpdate(user._id, { $set: { bvn: bvnToUse, bvnVerified: true } });

    await KYC.create({
      userId: user._id, provider: 'manual-admin', status: 'APPROVED',
      frontendIdType: 'bvn', idNumber: bvnToUse, verificationDate: now
    });

    // Send verification email
    try {
      await sendKycEmail(user.email, user.firstname, 'APPROVED', 'Your BVN has been verified.');
    } catch (emailErr) {
      logger.error('Failed to send BVN verification email', { userId: user._id, error: emailErr.message });
    }

    return res.status(200).json({ success: true, message: 'BVN verified successfully.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// POST: Disable BVN
router.post('/disable-bvn', async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber || !validator.isMobilePhone(phoneNumber, 'any')) {
    return res.status(400).json({ success: false, error: 'Valid phone number is required.' });
  }

  try {
    const user = await User.findOne({ phonenumber: phoneNumber });
    if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

    const now = new Date();
    await User.findByIdAndUpdate(user._id, { $set: { bvn: null, bvnVerified: false } });

    await KYC.updateMany(
      { userId: user._id, frontendIdType: 'bvn', status: { $ne: 'CANCELLED' } },
      { $set: { status: 'CANCELLED', cancelledAt: now, cancelledReason: 'BVN disabled by admin' } }
    );

    return res.status(200).json({ success: true, message: 'BVN disabled successfully.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// POST: Upgrade KYC Level
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

    // Send upgrade email
    try {
      await sendKycEmail(user.email, user.firstname, 'APPROVED', `Your account has been upgraded to ${kycLevel}. ${upgradeReason}`);
    } catch (emailErr) {
      logger.error('Failed to send KYC upgrade email', { userId: user._id, error: emailErr.message });
    }

    return res.status(200).json({ success: true, message: `Upgraded to ${kycLevel}.` });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;