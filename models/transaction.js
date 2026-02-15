// models/Transaction.js
const mongoose = require('mongoose');

/** ========= Subdocs for NGNZ bank withdrawals ========= **/

// Bank destination info (mask/hash the account number in your route before saving)
const BankDestinationSchema = new mongoose.Schema({
  bankName: { type: String, trim: true },
  bankCode: { type: String, trim: true },
  pagaBankCode: { type: String, trim: true },
  merchantCode: { type: String, trim: true },
  accountName: { type: String, trim: true },

  // Store only safe variants here; use a vault if you need the raw value elsewhere
  accountNumberMasked: { type: String, trim: true },   // e.g. "12****34"
  accountNumberLast4:  { type: String, trim: true },   // e.g. "1234"
  accountNumberHash:   { type: String },               // index moved below
}, { _id: false });

// NGNZ withdrawal details
const NGNZWithdrawalSchema = new mongoose.Schema({
  // usually identical to top-level `reference`, kept for clarity
  withdrawalReference: { type: String }, // index moved below

  // financials (all POSITIVE numbers here for clarity)
  requestedAmount:   { type: Number }, // full NGNZ amount deducted from user
  withdrawalFee:     { type: Number, default: 0 }, // NGN fee you retain
  amountSentToBank:  { type: Number }, // requestedAmount - withdrawalFee
  payoutCurrency:    { type: String, default: 'NGN' },

  // destination bank
  destination: { type: BankDestinationSchema },

  // provider details (Obiex)
  provider: { type: String, default: 'OBIEX' },
  idempotencyKey: { type: String },
  obiex: {
    id:        { type: String }, // index moved below
    reference: { type: String }, // index moved below
    status:    { type: String }, // e.g. PENDING | SUCCESS | FAILED
  },

  // bookkeeping
  preparedAt:  { type: Date },
  sentAt:      { type: Date },
  completedAt: { type: Date },
  failedAt:    { type: Date },
  failureReason: { type: String },
}, { _id: false });

/** ========= Frontend Receipt Details Schema ========= **/
// This schema ensures all fields needed by FiatWithdrawalReceiptModal are easily accessible
const ReceiptDetailsSchema = new mongoose.Schema({
  // Core transaction identifiers
  transactionId: { type: String }, // Maps to _id or obiexTransactionId
  reference: { type: String }, // Primary reference number
  
  // Provider information
  provider: { type: String }, // e.g., 'OBIEX', 'PAYSTACK'
  providerStatus: { type: String }, // Provider's status (e.g., obiexStatus)
  
  // Bank details (for withdrawals)
  bankName: { type: String },
  accountName: { type: String },
  accountNumber: { type: String }, // Masked version for display
  
  // Financial details
  currency: { type: String }, // e.g., 'NGN', 'NGNZ'
  amount: { type: String }, // Formatted amount with currency symbol (e.g., "₦120,000")
  fee: { type: String }, // Formatted fee (e.g., "₦30")
  
  // Additional details
  narration: { type: String }, // Transaction description/note
  date: { type: String }, // Human-readable date
  
  // Category for frontend filtering/display
  category: { type: String, enum: ['token', 'utility', 'withdrawal', 'deposit', 'swap'], default: 'utility' },
  
  // Any additional provider-specific fields
  additionalFields: { type: mongoose.Schema.Types.Mixed }
}, { _id: false });

/** ========= Main Transaction schema ========= **/

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  type: {
    type: String,
    enum: [
      'DEPOSIT',
      'WITHDRAWAL',
      'INTERNAL_TRANSFER_SENT',
      'INTERNAL_TRANSFER_RECEIVED',
      'SWAP',
      'OBIEX_SWAP',
      'GIFTCARD',
      'GIFTCARD_PAYOUT'
    ],
    required: true
  },

  currency: { type: String, required: true },
  address: { type: String },

  // Core amounts: outflows are NEGATIVE (WITHDRAWAL, INTERNAL_TRANSFER_SENT); inflows positive (DEPOSIT, INTERNAL_TRANSFER_RECEIVED)
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
      'OBIEX'
    ],
    default: 'CRYPTO_WALLET'
  },

  hash: { type: String },
  transactionId: { type: String },
  obiexTransactionId: { type: String },
  memo: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed },
  reference: { type: String },

  /** ========= Frontend Receipt Details ========= **/
  // This field ensures all data needed by the receipt modal is easily accessible
  receiptDetails: { type: ReceiptDetailsSchema },

  /** ========= Internal transfer ========= **/
  recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  recipientUsername: { type: String },
  recipientFullName: { type: String },
  senderUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  senderUsername: { type: String },
  senderFullName: { type: String },

  /** ========= Swap - UPDATED FOR ENHANCED COMPATIBILITY ========= **/
  fromCurrency: { type: String },
  toCurrency: { type: String },
  fromAmount: { type: Number },
  toAmount: { type: Number },
  // UPDATED: More flexible swapType enum to handle both old and new values
  swapType: { 
    type: String, 
    enum: [
      // Old values (maintain backward compatibility)
      'onramp', 
      'offramp', 
      'crypto_to_crypto',
      // New values from enhanced swap.js
      'ONRAMP',
      'OFFRAMP', 
      'CRYPTO_TO_CRYPTO',
      'CRYPTO_TO_STABLECOIN',
      'STABLECOIN_TO_CRYPTO',
      'DIRECT',
      'NGNX_TO_CRYPTO',
      'CRYPTO_TO_NGNX'
    ]
  },

  // NEW: Enhanced swap tracking fields
  swapCategory: { 
    type: String,
    enum: [
      'CRYPTO_EXCHANGE',
      'CRYPTO_TO_CRYPTO_EXCHANGE', 
      'NGNZ_EXCHANGE',
      'FIAT_EXCHANGE'
    ]
  },
  swapPair: { type: String }, // e.g., "BTC-ETH", "NGNZ-BTC"
  intermediateToken: { type: String }, // For crypto-to-crypto routing
  routingPath: { type: String }, // e.g., "BTC → USDT → ETH"
  exchangeRate: { type: Number }, // Overall exchange rate
  
  // NEW: Enhanced price tracking
  fromPrice: { type: Number }, // USD price of source currency
  toPrice: { type: Number },   // USD price of target currency
  
  // NEW: Enhanced correlation tracking
  correlationId: { type: String }, // Links related operations
  originalQuoteId: { type: String }, // Links back to original quote
  
  // NEW: Enhanced execution tracking
  executionTimestamp: { type: Date },
  swapDirection: { type: String, enum: ['IN', 'OUT', 'INTERNAL'] },

  /** ========= Gift card ========= **/
  giftCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'GiftCard' },
  cardType: { type: String },
  cardFormat: { type: String },
  cardRange: { type: String },
  country: { type: String },
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

  /** ========= NGNZ Withdrawal ========= **/
  isNGNZWithdrawal: { type: Boolean, default: false, index: true },

  // Convenience top-level fields for quick filters/analytics (duplicates NGNZ subdoc values)
  bankAmount: { type: Number },     // == ngnzWithdrawal.amountSentToBank (POSITIVE)
  withdrawalFee: { type: Number },  // == ngnzWithdrawal.withdrawalFee (POSITIVE)
  payoutCurrency: { type: String, default: 'NGN' },

  ngnzWithdrawal: { type: NGNZWithdrawalSchema },

  /** ========= Timestamps ========= **/
  completedAt: { type: Date },
  failedAt: { type: Date },
  failureReason: { type: String },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

/** ========= Indexes - ENHANCED FOR BETTER SWAP TRACKING ========= **/

// Existing / common indexes
transactionSchema.index({ transactionId: 1 }, { sparse: true });
transactionSchema.index(
  { obiexTransactionId: 1 },
  { unique: true, partialFilterExpression: { obiexTransactionId: { $exists: true, $type: 'string' } } }
);
transactionSchema.index({ reference: 1 }, { sparse: true });
transactionSchema.index({ userId: 1, type: 1, status: 1 });
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ currency: 1, status: 1 });
transactionSchema.index({ recipientUserId: 1, type: 1, status: 1 });
transactionSchema.index({ senderUserId: 1, type: 1, status: 1 });
transactionSchema.index({ userId: 1, type: 1, swapType: 1, status: 1 });
transactionSchema.index({ fromCurrency: 1, toCurrency: 1, status: 1 });
transactionSchema.index({ userId: 1, type: 1, fromCurrency: 1, toCurrency: 1 });
transactionSchema.index({ reference: 1, type: 1 });
transactionSchema.index({ giftCardId: 1 });
transactionSchema.index({ userId: 1, type: 1, cardType: 1, status: 1 });
transactionSchema.index({ cardType: 1, country: 1, status: 1 });

// NGNZ withdrawal–focused
transactionSchema.index({ isNGNZWithdrawal: 1, status: 1, createdAt: -1 });
transactionSchema.index({ bankAmount: 1, status: 1 });

// Receipt details indexes for faster frontend queries
transactionSchema.index({ 'receiptDetails.transactionId': 1 }, { sparse: true });
transactionSchema.index({ 'receiptDetails.reference': 1 }, { sparse: true });
transactionSchema.index({ 'receiptDetails.provider': 1 }, { sparse: true });

// Subdoc indexes moved here to avoid duplicates
transactionSchema.index({ 'ngnzWithdrawal.withdrawalReference': 1 }, { sparse: true });
transactionSchema.index({ 'ngnzWithdrawal.obiex.reference': 1 }, { sparse: true });
transactionSchema.index({ 'ngnzWithdrawal.obiex.id': 1 }, { sparse: true });
transactionSchema.index({ 'ngnzWithdrawal.destination.accountNumberHash': 1 }, { sparse: true });

// NEW: Enhanced swap tracking indexes
transactionSchema.index({ correlationId: 1 }, { sparse: true });
transactionSchema.index({ originalQuoteId: 1 }, { sparse: true });
transactionSchema.index({ swapPair: 1, status: 1 });
transactionSchema.index({ swapCategory: 1, status: 1 });
transactionSchema.index({ userId: 1, swapCategory: 1, createdAt: -1 });
transactionSchema.index({ userId: 1, correlationId: 1 });
transactionSchema.index({ intermediateToken: 1, status: 1 });
transactionSchema.index({ executionTimestamp: -1 }, { sparse: true });

/** ========= Hooks & Methods ========= **/

transactionSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  
  // Auto-populate receiptDetails for withdrawals if not already set
  if (this.isNGNZWithdrawal && !this.receiptDetails && this.ngnzWithdrawal) {
    this.populateReceiptDetails();
  }
  
  // NEW: Auto-populate enhanced swap fields from metadata if not set
  if (this.type === 'SWAP' && this.metadata) {
    this.syncSwapFieldsFromMetadata();
  }
  
  next();
});

/**
 * NEW: Method to sync enhanced swap fields from metadata
 * This ensures consistency between metadata and top-level fields
 */
transactionSchema.methods.syncSwapFieldsFromMetadata = function() {
  if (!this.metadata) return;
  
  // Sync top-level fields from metadata if not already set
  if (this.metadata.correlationId && !this.correlationId) {
    this.correlationId = this.metadata.correlationId;
  }
  
  if (this.metadata.originalQuoteId && !this.originalQuoteId) {
    this.originalQuoteId = this.metadata.originalQuoteId;
  }
  
  if (this.metadata.swapCategory && !this.swapCategory) {
    this.swapCategory = this.metadata.swapCategory;
  }
  
  if (this.metadata.swapPair && !this.swapPair) {
    this.swapPair = this.metadata.swapPair;
  }
  
  if (this.metadata.intermediateToken && !this.intermediateToken) {
    this.intermediateToken = this.metadata.intermediateToken;
  }
  
  if (this.metadata.routingPath && !this.routingPath) {
    this.routingPath = this.metadata.routingPath;
  }
  
  if (this.metadata.exchangeRate && !this.exchangeRate) {
    this.exchangeRate = this.metadata.exchangeRate;
  }
  
  if (this.metadata.fromPrice && !this.fromPrice) {
    this.fromPrice = this.metadata.fromPrice;
  }
  
  if (this.metadata.toPrice && !this.toPrice) {
    this.toPrice = this.metadata.toPrice;
  }
  
  if (this.metadata.executionTimestamp && !this.executionTimestamp) {
    this.executionTimestamp = this.metadata.executionTimestamp;
  }
  
  if (this.metadata.swapDirection && !this.swapDirection) {
    this.swapDirection = this.metadata.swapDirection;
  }
};

/**
 * Method to populate receiptDetails from transaction data
 * This ensures the frontend modal has all the data it needs
 */
transactionSchema.methods.populateReceiptDetails = function() {
  const formatCurrency = (amount, currency = 'NGN') => {
    if (!amount) return '—';
    const symbol = currency === 'NGN' ? '₦' : currency === 'NGNZ' ? '₦' : '';
    return `${symbol}${Math.abs(amount).toLocaleString()}`;
  };

  const formatDate = (date) => {
    if (!date) return '—';
    return new Date(date).toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  this.receiptDetails = {
    // Core identifiers
    transactionId: this.obiexTransactionId || this._id.toString(),
    reference: this.reference,
    
    // Provider info
    provider: this.ngnzWithdrawal?.provider || this.source || '—',
    providerStatus: this.ngnzWithdrawal?.obiex?.status,
    
    // Bank details (for NGNZ withdrawals)
    bankName: this.ngnzWithdrawal?.destination?.bankName,
    accountName: this.ngnzWithdrawal?.destination?.accountName,
    accountNumber: this.ngnzWithdrawal?.destination?.accountNumberMasked,
    
    // Financial details
    currency: this.currency,
    amount: formatCurrency(Math.abs(this.amount), this.currency),
    fee: this.withdrawalFee ? formatCurrency(this.withdrawalFee) : undefined,
    
    // Additional details
    narration: this.narration,
    date: formatDate(this.createdAt),
    
    // Category
    category: this.isNGNZWithdrawal ? 'withdrawal' : (this.type === 'SWAP' ? 'swap' : 'utility'),
    
    // Additional provider-specific fields
    additionalFields: {
      obiexId: this.ngnzWithdrawal?.obiex?.id,
      obiexReference: this.ngnzWithdrawal?.obiex?.reference,
      amountSentToBank: this.bankAmount ? formatCurrency(this.bankAmount) : undefined,
      totalAmountDeducted: formatCurrency(Math.abs(this.amount), this.currency),
      // NEW: Enhanced swap details for receipts
      swapPair: this.swapPair,
      routingPath: this.routingPath,
      exchangeRate: this.exchangeRate,
      correlationId: this.correlationId
    }
  };
};

/**
 * Method to get formatted data for frontend receipt modal
 * ENHANCED: Better support for swap transactions
 */
transactionSchema.methods.getReceiptData = function() {
  // Ensure receiptDetails is populated
  if (!this.receiptDetails) {
    this.populateReceiptDetails();
  }

  return {
    id: this._id.toString(),
    type: this.type === 'WITHDRAWAL' ? 'Withdrawal' :
          this.type === 'SWAP' ? 'Swap' : this.type,
    status: this.status === 'SUCCESSFUL' ? 'Successful' : this.status,
    amount: this.receiptDetails.amount,
    date: this.receiptDetails.date,
    createdAt: this.createdAt.toISOString(),
    details: {
      // All the fields your frontend modal expects
      transactionId: this.receiptDetails.transactionId,
      reference: this.receiptDetails.reference,
      provider: this.receiptDetails.provider,
      providerStatus: this.receiptDetails.providerStatus,
      bankName: this.receiptDetails.bankName,
      accountName: this.receiptDetails.accountName,
      accountNumber: this.receiptDetails.accountNumber,
      currency: this.receiptDetails.currency,
      fee: this.receiptDetails.fee,
      amount: this.receiptDetails.amount,
      narration: this.receiptDetails.narration,
      category: this.receiptDetails.category,

      // NEW: Enhanced swap details (top-level for backward compatibility)
      fromCurrency: this.fromCurrency,
      toCurrency: this.toCurrency,
      fromAmount: this.fromAmount,
      toAmount: this.toAmount,
      swapType: this.swapType,
      swapCategory: this.swapCategory,

      // 🔧 FIX: Add swapDetails nested object for frontend compatibility
      swapDetails: this.type === 'SWAP' && this.fromCurrency && this.toCurrency ? {
        fromAmount: this.fromAmount?.toString() || '',
        fromCurrency: this.fromCurrency || '',
        toAmount: this.toAmount?.toString() || '',
        toCurrency: this.toCurrency || '',
        rate: this.exchangeRate?.toString() || '',
        exchangeRate: this.exchangeRate?.toString() || ''
      } : undefined,

      // Additional fields that might be useful
      ...this.receiptDetails.additionalFields
    }
  };
};

/**
 * Static method to create swap transaction pairs
 * ENHANCED: Updated to work with new enhanced swap system
 */
transactionSchema.statics.createSwapTransactions = async function ({
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
  session = null,
  // NEW: Enhanced parameters
  swapCategory = 'CRYPTO_EXCHANGE',
  correlationId = null,
  fromPrice = null,
  toPrice = null,
  intermediateToken = null,
  routingPath = null,
  metadata = {}
}) {
  const swapReference = `SWAP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const normalizedSwapType = swapType?.toLowerCase() || 'crypto_to_crypto';
  
  // Enhanced metadata combining old and new fields
  const enhancedMetadata = {
    swapDirection: 'OUT',
    exchangeRate,
    relatedTransactionRef: swapReference,
    quoteId,
    provider,
    markdownApplied,
    quoteExpiresAt,
    // NEW: Enhanced tracking fields
    swapCategory,
    correlationId,
    fromPrice,
    toPrice,
    intermediateToken,
    routingPath,
    executionTimestamp: new Date(),
    swapPair: `${sourceCurrency}-${targetCurrency}`,
    fromCurrency: sourceCurrency,
    toCurrency: targetCurrency,
    fromAmount: sourceAmount,
    toAmount: targetAmount,
    originalQuoteId: quoteId,
    ...metadata // Allow additional custom metadata
  };

  const swapOutTransaction = new this({
    userId,
    type: 'SWAP',
    currency: sourceCurrency,
    amount: -sourceAmount,
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
    // NEW: Enhanced top-level fields
    swapCategory,
    swapPair: `${sourceCurrency}-${targetCurrency}`,
    intermediateToken,
    routingPath,
    exchangeRate,
    fromPrice,
    toPrice,
    correlationId,
    originalQuoteId: quoteId,
    executionTimestamp: new Date(),
    swapDirection: 'OUT',
    metadata: enhancedMetadata
  });

  const swapInTransaction = new this({
    userId,
    type: 'SWAP',
    currency: targetCurrency,
    amount: targetAmount,
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
    fee: 0,
    // NEW: Enhanced top-level fields
    swapCategory,
    swapPair: `${sourceCurrency}-${targetCurrency}`,
    intermediateToken,
    routingPath,
    exchangeRate,
    fromPrice,
    toPrice,
    correlationId,
    originalQuoteId: quoteId,
    executionTimestamp: new Date(),
    swapDirection: 'IN',
    metadata: {
      ...enhancedMetadata,
      swapDirection: 'IN'
    }
  });

  const saveOptions = session ? { session } : {};
  await swapOutTransaction.save(saveOptions);
  await swapInTransaction.save(saveOptions);

  return {
    swapOutTransaction,
    swapInTransaction,
    swapId: swapReference
  };
};

/**
 * NEW: Static method to find related swap transactions by correlation ID
 */
transactionSchema.statics.findRelatedSwaps = function(correlationId) {
  return this.find({ 
    correlationId,
    type: { $in: ['SWAP', 'OBIEX_SWAP'] }
  }).sort({ createdAt: -1 });
};

/**
 * NEW: Static method to get swap analytics by pair
 */
transactionSchema.statics.getSwapAnalytics = function(swapPair, timeframe = '24h') {
  const timeAgo = new Date();
  const hours = timeframe === '24h' ? 24 : 
                timeframe === '7d' ? 24 * 7 : 
                timeframe === '30d' ? 24 * 30 : 24;
  timeAgo.setHours(timeAgo.getHours() - hours);
  
  return this.aggregate([
    {
      $match: {
        swapPair,
        type: 'SWAP',
        status: 'SUCCESSFUL',
        createdAt: { $gte: timeAgo }
      }
    },
    {
      $group: {
        _id: null,
        totalSwaps: { $sum: 1 },
        totalVolume: { $sum: { $abs: '$amount' } },
        avgExchangeRate: { $avg: '$exchangeRate' },
        uniqueUsers: { $addToSet: '$userId' }
      }
    },
    {
      $project: {
        _id: 0,
        totalSwaps: 1,
        totalVolume: 1,
        avgExchangeRate: 1,
        uniqueUsers: { $size: '$uniqueUsers' }
      }
    }
  ]);
};

module.exports = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);