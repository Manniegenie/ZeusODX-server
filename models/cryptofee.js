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
  networkName: {
    type: String,
    required: false,
    trim: true,
  },
  networkFee: {
    type: Number,
    required: true,
    default: 0, // Fee amount in network's native currency (e.g., 0.50 BSC, 0.01 ETH)
  },
}, {
  timestamps: true,
});

// Compound unique index on currency + network combination
CryptoFeeMarkupSchema.index({ currency: 1, network: 1 }, { unique: true });

module.exports = mongoose.model('CryptoFeeMarkup', CryptoFeeMarkupSchema);