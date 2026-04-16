const mongoose = require('mongoose');

const TokenBalanceSchema = new mongoose.Schema({
  amount:          { type: Number, default: 0 },
  pendingAmount:   { type: Number, default: 0 },
  priceUsd:        { type: Number, default: 0 },
  usdValue:        { type: Number, default: 0 },
  pendingUsdValue: { type: Number, default: 0 },
}, { _id: false });

const platformSnapshotSchema = new mongoose.Schema({
  snapshotType: { type: String, enum: ['auto', 'manual'], default: 'auto' },
  takenBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },

  usdToNairaRate:     { type: Number, required: true },
  totalUsd:           { type: Number, default: 0 },
  totalNaira:         { type: Number, default: 0 },
  totalPendingUsd:    { type: Number, default: 0 },
  totalPendingNaira:  { type: Number, default: 0 },
  userCount:          { type: Number, default: 0 },

  breakdown: {
    BTC:  { type: TokenBalanceSchema },
    ETH:  { type: TokenBalanceSchema },
    SOL:  { type: TokenBalanceSchema },
    USDT: { type: TokenBalanceSchema },
    USDC: { type: TokenBalanceSchema },
    BNB:  { type: TokenBalanceSchema },
    MATIC:{ type: TokenBalanceSchema },
    TRX:  { type: TokenBalanceSchema },
    NGNZ: { type: TokenBalanceSchema },
  },

  notes: { type: String, trim: true, default: '' },
}, { timestamps: true });

platformSnapshotSchema.index({ createdAt: -1 });
platformSnapshotSchema.index({ snapshotType: 1, createdAt: -1 });

module.exports = mongoose.model('PlatformSnapshot', platformSnapshotSchema);
