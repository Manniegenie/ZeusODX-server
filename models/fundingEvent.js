const mongoose = require('mongoose');

const fundingEventSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['obiex_topup', 'bank_deposit', 'manual_funding', 'platform_withdrawal', 'other'],
    required: true,
  },
  amountNaira:  { type: Number, default: 0 },
  amountUsd:    { type: Number, default: 0 },
  description:  { type: String, trim: true, default: '' },
  reference:    { type: String, trim: true, default: '' },
  recordedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', required: true },
}, { timestamps: true });

fundingEventSchema.index({ createdAt: -1 });
fundingEventSchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model('FundingEvent', fundingEventSchema);
