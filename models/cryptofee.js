const mongoose = require('mongoose');

const CryptoFeeMarkupSchema = new mongoose.Schema({
  currency: {
    type: String,
    required: true,
    uppercase: true,
  },
  network: {
    type: String,
    required: true,
    uppercase: true,
  },
  feeUsd: {
    type: Number,
    required: true,
    default: 0, // Fee amount in USD
  },
}, {
  timestamps: true,
});

// Compound unique index on currency + network combination
CryptoFeeMarkupSchema.index({ currency: 1, network: 1 }, { unique: true });

module.exports = mongoose.model('CryptoFeeMarkup', CryptoFeeMarkupSchema);