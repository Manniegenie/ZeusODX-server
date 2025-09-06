const express = require('express');
const router = express.Router();
const User = require('../models/user');
const SmileIDNINService = require('../services/SmileIDService');
const EmailVerificationService = require('../services/VerifiedEmail');
const logger = require('../utils/logger');

const smileService = new SmileIDNINService();

// POST: /api/kyc/verify-nin - Submit NIN for verification
router.post('/verify-nin', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      nin,
      firstName,
      lastName,
      middleName,
      dateOfBirth, // YYYY-MM-DD
      gender, // M or F
      phoneNumber
    } = req.body;

    // Validate required fields
    if (!nin || !firstName || !lastName || !dateOfBirth || !gender) {
      return res.status(400).json({
        success: false,
        message: 'All required fields must be provided: nin, firstName, lastName, dateOfBirth, gender'
      });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if user has completed KYC Level 1 (phone verification)
    if (user.kycLevel < 1) {
      return res.status(400).json({
        success: false,
        message: 'Please complete phone verification first'
      });
    }

    // Check if user's email is verified
    if (!EmailVerificationService.isEmailVerifiedFromObject(user)) {
      return res.status(400).json({
        success: false,
        message: 'Please verify your email address first'
      });
    }

    // Check if NIN verification is already in progress or completed
    if (user.kyc.level2.status === 'pending') {
      return res.status(400).json({
        success: false,
        message: 'NIN verification already in progress'
      });
    }

    if (user.kyc.level2.status === 'approved') {
      return res.status(400).json({
        success: false,
        message: 'NIN verification already completed'
      });
    }

    // Validate NIN format
    if (!smileService.validateNINFormat(nin)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid NIN format. NIN should be 11 digits'
      });
    }

    // Validate date of birth format
    const dobRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dobRegex.test(dateOfBirth)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date of birth format. Use YYYY-MM-DD'
      });
    }

    // Validate gender
    if (!['M', 'F'].includes(gender.toUpperCase())) {
      return res.status(400).json({
        success: false,
        message: 'Gender must be M or F'
      });
    }

    // Update user's KYC status to pending
    user.kyc.level2.status = 'pending';
    user.kyc.level2.documentType = 'NIN';
    user.kyc.level2.documentNumber = nin;
    user.kyc.level2.submittedAt = new Date();
    user.kycStatus = 'pending';
    await user.save();

    // Submit to Smile ID
    const verificationResult = await smileService.verifyNIN({
      userId,
      nin,
      firstName,
      lastName,
      middleName,
      dateOfBirth,
      gender: gender.toUpperCase(),
      phoneNumber: phoneNumber || user.phonenumber
    });

    logger.info('NIN verification submitted successfully', {
      userId,
      jobId: verificationResult.jobId,
      ninMasked: nin.slice(0, 3) + '********'
    });

    res.status(200).json({
      success: true,
      message: 'NIN verification submitted successfully. You will be notified once verification is complete.',
      jobId: verificationResult.jobId,
      status: 'pending'
    });

  } catch (error) {
    logger.error('NIN verification submission failed', {
      error: error.message,
      stack: error.stack,
      userId: req.user?.id
    });

    // Reset user's KYC status if submission failed
    if (req.user?.id) {
      try {
        const user = await User.findById(req.user.id);
        if (user && user.kyc.level2.status === 'pending') {
          user.kyc.level2.status = 'not_submitted';
          user.kyc.level2.submittedAt = null;
          user.kycStatus = user.kycLevel >= 1 ? 'approved' : 'not_verified';
          await user.save();
        }
      } catch (resetError) {
        logger.error('Failed to reset KYC status after submission error', {
          error: resetError.message,
          userId: req.user.id
        });
      }
    }

    res.status(500).json({
      success: false,
      message: 'Failed to submit NIN verification. Please try again.'
    });
  }
});

// POST: /api/kyc/smile-callback - Webhook endpoint for Smile ID results
router.post('/smile-callback', async (req, res) => {
  try {
    logger.info('Received Smile ID webhook callback', {
      smileJobId: req.body.SmileJobID,
      resultCode: req.body.ResultCode
    });

    // Process the callback
    const result = await smileService.handleVerificationCallback(req.body);

    // Send success response to Smile ID
    res.status(200).json({
      success: true,
      message: 'Callback processed successfully'
    });

    // You might want to notify the user via email/push notification here
    if (result.verification_status === 'verified') {
      logger.info('User successfully verified via NIN', {
        userId: result.userId,
        kycLevel: result.kyc_level
      });
      // TODO: Send success notification to user
    } else if (result.verification_status === 'failed') {
      logger.warn('User NIN verification failed', {
        userId: result.userId,
        resultText: result.result_text
      });
      // TODO: Send failure notification to user
    }

  } catch (error) {
    logger.error('Failed to process Smile ID callback', {
      error: error.message,
      stack: error.stack,
      callbackData: req.body
    });

    // Still send success to prevent retries
    res.status(200).json({
      success: false,
      message: 'Callback processing failed'
    });
  }
});

// GET: /api/kyc/verification-status - Check NIN verification status
router.get('/verification-status', async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId).select('kyc kycLevel kycStatus');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const verificationStatus = {
      kycLevel: user.kycLevel,
      kycStatus: user.kycStatus,
      level1: {
        status: user.kyc.level1.status,
        phoneVerified: user.kyc.level1.phoneVerified,
        verifiedAt: user.kyc.level1.verifiedAt
      },
      level2: {
        status: user.kyc.level2.status,
        emailVerified: user.kyc.level2.emailVerified,
        documentSubmitted: user.kyc.level2.documentSubmitted,
        documentType: user.kyc.level2.documentType,
        submittedAt: user.kyc.level2.submittedAt,
        approvedAt: user.kyc.level2.approvedAt,
        rejectedAt: user.kyc.level2.rejectedAt,
        rejectionReason: user.kyc.level2.rejectionReason
      },
      limits: user.getKycLimits()
    };

    res.status(200).json({
      success: true,
      verificationStatus
    });

  } catch (error) {
    logger.error('Failed to get verification status', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      success: false,
      message: 'Failed to get verification status'
    });
  }
});

// GET: /api/kyc/test-data - Get sandbox test data (development only)
router.get('/test-data', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({
      success: false,
      message: 'Not found'
    });
  }

  const testData = smileService.getSandboxTestData();
  res.status(200).json({
    success: true,
    message: 'Sandbox test data for NIN verification',
    testData
  });
});

module.exports = router;