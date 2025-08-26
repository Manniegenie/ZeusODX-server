// routes/giftcards.js
const express = require('express');
const router = express.Router();
const GiftCardPrice = require('../models/giftcardPrice'); // Adjust path as needed

/**
 * GET /api/giftcards/:cardType/countries
 * Fetches available countries for a specific gift card type
 * 
 * @param {string} cardType - The gift card type (e.g., 'AMAZON', 'APPLE', etc.)
 * @returns {Object} Response with available countries and their rates
 */
router.get('/:cardType/countries', async (req, res) => {
  try {
    const { cardType } = req.params;
    
    // Validate cardType parameter
    if (!cardType) {
      return res.status(400).json({
        success: false,
        message: 'Card type is required'
      });
    }

    // Normalize cardType to uppercase to match schema enum
    const normalizedCardType = cardType.toUpperCase();

    // Valid card types from your schema
    const validCardTypes = [
      'APPLE', 'STEAM', 'NORDSTROM', 'MACY', 'NIKE', 'GOOGLE_PLAY',
      'AMAZON', 'VISA', 'RAZOR_GOLD', 'AMERICAN_EXPRESS', 'SEPHORA',
      'FOOTLOCKER', 'XBOX', 'EBAY'
    ];

    // Check if provided cardType is valid
    if (!validCardTypes.includes(normalizedCardType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid card type. Must be one of: ${validCardTypes.join(', ')}`,
        validCardTypes
      });
    }

    // Use the static method from your schema to get countries for this card type
    const countries = await GiftCardPrice.getCountriesForCard(normalizedCardType);

    if (!countries || countries.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No active countries found for ${normalizedCardType} gift cards`,
        data: {
          cardType: normalizedCardType,
          countries: []
        }
      });
    }

    // Transform the data to include additional useful information
    const formattedCountries = countries.map(country => ({
      code: country.country,
      name: getCountryDisplayName(country.country),
      rate: country.rate,
      rateDisplay: `${country.rate}/${country.sourceCurrency}`,
      sourceCurrency: country.sourceCurrency
    }));

    return res.status(200).json({
      success: true,
      message: `Available countries for ${normalizedCardType} retrieved successfully`,
      data: {
        cardType: normalizedCardType,
        cardTypeDisplay: getCardTypeDisplayName(normalizedCardType),
        totalCountries: countries.length,
        countries: formattedCountries
      }
    });

  } catch (error) {
    console.error('Error fetching countries for gift card:', error);
    
    return res.status(500).json({
      success: false,
      message: 'Internal server error while fetching available countries',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Helper function to get display names for countries
 */
function getCountryDisplayName(countryCode) {
  const countryNames = {
    'US': 'United States',
    'CANADA': 'Canada',
    'AUSTRALIA': 'Australia',
    'SWITZERLAND': 'Switzerland'
  };
  
  return countryNames[countryCode] || countryCode;
}

/**
 * Helper function to get display names for card types
 */
function getCardTypeDisplayName(cardType) {
  const cardTypeNames = {
    'APPLE': 'Apple/iTunes',
    'STEAM': 'Steam',
    'NORDSTROM': 'Nordstrom',
    'MACY': 'Macy\'s',
    'NIKE': 'Nike',
    'GOOGLE_PLAY': 'Google Play',
    'AMAZON': 'Amazon',
    'VISA': 'Visa/Vanilla',
    'RAZOR_GOLD': 'Razor Gold',
    'AMERICAN_EXPRESS': 'American Express',
    'SEPHORA': 'Sephora',
    'FOOTLOCKER': 'Footlocker',
    'XBOX': 'Xbox',
    'EBAY': 'eBay'
  };
  
  return cardTypeNames[cardType] || cardType;
}

module.exports = router;