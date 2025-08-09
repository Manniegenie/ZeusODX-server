// models/CryptoPrice.js
const mongoose = require('mongoose');

const cryptoPriceSchema = new mongoose.Schema({
  symbol: {
    type: String,
    required: true,
    uppercase: true
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  hourly_change: {
    type: Number,
    default: 0  // Stored as percentage (e.g., 2.5 for 2.5%, -1.2 for -1.2%)
  },
  timestamp: {
    type: Date,
    default: Date.now,
    required: true
  }
}, {
  timestamps: false,
  collection: 'crypto_prices'
});

// Indexes for efficient queries
cryptoPriceSchema.index({ symbol: 1, timestamp: -1 });
cryptoPriceSchema.index({ timestamp: -1 });

// Get latest price for a symbol
cryptoPriceSchema.statics.getLatestPrice = async function(symbol) {
  return await this.findOne({
    symbol: symbol.toUpperCase()
  }).sort({ timestamp: -1 });
};

// Get latest prices for all symbols
cryptoPriceSchema.statics.getLatestPrices = async function() {
  const pipeline = [
    { $sort: { symbol: 1, timestamp: -1 } },
    { $group: {
        _id: '$symbol',
        symbol: { $first: '$symbol' },
        price: { $first: '$price' },
        hourly_change: { $first: '$hourly_change' },
        timestamp: { $first: '$timestamp' }
      }
    },
    { $sort: { symbol: 1 } }
  ];
  
  return await this.aggregate(pipeline);
};

module.exports = mongoose.model('CryptoPrice', cryptoPriceSchema);