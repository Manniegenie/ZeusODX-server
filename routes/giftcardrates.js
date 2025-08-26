const express = require('express');
const router = express.Router();
const GiftCardPrice = require('../models/giftcardPrice');
const logger = require('../utils/logger');

// Allowed gift card types (from approved enum)
const allowedGiftCards = [
  'APPLE',
  'STEAM',
  'NORDSTROM',
  'MACY',
  'NIKE',
  'GOOGLE_PLAY',
  'AMAZON',
  'VISA',
  'RAZOR_GOLD',
  'AMERICAN_EXPRESS',
  'SEPHORA',
  'FOOTLOCKER',
  'XBOX',
  'EBAY'
];

// Allowed countries
const allowedCountries = ['US', 'CANADA', 'AUSTRALIA', 'SWITZERLAND'];

// Validation function
function validateRateRequest(body) {
  const { amount, giftcard, country, cardFormat } = body;
  const errors = [];

  if (!amount && amount !== 0) {
    errors.push('Amount is required');
  } else if (typeof amount !== 'number' || amount <= 0) {
    errors.push('Amount must be a positive number');
  } else if (amount < 5 || amount > 2000) {
    errors.push('Amount must be between $5 and $2000');
  }

  if (!giftcard) {
    errors.push('Giftcard type is required');
  } else if (typeof giftcard !== 'string') {
    errors.push('Giftcard must be a string');
  } else if (!allowedGiftCards.includes(giftcard.toUpperCase())) {
    errors.push(`Giftcard must be one of: ${allowedGiftCards.join(', ')}`);
  }

  if (!country) {
    errors.push('Country is required');
  } else if (!allowedCountries.includes(country.toUpperCase())) {
    errors.push('Country must be one of: US, CANADA, AUSTRALIA, SWITZERLAND');
  }

  if (cardFormat && !['PHYSICAL', 'E_CODE'].includes(cardFormat.toUpperCase())) {
    errors.push('Card format must be either PHYSICAL or E_CODE');
  }

  if (errors.length > 0) {
    return { success: false, errors, message: errors.join('; ') };
  }

  return {
    success: true,
    validatedData: {
      amount: parseFloat(amount),
      giftcard: giftcard.toUpperCase().trim(),
      country: country.toUpperCase().trim(),
      cardFormat: cardFormat ? cardFormat.toUpperCase() : null
    }
  };
}

// POST /calculate-rate - Calculate amount user will receive
router.post('/calculate-rate', async (req, res) => {
  try {
    const validation = validateRateRequest(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: validation.message,
        errors: validation.errors
      });
    }

    const { amount, giftcard, country, cardFormat } = validation.validatedData;
    const giftCardRate = await GiftCardPrice.getRateByCardTypeAndCountry(giftcard, country);

    if (!giftCardRate) {
      return res.status(404).json({
        success: false,
        message: `Rate not found for gift card type: ${giftcard} in country: ${country}`,
        availableCards: allowedGiftCards,
        availableCountries: allowedCountries
      });
    }

    if (!giftCardRate.isValidAmount(amount)) {
      return res.status(400).json({
        success: false,
        message: `Amount must be between ${giftCardRate.minAmount} and ${giftCardRate.maxAmount} for ${giftcard} in ${country}`,
        limits: {
          minAmount: giftCardRate.minAmount,
          maxAmount: giftCardRate.maxAmount
        }
      });
    }

    const calculation = giftCardRate.calculateAmount(amount, cardFormat);

    logger.info('Gift card rate calculation', {
      giftcard,
      country,
      amount,
      cardFormat,
      rate: calculation.rate,
      amountToReceive: calculation.amountToReceive
    });

    res.status(200).json({
      success: true,
      data: {
        amountToReceive: calculation.amountToReceive,
        rate: calculation.rateDisplay,
        giftcard: giftcard,
        country: country,
        calculation: {
          inputAmount: amount,
          exchangeRate: calculation.rate,
          outputAmount: calculation.amountToReceive,
          sourceCurrency: calculation.sourceCurrency,
          targetCurrency: calculation.targetCurrency,
          cardFormat: cardFormat,
          country: country
        }
      },
      message: 'Rate calculation completed successfully'
    });

  } catch (error) {
    logger.error('Error calculating gift card rate', { error: error.message, requestBody: req.body });
    res.status(500).json({
      success: false,
      message: 'Failed to calculate gift card rate'
    });
  }
});

module.exports = router;
