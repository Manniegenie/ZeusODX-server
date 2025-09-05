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
      'SWAP', // Added SWAP type for swap transactions
      'OBIEX_SWAP', // Added for Obiex swap transactions
      'GIFTCARD' // Added GIFTCARD type for gift card transactions
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
  source: { 
    type: String, 
    enum: [
      'CRYPTO_WALLET', 
      'BANK', 
      'INTERNAL', 
      'GIFTCARD', 
      'NGNZ_WITHDRAWAL', 
      'OBIEX' // Added for Obiex transactions
    ], 
    default: 'CRYPTO_WALLET' 
  },
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
  swapType: { type: String, enum: ['onramp', 'offramp', 'crypto_to_crypto'] }, // Type of swap
  
  // Gift card specific fields
  giftCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'GiftCard' },
  cardType: { type: String }, // AMAZON, APPLE, etc.
  cardFormat: { type: String }, // PHYSICAL, E_CODE
  cardRange: { type: String }, // 25-100, 100-200, etc.
  country: { type: String }, // US, CANADA, etc.
  imageUrls: [{ type: String }],
  imagePublicIds: [{ type: String }],
  totalImages: { type: Number, default: 0 },
  eCode: { type: String },
  description: { type: String },
  expectedRate: { type: Number },
  expectedRateDisplay: { type: String },
  expectedAmountToReceive: { type: Number },
  expectedSourceCurrency: { type: String },
  expectedTargetCurrency: { type: String },
  
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

// Additional indexes for swap transactions
transactionSchema.index({ userId: 1, type: 1, swapType: 1, status: 1 }); // For swap queries
transactionSchema.index({ fromCurrency: 1, toCurrency: 1, status: 1 }); // For swap pair queries
transactionSchema.index({ userId: 1, type: 1, fromCurrency: 1, toCurrency: 1 }); // For user swap history
transactionSchema.index({ reference: 1, type: 1 }); // For finding related transactions by reference and type

// Additional indexes for gift card transactions
transactionSchema.index({ giftCardId: 1 }); // For finding transaction by gift card
transactionSchema.index({ userId: 1, type: 1, cardType: 1, status: 1 }); // For gift card queries
transactionSchema.index({ cardType: 1, country: 1, status: 1 }); // For gift card analytics

// Update the updatedAt field on save
transactionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

/**
 * Static method to create swap transaction pairs
 * This method creates two transactions: one debit (outgoing) and one credit (incoming)
 */
transactionSchema.statics.createSwapTransactions = async function({
  userId,
  quoteId = null,
  sourceCurrency,
  targetCurrency,
  sourceAmount,
  targetAmount,
  exchangeRate,
  swapType,
  provider = 'INTERNAL_EXCHANGE',
  markdownApplied = 0,
  swapFee = 0,
  quoteExpiresAt = null,
  status = 'SUCCESSFUL',
  session = null
}) {
  // Generate a unique reference for this swap pair
  const swapReference = `SWAP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Normalize swapType to lowercase for consistent database storage
  const normalizedSwapType = swapType?.toLowerCase() || 'crypto_to_crypto';
  
  // Create the outgoing transaction (debit)
  const swapOutTransaction = new this({
    userId,
    type: 'SWAP',
    currency: sourceCurrency,
    amount: -sourceAmount, // Negative for outgoing
    status,
    source: 'INTERNAL',
    fromCurrency: sourceCurrency,
    toCurrency: targetCurrency,
    fromAmount: sourceAmount,
    toAmount: targetAmount,
    swapType: normalizedSwapType,
    reference: swapReference,
    narration: `Swap ${sourceAmount} ${sourceCurrency} to ${targetAmount} ${targetCurrency}`,
    completedAt: status === 'SUCCESSFUL' ? new Date() : null,
    fee: swapFee,
    metadata: {
      swapDirection: 'OUT',
      exchangeRate,
      relatedTransactionRef: swapReference,
      quoteId,
      provider,
      markdownApplied,
      quoteExpiresAt
    }
  });

  // Create the incoming transaction (credit)
  const swapInTransaction = new this({
    userId,
    type: 'SWAP',
    currency: targetCurrency,
    amount: targetAmount, // Positive for incoming
    status,
    source: 'INTERNAL',
    fromCurrency: sourceCurrency,
    toCurrency: targetCurrency,
    fromAmount: sourceAmount,
    toAmount: targetAmount,
    swapType: normalizedSwapType,
    reference: swapReference,
    narration: `Swap ${sourceAmount} ${sourceCurrency} to ${targetAmount} ${targetCurrency}`,
    completedAt: status === 'SUCCESSFUL' ? new Date() : null,
    fee: 0, // Fee is only applied to the outgoing transaction
    metadata: {
      swapDirection: 'IN',
      exchangeRate,
      relatedTransactionRef: swapReference,
      quoteId,
      provider,
      markdownApplied,
      quoteExpiresAt
    }
  });

  // Save both transactions
  const saveOptions = session ? { session } : {};
  await swapOutTransaction.save(saveOptions);
  await swapInTransaction.save(saveOptions);

  return {
    swapOutTransaction,
    swapInTransaction,
    swapId: swapReference
  };
};

module.exports = mongoose.model('Transaction', transactionSchema);