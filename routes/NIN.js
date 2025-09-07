// routes/NIN.js  (excerpt – keep your other code as-is)
const express = require('express');
const router = express.Router();
const User = require('../models/user');
const SmileIDNINService = require('../services/SmileIDService');
const EmailVerificationService = require('../services/VerifiedEmail');
const logger = require('../utils/logger');

const smileService = new SmileIDNINService();

router.post('/verify-nin', async (req, res) => {
  try {
    const userId = req.user.id;
    const { nin } = req.body;

    if (!nin) return res.status(400).json({ success: false, message: 'NIN is required' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.firstname || !user.lastname) {
      return res.status(400).json({ success: false, message: 'Please complete your profile with first and last name' });
    }
    if (user.kycLevel < 1) {
      return res.status(400).json({ success: false, message: 'Please complete phone verification first' });
    }
    if (!EmailVerificationService.isEmailVerifiedFromObject(user)) {
      return res.status(400).json({ success: false, message: 'Please verify your email address first' });
    }

    // NEW: block only while explicitly locked
    if (user.kyc?.level2?.submissionLocked === true) {
      return res.status(400).json({ success: false, message: 'NIN verification already in progress' });
    }

    // (Optional) You can still guard against 'approved' state:
    if (user.kyc.level2.status === 'approved') {
      return res.status(400).json({ success: false, message: 'NIN verification already completed' });
    }

    if (!smileService.validateNINFormat(nin)) {
      return res.status(400).json({ success: false, message: 'Invalid NIN format. NIN should be 11 digits' });
    }

    // mark pending locally (fast UX), service will lock too
    user.kyc.level2.status = 'pending';
    user.kyc.level2.documentType = 'NIN';
    user.kyc.level2.documentNumber = nin;
    user.kyc.level2.submittedAt = new Date();
    user.kyc.level2.submissionLocked = true;  // <<< lock
    user.kyc.level2.canResubmit = false;
    user.kycStatus = 'pending';
    await user.save();

    const verificationResult = await smileService.verifyNIN({
      userId,
      nin,
      firstName: user.firstname,
      lastName: user.lastname,
      middleName: '',
      dateOfBirth: '1990-01-01',
      gender: 'M',
      phoneNumber: user.phonenumber
    });

    logger.info('NIN verification submitted successfully', {
      userId,
      jobId: verificationResult.jobId,
      ninMasked: nin.slice(0, 3) + '********',
      firstName: user.firstname,
      lastName: user.lastname
    });

    res.status(200).json({
      success: true,
      message: 'NIN verification submitted successfully. You will be notified once verification is complete.',
      jobId: verificationResult.jobId,
      status: 'pending'
    });

  } catch (error) {
    logger.error('NIN verification submission failed', {
      error: error.message, stack: error.stack, userId: req.user?.id
    });

    // If submit failed, unlock so user can try again
    if (req.user?.id) {
      try {
        await User.findByIdAndUpdate(req.user.id, {
          $set: {
            'kyc.level2.status': 'not_submitted',
            'kyc.level2.submittedAt': null,
            'kyc.level2.submissionLocked': false,  // <<< unlock on error
            'kyc.level2.canResubmit': true,
            'kycStatus': 'not_verified'
          }
        }, { new: true });
      } catch (resetError) {
        logger.error('Failed to reset KYC status after submission error', { error: resetError.message, userId: req.user.id });
      }
    }

    res.status(500).json({ success: false, message: 'Failed to submit NIN verification. Please try again.' });
  }
});

// Webhook endpoint unchanged: the service now unlocks on success/failure
router.post('/smile-callback', async (req, res) => {
  try {
    logger.info('Received Smile ID webhook callback', {
      smileJobId: req.body.SmileJobID, resultCode: req.body.ResultCode
    });

    const result = await smileService.handleVerificationCallback(req.body);

    res.status(200).json({ success: true, message: 'Callback processed successfully' });

    if (result.verification_status === 'verified') {
      logger.info('User successfully verified via NIN', { userId: result.userId, kycLevel: result.kyc_level });
      // notify user...
    } else if (result.verification_status === 'failed') {
      logger.warn('User NIN verification failed', { userId: result.userId, resultText: result.result_text });
      // notify user...
    }
  } catch (error) {
    logger.error('Failed to process Smile ID callback', { error: error.message, stack: error.stack, callbackData: req.body });
    // Acknowledge to prevent retries
    res.status(200).json({ success: false, message: 'Callback processing failed' });
  }
});

module.exports = router;
