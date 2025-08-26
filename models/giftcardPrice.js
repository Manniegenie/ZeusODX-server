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
    'VISA',               // Visa + Vanilla (4097|4118)
    'RAZOR_GOLD',         // Razor gold gift card
    'AMERICAN_EXPRESS',   // American Express (3779/3751)
    'SEPHORA',            // Sephora
    'FOOTLOCKER',         // Footlocker
    'XBOX',               // Xbox card
    'EBAY'                // eBay
  ],
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
    default: 5,
    min: 0
  },

  maxAmount: {
    type: Number,
    default: 2000,
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

// Compound unique index to ensure one rate per card type per country
giftCardPriceSchema.index({ cardType: 1, country: 1 }, { unique: true });

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
    .select('cardType country rate physicalRate ecodeRate sourceCurrency targetCurrency minAmount maxAmount')
    .sort({ country: 1, cardType: 1 });
};

giftCardPriceSchema.statics.getRateByCardTypeAndCountry = async function(cardType, country) {
  return await this.findOne({ 
    cardType: cardType.toUpperCase(), 
    country: country.toUpperCase(),
    isActive: true 
  });
};

giftCardPriceSchema.statics.getCountriesForCard = async function(cardType) {
  return await this.find({ 
    cardType: cardType.toUpperCase(), 
    isActive: true 
  }).select('country rate sourceCurrency').sort({ country: 1 });
};

giftCardPriceSchema.statics.getAllCountries = async function() {
  return await this.distinct('country', { isActive: true });
};

giftCardPriceSchema.statics.getCardsByCountry = async function(country) {
  return await this.find({ 
    country: country.toUpperCase(), 
    isActive: true 
  }).select('cardType rate').sort({ cardType: 1 });
};

// Update lastUpdated on save
giftCardPriceSchema.pre('save', function(next) {
  this.lastUpdated = new Date();
  next();
});

module.exports = mongoose.model('GiftCardPrice', giftCardPriceSchema);