const mongoose = require('mongoose');

const nairaMarkdownSchema = new mongoose.Schema({
  markup: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  offrampRate: {
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
  collection: 'nairamarkdowns'
});

module.exports = mongoose.model('NairaMarkdown', nairaMarkdownSchema);