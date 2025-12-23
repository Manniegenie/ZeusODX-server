const mongoose = require('mongoose');

const CryptoFeeMarkupSchema = new mongoose.Schema({
  currency: {
    type: String,
    required: true,
    uppercase: true,
    trim: true,
  },
  /**
   * The Network Code (Obiex Format)
   * Must be: TRX, BSC, ETH, MATIC, SOL, BTC, ARBITRUM, AVAXC, BASE
   */
  network: {
    type: String,
    required: true,
    uppercase: true,
    trim: true,
  },
  networkName: {
    type: String, // e.g. "Tron (TRC20)" - for your UI only
    required: false,
    trim: true,
  },
  networkFee: {
    type: Number,
    required: true,
    default: 0, // Your markup in native token
  },
}, {
  timestamps: true,
});

CryptoFeeMarkupSchema.index({ currency: 1, network: 1 }, { unique: true });

module.exports = mongoose.model('CryptoFeeMarkup', CryptoFeeMarkupSchema);