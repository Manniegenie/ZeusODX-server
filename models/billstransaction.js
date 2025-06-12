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
  
  // Amount information (NGNB only - with backward compatibility)
  amount: {
    type: Number,
    required: true,
    min: 0,
    description: 'Amount in Naira (same as NGNB due to 1:1 peg)'
  },
  amountNaira: {
    type: Number,
    required: true,
    min: 0,
    description: 'Amount in Nigerian Naira'
  },
  
  // NGNB amount (new field - will be auto-populated from old fields)
  amountNGNB: {
    type: Number,
    min: 0,
    description: 'Amount in NGNB (always equals amountNaira due to 1:1 peg)'
  },
  
  // Legacy crypto fields for backward compatibility
  amountCrypto: {
    type: Number,
    min: 0,
    description: 'Legacy field - same as amountNGNB for NGNB transactions'
  },
  cryptoPrice: {
    type: Number,
    min: 0,
    default: 1,
    description: 'Legacy field - always 1 for NGNB (1:1 peg with Naira)'
  },
  
  // Legacy USD support (for backward compatibility)
  amountUsd: {
    type: Number,
    min: 0,
    description: 'Legacy field - calculated from amountCrypto * cryptoPrice'
  },
  
  // Payment currency (NGNB only but supporting legacy values)
  paymentCurrency: {
    type: String,
    required: true,
    enum: ['NGNB', 'BTC', 'ETH', 'SOL', 'USDT', 'USDC'], // Keep legacy values but force to NGNB
    default: 'NGNB'
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
  network: {
    type: String,
    enum: ['MTN', 'GLO', 'AIRTEL', '9MOBILE', 'EKEDC', 'IKEDC', 'DSTV', 'GOTV', 'STARTIMES', null]
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
  
  // Enhanced metadata for NGNB transactions
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
  
  // New fields with backward compatibility
  balanceReserved: {
    type: Boolean,
    default: false,
    description: 'Whether NGNB balance was reserved for this transaction'
  },
  twoFactorValidated: {
    type: Boolean,
    default: false,
    description: 'Whether 2FA was validated for this transaction'
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
      enum: ['validation', 'balance_check', 'balance_reservation', 'api_call', 'webhook_processing', 'refund', 'unexpected_error']
    }
  }]
}, {
  timestamps: true, // Adds createdAt and updatedAt automatically
  collection: 'billtransactions'
});

// OPTIMIZED INDEXES for NGNB-only bill payments
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

// Virtual for formatted amount display (NGNB-specific)
billTransactionSchema.virtual('formattedAmount').get(function() {
  return `₦${this.amountNaira.toLocaleString()} (${this.amountNGNB} NGNB)`;
});

// Virtual for payment summary
billTransactionSchema.virtual('paymentSummary').get(function() {
  return {
    currency: 'NGNB',
    amount: this.amountNGNB,
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

// Instance method to get payment details (NGNB-specific)
billTransactionSchema.methods.getPaymentDetails = function() {
  return {
    currency: 'NGNB',
    amount: this.amountNGNB,
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

// Static method to get user's bill transactions (NGNB-specific)
billTransactionSchema.statics.getUserTransactions = function(userId, options = {}) {
  const query = { userId, paymentCurrency: 'NGNB' };
  
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
    paymentCurrency: 'NGNB',
    status: { $in: ['initiated-api', 'processing-api'] },
    createdAt: { $gte: new Date(Date.now() - timeLimit * 60 * 1000) }
  };
  
  if (billType) {
    query.billType = billType;
  }
  
  return this.find(query).sort({ createdAt: -1 });
};

// Static method to get transaction summary by bill type (NGNB-specific)
billTransactionSchema.statics.getBillTypeSummary = function(userId, dateRange = {}) {
  const matchQuery = { 
    userId, 
    status: 'completed-api',
    paymentCurrency: 'NGNB'
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
        totalAmountNGNB: { $sum: '$amountNGNB' },
        count: { $sum: 1 },
        avgAmount: { $avg: '$amountNaira' },
        maxAmount: { $max: '$amountNaira' },
        minAmount: { $min: '$amountNaira' }
      }
    },
    { $sort: { totalAmount: -1 } }
  ]);
};

// Static method to get NGNB spending summary
billTransactionSchema.statics.getNGNBSummary = function(userId, dateRange = {}) {
  const matchQuery = { 
    userId, 
    status: 'completed-api',
    paymentCurrency: 'NGNB'
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
        totalNGNB: { $sum: '$amountNGNB' },
        totalNaira: { $sum: '$amountNaira' },
        totalTransactions: { $sum: 1 },
        avgAmount: { $avg: '$amountNGNB' },
        billTypes: { $addToSet: '$billType' },
        totalByBillType: {
          $push: {
            billType: '$billType',
            amount: '$amountNGNB'
          }
        }
      }
    }
  ]);
};

// Static method to find transactions by amount range (NGNB)
billTransactionSchema.statics.findByNGNBRange = function(minAmount, maxAmount, options = {}) {
  const query = {
    paymentCurrency: 'NGNB',
    amountNGNB: { $gte: minAmount, $lte: maxAmount }
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
      paymentCurrency: 'NGNB',
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
    paymentCurrency: 'NGNB',
    balanceReserved: true,
    status: { $in: ['failed', 'refunded'] },
    portfolioUpdated: false
  });
};

// Pre-save middleware to ensure backward compatibility and NGNB consistency
billTransactionSchema.pre('save', function(next) {
  // Handle backward compatibility: populate new fields from old fields
  
  // If we have amountCrypto but no amountNGNB, use amountCrypto
  if (this.amountCrypto && !this.amountNGNB) {
    this.amountNGNB = this.amountCrypto;
  }
  
  // If we have amountNGNB but no amountCrypto, populate amountCrypto
  if (this.amountNGNB && !this.amountCrypto) {
    this.amountCrypto = this.amountNGNB;
  }
  
  // If we have amountNaira but no amountNGNB, use 1:1 ratio
  if (this.amountNaira && !this.amountNGNB) {
    this.amountNGNB = this.amountNaira;
  }
  
  // If we have amountNGNB but no amountNaira, use 1:1 ratio
  if (this.amountNGNB && !this.amountNaira) {
    this.amountNaira = this.amountNGNB;
  }
  
  // Ensure amount field consistency
  if (!this.amount && this.amountNaira) {
    this.amount = this.amountNaira;
  }
  
  // Set cryptoPrice to 1 for NGNB (1:1 peg)
  if (!this.cryptoPrice || this.paymentCurrency === 'NGNB') {
    this.cryptoPrice = 1;
  }
  
  // Calculate amountUsd for backward compatibility
  if (!this.amountUsd && this.amountCrypto && this.cryptoPrice) {
    this.amountUsd = this.amountCrypto * this.cryptoPrice;
  }
  
  // Force payment currency to NGNB for new transactions
  if (!this.paymentCurrency || this.paymentCurrency !== 'NGNB') {
    this.paymentCurrency = 'NGNB';
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

// Pre-save validation for backward compatibility
billTransactionSchema.pre('save', function(next) {
  // More lenient validation - allow either old or new field combinations
  
  // Ensure we have at least one amount field
  if (!this.amount && !this.amountNaira && !this.amountNGNB && !this.amountCrypto) {
    return next(new Error('At least one amount field is required'));
  }
  
  // If we have both amountNGNB and amountNaira, ensure they match (1:1 peg)
  if (this.amountNGNB && this.amountNaira && Math.abs(this.amountNGNB - this.amountNaira) > 0.01) {
    return next(new Error('NGNB amount must equal Naira amount (1:1 peg)'));
  }
  
  // If we have both amountCrypto and amountNGNB, ensure they match
  if (this.amountCrypto && this.amountNGNB && Math.abs(this.amountCrypto - this.amountNGNB) > 0.01) {
    return next(new Error('amountCrypto and amountNGNB must match for NGNB transactions'));
  }
  
  next();
});

// Enhanced post-save middleware for NGNB logging
billTransactionSchema.post('save', function(doc) {
  const balanceStatus = doc.balanceReserved ? '✅ Reserved' : '⚠️ Not Reserved';
  const twoFAStatus = doc.twoFactorValidated ? '✅ 2FA' : '❌ No 2FA';
  
  console.log(`📋 Bill transaction ${doc.orderId}: ${doc.status} | ${doc.billType} | ${doc.amountNGNB} NGNB | ${twoFAStatus} | ${balanceStatus}`);
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