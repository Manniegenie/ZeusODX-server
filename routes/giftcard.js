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
const { sendGiftcardSubmissionNotification } = require('../services/notificationService');

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Gift Card Types Mapping for Frontend Display
const GIFTCARD_TYPES = {
  'APPLE': 'Apple',
  'APPLE/ITUNES': 'Apple/iTunes',
  'STEAM': 'Steam',
  'NORDSTROM': 'Nordstrom',
  'MACY': "Macy's",
  'NIKE': 'Nike',
  'GOOGLE_PLAY': 'Google Play',
  'AMAZON': 'Amazon',
  'VISA': 'Visa',
  'VANILLA': 'Vanilla',
  'RAZOR_GOLD': 'Razor Gold',
  'AMERICAN_EXPRESS': 'American Express',
  'SEPHORA': 'Sephora',
  'FOOTLOCKER': 'Foot Locker',
  'XBOX': 'Xbox',
  'EBAY': 'eBay'
};

// Countries mapping
const COUNTRIES = {
  'US': 'United States',
  'CANADA': 'Canada',
  'AUSTRALIA': 'Australia',
  'SWITZERLAND': 'Switzerland'
};

// Card formats
const CARD_FORMATS = {
  'PHYSICAL': 'Physical Card',
  'E_CODE': 'E-Code'
};

// Vanilla types (for VANILLA cards only)
const VANILLA_TYPES = {
  '4097': 'Vanilla 4097',
  '4118': 'Vanilla 4118'
};

// Gift card config
const GIFTCARD_CONFIG = {
  SUPPORTED_TYPES: Object.keys(GIFTCARD_TYPES),
  SUPPORTED_FORMATS: Object.keys(CARD_FORMATS),
  SUPPORTED_COUNTRIES: Object.keys(COUNTRIES),
  SUPPORTED_VANILLA_TYPES: Object.keys(VANILLA_TYPES),
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

  logger.debug('Fetching rate for card', { cardType, country, vanillaType, options });
  const rate = await GiftCardPrice.getRateByCardTypeAndCountry(cardType, country, options);
  if (!rate) {
    const errorMessage = `Rate not found for ${cardType} in ${country}${cardType === 'VANILLA' && vanillaType ? ` with vanilla type ${vanillaType}` : ''}`;
    logger.error(errorMessage);
    throw new Error(errorMessage);
  }
  
  logger.debug('Rate found', { rate: rate._id, minAmount: rate.minAmount, maxAmount: rate.maxAmount });
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

// Debug middleware to log request details
router.use('/submit', (req, res, next) => {
  logger.debug('Incoming gift card submission request', {
    body: req.body,
    files: req.files ? req.files.map(f => ({ originalname: f.originalname, size: f.size, mimetype: f.mimetype })) : null,
    userId: req.user?.id,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  next();
});

// POST /giftcard/submit - Gift card submission route
router.post('/submit', upload.array('cardImages', GIFTCARD_CONFIG.MAX_IMAGES), async (req, res) => {
  const badRequest = (errors) => {
    logger.error('Validation failed', { errors });
    return res.status(400).json({ success: false, message: 'Validation failed', errors });
  };

  try {
    const {
      cardType,
      cardFormat,
      cardRange,
      cardValue: cardValueRaw,
      currency,
      country,
      description,
      eCode,
      vanillaType
    } = req.body;

    // Debug logging
    logger.info('Received gift card submission', {
      cardType,
      cardFormat,
      country,
      cardValue: cardValueRaw,
      cardRange,
      hasFiles: !!(req.files && req.files.length > 0),
      filesCount: req.files ? req.files.length : 0
    });

    const errors = [];

    // Validate only card type
    let isValidCardType = false;
    if (cardType) {
      const normalizedInputCardType = String(cardType).toUpperCase();
      if (GIFTCARD_CONFIG.SUPPORTED_TYPES.includes(normalizedInputCardType)) {
        isValidCardType = true;
      }
    }

    if (!isValidCardType) {
      errors.push(`Invalid or missing card type: ${cardType}. Supported types: ${GIFTCARD_CONFIG.SUPPORTED_TYPES.join(', ')}`);
    }

    if (errors.length > 0) return badRequest(errors);

    // Normalize - with Apple/iTunes handling
    let normalizedCardType = String(cardType).toUpperCase();
    if (normalizedCardType === 'APPLE/ITUNES') {
      normalizedCardType = 'APPLE';
    }
    
    const normalizedCardFormat = String(cardFormat).toUpperCase();
    const normalizedCountry = String(country).toUpperCase();
    const normalizedCurrency = (currency || 'USD').toUpperCase();
    const normalizedVanillaType = vanillaType || null;
    const cardVal = cardValueRaw ? parseFloat(cardValueRaw) : 0;

    logger.info('Normalized submission data', {
      originalCardType: cardType,
      normalizedCardType,
      normalizedCardFormat,
      normalizedCountry,
      normalizedCurrency,
      normalizedVanillaType,
      cardValue: cardVal
    });

    const userId = req.user?.id;
    if (!userId) {
      logger.error('Unauthorized submission attempt');
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // Fetch user
    logger.debug('Fetching user', { userId });
    const user = await User.findById(userId).lean().exec();
    if (!user) {
      logger.error('User not found', { userId });
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Image uploads: run concurrently (if PHYSICAL)
    let uploadPromise = Promise.resolve([]);
    if (normalizedCardFormat === 'PHYSICAL' && req.files && req.files.length > 0) {
      logger.debug('Starting image uploads', { fileCount: req.files.length });
      const fileUploads = req.files.map((file, index) => uploadToCloudinary(file.buffer)
        .catch(err => {
          logger.error('Image upload failed', { index, error: err.message });
          throw err;
        })
      );
      uploadPromise = Promise.allSettled(fileUploads).then(results => {
        const rejected = results.filter(r => r.status === 'rejected');
        if (rejected.length > 0) {
          rejected.forEach((r, i) => logger.error('Cloudinary upload error', { index: i, error: r.reason?.message || r.reason }));
          throw new Error('One or more image uploads failed');
        }
        logger.debug('Image uploads completed', { uploadedCount: results.length });
        return results.map(r => r.value);
      });
    }

    // Rate calculation promise
    logger.debug('Calculating rate', { cardType: normalizedCardType, country: normalizedCountry, cardValue: cardVal });
    const ratePromise = calculateAmountToReceive(
      normalizedCardType,
      normalizedCountry,
      cardVal,
      normalizedCardFormat,
      normalizedVanillaType
    ).catch(err => {
      logger.error('Rate calculation failed', { error: err.message });
      throw err;
    });

    // Run uploads + rate calc in parallel
    const [uploadedImages, rateCalculation] = await Promise.all([uploadPromise, ratePromise]);

    // Map results
    const imageUrls = (uploadedImages || []).map(img => img.secure_url);
    const imagePublicIds = (uploadedImages || []).map(img => img.public_id);
    logger.debug('Image upload results', { imageUrls, imagePublicIds });

    // Build gift card document
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
    logger.debug('Creating gift card document', { giftCardData });
    const giftCard = await GiftCard.create(giftCardData);

    // Create transaction
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

    logger.debug('Creating transaction', { transactionData });
    const transaction = await Transaction.create(transactionData);

    // Link transaction to gift card
    giftCard.transactionId = transaction._id;
    await giftCard.save();
    logger.info('Gift card and transaction saved', { giftCardId: giftCard._id, transactionId: transaction._id });

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

    // Response data
    const responseData = {
      submissionId: giftCard._id,
      transactionId: transaction._id,
      cardType: normalizedCardType,
      cardTypeName: GIFTCARD_TYPES[normalizedCardType],
      cardFormat: normalizedCardFormat,
      cardFormatName: CARD_FORMATS[normalizedCardFormat],
      cardRange,
      cardValue: cardVal,
      currency: normalizedCurrency,
      country: normalizedCountry,
      countryName: COUNTRIES[normalizedCountry],
      expectedAmountToReceive: rateCalculation.amountToReceive,
      rate: rateCalculation.rateDisplay,
      totalImages: imageUrls.length,
      imageUrls,
      status: giftCard.status,
      submittedAt: giftCard.createdAt
    };
    if (normalizedCardType === 'VANILLA' && normalizedVanillaType) {
      responseData.vanillaType = normalizedVanillaType;
      responseData.vanillaTypeName = VANILLA_TYPES[normalizedVanillaType];
    }

    // Send email and push notification asynchronously
    setImmediate(async () => {
      // Send email notification
      logger.debug('Sending gift card submission email', { userId, giftCardId: giftCard._id });
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
      }

      // Send push notification
      try {
        await sendGiftcardSubmissionNotification(
          userId,
          normalizedCardType,
          cardVal,
          rateCalculation.amountToReceive,
          giftCard._id.toString()
        );
        logger.info('Giftcard submission notification sent', {
          userId: user._id,
          submissionId: giftCard._id
        });
      } catch (error) {
        logger.error('Failed to send giftcard submission push notification', {
          userId: user._id,
          submissionId: giftCard._id,
          error: error.message
        });
      }
    });

    return res.status(201).json({ success: true, message: 'Gift card submitted successfully', data: responseData });

  } catch (err) {
    logger.error('Gift card submission failed', {
      userId: req.user?.id,
      cardType: req.body?.cardType,
      vanillaType: req.body?.vanillaType,
      error: err.message,
      stack: err.stack
    });

    if (err.message && err.message.toLowerCase().includes('upload')) {
      return res.status(500).json({ success: false, message: 'Image upload failed', error: err.message });
    }

    return res.status(500).json({ success: false, message: 'Submission failed', error: err.message });
  }
});

// GET /giftcard/types - Get supported gift card types
router.get('/types', (req, res) => {
  try {
    const giftcardOptions = Object.entries(GIFTCARD_TYPES).map(([value, label]) => ({
      value,
      label
    }));

    res.status(200).json({
      success: true,
      data: {
        types: giftcardOptions,
        countries: Object.entries(COUNTRIES).map(([value, label]) => ({ value, label })),
        formats: Object.entries(CARD_FORMATS).map(([value, label]) => ({ value, label })),
        vanillaTypes: Object.entries(VANILLA_TYPES).map(([value, label]) => ({ value, label }))
      },
      message: 'Gift card types retrieved successfully'
    });
  } catch (error) {
    logger.error('Error fetching gift card types', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch gift card types'
    });
  }
});

// GET /giftcard/rates - Get gift card rates (public endpoint)
router.get('/rates', async (req, res) => {
  try {
    const { country, cardType, vanillaType } = req.query;
    
    const query = { isActive: true };
    
    if (country) {
      query.country = country.toUpperCase();
    }
    
    if (cardType) {
      query.cardType = cardType.toUpperCase();
    }

    if (vanillaType) {
      query.vanillaType = vanillaType;
    }

    logger.debug('Fetching rates', { query });
    const rates = await GiftCardPrice.find(query)
      .sort({ country: 1, cardType: 1, vanillaType: 1 })
      .lean();

    const formattedRates = rates.map(rate => ({
      id: rate._id,
      cardType: rate.cardType,
      cardTypeName: GIFTCARD_TYPES[rate.cardType] || rate.cardType,
      country: rate.country,
      countryName: COUNTRIES[rate.country] || rate.country,
      rate: rate.rate,
      rateDisplay: `₦${rate.rate}/${rate.sourceCurrency}`,
      physicalRate: rate.physicalRate,
      ecodeRate: rate.ecodeRate,
      minAmount: rate.minAmount,
      maxAmount: rate.maxAmount,
      vanillaType: rate.vanillaType,
      vanillaTypeName: rate.vanillaType ? VANILLA_TYPES[rate.vanillaType] : null
    }));

    res.status(200).json({
      success: true,
      data: formattedRates,
      message: 'Gift card rates retrieved successfully'
    });

  } catch (error) {
    logger.error('Error fetching gift card rates', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch gift card rates'
    });
  }
});

// GET /giftcard/:id - Get gift card details
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const giftCard = await GiftCard.findOne({ _id: id, userId }).lean();
    
    if (!giftCard) {
      return res.status(404).json({ success: false, message: 'Gift card not found' });
    }

    const responseData = {
      ...giftCard,
      cardTypeName: GIFTCARD_TYPES[giftCard.cardType],
      cardFormatName: CARD_FORMATS[giftCard.cardFormat],
      countryName: COUNTRIES[giftCard.country],
      vanillaTypeName: giftCard.vanillaType ? VANILLA_TYPES[giftCard.vanillaType] : null
    };

    res.status(200).json({
      success: true,
      data: responseData,
      message: 'Gift card retrieved successfully'
    });

  } catch (error) {
    logger.error('Error fetching gift card', { 
      giftCardId: req.params.id, 
      userId: req.user?.id,
      error: error.message 
    });
    
    res.status(500).json({
      success: false,
      message: 'Failed to fetch gift card'
    });
  }
});

// GET /giftcard - Get user's gift cards
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { status, page = 1, limit = 10 } = req.query;
    const query = { userId };
    
    if (status) {
      query.status = status.toUpperCase();
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const [giftCards, total] = await Promise.all([
      GiftCard.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      GiftCard.countDocuments(query)
    ]);

    const formattedGiftCards = giftCards.map(card => ({
      ...card,
      cardTypeName: GIFTCARD_TYPES[card.cardType],
      cardFormatName: CARD_FORMATS[card.cardFormat],
      countryName: COUNTRIES[card.country],
      vanillaTypeName: card.vanillaType ? VANILLA_TYPES[card.vanillaType] : null
    }));

    res.status(200).json({
      success: true,
      data: {
        giftCards: formattedGiftCards,
        pagination: {
          currentPage: pageNum,
          totalPages: Math.ceil(total / limitNum),
          totalGiftCards: total,
          limit: limitNum
        }
      },
      message: 'Gift cards retrieved successfully'
    });

  } catch (error) {
    logger.error('Error fetching user gift cards', { 
      userId: req.user?.id,
      error: error.message 
    });
    
    res.status(500).json({
      success: false,
      message: 'Failed to fetch gift cards'
    });
  }
});

module.exports = router;