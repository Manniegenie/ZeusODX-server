const mongoose = require('mongoose');

const nairaMarkupSchema = new mongoose.Schema({
  markup: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  onrampRate: {
    type: Number,
    required: false,
    min: 0,
    default: null
  },
  lastCurrencyAPIRate: {
    type: Number,
    required: false,
    min: 0,
    default: null
  },
  rateSource: {
    type: String,
    enum: ['manual', 'currencyapi'],
    default: 'manual'
  }
}, {
  timestamps: true,
  collection: 'nairamarkups'
});

module.exports = mongoose.model('NairaMarkup', nairaMarkupSchema);