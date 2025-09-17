// routes/giftcards.js
const express = require('express');
const router = express.Router();
const GiftCardPrice = require('../models/giftcardPrice'); // adjust path if needed
const logger = console; // replace with your logger if you have one

/**
 * Route:
 *   GET /:cardType/countries
 *   GET /:cardType/:subType/countries
 *
 * Examples the route will accept:
 *   /APPLE/countries
 *   /APPLE/ITUNES/countries
 *   /APPLE-ITUNES/countries
 *   /GOOGLE_PLAY/countries
 *   /GOOGLEPLAY/countries
 *   /VISA/Vanilla/countries
 */
router.get('/:cardType/:subType?/countries', async (req, res) => {
  try {
    let { cardType: rawCardType, subType } = req.params;

    // Basic validation
    if (!rawCardType) {
      return res.status(400).json({ success: false, message: 'Card type is required' });
    }

    // Normalize incoming values
    const normalize = (s) => String(s || '').trim().toUpperCase().replace(/[\s\-]+/g, '_');

    let normalizedCardType = normalize(rawCardType);
    let normalizedSubType = subType ? normalize(subType) : '';

    // If cardType contains a delimiter like "APPLE/ITUNES" or "APPLE-ITUNES" or "APPLE_ITUNES"
    // (some clients may send combined strings), attempt to split and interpret.
    if (normalizedCardType.includes('/') || normalizedCardType.includes('_')) {
      // try to split on underscore (after normalization)
      const parts = normalizedCardType.split('_').filter(Boolean);
      if (parts.length >= 2) {
        // prefer the first part as cardType, second as subtype
        normalizedCardType = parts[0];
        if (!normalizedSubType) normalizedSubType = parts[1];
      }
    }

    // Map common subtype aliases to canonical card types or canonical enum names.
    // Extend this map if you have more aliases.
    const subtypeToCardMap = {
      ITUNES: 'APPLE',
      ITUNE: 'APPLE',
      APPLE_ITUNES: 'APPLE',
      APPLEITUNES: 'APPLE',

      GOOGLEPLAY: 'GOOGLE_PLAY',
      GOOGLE_PLAY: 'GOOGLE_PLAY',
      PLAY: 'GOOGLE_PLAY',
      'GOOGLE-PLAY': 'GOOGLE_PLAY',

      VANILLA: 'VISA',
      VISA_VANILLA: 'VISA',
      'VISA-VANILLA': 'VISA',

      RAZORGOLD: 'RAZOR_GOLD',
      RAZOR_GOLD: 'RAZOR_GOLD',

      AMEX: 'AMERICAN_EXPRESS',
      AMERICANEXPRESS: 'AMERICAN_EXPRESS',
      'AMERICAN-EXPRESS': 'AMERICAN_EXPRESS'
    };

    // If a subtype maps to a canonical card type, prefer that
    if (normalizedSubType && subtypeToCardMap[normalizedSubType]) {
      normalizedCardType = subtypeToCardMap[normalizedSubType];
    }

    // If cardType itself is an alias in map, map it
    if (subtypeToCardMap[normalizedCardType]) {
      normalizedCardType = subtypeToCardMap[normalizedCardType];
    }

    // Final canonical list of valid card types (match your schema)
    const validCardTypes = [
      'APPLE', 'STEAM', 'NORDSTROM', 'MACY', 'NIKE', 'GOOGLE_PLAY',
      'AMAZON', 'VISA', 'RAZOR_GOLD', 'AMERICAN_EXPRESS', 'SEPHORA',
      'FOOTLOCKER', 'XBOX', 'EBAY'
    ];

    // Defensive: if someone passes "APPLE_ITUNES" as single token after normalization,
    // try to map it back:
    if (!validCardTypes.includes(normalizedCardType) && subtypeToCardMap[normalizedCardType]) {
      normalizedCardType = subtypeToCardMap[normalizedCardType];
    }

    if (!validCardTypes.includes(normalizedCardType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid card type. Must be one of: ${validCardTypes.join(', ')}`,
        validCardTypes
      });
    }

    // Query DB for active rates for this card type
    const countries = await GiftCardPrice.getCountriesForCard(normalizedCardType);

    if (!countries || countries.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No active countries found for ${normalizedCardType} gift cards`,
        data: { cardType: normalizedCardType, countries: [] }
      });
    }

    // Format response
    const formattedCountries = countries.map(c => ({
      code: c.country,
      name: getCountryDisplayName(c.country),
      rate: c.rate,
      rateDisplay: `${c.rate}/${c.sourceCurrency}`,
      sourceCurrency: c.sourceCurrency
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

  } catch (err) {
    logger.error('Error fetching countries for gift card:', err && (err.stack || err.message || err));
    return res.status(500).json({
      success: false,
      message: 'Internal server error while fetching available countries',
      error: process.env.NODE_ENV === 'development' ? (err && err.message) : undefined
    });
  }
});

/**
 * Helper: country display names
 */
function getCountryDisplayName(countryCode) {
  const map = {
    'US': 'United States',
    'CANADA': 'Canada',
    'AUSTRALIA': 'Australia',
    'SWITZERLAND': 'Switzerland'
  };
  const k = String(countryCode || '').toUpperCase();
  return map[k] || k;
}

/**
 * Helper: card type display names
 */
function getCardTypeDisplayName(cardType) {
  const map = {
    'APPLE': 'Apple / iTunes',
    'STEAM': 'Steam',
    'NORDSTROM': 'Nordstrom',
    'MACY': 'Macy\'s',
    'NIKE': 'Nike',
    'GOOGLE_PLAY': 'Google Play',
    'AMAZON': 'Amazon',
    'VISA': 'Visa / Vanilla',
    'RAZOR_GOLD': 'Razor Gold',
    'AMERICAN_EXPRESS': 'American Express',
    'SEPHORA': 'Sephora',
    'FOOTLOCKER': 'Footlocker',
    'XBOX': 'Xbox',
    'EBAY': 'eBay'
  };
  return map[cardType] || cardType;
}

module.exports = router;
