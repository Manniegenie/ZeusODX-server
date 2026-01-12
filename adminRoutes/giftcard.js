const express = require('express');
const router = express.Router();
const GiftCard = require('../models/giftcard');
const GiftCardPrice = require('../models/giftcardPrice');
const User = require('../models/user');
const Transaction = require('../models/transaction');
const logger = require('../utils/logger');
const validator = require('validator');
const { SendGiftcardMail } = require('../services/EmailService');

// Validation function for rate data (updated for NGN rates)
function validateRateData(data) {
  const { cardType, country, rate, physicalRate, ecodeRate, sourceCurrency, targetCurrency, minAmount, maxAmount, vanillaType } = data;
  const errors = [];

  // Updated allowed gift card types
  const allowedCardTypes = [
    'APPLE',
    'STEAM',
    'NORDSTROM',
    'MACY',
    'NIKE',
    'GOOGLE_PLAY',
    'AMAZON',
    'VISA',
    'VANILLA',
    'RAZOR_GOLD',
    'AMERICAN_EXPRESS',
    'SEPHORA',
    'FOOTLOCKER',
    'XBOX',
    'EBAY'
  ];

  const allowedCountries = ['US', 'CANADA', 'AUSTRALIA', 'SWITZERLAND'];
  const allowedCurrencies = ['USD', 'NGN', 'GBP', 'EUR', 'CAD'];
  const allowedVanillaTypes = ['4097', '4118'];

  // Required fields
  if (!cardType) {
    errors.push('cardType is required');
  } else if (!allowedCardTypes.includes(cardType.toUpperCase())) {
    errors.push(`Invalid cardType: ${cardType}`);
  }

  if (!country) {
    errors.push('country is required');
  } else if (!allowedCountries.includes(country.toUpperCase())) {
    errors.push(`Invalid country: ${country}`);
  }

  if (!rate && rate !== 0) {
    errors.push('rate is required');
  } else if (typeof rate !== 'number' || rate < 0) {
    errors.push('rate must be a positive number');
  } else if (rate < 100) {
    errors.push('rate seems too low for NGN conversion (expected range: 1000-2000)');
  }

  // Validate vanillaType for VANILLA cards
  if (cardType && cardType.toUpperCase() === 'VANILLA') {
    if (!vanillaType) {
      errors.push('vanillaType is required for VANILLA gift cards');
    } else if (!allowedVanillaTypes.includes(vanillaType)) {
      errors.push(`vanillaType must be one of: ${allowedVanillaTypes.join(', ')}`);
    }
  } else if (vanillaType) {
    errors.push('vanillaType can only be specified for VANILLA gift cards');
  }

  // Optional field validations
  if (physicalRate !== undefined && physicalRate !== null) {
    if (typeof physicalRate !== 'number' || physicalRate < 0) {
      errors.push('physicalRate must be a positive number');
    } else if (physicalRate < 100) {
      errors.push('physicalRate seems too low for NGN conversion (expected range: 1000-2000)');
    }
  }

  if (ecodeRate !== undefined && ecodeRate !== null) {
    if (typeof ecodeRate !== 'number' || ecodeRate < 0) {
      errors.push('ecodeRate must be a positive number');
    } else if (ecodeRate < 100) {
      errors.push('ecodeRate seems too low for NGN conversion (expected range: 1000-2000)');
    }
  }

  if (sourceCurrency && !allowedCurrencies.includes(sourceCurrency.toUpperCase())) {
    errors.push('Invalid sourceCurrency');
  }

  if (targetCurrency && !allowedCurrencies.includes(targetCurrency.toUpperCase())) {
    errors.push('Invalid targetCurrency');
  }

  if (minAmount !== undefined && minAmount !== null && (typeof minAmount !== 'number' || minAmount < 0)) {
    errors.push('minAmount must be a positive number');
  }

  if (maxAmount !== undefined && maxAmount !== null && (typeof maxAmount !== 'number' || maxAmount < 0)) {
    errors.push('maxAmount must be a positive number');
  }

  if (minAmount && maxAmount && minAmount > maxAmount) {
    errors.push('minAmount cannot be greater than maxAmount');
  }

  return {
    success: errors.length === 0,
    errors,
    validatedData: errors.length === 0 ? {
      cardType: cardType.toUpperCase(),
      country: country.toUpperCase(),
      rate: parseFloat(rate),
      physicalRate: physicalRate ? parseFloat(physicalRate) : null,
      ecodeRate: ecodeRate ? parseFloat(ecodeRate) : null,
      sourceCurrency: sourceCurrency ? sourceCurrency.toUpperCase() : 'USD',
      targetCurrency: targetCurrency ? targetCurrency.toUpperCase() : 'NGN',
      minAmount: minAmount ? parseFloat(minAmount) : 5,
      maxAmount: maxAmount ? parseFloat(maxAmount) : 2000,
      vanillaType: vanillaType || null
    } : null
  };
}

// POST /admin/giftcard/rates - Create new rate (no auth)
router.post('/rates', async (req, res) => {
  try {
    const validation = validateRateData(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors
      });
    }

    const rateData = {
      ...validation.validatedData,
      notes: req.body.notes || null
    };

    // Check if rate already exists (including vanillaType for VANILLA cards)
    const existingQuery = {
      cardType: rateData.cardType,
      country: rateData.country
    };

    if (rateData.cardType === 'VANILLA' && rateData.vanillaType) {
      existingQuery.vanillaType = rateData.vanillaType;
    }

    const existingRate = await GiftCardPrice.findOne(existingQuery);

    if (existingRate) {
      let message = `Rate already exists for ${rateData.cardType} in ${rateData.country}`;
      if (rateData.cardType === 'VANILLA' && rateData.vanillaType) {
        message += ` with vanilla type ${rateData.vanillaType}`;
      }
      message += '. Use PUT to update.';
      
      return res.status(409).json({
        success: false,
        message: message
      });
    }

    const newRate = await GiftCardPrice.create(rateData);

    logger.info('Gift card rate created', {
      cardType: newRate.cardType,
      country: newRate.country,
      rate: newRate.rate,
      vanillaType: newRate.vanillaType
    });

    res.status(201).json({
      success: true,
      message: 'Gift card rate created successfully',
      data: {
        id: newRate._id,
        cardType: newRate.cardType,
        country: newRate.country,
        rate: newRate.rate,
        rateDisplay: `₦${newRate.rate}/${newRate.sourceCurrency}`,
        physicalRate: newRate.physicalRate,
        ecodeRate: newRate.ecodeRate,
        minAmount: newRate.minAmount,
        maxAmount: newRate.maxAmount,
        vanillaType: newRate.vanillaType,
        isActive: newRate.isActive,
        createdAt: newRate.createdAt
      }
    });

  } catch (error) {
    logger.error('Error creating gift card rate', {
      error: error.message,
      requestBody: req.body
    });

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'Rate already exists for this card type and country combination'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create gift card rate'
    });
  }
});

// POST /admin/giftcard/rates/bulk - Create multiple rates (no auth)
router.post('/rates/bulk', async (req, res) => {
  try {
    const { rates } = req.body;

    if (!Array.isArray(rates) || rates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'rates must be a non-empty array'
      });
    }

    if (rates.length > 100) {
      return res.status(400).json({
        success: false,
        message: 'Maximum 100 rates can be created at once'
      });
    }

    const validatedRates = [];
    const errors = [];

    // Validate all rates first
    for (let i = 0; i < rates.length; i++) {
      const validation = validateRateData(rates[i]);
      if (!validation.success) {
        errors.push({
          index: i,
          data: rates[i],
          errors: validation.errors
        });
      } else {
        validatedRates.push({
          ...validation.validatedData,
          notes: rates[i].notes || null
        });
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed for some rates',
        errors: errors
      });
    }

    // Create all rates
    const createdRates = await GiftCardPrice.insertMany(validatedRates, { ordered: false });

    logger.info('Bulk gift card rates created', {
      totalRates: createdRates.length
    });

    res.status(201).json({
      success: true,
      message: `${createdRates.length} gift card rates created successfully`,
      data: {
        totalCreated: createdRates.length,
        rates: createdRates.map(rate => ({
          id: rate._id,
          cardType: rate.cardType,
          country: rate.country,
          rate: rate.rate,
          rateDisplay: `₦${rate.rate}/${rate.sourceCurrency}`,
          vanillaType: rate.vanillaType
        }))
      }
    });

  } catch (error) {
    logger.error('Error creating bulk gift card rates', {
      error: error.message
    });

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'Some rates already exist. Duplicates were skipped.',
        details: error.writeErrors || []
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create bulk gift card rates'
    });
  }
});

// PUT /admin/giftcard/rates/:id - Update existing rate (no auth)
router.put('/rates/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const existingRate = await GiftCardPrice.findById(id);
    if (!existingRate) {
      return res.status(404).json({
        success: false,
        message: 'Gift card rate not found'
      });
    }

    // Validate only provided fields
    const updateData = {};
    const fieldsToUpdate = ['rate', 'physicalRate', 'ecodeRate', 'minAmount', 'maxAmount', 'isActive', 'notes'];
    
    // Note: cardType, country, and vanillaType should not be updated after creation
    // as they define the unique identity of the rate
    
    for (const field of fieldsToUpdate) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    }

    // Validate rates if provided (updated for NGN ranges)
    if (updateData.rate !== undefined) {
      if (typeof updateData.rate !== 'number' || updateData.rate < 0) {
        return res.status(400).json({
          success: false,
          message: 'rate must be a positive number'
        });
      } else if (updateData.rate < 100) {
        return res.status(400).json({
          success: false,
          message: 'rate seems too low for NGN conversion (expected range: 1000-2000)'
        });
      }
    }

    if (updateData.physicalRate !== undefined && updateData.physicalRate !== null) {
      if (typeof updateData.physicalRate !== 'number' || updateData.physicalRate < 0) {
        return res.status(400).json({
          success: false,
          message: 'physicalRate must be a positive number'
        });
      } else if (updateData.physicalRate < 100) {
        return res.status(400).json({
          success: false,
          message: 'physicalRate seems too low for NGN conversion (expected range: 1000-2000)'
        });
      }
    }

    if (updateData.ecodeRate !== undefined && updateData.ecodeRate !== null) {
      if (typeof updateData.ecodeRate !== 'number' || updateData.ecodeRate < 0) {
        return res.status(400).json({
          success: false,
          message: 'ecodeRate must be a positive number'
        });
      } else if (updateData.ecodeRate < 100) {
        return res.status(400).json({
          success: false,
          message: 'ecodeRate seems too low for NGN conversion (expected range: 1000-2000)'
        });
      }
    }

    updateData.lastUpdated = new Date();

    const updatedRate = await GiftCardPrice.findByIdAndUpdate(id, updateData, { new: true });

    logger.info('Gift card rate updated', {
      rateId: id,
      cardType: updatedRate.cardType,
      country: updatedRate.country,
      vanillaType: updatedRate.vanillaType,
      updatedFields: Object.keys(updateData)
    });

    res.status(200).json({
      success: true,
      message: 'Gift card rate updated successfully',
      data: {
        id: updatedRate._id,
        cardType: updatedRate.cardType,
        country: updatedRate.country,
        rate: updatedRate.rate,
        rateDisplay: `₦${updatedRate.rate}/${updatedRate.sourceCurrency}`,
        physicalRate: updatedRate.physicalRate,
        ecodeRate: updatedRate.ecodeRate,
        minAmount: updatedRate.minAmount,
        maxAmount: updatedRate.maxAmount,
        vanillaType: updatedRate.vanillaType,
        isActive: updatedRate.isActive,
        lastUpdated: updatedRate.lastUpdated
      }
    });

  } catch (error) {
    logger.error('Error updating gift card rate', {
      rateId: req.params.id,
      error: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to update gift card rate'
    });
  }
});

// DELETE /admin/giftcard/rates/:id - Delete rate (no auth)
router.delete('/rates/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const deletedRate = await GiftCardPrice.findByIdAndDelete(id);
    
    if (!deletedRate) {
      return res.status(404).json({
        success: false,
        message: 'Gift card rate not found'
      });
    }

    logger.info('Gift card rate deleted', {
      rateId: id,
      cardType: deletedRate.cardType,
      country: deletedRate.country,
      vanillaType: deletedRate.vanillaType
    });

    res.status(200).json({
      success: true,
      message: 'Gift card rate deleted successfully',
      data: {
        deletedRate: {
          cardType: deletedRate.cardType,
          country: deletedRate.country,
          rate: deletedRate.rate,
          vanillaType: deletedRate.vanillaType
        }
      }
    });

  } catch (error) {
    logger.error('Error deleting gift card rate', {
      rateId: req.params.id,
      error: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to delete gift card rate'
    });
  }
});

// GET /admin/giftcard/rates - Get all rates (admin view with more details) (no auth)
router.get('/rates', async (req, res) => {
  try {
    const { country, cardType, vanillaType, isActive, page = 1, limit = 50 } = req.query;
    
    const query = {};
    
    if (country) {
      if (!['US', 'CANADA', 'AUSTRALIA', 'SWITZERLAND'].includes(country.toUpperCase())) {
        return res.status(400).json({
          success: false,
          message: 'Invalid country'
        });
      }
      query.country = country.toUpperCase();
    }
    
    if (cardType) {
      query.cardType = cardType.toUpperCase();
    }

    if (vanillaType) {
      if (!['4097', '4118'].includes(vanillaType)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid vanillaType. Must be 4097 or 4118'
        });
      }
      query.vanillaType = vanillaType;
    }
    
    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // No populate() on updatedBy anymore
    const rates = await GiftCardPrice.find(query)
      .sort({ country: 1, cardType: 1, vanillaType: 1 })
      .skip(skip)
      .limit(limitNum);

    const total = await GiftCardPrice.countDocuments(query);

    res.status(200).json({
      success: true,
      data: {
        rates: rates.map(rate => ({
          id: rate._id,
          cardType: rate.cardType,
          country: rate.country,
          rate: rate.rate,
          rateDisplay: `₦${rate.rate}/${rate.sourceCurrency}`,
          physicalRate: rate.physicalRate,
          ecodeRate: rate.ecodeRate,
          sourceCurrency: rate.sourceCurrency,
          targetCurrency: rate.targetCurrency,
          minAmount: rate.minAmount,
          maxAmount: rate.maxAmount,
          vanillaType: rate.vanillaType,
          isActive: rate.isActive,
          lastUpdated: rate.lastUpdated,
          notes: rate.notes,
          createdAt: rate.createdAt
        })),
        pagination: {
          currentPage: pageNum,
          totalPages: Math.ceil(total / limitNum),
          totalRates: total,
          limit: limitNum
        }
      },
      message: 'Gift card rates retrieved successfully'
    });

  } catch (error) {
    logger.error('Error fetching admin gift card rates', {
      error: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to fetch gift card rates'
    });
  }
});

// ==================== GIFT CARD SUBMISSION REVIEW ENDPOINTS ====================

// GET /admin/giftcard/submissions - List all gift card submissions with filtering
router.get('/submissions', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      cardType,
      country,
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

    if (cardType) {
      filter.cardType = cardType.toUpperCase();
    }

    if (country) {
      filter.country = country.toUpperCase();
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
          pipeline: [
            {
              $project: {
                _id: 1,
                firstname: 1,
                lastname: 1,
                email: 1,
                phonenumber: 1,
                username: 1
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
            { eCode: { $regex: searchTerm, $options: 'i' } },
            { cardRange: { $regex: searchTerm, $options: 'i' } },
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
    const totalResult = await GiftCard.aggregate(countPipeline);
    const total = totalResult.length > 0 ? totalResult[0].total : 0;

    // Add pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    pipeline.push(
      { $skip: skip },
      { $limit: parseInt(limit) }
    );

    const submissions = await GiftCard.aggregate(pipeline);

    // Calculate pagination
    const totalPages = Math.ceil(total / parseInt(limit));
    const hasNextPage = parseInt(page) < totalPages;
    const hasPrevPage = parseInt(page) > 1;

    logger.info('Gift card submissions retrieved', {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      resultsCount: submissions.length
    });

    return res.status(200).json({
      success: true,
      data: {
        submissions,
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
    logger.error('Error retrieving gift card submissions', { error: error.message, stack: error.stack });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// GET /admin/giftcard/submissions/:id - Get gift card submission details
router.get('/submissions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!validator.isMongoId(id)) {
      return res.status(400).json({ success: false, error: 'Valid submission ID is required.' });
    }

    const submission = await GiftCard.findById(id)
      .populate('userId', 'firstname lastname email phonenumber username createdAt')
      .populate('giftCardRateId')
      .populate('transactionId');

    if (!submission) {
      return res.status(404).json({ success: false, error: 'Gift card submission not found.' });
    }

    return res.status(200).json({
      success: true,
      data: { submission }
    });

  } catch (error) {
    logger.error('Error retrieving gift card submission details', { error: error.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// POST /admin/giftcard/submissions/:id/approve - Approve gift card submission and fund user
router.post('/submissions/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { approvedValue, paymentRate, notes } = req.body;

    if (!validator.isMongoId(id)) {
      return res.status(400).json({ success: false, error: 'Valid submission ID is required.' });
    }

    const submission = await GiftCard.findById(id).populate('userId');
    if (!submission) {
      return res.status(404).json({ success: false, error: 'Gift card submission not found.' });
    }

    if (submission.status !== 'PENDING' && submission.status !== 'REVIEWING') {
      return res.status(400).json({
        success: false,
        error: `Cannot approve submission with status: ${submission.status}`
      });
    }

    const now = new Date();

    // Calculate payment amount
    const finalApprovedValue = approvedValue || submission.cardValue;
    const finalPaymentRate = paymentRate || submission.expectedRate;
    const paymentAmount = finalApprovedValue * finalPaymentRate;

    // Update submission
    submission.status = 'APPROVED';
    submission.approvedValue = finalApprovedValue;
    submission.paymentRate = finalPaymentRate;
    submission.paymentAmount = paymentAmount;
    submission.reviewedAt = now;
    submission.reviewNotes = notes || null;

    await submission.save();

    // Create and process transaction to fund user
    const transaction = await Transaction.create({
      userId: submission.userId._id,
      type: 'GIFTCARD_PAYOUT',
      currency: 'NGN',
      amount: paymentAmount,
      status: 'SUCCESSFUL',
      description: `Gift card approved: ${submission.cardType} ${submission.cardFormat}`,
      metadata: {
        giftCardId: submission._id,
        cardType: submission.cardType,
        cardValue: finalApprovedValue,
        paymentRate: finalPaymentRate,
        approvedBy: 'admin'
      }
    });

    // Update submission with transaction reference
    submission.transactionId = transaction._id;
    submission.paidAt = now;
    submission.status = 'PAID';
    await submission.save();

    // Fund user's NGNZ balance
    const user = await User.findById(submission.userId._id);
    if (!user.ngnzBalance) {
      user.ngnzBalance = 0;
    }
    user.ngnzBalance += paymentAmount;
    await user.save();

    logger.info('Gift card submission approved and user funded', {
      submissionId: id,
      userId: submission.userId._id,
      paymentAmount,
      ngnzBalance: user.ngnzBalance,
      transactionId: transaction._id
    });

    // Send approval email to user
    try {
      logger.info('Attempting to send approval email', {
        userId: submission.userId._id,
        email: submission.userId.email,
        submissionId: submission._id,
        paymentAmount,
        hasBrevoTemplateApproved: !!process.env.BREVO_TEMPLATE_GIFTCARD_APPROVED,
        hasBrevoApiKey: !!process.env.BREVO_API_KEY
      });

      await SendGiftcardMail(
        submission.userId.email,
        submission.userId.firstname || submission.userId.username || 'User',
        {
          status: 'APPROVED',
          submissionId: submission._id.toString(),
          giftcardType: submission.cardType,
          cardFormat: submission.cardFormat,
          country: submission.country,
          cardValue: submission.cardValue,
          approvedValue: finalApprovedValue,
          paymentAmount: paymentAmount,
          paymentCurrency: 'NGN',
          paymentRate: finalPaymentRate,
          rateDisplay: `₦${finalPaymentRate}/USD`,
          transactionId: transaction._id.toString(),
          reference: transaction._id.toString(),
          reviewNotes: notes,
          reviewedAt: now
        }
      );

      logger.info('✅ Approval email sent successfully to user', {
        userId: submission.userId._id,
        email: submission.userId.email,
        submissionId: submission._id
      });
    } catch (emailError) {
      logger.error('❌ Failed to send approval email - CRITICAL', {
        error: emailError.message,
        stack: emailError.stack,
        statusCode: emailError.statusCode || emailError.status,
        response: emailError.response?.body || emailError.response,
        userId: submission.userId._id,
        email: submission.userId.email,
        submissionId: submission._id,
        paymentAmount,
        brevoTemplateApproved: process.env.BREVO_TEMPLATE_GIFTCARD_APPROVED,
        brevoApiKeyConfigured: !!process.env.BREVO_API_KEY,
        senderEmail: process.env.SENDER_EMAIL || process.env.SUPPORT_EMAIL
      });
      // Don't fail the request if email fails, but log extensively for debugging
    }

    return res.status(200).json({
      success: true,
      message: 'Gift card approved and user funded successfully.',
      data: {
        submissionId: submission._id,
        status: submission.status,
        paymentAmount,
        transactionId: transaction._id,
        userBalance: user.ngnzBalance
      }
    });

  } catch (error) {
    logger.error('Error approving gift card submission', { error: error.message, stack: error.stack });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// POST /admin/giftcard/submissions/:id/reject - Reject gift card submission
router.post('/submissions/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { rejectionReason, notes } = req.body;

    if (!validator.isMongoId(id)) {
      return res.status(400).json({ success: false, error: 'Valid submission ID is required.' });
    }

    if (!rejectionReason) {
      return res.status(400).json({ success: false, error: 'Rejection reason is required.' });
    }

    const validReasons = ['INVALID_IMAGE', 'ALREADY_USED', 'INSUFFICIENT_BALANCE', 'FAKE_CARD', 'UNREADABLE', 'WRONG_TYPE', 'EXPIRED', 'INVALID_ECODE', 'DUPLICATE_ECODE', 'OTHER'];
    if (!validReasons.includes(rejectionReason)) {
      return res.status(400).json({ success: false, error: 'Invalid rejection reason.' });
    }

    const submission = await GiftCard.findById(id).populate('userId');
    if (!submission) {
      return res.status(404).json({ success: false, error: 'Gift card submission not found.' });
    }

    if (submission.status !== 'PENDING' && submission.status !== 'REVIEWING') {
      return res.status(400).json({
        success: false,
        error: `Cannot reject submission with status: ${submission.status}`
      });
    }

    // Update submission
    submission.status = 'REJECTED';
    submission.rejectionReason = rejectionReason;
    submission.reviewNotes = notes || null;
    submission.reviewedAt = new Date();

    await submission.save();

    logger.info('Gift card submission rejected', {
      submissionId: id,
      userId: submission.userId,
      rejectionReason
    });

    // Send rejection email to user
    try {
      logger.info('Attempting to send rejection email', {
        userId: submission.userId._id,
        email: submission.userId.email,
        submissionId: submission._id,
        rejectionReason,
        hasBrevoTemplateRejected: !!process.env.BREVO_TEMPLATE_GIFTCARD_REJECTED,
        hasBrevoApiKey: !!process.env.BREVO_API_KEY
      });

      await SendGiftcardMail(
        submission.userId.email,
        submission.userId.firstname || submission.userId.username || 'User',
        {
          status: 'REJECTED',
          submissionId: submission._id.toString(),
          giftcardType: submission.cardType,
          cardFormat: submission.cardFormat,
          country: submission.country,
          cardValue: submission.cardValue,
          rejectionReason: rejectionReason,
          reviewNotes: notes,
          reviewedAt: submission.reviewedAt
        }
      );

      logger.info('✅ Rejection email sent successfully to user', {
        userId: submission.userId._id,
        email: submission.userId.email,
        submissionId: submission._id
      });
    } catch (emailError) {
      logger.error('❌ Failed to send rejection email - CRITICAL', {
        error: emailError.message,
        stack: emailError.stack,
        statusCode: emailError.statusCode || emailError.status,
        response: emailError.response?.body || emailError.response,
        userId: submission.userId._id,
        email: submission.userId.email,
        submissionId: submission._id,
        rejectionReason,
        brevoTemplateRejected: process.env.BREVO_TEMPLATE_GIFTCARD_REJECTED,
        brevoApiKeyConfigured: !!process.env.BREVO_API_KEY,
        senderEmail: process.env.SENDER_EMAIL || process.env.SUPPORT_EMAIL
      });
      // Don't fail the request if email fails, but log extensively for debugging
    }

    return res.status(200).json({
      success: true,
      message: 'Gift card submission rejected successfully.',
      data: {
        submissionId: submission._id,
        status: submission.status,
        rejectionReason
      }
    });

  } catch (error) {
    logger.error('Error rejecting gift card submission', { error: error.message, stack: error.stack });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// POST /admin/giftcard/submissions/:id/review - Mark submission as under review
router.post('/submissions/:id/review', async (req, res) => {
  try {
    const { id } = req.params;

    if (!validator.isMongoId(id)) {
      return res.status(400).json({ success: false, error: 'Valid submission ID is required.' });
    }

    const submission = await GiftCard.findById(id);
    if (!submission) {
      return res.status(404).json({ success: false, error: 'Gift card submission not found.' });
    }

    if (submission.status !== 'PENDING') {
      return res.status(400).json({
        success: false,
        error: `Cannot mark submission as reviewing with status: ${submission.status}`
      });
    }

    submission.status = 'REVIEWING';
    await submission.save();

    logger.info('Gift card submission marked as reviewing', { submissionId: id });

    return res.status(200).json({
      success: true,
      message: 'Gift card submission marked as under review.',
      data: { submissionId: submission._id, status: submission.status }
    });

  } catch (error) {
    logger.error('Error marking gift card as reviewing', { error: error.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;