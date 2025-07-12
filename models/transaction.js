const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  
  // UPDATED: Extended type to include swap operations
  type: { 
    type: String, 
    enum: [
      'DEPOSIT', 
      'WITHDRAWAL', 
      'SWAP_IN',     // Receiving currency in a swap
      'SWAP_OUT',    // Sending currency in a swap
      'ONRAMP',      // NGNZ to crypto conversion
      'OFFRAMP'      // Crypto to NGNZ conversion
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
    enum: ['PENDING', 'APPROVED', 'PROCESSING', 'SUCCESSFUL', 'FAILED', 'REJECTED', 'CONFIRMED'],
    required: true,
  },
  
  network: { type: String },
  narration: { type: String },
  source: { type: String, enum: ['CRYPTO_WALLET', 'BANK', 'INTERNAL'], default: 'CRYPTO_WALLET' },
  hash: { type: String },
  transactionId: { type: String },
  obiexTransactionId: { type: String },
  memo: { type: String },
  reference: { type: String },
  
  // NEW: Swap-specific fields
  swapDetails: {
    quoteId: { type: String }, // Quote ID from swap service
    swapId: { type: String },  // Unique swap ID linking SWAP_IN and SWAP_OUT transactions
    sourceCurrency: { type: String }, // Currency being swapped from
    targetCurrency: { type: String }, // Currency being swapped to
    sourceAmount: { type: Number },   // Amount of source currency
    targetAmount: { type: Number },   // Amount of target currency received
    exchangeRate: { type: Number },   // Exchange rate used
    swapType: { 
      type: String, 
      enum: ['CRYPTO_TO_CRYPTO', 'ONRAMP', 'OFFRAMP'] 
    },
    
    // Quote expiration and timing
    quoteExpiresAt: { type: Date },
    quoteAcceptedAt: { type: Date },
    
    // Fee breakdown for swaps
    swapFee: { type: Number, default: 0 },
    markdownApplied: { type: Number, default: 0 }, // Global markdown percentage applied
    
    // Provider information
    provider: { 
      type: String, 
      enum: ['OBIEX', 'ONRAMP_SERVICE', 'OFFRAMP_SERVICE'],
      default: 'OBIEX'
    }
  },
  
  // NEW: Related transaction for swaps (links SWAP_IN and SWAP_OUT)
  relatedTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
  
  metadata: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// UPDATED: Additional indexes for swap queries
transactionSchema.index({ transactionId: 1 }, { sparse: true });
transactionSchema.index({ obiexTransactionId: 1 }, { unique: true, sparse: true });
transactionSchema.index({ reference: 1 }, { sparse: true });
transactionSchema.index({ userId: 1, type: 1, status: 1 });
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ currency: 1, status: 1 });

// NEW: Indexes for swap operations
transactionSchema.index({ 'swapDetails.swapId': 1 }, { sparse: true });
transactionSchema.index({ 'swapDetails.quoteId': 1 }, { sparse: true });
transactionSchema.index({ userId: 1, type: 1, 'swapDetails.swapType': 1 });
transactionSchema.index({ relatedTransactionId: 1 }, { sparse: true });

// Update the updatedAt field on save
transactionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// NEW: Static method to create swap transaction pair
transactionSchema.statics.createSwapTransactions = async function(swapData) {
  const {
    userId,
    quoteId,
    sourceCurrency,
    targetCurrency,
    sourceAmount,
    targetAmount,
    exchangeRate,
    swapType = 'CRYPTO_TO_CRYPTO',
    provider = 'OBIEX',
    markdownApplied = 0,
    swapFee = 0,
    quoteExpiresAt,
    status = 'PENDING'
  } = swapData;
  
  const swapId = `swap_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const baseSwapDetails = {
    quoteId,
    swapId,
    sourceCurrency,
    targetCurrency,
    sourceAmount,
    targetAmount,
    exchangeRate,
    swapType,
    provider,
    markdownApplied,
    swapFee,
    quoteExpiresAt,
    quoteAcceptedAt: new Date()
  };
  
  // Create SWAP_OUT transaction (debit)
  const swapOutTransaction = new this({
    userId,
    type: swapType === 'ONRAMP' ? 'ONRAMP' : 'SWAP_OUT',
    currency: sourceCurrency,
    amount: -Math.abs(sourceAmount), // Negative for outgoing
    status,
    source: 'INTERNAL',
    narration: `Swap ${sourceCurrency} to ${targetCurrency}`,
    swapDetails: {
      ...baseSwapDetails,
    }
  });
  
  // Create SWAP_IN transaction (credit)
  const swapInTransaction = new this({
    userId,
    type: swapType === 'OFFRAMP' ? 'OFFRAMP' : 'SWAP_IN',
    currency: targetCurrency,
    amount: Math.abs(targetAmount), // Positive for incoming
    status,
    source: 'INTERNAL',
    narration: `Swap ${sourceCurrency} to ${targetCurrency}`,
    swapDetails: {
      ...baseSwapDetails,
    }
  });
  
  // Save both transactions
  const savedSwapOut = await swapOutTransaction.save();
  const savedSwapIn = await swapInTransaction.save();
  
  // Link transactions to each other
  savedSwapOut.relatedTransactionId = savedSwapIn._id;
  savedSwapIn.relatedTransactionId = savedSwapOut._id;
  
  await savedSwapOut.save();
  await savedSwapIn.save();
  
  return {
    swapOutTransaction: savedSwapOut,
    swapInTransaction: savedSwapIn,
    swapId
  };
};

// NEW: Static method to update swap transaction status
transactionSchema.statics.updateSwapStatus = async function(swapId, newStatus) {
  const result = await this.updateMany(
    { 'swapDetails.swapId': swapId },
    { 
      $set: { 
        status: newStatus,
        updatedAt: new Date()
      }
    }
  );
  
  return result;
};

// NEW: Static method to get swap transaction pair
transactionSchema.statics.getSwapTransactions = async function(swapId) {
  const transactions = await this.find({ 'swapDetails.swapId': swapId });
  
  const swapOut = transactions.find(tx => tx.type === 'SWAP_OUT' || tx.type === 'ONRAMP');
  const swapIn = transactions.find(tx => tx.type === 'SWAP_IN' || tx.type === 'OFFRAMP');
  
  return {
    swapOutTransaction: swapOut,
    swapInTransaction: swapIn,
    transactions
  };
};

module.exports = mongoose.model('Transaction', transactionSchema);