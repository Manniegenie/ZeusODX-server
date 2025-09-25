// app/routes/giftcard.js (updated)
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');

const User = require('../models/user');
const GiftCard = require('../models/giftcard');
const Transaction = require('../models/transaction');
const GiftCardPrice = require('../models/giftcardPrice');
const logger = require('../utils/logger');
const { sendDepositEmail } = require('../services/EmailService'); // <-- email service import

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

// Cloudinary upload helper
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

// Gift card submission route
router.post('/submit', upload.array('cardImages', 20), async (req, res) => {
  try {
    const {
      cardType,
      cardFormat,
      cardRange,
      cardValue, // This comes as string from form data
      currency,
      country,
      description,
      eCode,
      vanillaType
    } = req.body;

    const errors = [];

    // Validate inputs
    if (!GIFTCARD_CONFIG.SUPPORTED_TYPES.includes(cardType?.toUpperCase())) {
      errors.push('Invalid card type');
    }
    if (!GIFTCARD_CONFIG.SUPPORTED_FORMATS.includes(cardFormat?.toUpperCase())) {
      errors.push('Invalid card format');
    }
    if (!GIFTCARD_CONFIG.SUPPORTED_COUNTRIES.includes(country?.toUpperCase())) {
      errors.push('Invalid country');
    }
    if (!cardRange) {
      errors.push('Card range is required');
    }

    // Validate vanillaType for VANILLA cards
    if (cardType && cardType.toUpperCase() === 'VANILLA') {
      if (!vanillaType) {
        errors.push('Vanilla type is required for VANILLA gift cards');
      } else if (!GIFTCARD_CONFIG.SUPPORTED_VANILLA_TYPES.includes(vanillaType)) {
        errors.push(`Vanilla type must be one of: ${GIFTCARD_CONFIG.SUPPORTED_VANILLA_TYPES.join(', ')}`);
      }
    } else if (vanillaType) {
      errors.push('Vanilla type can only be specified for VANILLA gift cards');
    }

    // Validate cardValue as string first, then convert to number
    if (!cardValue || typeof cardValue !== 'string' || cardValue.trim() === '') {
      errors.push('Card value is required');
    } else {
      const cardVal = parseFloat(cardValue);
      if (isNaN(cardVal) || cardVal < 5 || cardVal > 2000) {
        errors.push('Card value must be between $5 and $2000');
      }
    }

    if (cardFormat?.toUpperCase() === 'E_CODE') {
      if (!eCode || eCode.length < 5 || eCode.length > 100) {
        errors.push('E-code must be between 5 and 100 characters');
      }
    }

    if (cardFormat?.toUpperCase() === 'PHYSICAL' && (!req.files || req.files.length === 0)) {
      errors.push('At least one image is required for physical cards');
    }

    if (req.files && req.files.length > GIFTCARD_CONFIG.MAX_IMAGES) {
      errors.push(`Maximum ${GIFTCARD_CONFIG.MAX_IMAGES} images allowed`);
    }

    if (errors.length > 0) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    // Normalize
    const normalizedCardType = cardType.toUpperCase();
    const normalizedCardFormat = cardFormat.toUpperCase();
    const normalizedCountry = country.toUpperCase();
    const normalizedCurrency = currency?.toUpperCase() || 'USD';
    const normalizedVanillaType = vanillaType || null;
    const cardVal = parseFloat(cardValue); // Convert to number after validation

    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const pendingCount = await GiftCard.countDocuments({
      userId,
      status: { $in: ['PENDING', 'REVIEWING'] }
    });

    if (pendingCount >= GIFTCARD_CONFIG.MAX_PENDING_SUBMISSIONS) {
      return res.status(400).json({ success: false, message: `Maximum ${GIFTCARD_CONFIG.MAX_PENDING_SUBMISSIONS} pending submissions allowed` });
    }

    // Upload images
    const uploadedImages = [];
    for (const file of req.files) {
      const result = await uploadToCloudinary(file.buffer);
      uploadedImages.push(result);
    }

    // Rate calculation with vanilla type support
    const rateCalculation = await calculateAmountToReceive(
      normalizedCardType, 
      normalizedCountry, 
      cardVal, 
      normalizedCardFormat,
      normalizedVanillaType
    );

    const imageUrls = uploadedImages.map(img => img.secure_url);
    const imagePublicIds = uploadedImages.map(img => img.public_id);

    // Save gift card
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
      status: 'PENDING',
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

    // Add vanillaType for VANILLA cards
    if (normalizedCardType === 'VANILLA' && normalizedVanillaType) {
      giftCardData.vanillaType = normalizedVanillaType;
    }

    const giftCard = await GiftCard.create(giftCardData);

    // Save transaction
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

    // Add vanillaType for VANILLA cards
    if (normalizedCardType === 'VANILLA' && normalizedVanillaType) {
      transactionData.vanillaType = normalizedVanillaType;
      // Update narration to include vanilla type
      transactionData.narration = `Gift card submission - ${normalizedCardType} ${normalizedVanillaType} ${normalizedCardFormat} (${normalizedCountry}) - Expected: ${rateCalculation.amountToReceive} ${rateCalculation.targetCurrency}`;
    }

    const transaction = await Transaction.create(transactionData);

    giftCard.transactionId = transaction._id;
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

    // Send notification email to user (non-blocking; errors logged)
    try {
      if (user.email) {
        // Re-using sendDepositEmail signature: (email, name, amount, currency, reference)
        await sendDepositEmail(
          user.email,
          user.firstName || user.username || 'User',
          rateCalculation.amountToReceive,
          rateCalculation.targetCurrency,
          transaction._id.toString()
        );
        logger.info(`Giftcard submission email sent to ${user.email}`, { userId, submissionId: giftCard._id });
      } else {
        logger.warn(`User ${user._id} has no email, skipping giftcard submission email`);
      }
    } catch (emailErr) {
      // Log but don't fail the request if email fails
      logger.error('Failed to send giftcard submission email', { error: emailErr.message, stack: emailErr.stack, userId, submissionId: giftCard._id });
    }

    // Prepare response data
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

    // Add vanillaType to response for VANILLA cards
    if (normalizedCardType === 'VANILLA' && normalizedVanillaType) {
      responseData.vanillaType = normalizedVanillaType;
    }

    res.status(201).json({
      success: true,
      message: 'Gift card submitted successfully',
      data: responseData
    });

  } catch (error) {
    logger.error('Gift card submission failed', {
      userId: req.user?.id,
      cardType: req.body?.cardType,
      vanillaType: req.body?.vanillaType,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ success: false, message: 'Submission failed', error: error.message });
  }
});

module.exports = router;
