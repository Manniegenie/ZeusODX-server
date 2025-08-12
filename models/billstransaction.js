const mongoose = require('mongoose');

const billTransactionSchema = new mongoose.Schema({
  // Core transaction identifiers
  orderId: {
    type: String,
    required: true,
    unique: true
  },
  requestId: {
    type: String
  },
  
  // Transaction status and type
  status: {
    type: String,
    required: true,
    enum: ['initiated-api', 'processing-api', 'completed-api', 'failed', 'refunded']
  },
  billType: {
    type: String,
    required: true,
    enum: ['airtime', 'data', 'electricity', 'cable_tv', 'internet', 'betting', 'education', 'other']
  },
  
  // Product details
  productName: {
    type: String,
    required: true
  },
  quantity: {
    type: Number,
    default: 1,
    min: 1
  },
  
  // Amount information (NGNZ only)
  amount: {
    type: Number,
    required: true,
    min: 0,
    description: 'Amount in Naira (same as NGNZ due to 1:1 peg)'
  },
  amountNaira: {
    type: Number,
    required: true,
    min: 0,
    description: 'Amount in Nigerian Naira'
  },
  
  // NGNZ amount
  amountNGNZ: {
    type: Number,
    min: 0,
    description: 'Amount in NGNZ (always equals amountNaira due to 1:1 peg)'
  },
  
  // Legacy crypto fields for backward compatibility
  amountCrypto: {
    type: Number,
    min: 0,
    description: 'Legacy field - same as amountNGNZ for NGNZ transactions'
  },
  cryptoPrice: {
    type: Number,
    min: 0,
    default: 1,
    description: 'Legacy field - always 1 for NGNZ (1:1 peg with Naira)'
  },
  
  // Legacy USD support (for backward compatibility)
  amountUsd: {
    type: Number,
    min: 0,
    description: 'Legacy field - calculated from amountCrypto * cryptoPrice'
  },
  
  // Payment currency (NGNZ only but supporting legacy values)
  paymentCurrency: {
    type: String,
    required: true,
    enum: ['NGNZ', 'BTC', 'ETH', 'SOL', 'USDT', 'USDC'],
    default: 'NGNZ'
  },
  
  // User reference
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Customer information
  customerPhone: {
    type: String
  },
  
  // UPDATED: Added betting providers to network enum
  network: {
    type: String,
    enum: [
      // Telecom networks
      'MTN', 'GLO', 'AIRTEL', '9MOBILE',
      
      // Electricity distribution companies
      'IKEJA-ELECTRIC', 'EKO-ELECTRIC', 'KANO-ELECTRIC', 'PORTHARCOURT-ELECTRIC',
      'JOS-ELECTRIC', 'IBADAN-ELECTRIC', 'KADUNA-ELECTRIC', 'ABUJA-ELECTRIC',
      'ENUGU-ELECTRIC', 'BENIN-ELECTRIC', 'ABA-ELECTRIC', 'YOLA-ELECTRIC',
      
      // Legacy electricity enum values (for backward compatibility)
      'EKEDC', 'IKEDC',
      
      // Cable TV providers
      'DSTV', 'GOTV', 'STARTIMES',
      
      // Betting providers
      '1xBet', 'BangBet', 'Bet9ja', 'BetKing', 'BetLand', 'BetLion',
      'BetWay', 'CloudBet', 'LiveScoreBet', 'MerryBet', 'NaijaBet',
      'NairaBet', 'SupaBet',
      
      null
    ]
  },
  
  customerInfo: {
    phone: String,
    customerId: String,
    customerName: String,
    meterNumber: String,
    accountNumber: String,
    network: String,
    serviceType: String,
    smartCardNumber: String, // For cable TV
    packageCode: String, // For data/cable packages
    disco: String // For electricity (distribution company)
  },
  
  // Timestamps
  timestamp: {
    type: Date,
    required: true,
    default: Date.now
  },
  webhookProcessedAt: {
    type: Date,
    default: null
  },
  
  // Enhanced metadata for NGNZ transactions
  metaData: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  // Processing flags
  portfolioUpdated: {
    type: Boolean,
    default: false
  },
  refundProcessed: {
    type: Boolean,
    default: false
  },
  
  // New fields
  balanceReserved: {
    type: Boolean,
    default: false,
    description: 'Whether NGNZ balance was reserved for this transaction'
  },
  twoFactorValidated: {
    type: Boolean,
    default: false,
    description: 'Whether 2FA was validated for this transaction'
  },
  passwordPinValidated: {
    type: Boolean,
    default: false,
    description: 'Whether password PIN was validated for this transaction'
  },
  kycValidated: {
    type: Boolean,
    default: false,
    description: 'Whether KYC validation passed for this transaction'
  },
  balanceCompleted: {
    type: Boolean,
    default: false,
    description: 'Whether balance update was completed for this transaction'
  },
  
  // Error tracking
  processingErrors: [{
    error: String,
    timestamp: {
      type: Date,
      default: Date.now
    },
    phase: {
      type: String,
      enum: ['validation', 'balance_check', 'balance_reservation', 'balance_update', 'api_call', 'webhook_processing', 'refund', 'unexpected_error']
    },
    ebills_order_id: String
  }]
}, {
  timestamps: true, // Adds createdAt and updatedAt automatically
  collection: 'billtransactions'
});

// OPTIMIZED INDEXES for NGNZ-only bill payments
billTransactionSchema.index({ requestId: 1 });
billTransactionSchema.index({ userId: 1, status: 1 });
billTransactionSchema.index({ userId: 1, billType: 1 });
billTransactionSchema.index({ userId: 1, createdAt: -1 });
billTransactionSchema.index({ userId: 1, billType: 1, status: 1 });
billTransactionSchema.index({ orderId: 1, userId: 1 });
billTransactionSchema.index({ customerPhone: 1, status: 1 });
billTransactionSchema.index({ timestamp: -1 });
billTransactionSchema.index({ status: 1, createdAt: -1 });
billTransactionSchema.index({ balanceReserved: 1, status: 1 }); // For cleanup operations

// Virtual for formatted amount display (NGNZ-specific)
billTransactionSchema.virtual('formattedAmount').get(function() {
  return `₦${this.amountNaira.toLocaleString()} (${this.amountNGNZ} NGNZ)`;
});

// Virtual for payment summary
billTransactionSchema.virtual('paymentSummary').get(function() {
  return {
    currency: 'NGNZ',
    amount: this.amountNGNZ,
    nairaEquivalent: this.amountNaira,
    exchangeRate: 1, // Always 1:1
    balanceReserved: this.balanceReserved,
    twoFactorValidated: this.twoFactorValidated
  };
});

// Instance method to check if transaction is successful
billTransactionSchema.methods.isSuccessful = function() {
  return this.status === 'completed-api';
};

// Instance method to check if transaction is pending
billTransactionSchema.methods.isPending = function() {
  return ['initiated-api', 'processing-api'].includes(this.status);
};

// Instance method to check if transaction is failed
billTransactionSchema.methods.isFailed = function() {
  return this.status === 'failed';
};

// Instance method to check if transaction is refunded
billTransactionSchema.methods.isRefunded = function() {
  return this.status === 'refunded';
};

// Instance method to get payment details (NGNZ-specific)
billTransactionSchema.methods.getPaymentDetails = function() {
  return {
    currency: 'NGNZ',
    amount: this.amountNGNZ,
    nairaAmount: this.amountNaira,
    exchangeRate: 1,
    balanceReserved: this.balanceReserved,
    twoFactorValidated: this.twoFactorValidated,
    formattedAmount: this.formattedAmount
  };
};

// Instance method to mark balance as reserved
billTransactionSchema.methods.markBalanceReserved = function() {
  this.balanceReserved = true;
  this.metaData = this.metaData || {};
  this.metaData.balance_reserved = true;
  this.metaData.balance_reserved_at = new Date();
  return this.save();
};

// Instance method to mark balance as released
billTransactionSchema.methods.markBalanceReleased = function() {
  this.balanceReserved = false;
  this.metaData = this.metaData || {};
  this.metaData.balance_reserved = false;
  this.metaData.balance_released_at = new Date();
  return this.save();
};

// Static method to get user's bill transactions (NGNZ-specific)
billTransactionSchema.statics.getUserTransactions = function(userId, options = {}) {
  const query = { userId, paymentCurrency: 'NGNZ' };
  
  if (options.billType) {
    query.billType = options.billType;
  }
  
  if (options.status) {
    query.status = options.status;
  }
  
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(options.limit || 50)
    .populate('userId', 'name email phone');
};

// Static method to get pending transactions for user
billTransactionSchema.statics.getUserPendingTransactions = function(userId, billType = null, timeLimit = 5) {
  const query = {
    userId,
    paymentCurrency: 'NGNZ',
    status: { $in: ['initiated-api', 'processing-api'] },
    createdAt: { $gte: new Date(Date.now() - timeLimit * 60 * 1000) }
  };
  
  if (billType) {
    query.billType = billType;
  }
  
  return this.find(query).sort({ createdAt: -1 });
};

// Static method to get transaction summary by bill type (NGNZ-specific)
billTransactionSchema.statics.getBillTypeSummary = function(userId, dateRange = {}) {
  const matchQuery = { 
    userId, 
    status: 'completed-api',
    paymentCurrency: 'NGNZ'
  };
  
  if (dateRange.start || dateRange.end) {
    matchQuery.createdAt = {};
    if (dateRange.start) matchQuery.createdAt.$gte = dateRange.start;
    if (dateRange.end) matchQuery.createdAt.$lte = dateRange.end;
  }
  
  return this.aggregate([
    { $match: matchQuery },
    {
      $group: {
        _id: '$billType',
        totalAmount: { $sum: '$amountNaira' },
        totalAmountNGNZ: { $sum: '$amountNGNZ' },
        count: { $sum: 1 },
        avgAmount: { $avg: '$amountNaira' },
        maxAmount: { $max: '$amountNaira' },
        minAmount: { $min: '$amountNaira' }
      }
    },
    { $sort: { totalAmount: -1 } }
  ]);
};

// Static method to get NGNZ spending summary
billTransactionSchema.statics.getNGNZSummary = function(userId, dateRange = {}) {
  const matchQuery = { 
    userId, 
    status: 'completed-api',
    paymentCurrency: 'NGNZ'
  };
  
  if (dateRange.start || dateRange.end) {
    matchQuery.createdAt = {};
    if (dateRange.start) matchQuery.createdAt.$gte = dateRange.start;
    if (dateRange.end) matchQuery.createdAt.$lte = dateRange.end;
  }
  
  return this.aggregate([
    { $match: matchQuery },
    {
      $group: {
        _id: null,
        totalNGNZ: { $sum: '$amountNGNZ' },
        totalNaira: { $sum: '$amountNaira' },
        totalTransactions: { $sum: 1 },
        avgAmount: { $avg: '$amountNGNZ' },
        billTypes: { $addToSet: '$billType' },
        totalByBillType: {
          $push: {
            billType: '$billType',
            amount: '$amountNGNZ'
          }
        }
      }
    }
  ]);
};

// Static method to find transactions by amount range (NGNZ)
billTransactionSchema.statics.findByNGNZRange = function(minAmount, maxAmount, options = {}) {
  const query = {
    paymentCurrency: 'NGNZ',
    amountNGNZ: { $gte: minAmount, $lte: maxAmount }
  };
  
  if (options.status) {
    query.status = options.status;
  }
  
  if (options.userId) {
    query.userId = options.userId;
  }
  
  if (options.billType) {
    query.billType = options.billType;
  }
  
  return this.find(query).sort({ createdAt: -1 }).limit(options.limit || 100);
};

// Static method to cleanup old pending transactions
billTransactionSchema.statics.cleanupStalePendingTransactions = function(olderThanMinutes = 30) {
  return this.updateMany(
    {
      status: { $in: ['initiated-api', 'processing-api'] },
      paymentCurrency: 'NGNZ',
      createdAt: { $lt: new Date(Date.now() - olderThanMinutes * 60 * 1000) }
    },
    {
      $set: {
        status: 'failed',
        $push: {
          processingErrors: {
            error: `Transaction marked as failed due to timeout (${olderThanMinutes} minutes)`,
            timestamp: new Date(),
            phase: 'cleanup'
          }
        }
      }
    }
  );
};

// Static method to get transactions needing balance release
billTransactionSchema.statics.getTransactionsNeedingBalanceRelease = function() {
  return this.find({
    paymentCurrency: 'NGNZ',
    balanceReserved: true,
    status: { $in: ['failed', 'refunded'] },
    portfolioUpdated: false
  });
};

// Pre-save middleware to ensure NGNZ consistency
billTransactionSchema.pre('save', function(next) {
  // If we have amountCrypto but no amountNGNZ, use amountCrypto
  if (this.amountCrypto && !this.amountNGNZ) {
    this.amountNGNZ = this.amountCrypto;
  }
  
  // If we have amountNGNZ but no amountCrypto, populate amountCrypto
  if (this.amountNGNZ && !this.amountCrypto) {
    this.amountCrypto = this.amountNGNZ;
  }
  
  // If we have amountNaira but no amountNGNZ, use 1:1 ratio
  if (this.amountNaira && !this.amountNGNZ) {
    this.amountNGNZ = this.amountNaira;
  }
  
  // If we have amountNGNZ but no amountNaira, use 1:1 ratio
  if (this.amountNGNZ && !this.amountNaira) {
    this.amountNaira = this.amountNGNZ;
  }
  
  // Ensure amount field consistency
  if (!this.amount && this.amountNaira) {
    this.amount = this.amountNaira;
  }
  
  // Set cryptoPrice to 1 for NGNZ (1:1 peg)
  if (!this.cryptoPrice || this.paymentCurrency === 'NGNZ') {
    this.cryptoPrice = 1;
  }
  
  // Calculate amountUsd for backward compatibility
  if (!this.amountUsd && this.amountCrypto && this.cryptoPrice) {
    this.amountUsd = this.amountCrypto * this.cryptoPrice;
  }
  
  // Force payment currency to NGNZ for new transactions
  if (!this.paymentCurrency || this.paymentCurrency !== 'NGNZ') {
    this.paymentCurrency = 'NGNZ';
  }
  
  // Sync balance reservation status with metadata
  if (this.metaData?.balance_reserved && !this.balanceReserved) {
    this.balanceReserved = this.metaData.balance_reserved;
  }
  
  // Sync 2FA validation status with metadata
  if (this.metaData?.twofa_validated && !this.twoFactorValidated) {
    this.twoFactorValidated = this.metaData.twofa_validated;
  }
  
  next();
});

// Pre-save validation
billTransactionSchema.pre('save', function(next) {
  // Ensure we have at least one amount field
  if (!this.amount && !this.amountNaira && !this.amountNGNZ && !this.amountCrypto) {
    return next(new Error('At least one amount field is required'));
  }
  
  // If we have both amountNGNZ and amountNaira, ensure they match (1:1 peg)
  if (this.amountNGNZ && this.amountNaira && Math.abs(this.amountNGNZ - this.amountNaira) > 0.01) {
    return next(new Error('NGNZ amount must equal Naira amount (1:1 peg)'));
  }
  
  // If we have both amountCrypto and amountNGNZ, ensure they match
  if (this.amountCrypto && this.amountNGNZ && Math.abs(this.amountCrypto - this.amountNGNZ) > 0.01) {
    return next(new Error('amountCrypto and amountNGNZ must match for NGNZ transactions'));
  }
  
  next();
});

// Enhanced post-save middleware for NGNZ logging
billTransactionSchema.post('save', function(doc) {
  const balanceStatus = doc.balanceReserved ? '✅ Reserved' : '⚠️ Not Reserved';
  const twoFAStatus = doc.twoFactorValidated ? '✅ 2FA' : '❌ No 2FA';
  
  console.log(`📋 Bill transaction ${doc.orderId}: ${doc.status} | ${doc.billType} | ${doc.amountNGNZ} NGNZ | ${twoFAStatus} | ${balanceStatus}`);
});

// Error handling middleware
billTransactionSchema.post('save', function(error, doc, next) {
  if (error.name === 'MongoServerError' && error.code === 11000) {
    if (error.keyPattern && error.keyPattern.orderId) {
      next(new Error('Transaction with this order ID already exists. Please try again.'));
    } else {
      next(new Error('Duplicate transaction detected. Please try again.'));
    }
  } else {
    next(error);
  }
});

module.exports = mongoose.model('BillTransaction', billTransactionSchema);