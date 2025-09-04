const mongoose = require('mongoose');

const transactionAuditSchema = new mongoose.Schema({
  // Core identification
  auditId: {
    type: String,
    required: true,
    unique: true,
    default: () => `AUDIT_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },
  
  // User and transaction references
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction',
    index: true
  },
  
  // Audit event details
  eventType: {
    type: String,
    required: true,
    enum: [
      'TRANSACTION_CREATED',
      'TRANSACTION_UPDATED', 
      'TRANSACTION_DELETED',
      'BALANCE_UPDATED',
      'SWAP_INITIATED',
      'SWAP_COMPLETED',
      'SWAP_FAILED',
      'OBIEX_SWAP_INITIATED',
      'OBIEX_SWAP_COMPLETED',
      'OBIEX_SWAP_FAILED',
      'QUOTE_CREATED',
      'QUOTE_ACCEPTED',
      'QUOTE_EXPIRED',
      'WEBHOOK_RECEIVED',
      'WEBHOOK_PROCESSED',
      'WEBHOOK_FAILED',
      'BALANCE_SYNC',
      'SYSTEM_ERROR',
      'USER_ACTION',
      'ADMIN_ACTION'
    ],
    index: true
  },
  
  // Status and outcome
  status: {
    type: String,
    required: true,
    enum: ['PENDING', 'SUCCESS', 'FAILED', 'WARNING', 'INFO'],
    default: 'PENDING',
    index: true
  },
  
  // Source of the audit event
  source: {
    type: String,
    required: true,
    enum: [
      'INTERNAL_SWAP',
      'OBIEX_API',
      'WEBHOOK',
      'USER_REQUEST',
      'ADMIN_PANEL',
      'SYSTEM_PROCESS',
      'BACKGROUND_JOB',
      'API_ENDPOINT',
      'CRON_JOB'
    ],
    index: true
  },
  
  // Action performed
  action: {
    type: String,
    required: true,
    maxlength: 100
  },
  
  // Detailed description
  description: {
    type: String,
    required: true,
    maxlength: 500
  },
  
  // Before state (for updates/changes)
  beforeState: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  
  // After state (for updates/changes)
  afterState: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  
  // Request/Response data
  requestData: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  
  responseData: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  
  // Error information (if applicable)
  errorDetails: {
    message: String,
    code: String,
    stack: String,
    httpStatus: Number,
    providerError: mongoose.Schema.Types.Mixed
  },
  
  // Financial details
  financialImpact: {
    currency: {
      type: String,
      uppercase: true
    },
    amount: {
      type: Number,
      default: 0
    },
    balanceBefore: Number,
    balanceAfter: Number,
    exchangeRate: Number,
    fees: {
      amount: Number,
      currency: String
    }
  },
  
  // Swap specific details
  swapDetails: {
    swapId: String,
    quoteId: String,
    sourceCurrency: String,
    targetCurrency: String,
    sourceAmount: Number,
    targetAmount: Number,
    exchangeRate: Number,
    provider: String,
    swapType: {
      type: String,
      enum: ['CRYPTO_TO_CRYPTO', 'CRYPTO_TO_FIAT', 'CRYPTO_TO_NGNX', 'INTERNAL', 'OBIEX']
    }
  },
  
  // Obiex specific details
  obiexDetails: {
    obiexTransactionId: String,
    obiexQuoteId: String,
    obiexStatus: String,
    obiexResponse: mongoose.Schema.Types.Mixed,
    obiexRequestId: String,
    obiexOperationType: {
      type: String,
      enum: ['QUOTE_CREATE', 'QUOTE_ACCEPT', 'CRYPTO_TO_NGNX', 'CURRENCY_FETCH']
    }
  },
  
  // System context
  systemContext: {
    ipAddress: String,
    userAgent: String,
    sessionId: String,
    apiVersion: String,
    platform: String,
    environment: {
      type: String,
      enum: ['development', 'staging', 'production'],
      default: 'production'
    }
  },
  
  // Timing information
  timing: {
    startTime: {
      type: Date,
      default: Date.now
    },
    endTime: Date,
    duration: Number, // in milliseconds
    processingTime: Number
  },
  
  // Related references
  relatedEntities: {
    parentAuditId: {
      type: String,
      index: true
    },
    relatedTransactionIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction'
    }],
    relatedAuditIds: [{
      type: String,
      ref: 'TransactionAudit'
    }],
    correlationId: {
      type: String,
      index: true
    }
  },
  
  // Metadata and tags
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  tags: [{
    type: String,
    maxlength: 50
  }],
  
  // Risk and compliance
  riskLevel: {
    type: String,
    enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
    default: 'LOW',
    index: true
  },
  
  flagged: {
    type: Boolean,
    default: false,
    index: true
  },
  
  flagReason: String,
  
  // Review status
  reviewed: {
    type: Boolean,
    default: false,
    index: true
  },
  
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  reviewedAt: Date,
  
  reviewNotes: String,
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  collection: 'transactionAudits'
});

// Indexes for better query performance
transactionAuditSchema.index({ userId: 1, createdAt: -1 });
transactionAuditSchema.index({ eventType: 1, status: 1 });
transactionAuditSchema.index({ source: 1, createdAt: -1 });
transactionAuditSchema.index({ 'swapDetails.swapId': 1 });
transactionAuditSchema.index({ 'obiexDetails.obiexTransactionId': 1 });
transactionAuditSchema.index({ 'relatedEntities.correlationId': 1 });
transactionAuditSchema.index({ riskLevel: 1, flagged: 1 });
transactionAuditSchema.index({ reviewed: 1, createdAt: -1 });

// Compound indexes for common queries
transactionAuditSchema.index({ userId: 1, eventType: 1, createdAt: -1 });
transactionAuditSchema.index({ status: 1, riskLevel: 1, flagged: 1 });

// Pre-save middleware to update timestamps and calculate duration
transactionAuditSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  
  // Calculate duration if endTime is set
  if (this.timing.endTime && this.timing.startTime) {
    this.timing.duration = this.timing.endTime - this.timing.startTime;
  }
  
  next();
});

// Static methods for common operations
transactionAuditSchema.statics.createAudit = function(auditData) {
  return new this(auditData).save();
};

transactionAuditSchema.statics.findByUser = function(userId, options = {}) {
  const query = { userId };
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(options.limit || 100)
    .lean();
};

transactionAuditSchema.statics.findBySwapId = function(swapId) {
  return this.find({ 'swapDetails.swapId': swapId })
    .sort({ createdAt: 1 })
    .lean();
};

transactionAuditSchema.statics.findByCorrelationId = function(correlationId) {
  return this.find({ 'relatedEntities.correlationId': correlationId })
    .sort({ createdAt: 1 })
    .lean();
};

transactionAuditSchema.statics.findFlagged = function(options = {}) {
  const query = { flagged: true };
  if (options.riskLevel) query.riskLevel = options.riskLevel;
  if (options.reviewed !== undefined) query.reviewed = options.reviewed;
  
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(options.limit || 50);
};

transactionAuditSchema.statics.getAuditStats = function(userId, timeRange = '24h') {
  const timeRanges = {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000
  };
  
  const since = new Date(Date.now() - timeRanges[timeRange]);
  const query = { createdAt: { $gte: since } };
  if (userId) query.userId = userId;
  
  return this.aggregate([
    { $match: query },
    {
      $group: {
        _id: '$eventType',
        count: { $sum: 1 },
        successCount: { $sum: { $cond: [{ $eq: ['$status', 'SUCCESS'] }, 1, 0] } },
        failureCount: { $sum: { $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0] } }
      }
    },
    { $sort: { count: -1 } }
  ]);
};

// Instance methods
transactionAuditSchema.methods.markAsReviewed = function(reviewedBy, notes) {
  this.reviewed = true;
  this.reviewedBy = reviewedBy;
  this.reviewedAt = new Date();
  if (notes) this.reviewNotes = notes;
  return this.save();
};

transactionAuditSchema.methods.flag = function(reason, riskLevel = 'MEDIUM') {
  this.flagged = true;
  this.flagReason = reason;
  this.riskLevel = riskLevel;
  return this.save();
};

transactionAuditSchema.methods.unflag = function() {
  this.flagged = false;
  this.flagReason = undefined;
  this.riskLevel = 'LOW';
  return this.save();
};

transactionAuditSchema.methods.setEndTime = function(endTime = new Date()) {
  this.timing.endTime = endTime;
  if (this.timing.startTime) {
    this.timing.duration = endTime - this.timing.startTime;
  }
  return this.save();
};

const TransactionAudit = mongoose.model('TransactionAudit', transactionAuditSchema);

module.exports = TransactionAudit;