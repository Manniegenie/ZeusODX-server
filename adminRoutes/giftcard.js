const express = require('express');
const router = express.Router();
const GiftCardPrice = require('../models/giftcardPrice');
const logger = require('../utils/logger');

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

module.exports = router;