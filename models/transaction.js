const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['DEPOSIT', 'WITHDRAWAL'], required: true },
  currency: { type: String, required: true },
  address: { type: String },
  amount: { type: Number, required: true },
  fee: { type: Number, default: 0 },
  obiexFee: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'PROCESSING', 'SUCCESSFUL', 'FAILED', 'REJECTED', 'CONFIRMED'],
    required: true,
  },
  network: { type: String },
  narration: { type: String },
  source: { type: String, enum: ['CRYPTO_WALLET', 'BANK', 'INTERNAL'], default: 'CRYPTO_WALLET' },
  hash: { type: String },
  transactionId: { type: String }, // Generic transaction ID - no index here
  obiexTransactionId: { type: String }, // Specific Obiex transaction ID - no index here
  memo: { type: String }, // For crypto memos/tags
  metadata: { type: mongoose.Schema.Types.Mixed }, // For additional data
  reference: { type: String }, // Obiex reference - no index here
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Define indexes only once using schema.index() - this avoids duplicates
transactionSchema.index({ transactionId: 1 }, { sparse: true }); // Sparse index ignores null/undefined values
transactionSchema.index({ obiexTransactionId: 1 }, { unique: true, sparse: true }); // Unique but allows nulls
transactionSchema.index({ reference: 1 }, { sparse: true }); // Sparse index for reference
transactionSchema.index({ userId: 1, type: 1, status: 1 }); // Compound index for queries
transactionSchema.index({ userId: 1, createdAt: -1 }); // For user transaction history
transactionSchema.index({ currency: 1, status: 1 }); // For currency-based queries

// Update the updatedAt field on save
transactionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Transaction', transactionSchema);