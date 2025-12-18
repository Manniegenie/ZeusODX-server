const express = require('express');
const router = express.Router();
const User = require('../models/user');
const KYC = require('../models/kyc');
const validator = require('validator');
const logger = require('../utils/logger');

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

    // Cancel ALL KYC records (not just pending) - permanent admin override
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

    // Permanently update user KYC status to rejected - admin override
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
    logger.error('Error disabling KYC', {
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
router.post('/reset', async (req, res) => {
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

// GET: Get all KYC entries with filtering and pagination
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

    // Build aggregation pipeline for search and user population
    const pipeline = [
      { $match: filter },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'user'
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

    // Get total count for pagination
    const countPipeline = [...pipeline, { $count: 'total' }];
    const totalResult = await KYC.aggregate(countPipeline);
    const total = totalResult.length > 0 ? totalResult[0].total : 0;

    // Add pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    pipeline.push(
      { $skip: skip },
      { $limit: parseInt(limit) }
    );

    // Project only necessary fields
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
        imageLinks: 1,
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

    // Calculate pagination info
    const totalPages = Math.ceil(total / parseInt(limit));
    const hasNextPage = parseInt(page) < totalPages;
    const hasPrevPage = parseInt(page) > 1;

    logger.info('KYC entries retrieved successfully', {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      status,
      idType,
      searchTerm: searchTerm ? '***' : null
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
        },
        filters: {
          status,
          idType,
          searchTerm: searchTerm ? '***' : null,
          dateFrom,
          dateTo
        }
      }
    });

  } catch (error) {
    logger.error('Error retrieving KYC entries', {
      error: error.message,
      stack: error.stack,
      query: req.query
    });
    return res.status(500).json({ 
      success: false, 
      error: 'Internal server error.' 
    });
  }
});

// GET: Get KYC entry details by ID
router.get('/details/:kycId', async (req, res) => {
  try {
    const { kycId } = req.params;

    if (!kycId || !validator.isMongoId(kycId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Valid KYC ID is required.' 
      });
    }

    const kycEntry = await KYC.findById(kycId).populate('userId', 
      'firstname lastname email phonenumber kycLevel kycStatus createdAt bvn bvnVerified'
    );

    if (!kycEntry) {
      return res.status(404).json({ 
        success: false, 
        error: 'KYC entry not found.' 
      });
    }

    logger.info('KYC entry details retrieved', { kycId });

    return res.status(200).json({
      success: true,
      data: {
        kyc: kycEntry,
        user: kycEntry.userId
      }
    });

  } catch (error) {
    logger.error('Error retrieving KYC entry details', {
      error: error.message,
      stack: error.stack,
      kycId: req.params.kycId
    });
    return res.status(500).json({ 
      success: false, 
      error: 'Internal server error.' 
    });
  }
});

// POST: Manually approve BVN for a user
router.post('/approve-bvn', async (req, res) => {
  const { phoneNumber, bvn } = req.body;

  if (!phoneNumber || !validator.isMobilePhone(phoneNumber, 'any')) {
    logger.warn('Invalid or missing phone number in approve BVN request', { phoneNumber });
    return res.status(400).json({ success: false, error: 'Valid phone number is required.' });
  }

  if (!bvn) {
    logger.warn('Missing BVN in approve BVN request', { phoneNumber });
    return res.status(400).json({ success: false, error: 'BVN is required.' });
  }

  try {
    const user = await User.findOne({ phonenumber: phoneNumber });
    if (!user) {
      logger.warn(`User not found: ${phoneNumber}`);
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const now = new Date();

    // Update user BVN and set bvnVerified to true
    await User.findByIdAndUpdate(user._id, {
      $set: {
        bvn: bvn,
        bvnVerified: true
      }
    });

    // Create or update KYC record for BVN
    const existingBvnKyc = await KYC.findOne({
      userId: user._id,
      frontendIdType: 'bvn'
    }).sort({ createdAt: -1 });

    let bvnKycDoc;
    if (existingBvnKyc) {
      bvnKycDoc = await KYC.findByIdAndUpdate(
        existingBvnKyc._id,
        {
          $set: {
            status: 'APPROVED',
            jobSuccess: true,
            resultCode: '1012',
            resultText: 'Manually approved by admin',
            idNumber: bvn,
            verificationDate: now,
            lastUpdated: now
          }
        },
        { new: true }
      );
    } else {
      bvnKycDoc = await KYC.create({
        userId: user._id,
        provider: 'manual-admin',
        environment: process.env.NODE_ENV || 'production',
        partnerJobId: `manual_bvn_${user._id}_${Date.now()}`,
        jobType: 1,
        status: 'APPROVED',
        jobSuccess: true,
        resultCode: '1012',
        resultText: 'Manually approved by admin',
        idType: 'BVN',
        frontendIdType: 'bvn',
        idNumber: bvn,
        country: 'NG',
        verificationDate: now,
        lastUpdated: now,
        createdAt: now
      });
    }

    const updatedUser = await User.findById(user._id);

    logger.info(`BVN manually approved for user: ${phoneNumber}`, {
      userId: user._id,
      kycId: bvnKycDoc._id,
      bvn: bvn.slice(0, 3) + '****'
    });

    return res.status(200).json({
      success: true,
      message: 'BVN approved successfully.',
      data: {
        userId: user._id,
        phoneNumber,
        kycId: bvnKycDoc._id,
        bvnVerified: updatedUser.bvnVerified
      }
    });

  } catch (error) {
    logger.error('Error approving BVN', {
      error: error.message,
      stack: error.stack,
      phoneNumber
    });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// POST: Manually verify BVN for a user (permanent admin override)
router.post('/verify-bvn', async (req, res) => {
  const { phoneNumber, bvn } = req.body;

  if (!phoneNumber || !validator.isMobilePhone(phoneNumber, 'any')) {
    logger.warn('Invalid or missing phone number in verify BVN request', { phoneNumber });
    return res.status(400).json({ success: false, error: 'Valid phone number is required.' });
  }

  try {
    const user = await User.findOne({ phonenumber: phoneNumber });
    if (!user) {
      logger.warn(`User not found: ${phoneNumber}`);
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    // Use provided BVN or existing user BVN
    const bvnToUse = bvn || user.bvn;
    if (!bvnToUse || !/^\d{11}$/.test(bvnToUse)) {
      logger.warn('Invalid or missing BVN in verify BVN request', { phoneNumber, hasUserBvn: !!user.bvn });
      return res.status(400).json({ success: false, error: 'Valid 11-digit BVN is required. Provide BVN or ensure user has BVN on record.' });
    }

    const now = new Date();

    // Update user BVN and set bvnVerified to true (permanent admin override)
    await User.findByIdAndUpdate(user._id, {
      $set: {
        bvn: bvnToUse,
        bvnVerified: true
      }
    });

    // Create or update KYC record for BVN with APPROVED status
    const existingBvnKyc = await KYC.findOne({
      userId: user._id,
      frontendIdType: 'bvn'
    }).sort({ createdAt: -1 });

    let bvnKycDoc;
    if (existingBvnKyc) {
      bvnKycDoc = await KYC.findByIdAndUpdate(
        existingBvnKyc._id,
        {
          $set: {
            status: 'APPROVED',
            jobSuccess: true,
            resultCode: '1012',
            resultText: 'Manually verified by admin',
            idNumber: bvnToUse,
            verificationDate: now,
            lastUpdated: now
          }
        },
        { new: true }
      );
    } else {
      bvnKycDoc = await KYC.create({
        userId: user._id,
        provider: 'manual-admin',
        environment: process.env.NODE_ENV || 'production',
        partnerJobId: `admin_verify_bvn_${user._id}_${Date.now()}`,
        jobType: 1,
        status: 'APPROVED',
        jobSuccess: true,
        resultCode: '1012',
        resultText: 'Manually verified by admin',
        idType: 'BVN',
        frontendIdType: 'bvn',
        idNumber: bvnToUse,
        country: 'NG',
        verificationDate: now,
        lastUpdated: now,
        createdAt: now
      });
    }

    const updatedUser = await User.findById(user._id);

    logger.info(`BVN manually verified for user: ${phoneNumber}`, {
      userId: user._id,
      kycId: bvnKycDoc._id,
      bvn: bvnToUse.slice(0, 3) + '****'
    });

    return res.status(200).json({
      success: true,
      message: 'BVN verified successfully.',
      data: {
        userId: user._id,
        phoneNumber,
        kycId: bvnKycDoc._id,
        bvnVerified: updatedUser.bvnVerified
      }
    });

  } catch (error) {
    logger.error('Error verifying BVN', {
      error: error.message,
      stack: error.stack,
      phoneNumber
    });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// POST: Manually disable/clear BVN for a user
router.post('/disable-bvn', async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber || !validator.isMobilePhone(phoneNumber, 'any')) {
    logger.warn('Invalid or missing phone number in disable BVN request', { phoneNumber });
    return res.status(400).json({ success: false, error: 'Valid phone number is required.' });
  }

  try {
    const user = await User.findOne({ phonenumber: phoneNumber });
    if (!user) {
      logger.warn(`User not found: ${phoneNumber}`);
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const now = new Date();

    // Clear BVN and set bvnVerified to false
    await User.findByIdAndUpdate(user._id, {
      $set: {
        bvn: null,
        bvnVerified: false
      }
    });

    // Cancel ALL BVN KYC records (permanent admin override)
    await KYC.updateMany(
      { userId: user._id, frontendIdType: 'bvn', status: { $ne: 'CANCELLED' } },
      {
        $set: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledReason: 'BVN disabled by admin (permanent override)',
          lastUpdated: now
        }
      }
    );

    const updatedUser = await User.findById(user._id);

    logger.info(`BVN disabled for user: ${phoneNumber}`, {
      userId: user._id,
      bvnVerified: updatedUser.bvnVerified
    });

    return res.status(200).json({
      success: true,
      message: 'BVN disabled successfully.',
      data: {
        userId: user._id,
        phoneNumber,
        bvnVerified: updatedUser.bvnVerified
      }
    });

  } catch (error) {
    logger.error('Error disabling BVN', {
      error: error.message,
      stack: error.stack,
      phoneNumber
    });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// POST: Manually upgrade user KYC level
router.post('/upgrade', async (req, res) => {
  const { phoneNumber, kycLevel, reason } = req.body;

  if (!phoneNumber || !validator.isMobilePhone(phoneNumber, 'any')) {
    logger.warn('Invalid or missing phone number in KYC upgrade request', { phoneNumber });
    return res.status(400).json({ success: false, error: 'Valid phone number is required.' });
  }

  if (!kycLevel || !['level1', 'level2', 'level3'].includes(kycLevel)) {
    logger.warn('Invalid KYC level in upgrade request', { phoneNumber, kycLevel });
    return res.status(400).json({ success: false, error: 'Valid KYC level (level1, level2, level3) is required.' });
  }

  try {
    const user = await User.findOne({ phonenumber: phoneNumber });
    if (!user) {
      logger.warn(`User not found for KYC upgrade: ${phoneNumber}`);
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const now = new Date();
    const upgradeReason = reason || 'Manually upgraded by admin';

    // Update user KYC level and status
    const updateData = {
      kycLevel,
      'kyc.status': 'approved',
      'kyc.updatedAt': now,
      'kyc.manualUpgrade': true,
      'kyc.upgradeReason': upgradeReason,
      'kyc.upgradedAt': now,
      'kycStatus': 'approved'
    };

    // Set level-specific data
    if (kycLevel === 'level2') {
      updateData['kyc.level2.status'] = 'approved';
      updateData['kyc.level2.approvedAt'] = now;
    } else if (kycLevel === 'level3') {
      updateData['kyc.level2.status'] = 'approved';
      updateData['kyc.level2.approvedAt'] = now;
      updateData['kyc.level3.status'] = 'approved';
      updateData['kyc.level3.approvedAt'] = now;
    }

    await User.findByIdAndUpdate(user._id, { $set: updateData });

    logger.info(`KYC manually upgraded for user: ${phoneNumber}`, {
      userId: user._id,
      kycLevel,
      reason: upgradeReason
    });

    return res.status(200).json({
      success: true,
      message: 'KYC upgraded successfully.',
      data: {
        userId: user._id,
        phoneNumber,
        kycLevel,
        reason: upgradeReason
      }
    });

  } catch (error) {
    logger.error('Error upgrading KYC', {
      error: error.message,
      stack: error.stack,
      phoneNumber,
      kycLevel
    });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;