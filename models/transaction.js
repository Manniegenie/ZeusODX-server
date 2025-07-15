const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { 
    type: String, 
    enum: [
      'DEPOSIT', 
      'WITHDRAWAL', 
      'INTERNAL_TRANSFER_SENT', 
      'INTERNAL_TRANSFER_RECEIVED',
      'SWAP' // Added SWAP type for swap transactions
    ], 
    required: true 
  },
  currency: { type: String, required: true },
  address: { type: String },
  amount: { type: Number, required: true },
  fee: { type: Number, default: 0 },
  obiexFee: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'PROCESSING', 'SUCCESSFUL', 'COMPLETED', 'FAILED', 'REJECTED', 'CONFIRMED'],
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
  
  // Internal transfer specific fields
  recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  recipientUsername: { type: String },
  senderUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  senderUsername: { type: String },
  
  // Swap specific fields
  fromCurrency: { type: String }, // Source currency for swaps
  toCurrency: { type: String }, // Target currency for swaps
  fromAmount: { type: Number }, // Amount being swapped from
  toAmount: { type: Number }, // Amount being swapped to
  swapType: { type: String, enum: ['onramp', 'offramp'] }, // Type of swap
  
  // Additional timestamp fields
  completedAt: { type: Date },
  failedAt: { type: Date },
  failureReason: { type: String },
  
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

// Additional indexes for internal transfers
transactionSchema.index({ recipientUserId: 1, type: 1, status: 1 }); // For recipient queries
transactionSchema.index({ senderUserId: 1, type: 1, status: 1 }); // For sender queries
transactionSchema.index({ reference: 1, type: 1 }); // For finding related internal transfer transactions

// Additional indexes for swap transactions
transactionSchema.index({ userId: 1, type: 1, swapType: 1, status: 1 }); // For swap queries
transactionSchema.index({ fromCurrency: 1, toCurrency: 1, status: 1 }); // For swap pair queries
transactionSchema.index({ userId: 1, type: 1, fromCurrency: 1, toCurrency: 1 }); // For user swap history

// Update the updatedAt field on save
transactionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Transaction', transactionSchema);