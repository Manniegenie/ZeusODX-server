// models/giftcardPrice.js
const mongoose = require('mongoose');

const giftCardPriceSchema = new mongoose.Schema({
  cardType: {
    type: String,
    required: true,
    enum: [
      'APPLE',              // Apple / iTunes
      'STEAM',              // Steam card
      'NORDSTROM',          // Nordstrom
      'MACY',               // Macy
      'NIKE',               // Nike gift card
      'GOOGLE_PLAY',        // Google Play Store
      'AMAZON',             // Amazon gift card
      'VISA',               // Visa
      'VANILLA',            // Vanilla (two BIN variations supported via vanillaType)
      'RAZOR_GOLD',         // Razor gold gift card
      'AMERICAN_EXPRESS',   // American Express (3779/3751)
      'SEPHORA',            // Sephora
      'FOOTLOCKER',         // Footlocker
      'XBOX',               // Xbox card
      'EBAY'                // eBay
    ],
    index: true
  },

  // For VANILLA rows, which BIN/variation (4097 or 4118). null for other card types.
  vanillaType: {
    type: String,
    enum: ['4097', '4118', null],
    default: null,
    index: true
  },

  // Country for the gift card rate
  country: {
    type: String,
    required: true,
    enum: ['US', 'CANADA', 'AUSTRALIA', 'SWITZERLAND'],
    index: true
  },

  // Exchange rate (e.g., 918 means 918 NGN per 1 USD)
  rate: {
    type: Number,
    required: true,
    min: 0
  },

  // Source currency (what the gift card is denominated in)
  sourceCurrency: {
    type: String,
    required: true,
    enum: ['USD', 'NGN', 'GBP', 'EUR', 'CAD'],
    default: 'USD'
  },

  // Target currency (what user receives)
  targetCurrency: {
    type: String,
    required: true,
    enum: ['USD', 'NGN', 'GBP', 'EUR', 'CAD'],
    default: 'NGN'
  },

  // Card format specific rates (optional)
  physicalRate: {
    type: Number,
    min: 0,
    default: null
  },

  ecodeRate: {
    type: Number,
    min: 0,
    default: null
  },

  // Minimum and maximum amounts
  minAmount: {
    type: Number,
    default: 25,
    min: 0
  },

  maxAmount: {
    type: Number,
    default: 1000,
    min: 0
  },

  // Status
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },

  // Additional metadata
  lastUpdated: {
    type: Date,
    default: Date.now
  },

  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },

  notes: {
    type: String,
    maxlength: 500
  }
}, {
  timestamps: true
});

// Indexes for performance
giftCardPriceSchema.index({ cardType: 1, country: 1, isActive: 1 });
giftCardPriceSchema.index({ country: 1, isActive: 1 });
giftCardPriceSchema.index({ isActive: 1, lastUpdated: -1 });

// Compound unique index:
// - For non-VANILLA types uniqueness by (cardType, country)
// - For VANILLA we want uniqueness by (cardType, country, vanillaType)
// We accomplish this by creating a unique index including vanillaType and allowing null.
// Note: If your Mongo version and driver support partialFilterExpression you can refine this, but this index will work:
// ensure that (cardType + country + vanillaType) is unique — for non-VANILLA rows vanillaType will be null.
giftCardPriceSchema.index(
  { cardType: 1, country: 1, vanillaType: 1 },
  { unique: true, partialFilterExpression: { isActive: { $exists: true } } }
);

// Instance methods
giftCardPriceSchema.methods.calculateAmount = function(amount, cardFormat = null) {
  let applicableRate = this.rate;
  
  // Use format-specific rate if available
  if (cardFormat === 'PHYSICAL' && this.physicalRate) {
    applicableRate = this.physicalRate;
  } else if (cardFormat === 'E_CODE' && this.ecodeRate) {
    applicableRate = this.ecodeRate;
  }
  
  const amountToReceive = amount * applicableRate;
  
  return {
    amountToReceive: Math.round(amountToReceive * 100) / 100, // Round to 2 decimal places
    rate: applicableRate,
    rateDisplay: `${applicableRate}/${this.sourceCurrency}`,
    sourceCurrency: this.sourceCurrency,
    targetCurrency: this.targetCurrency
  };
};

giftCardPriceSchema.methods.isValidAmount = function(amount) {
  return amount >= this.minAmount && amount <= this.maxAmount;
};

// Static methods
giftCardPriceSchema.statics.getActiveRates = async function(country = null) {
  const query = { isActive: true };
  
  if (country) {
    query.country = country.toUpperCase();
  }
  
  return await this.find(query)
    .select('cardType country rate physicalRate ecodeRate sourceCurrency targetCurrency minAmount maxAmount vanillaType')
    .sort({ country: 1, cardType: 1 });
};

/**
 * Get single rate by cardType + country.
 * options = { vanillaType: '4097' } (optional)
 */
giftCardPriceSchema.statics.getRateByCardTypeAndCountry = async function(cardType, country, options = {}) {
  if (!cardType || !country) return null;
  const q = {
    cardType: cardType.toUpperCase(),
    country: country.toUpperCase(),
    isActive: true
  };

  // If cardType is VANILLA and vanillaType provided, use it.
  if (q.cardType === 'VANILLA' && options && options.vanillaType) {
    q.vanillaType = String(options.vanillaType);
  }

  return await this.findOne(q).select('cardType country rate sourceCurrency targetCurrency physicalRate ecodeRate minAmount maxAmount vanillaType');
};

/**
 * Get countries (rate rows) for a card type.
 * options = { vanillaType: '4097' } (optional)
 */
giftCardPriceSchema.statics.getCountriesForCard = async function(cardType, options = {}) {
  if (!cardType) return [];
  const q = {
    cardType: cardType.toUpperCase(),
    isActive: true
  };

  if (q.cardType === 'VANILLA' && options && options.vanillaType) {
    q.vanillaType = String(options.vanillaType);
  }

  return await this.find(q).select('country rate sourceCurrency vanillaType').sort({ country: 1 });
};

giftCardPriceSchema.statics.getAllCountries = async function() {
  return await this.distinct('country', { isActive: true });
};

giftCardPriceSchema.statics.getCardsByCountry = async function(country) {
  if (!country) return [];
  return await this.find({ 
    country: country.toUpperCase(), 
    isActive: true 
  }).select('cardType rate vanillaType').sort({ cardType: 1 });
};

// Update lastUpdated on save
giftCardPriceSchema.pre('save', function(next) {
  this.lastUpdated = new Date();
  next();
});

module.exports = mongoose.model('GiftCardPrice', giftCardPriceSchema);
