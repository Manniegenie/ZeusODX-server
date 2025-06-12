const mongoose = require('mongoose');

const CryptoFeeMarkupSchema = new mongoose.Schema({
  currency: {
    type: String,
    required: true,
    uppercase: true,
    unique: true, // Unique per currency only
  },
  feeUsd: {
    type: Number,
    required: true,
    default: 0, // Fee amount in USD
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('CryptoFeeMarkup', CryptoFeeMarkupSchema);
