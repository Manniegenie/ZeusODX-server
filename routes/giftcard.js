// app/routes/giftcard.js (performance-updated with better email error handling)
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');

const User = require('../models/user');
const GiftCard = require('../models/giftcard');
const Transaction = require('../models/transaction');
const GiftCardPrice = require('../models/giftcardPrice');
const logger = require('../utils/logger');
const { sendGiftcardSubmissionEmail } = require('../services/EmailService');

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Gift card config
const GIFTCARD_CONFIG = {
  SUPPORTED_TYPES: [
    'APPLE', 'STEAM', 'NORDSTROM', 'MACY', 'NIKE', 'GOOGLE_PLAY',
    'AMAZON', 'VISA', 'VANILLA', 'RAZOR_GOLD', 'AMERICAN_EXPRESS',
    'SEPHORA', 'FOOTLOCKER', 'XBOX', 'EBAY'
  ],
  SUPPORTED_FORMATS: ['PHYSICAL', 'E_CODE'],
  SUPPORTED_COUNTRIES: ['US', 'CANADA', 'AUSTRALIA', 'SWITZERLAND'],
  SUPPORTED_VANILLA_TYPES: ['4097', '4118'],
  MAX_PENDING_SUBMISSIONS: 5,
  MAX_IMAGES: 20,
  STATUS: { PENDING: 'PENDING' }
};

// Multer setup
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'), false);
    }
    cb(null, true);
  }
});

// Cloudinary upload helper (returns a Promise)
function uploadToCloudinary(fileBuffer) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream({
      folder: 'giftcards',
      transformation: [
        { width: 1000, height: 1000, crop: 'limit' },
        { quality: 'auto' },
        { fetch_format: 'auto' }
      ]
    }, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    }).end(fileBuffer);
  });
}

// Rate calculation with vanilla type support
async function calculateAmountToReceive(cardType, country, cardValue, cardFormat, vanillaType = null) {
  const options = {};
  if (cardType === 'VANILLA' && vanillaType) {
    options.vanillaType = vanillaType;
  }

  const rate = await GiftCardPrice.getRateByCardTypeAndCountry(cardType, country, options);
  if (!rate) {
    let errorMessage = `Rate not found for ${cardType} in ${country}`;
    if (cardType === 'VANILLA' && vanillaType) {
      errorMessage += ` with vanilla type ${vanillaType}`;
    }
    throw new Error(errorMessage);
  }
  
  if (!rate.isValidAmount(cardValue)) {
    throw new Error(`Amount must be between $${rate.minAmount} and $${rate.maxAmount}`);
  }
  
  return {
    ...rate.calculateAmount(cardValue, cardFormat),
    giftCardRateId: rate._id
  };
}

// Safe email sending function
async function safelySendGiftcardEmail(user, giftCard, transaction, rateCalculation, imageUrls) {
  try {
    if (!user.email) {
      logger.warn('User has no email; skipping giftcard submission email', { 
        userId: user._id, 
        submissionId: giftCard._id 
      });
      return { success: false, reason: 'No email address' };
    }

    await sendGiftcardSubmissionEmail(
      user.email,
      user.firstName || user.username || 'User',
      giftCard._id.toString(),
      giftCard.cardType,
      giftCard.cardFormat,
      giftCard.country,
      giftCard.cardValue,
      rateCalculation.amountToReceive,
      rateCalculation.targetCurrency,
      rateCalculation.rateDisplay,
      imageUrls.length,
      imageUrls.slice(0, 3),
      transaction._id.toString()
    );

    logger.info('Giftcard submission email sent successfully', { 
      userId: user._id, 
      submissionId: giftCard._id,
      email: user.email
    });
    
    return { success: true };
  } catch (emailErr) {
    logger.error('Failed to send giftcard submission email', {
      userId: user._id,
      submissionId: giftCard._id,
      email: user.email,
      error: emailErr.message,
      stack: emailErr.stack,
      // Include additional context for debugging
      templateIdConfigured: !!process.env.BREVO_TEMPLATE_GIFTCARD_SUBMISSION,
      brevoApiKeyConfigured: !!process.env.BREVO_API_KEY,
      senderEmailConfigured: !!process.env.SENDER_EMAIL || !!process.env.SUPPORT_EMAIL
    });
    
    return { 
      success: false, 
      reason: emailErr.message,
      error: emailErr 
    };
  }
}

// ---------------------------
// Gift card submission route
// ---------------------------
router.post('/submit', upload.array('cardImages', GIFTCARD_CONFIG.MAX_IMAGES), async (req, res) => {
  // Quick local helper for a 400 response
  const badRequest = (errors) => res.status(400).json({ success: false, message: 'Validation failed', errors });

  try {
    const {
      cardType,
      cardFormat,
      cardRange,
      cardValue: cardValueRaw, // string from form-data
      currency,
      country,
      description,
      eCode,
      vanillaType
    } = req.body;

    const errors = [];

    // Basic input validations (fast, synchronous)
    if (!cardType || !GIFTCARD_CONFIG.SUPPORTED_TYPES.includes(String(cardType).toUpperCase())) {
      errors.push('Invalid or missing card type');
    }
    if (!cardFormat || !GIFTCARD_CONFIG.SUPPORTED_FORMATS.includes(String(cardFormat).toUpperCase())) {
      errors.push('Invalid or missing card format');
    }
    if (!country || !GIFTCARD_CONFIG.SUPPORTED_COUNTRIES.includes(String(country).toUpperCase())) {
      errors.push('Invalid or missing country');
    }
    if (!cardRange) {
      errors.push('Card range is required');
    }

    // Vanilla type constraints
    if (cardType && String(cardType).toUpperCase() === 'VANILLA') {
      if (!vanillaType) {
        errors.push('Vanilla type is required for VANILLA gift cards');
      } else if (!GIFTCARD_CONFIG.SUPPORTED_VANILLA_TYPES.includes(String(vanillaType))) {
        errors.push(`Vanilla type must be one of: ${GIFTCARD_CONFIG.SUPPORTED_VANILLA_TYPES.join(', ')}`);
      }
    } else if (vanillaType) {
      errors.push('Vanilla type can only be specified for VANILLA gift cards');
    }

    // cardValue validation & normalization early to allow parallel work
    if (!cardValueRaw || typeof cardValueRaw !== 'string' || cardValueRaw.trim() === '') {
      errors.push('Card value is required');
    }
    const cardVal = parseFloat(cardValueRaw);
    if (isNaN(cardVal) || cardVal < 5 || cardVal > 2000) {
      errors.push('Card value must be between $5 and $2000');
    }

    if (String(cardFormat).toUpperCase() === 'E_CODE') {
      if (!eCode || eCode.length < 5 || eCode.length > 100) {
        errors.push('E-code must be between 5 and 100 characters');
      }
    }

    if (String(cardFormat).toUpperCase() === 'PHYSICAL') {
      if (!req.files || req.files.length === 0) {
        errors.push('At least one image is required for physical cards');
      }
      if (req.files && req.files.length > GIFTCARD_CONFIG.MAX_IMAGES) {
        errors.push(`Maximum ${GIFTCARD_CONFIG.MAX_IMAGES} images allowed`);
      }
    }

    if (errors.length > 0) return badRequest(errors);

    // Normalize
    const normalizedCardType = String(cardType).toUpperCase();
    const normalizedCardFormat = String(cardFormat).toUpperCase();
    const normalizedCountry = String(country).toUpperCase();
    const normalizedCurrency = (currency || 'USD').toUpperCase();
    const normalizedVanillaType = vanillaType || null;

    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    // Fetch user and pending count in parallel (both needed before heavy work)
    const [user, pendingCount] = await Promise.all([
      User.findById(userId).lean().exec(),
      GiftCard.countDocuments({ userId, status: { $in: ['PENDING', 'REVIEWING'] } })
    ]);

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (pendingCount >= GIFTCARD_CONFIG.MAX_PENDING_SUBMISSIONS) {
      return res.status(400).json({ success: false, message: `Maximum ${GIFTCARD_CONFIG.MAX_PENDING_SUBMISSIONS} pending submissions allowed` });
    }

    // Prepare two independent async tasks that we can run in parallel:
    // 1) upload images (if any)
    // 2) calculate expected rate/amount

    // Image uploads: run concurrently (if PHYSICAL)
    let uploadPromise = Promise.resolve([]);
    if (normalizedCardFormat === 'PHYSICAL' && req.files && req.files.length > 0) {
      const fileUploads = req.files.map((file) => uploadToCloudinary(file.buffer));
      // Use allSettled so we can log partial failures, but treat any rejection as failure for now
      uploadPromise = Promise.allSettled(fileUploads).then(results => {
        const rejected = results.filter(r => r.status === 'rejected');
        if (rejected.length > 0) {
          // Log individual errors for debugging
          rejected.forEach((r, i) => logger.error('Cloudinary upload error', { index: i, error: r.reason?.message || r.reason }));
          throw new Error('One or more image uploads failed');
        }
        // Map to results
        return results.map(r => r.value);
      });
    }

    // Rate calculation promise
    const ratePromise = calculateAmountToReceive(
      normalizedCardType,
      normalizedCountry,
      cardVal,
      normalizedCardFormat,
      normalizedVanillaType
    );

    // Run uploads + rate calc in parallel
    const [uploadedImages, rateCalculation] = await Promise.all([uploadPromise, ratePromise]);

    // map results
    const imageUrls = (uploadedImages || []).map(img => img.secure_url);
    const imagePublicIds = (uploadedImages || []).map(img => img.public_id);

    // Build gift card document (we create and then transaction)
    const giftCardData = {
      userId,
      cardType: normalizedCardType,
      cardFormat: normalizedCardFormat,
      cardRange,
      cardValue: cardVal,
      currency: normalizedCurrency,
      country: normalizedCountry,
      description: description || null,
      eCode: normalizedCardFormat === 'E_CODE' ? eCode : null,
      imageUrls,
      imagePublicIds,
      totalImages: imageUrls.length,
      status: GIFTCARD_CONFIG.STATUS.PENDING,
      expectedRate: rateCalculation.rate,
      expectedRateDisplay: rateCalculation.rateDisplay,
      expectedAmountToReceive: rateCalculation.amountToReceive,
      expectedSourceCurrency: rateCalculation.sourceCurrency,
      expectedTargetCurrency: rateCalculation.targetCurrency,
      giftCardRateId: rateCalculation.giftCardRateId,
      metadata: {
        submittedAt: new Date(),
        userAgent: req.get('User-Agent'),
        ipAddress: req.ip
      }
    };

    if (normalizedCardType === 'VANILLA' && normalizedVanillaType) {
      giftCardData.vanillaType = normalizedVanillaType;
    }

    // Persist gift card
    const giftCard = await GiftCard.create(giftCardData);

    // Create transaction referencing the giftCard
    const transactionData = {
      userId,
      type: 'GIFTCARD',
      currency: normalizedCurrency,
      amount: cardVal,
      status: 'PENDING',
      source: 'GIFTCARD',
      giftCardId: giftCard._id,
      cardType: normalizedCardType,
      cardFormat: normalizedCardFormat,
      cardRange,
      country: normalizedCountry,
      imageUrls,
      imagePublicIds,
      totalImages: imageUrls.length,
      eCode: normalizedCardFormat === 'E_CODE' ? eCode : null,
      description: description || null,
      expectedRate: rateCalculation.rate,
      expectedRateDisplay: rateCalculation.rateDisplay,
      expectedAmountToReceive: rateCalculation.amountToReceive,
      expectedSourceCurrency: rateCalculation.sourceCurrency,
      expectedTargetCurrency: rateCalculation.targetCurrency,
      narration: `Gift card submission - ${normalizedCardType} ${normalizedCardFormat} (${normalizedCountry}) - Expected: ${rateCalculation.amountToReceive} ${rateCalculation.targetCurrency}`
    };

    if (normalizedCardType === 'VANILLA' && normalizedVanillaType) {
      transactionData.vanillaType = normalizedVanillaType;
      transactionData.narration = `Gift card submission - ${normalizedCardType} ${normalizedVanillaType} ${normalizedCardFormat} (${normalizedCountry}) - Expected: ${rateCalculation.amountToReceive} ${rateCalculation.targetCurrency}`;
    }

    const transaction = await Transaction.create(transactionData);

    // Link transaction id back to giftCard (no need to block further ops on this)
    giftCard.transactionId = transaction._id;
    // Save without awaiting a fresh fetch — just update
    await giftCard.save();

    logger.info('Gift card submitted successfully', {
      userId,
      submissionId: giftCard._id,
      transactionId: transaction._id,
      cardType: normalizedCardType,
      cardFormat: normalizedCardFormat,
      country: normalizedCountry,
      vanillaType: normalizedVanillaType,
      cardValue: cardVal,
      expectedAmountToReceive: rateCalculation.amountToReceive
    });

    // Respond to client immediately with essential data
    const responseData = {
      submissionId: giftCard._id,
      transactionId: transaction._id,
      cardType: normalizedCardType,
      cardFormat: normalizedCardFormat,
      cardRange,
      cardValue: cardVal,
      currency: normalizedCurrency,
      country: normalizedCountry,
      expectedAmountToReceive: rateCalculation.amountToReceive,
      rate: rateCalculation.rateDisplay,
      totalImages: imageUrls.length,
      imageUrls,
      status: giftCard.status,
      submittedAt: giftCard.createdAt
    };
    if (normalizedCardType === 'VANILLA' && normalizedVanillaType) responseData.vanillaType = normalizedVanillaType;

    // FIRE & FORGET: send notification email asynchronously (non-blocking)
    // We intentionally do not await this so the HTTP response is faster.
    setImmediate(async () => {
      const emailResult = await safelySendGiftcardEmail(user, giftCard, transaction, rateCalculation, imageUrls);
      
      if (emailResult.success) {
        logger.info('Async: Giftcard submission email sent successfully', { 
          userId: user._id, 
          submissionId: giftCard._id,
          email: user.email
        });
      } else {
        logger.warn('Async: Giftcard submission email failed (non-critical)', {
          userId: user._id,
          submissionId: giftCard._id,
          email: user.email,
          reason: emailResult.reason
        });
        
        // Optionally, you could queue this for retry later
        // await addToEmailRetryQueue({ user, giftCard, transaction, rateCalculation, imageUrls });
      }
    });

    return res.status(201).json({ success: true, message: 'Gift card submitted successfully', data: responseData });

  } catch (err) {
    // Centralized error logging
    logger.error('Gift card submission failed (performance-updated route)', {
      userId: req.user?.id,
      cardType: req.body?.cardType,
      vanillaType: req.body?.vanillaType,
      error: err.message,
      stack: err.stack
    });

    // If cloudinary upload error bubbled up it will be caught here
    if (err.message && err.message.toLowerCase().includes('upload')) {
      return res.status(500).json({ success: false, message: 'Image upload failed', error: err.message });
    }

    return res.status(500).json({ success: false, message: 'Submission failed', error: err.message });
  }
});

module.exports = router;