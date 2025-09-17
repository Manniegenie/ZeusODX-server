// routes/giftcards.js
const express = require('express');
const router = express.Router();
const GiftCardPrice = require('../models/giftcardPrice'); // Adjust path if needed

/**
 * Flexible normalizer that maps many client-side variations to canonical model values.
 * Returns an object: { cardType: 'APPLE'|'VISA'|'VANILLA'|..., vanillaType: '4097'|'4118'|undefined }
 */
function normalizeCardType(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();

  // Quick helpers
  const onlyAlpha = (t) => t.replace(/[^a-z0-9]/g, '');
  const includes = (t) => s.indexOf(t) !== -1;

  // Exact mappings & common aliases
  if (includes('apple') || includes('itunes')) return { cardType: 'APPLE' };
  if (includes('steam')) return { cardType: 'STEAM' };
  if (includes('nord') || includes('nordstrom')) return { cardType: 'NORDSTROM' };
  if (includes('macy')) return { cardType: 'MACY' };
  if (includes('nike')) return { cardType: 'NIKE' };
  if (includes('google') || includes('googleplay') || includes('google_play') || includes('playstore')) return { cardType: 'GOOGLE_PLAY' };
  if (includes('amazon')) return { cardType: 'AMAZON' };
  if (includes('american') || includes('amex') || includes('american_express') || includes('american-express')) return { cardType: 'AMERICAN_EXPRESS' };
  if (includes('sephora')) return { cardType: 'SEPHORA' };
  if (includes('foot') || includes('footlocker')) return { cardType: 'FOOTLOCKER' };
  if (includes('xbox')) return { cardType: 'XBOX' };
  if (includes('ebay')) return { cardType: 'EBAY' };
  if (includes('razor') || includes('razor_gold') || includes('razer')) return { cardType: 'RAZOR_GOLD' };

  // VISA vs VANILLA ambiguity handling:
  // If the string explicitly mentions "vanilla" or a bin variant (4097/4118) treat as VANILLA
  if (includes('vanilla') || includes('4097') || includes('4118')) {
    const vanillaType = s.includes('4097') ? '4097' : (s.includes('4118') ? '4118' : undefined);
    return { cardType: 'VANILLA', vanillaType };
  }

  // If the string explicitly mentions "visa" but not vanilla, map to VISA
  if (includes('visa')) {
    // guard: avoid false positive for "visa_card" that actually meant "vanilla" clients — but per instruction, handle client side
    // If the string also mentions vanilla-like terms, prefer VANILLA above; since we've already checked vanilla, we can safely map to VISA here.
    return { cardType: 'VISA' };
  }

  // Fallback: try to map clean alphanumeric token to possible enum (e.g., "VISA_CARD" -> "VISA")
  const token = onlyAlpha(s).toUpperCase();
  const known = [
    'APPLE','STEAM','NORDSTROM','MACY','NIKE','GOOGLEPLAY','GOOGLE_PLAY','AMAZON',
    'VISA','VANILLA','RAZORGOLD','RAZOR_GOLD','AMERICANEXPRESS','AMERICAN_EXPRESS',
    'SEPHORA','FOOTLOCKER','XBOX','EBAY'
  ];
  // normalize token variants
  if (token === 'GOOGLEPLAY' || token === 'GOOGLE_PLAY') return { cardType: 'GOOGLE_PLAY' };
  if (token === 'RAZORGOLD' || token === 'RAZOR_GOLD') return { cardType: 'RAZOR_GOLD' };
  if (token === 'AMERICANEXPRESS' || token === 'AMERICAN_EXPRESS') return { cardType: 'AMERICAN_EXPRESS' };
  if (known.includes(token)) {
    // map to canonical form
    if (token === 'GOOGLEPLAY') return { cardType: 'GOOGLE_PLAY' };
    if (token === 'RAZORGOLD') return { cardType: 'RAZOR_GOLD' };
    if (token === 'AMERICANEXPRESS') return { cardType: 'AMERICAN_EXPRESS' };
    if (token === 'VANILLA') return { cardType: 'VANILLA' };
    return { cardType: token };
  }

  // if nothing matched, return null so route can respond 400
  return null;
}

/**
 * GET /api/giftcards/:cardType/countries
 */
router.get('/:cardType/countries', async (req, res) => {
  try {
    const { cardType: rawCardType } = req.params;

    if (!rawCardType) {
      return res.status(400).json({ success: false, message: 'Card type parameter is required' });
    }

    const normalized = normalizeCardType(rawCardType);
    if (!normalized) {
      // client will handle enum deficiencies; server returns clear guidance
      return res.status(400).json({
        success: false,
        message: `Unable to map card type "${rawCardType}" to a known cardType`
      });
    }

    const { cardType, vanillaType } = normalized;

    // Call model helper and pass vanillaType when available
    const options = {};
    if (vanillaType) options.vanillaType = vanillaType;

    const countries = await GiftCardPrice.getCountriesForCard(cardType, options);

    if (!countries || countries.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No active countries found for ${cardType} gift cards`,
        data: { cardType, countries: [] }
      });
    }

    const formattedCountries = countries.map(row => ({
      code: row.country,
      name: getCountryDisplayName(row.country),
      rate: row.rate,
      rateDisplay: `${row.rate}/${row.sourceCurrency}`,
      sourceCurrency: row.sourceCurrency,
      // include vanillaType if present on DB row or requested
      vanillaType: row.vanillaType || (vanillaType || undefined)
    }));

    return res.status(200).json({
      success: true,
      message: `Available countries for ${cardType} retrieved successfully`,
      data: {
        cardType,
        cardTypeDisplay: getCardTypeDisplayName(cardType),
        requestedRaw: rawCardType,
        requestedNormalized: { cardType, vanillaType },
        totalCountries: countries.length,
        countries: formattedCountries
      }
    });

  } catch (err) {
    console.error('Error fetching countries for gift card:', err);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while fetching available countries',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
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
    'VISA': 'Visa',
    'VANILLA': 'Vanilla (4097 / 4118)',
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
