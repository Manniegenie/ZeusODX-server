const mongoose = require('mongoose');
const logger = require('../utils/logger');

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { 
    type: String, 
    enum: ['DEPOSIT', 'WITHDRAWAL', 'SWAP_IN', 'SWAP_OUT', 'ONRAMP', 'OFFRAMP'], 
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
  obiexTransactionId: { type: String, unique: true, sparse: true },
  memo: { type: String },
  reference: { type: String },
  swapDetails: {
    quoteId: { type: String },
    swapId: { type: String },
    sourceCurrency: { type: String },
    targetCurrency: { type: String },
    sourceAmount: { type: Number },
    targetAmount: { type: Number },
    exchangeRate: { type: Number },
    swapType: { 
      type: String, 
      enum: ['CRYPTO_TO_CRYPTO', 'ONRAMP', 'OFFRAMP'] 
    },
    quoteExpiresAt: { type: Date },
    quoteAcceptedAt: { type: Date },
    swapFee: { type: Number, default: 0 },
    markdownApplied: { type: Number, default: 0 },
    provider: { 
      type: String, 
      enum: ['OBIEX', 'ONRAMP_SERVICE', 'OFFRAMP_SERVICE', 'INTERNAL_EXCHANGE', 'INTERNAL_ONRAMP', 'INTERNAL_OFFRAMP'],
      default: 'OBIEX'
    }
  },
  relatedTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
  metadata: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Define indexes for better query performance
// Note: obiexTransactionId already has unique: true in schema definition, so no explicit index needed
transactionSchema.index({ transactionId: 1 }, { sparse: true });
transactionSchema.index({ reference: 1 }, { sparse: true });
transactionSchema.index({ userId: 1, type: 1, status: 1 });
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ currency: 1, status: 1 });
transactionSchema.index({ 'swapDetails.swapId': 1 }, { sparse: true });
transactionSchema.index({ 'swapDetails.quoteId': 1 }, { sparse: true });
transactionSchema.index({ userId: 1, type: 1, 'swapDetails.swapType': 1 });
transactionSchema.index({ relatedTransactionId: 1 }, { sparse: true });

// Pre-save middleware to update timestamps
transactionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

/**
 * Creates swap transaction pairs for immediate completion
 * @param {Object} swapData - Swap transaction data
 * @returns {Object} Created swap transactions
 */
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
    status = 'SUCCESSFUL', // Default to SUCCESSFUL for immediate completion
    obiexTransactionId = null
  } = swapData;

  const swapId = `swap_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const baseTransactionId = obiexTransactionId || `swap_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const swapOutTransactionId = `${baseTransactionId}_out`;
  const swapInTransactionId = `${baseTransactionId}_in`;

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

  const swapOutTransaction = new this({
    userId,
    type: swapType === 'ONRAMP' ? 'ONRAMP' : 'SWAP_OUT',
    currency: sourceCurrency,
    amount: -Math.abs(sourceAmount),
    status,
    source: 'INTERNAL',
    narration: `Swap ${sourceCurrency} to ${targetCurrency}`,
    obiexTransactionId: swapOutTransactionId,
    swapDetails: { ...baseSwapDetails }
  });

  const swapInTransaction = new this({
    userId,
    type: swapType === 'OFFRAMP' ? 'OFFRAMP' : 'SWAP_IN',
    currency: targetCurrency,
    amount: Math.abs(targetAmount),
    status,
    source: 'INTERNAL',
    narration: `Swap ${sourceCurrency} to ${targetCurrency}`,
    obiexTransactionId: swapInTransactionId,
    swapDetails: { ...baseSwapDetails }
  });

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const savedSwapOut = await swapOutTransaction.save({ session });
      const savedSwapIn = await swapInTransaction.save({ session });

      // Link related transactions
      savedSwapOut.relatedTransactionId = savedSwapIn._id;
      savedSwapIn.relatedTransactionId = savedSwapOut._id;

      await savedSwapOut.save({ session });
      await savedSwapIn.save({ session });

      // NOTE: Balance updates are now handled directly in the swap router
      // This keeps the transaction creation focused on database operations only

      result = { 
        swapOutTransaction: savedSwapOut, 
        swapInTransaction: savedSwapIn, 
        swapId 
      };
    });
    
    logger.info('Swap transactions created successfully', {
      userId,
      swapId,
      status,
      sourceCurrency,
      targetCurrency,
      sourceAmount,
      targetAmount,
      provider,
      swapType
    });
    
    return result;
  } catch (error) {
    logger.error('Failed to create swap transactions', { 
      userId, 
      quoteId, 
      error: error.message,
      stack: error.stack
    });
    throw error;
  } finally {
    session.endSession();
  }
};

/**
 * Updates the status of all transactions related to a swap
 * @param {String} swapId - The swap ID
 * @param {String} newStatus - The new status to set
 * @returns {Object} Update result
 */
transactionSchema.statics.updateSwapStatus = async function(swapId, newStatus) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await this.updateMany(
        { 'swapDetails.swapId': swapId },
        { 
          $set: { 
            status: newStatus,
            updatedAt: new Date()
          }
        },
        { session }
      );

      // NOTE: Balance updates are now handled directly in swap router
      // This method is mainly for status updates from webhooks (if any) or cleanup operations
      logger.info('Swap status updated', {
        swapId,
        newStatus,
        modifiedCount: result.modifiedCount
      });
    });
    return result;
  } catch (error) {
    logger.error('Failed to update swap status', { 
      swapId, 
      newStatus, 
      error: error.message,
      stack: error.stack
    });
    throw error;
  } finally {
    session.endSession();
  }
};

/**
 * Gets all transactions related to a swap
 * @param {String} swapId - The swap ID
 * @returns {Object} Swap transactions
 */
transactionSchema.statics.getSwapTransactions = async function(swapId) {
  try {
    const transactions = await this.find({ 'swapDetails.swapId': swapId });
    
    const swapOut = transactions.find(tx => tx.type === 'SWAP_OUT' || tx.type === 'ONRAMP');
    const swapIn = transactions.find(tx => tx.type === 'SWAP_IN' || tx.type === 'OFFRAMP');
    
    logger.debug('Retrieved swap transactions', {
      swapId,
      transactionCount: transactions.length,
      hasSwapOut: !!swapOut,
      hasSwapIn: !!swapIn
    });
    
    return {
      swapOutTransaction: swapOut,
      swapInTransaction: swapIn,
      transactions
    };
  } catch (error) {
    logger.error('Failed to get swap transactions', {
      swapId,
      error: error.message
    });
    throw error;
  }
};

/**
 * Finds swap transactions by Obiex transaction ID
 * @param {String} obiexTransactionId - The Obiex transaction ID
 * @returns {Object|null} Swap transactions or null if not found
 */
transactionSchema.statics.findSwapByObiexId = async function(obiexTransactionId) {
  try {
    const transactions = await this.find({ obiexTransactionId });
    
    if (transactions.length === 0) {
      logger.debug('No transactions found for Obiex ID', { obiexTransactionId });
      return null;
    }
    
    const swapOut = transactions.find(tx => ['SWAP_OUT', 'ONRAMP'].includes(tx.type));
    const swapIn = transactions.find(tx => ['SWAP_IN', 'OFFRAMP'].includes(tx.type));
    
    logger.debug('Found transactions by Obiex ID', {
      obiexTransactionId,
      transactionCount: transactions.length,
      hasSwapOut: !!swapOut,
      hasSwapIn: !!swapIn
    });
    
    return {
      swapOutTransaction: swapOut,
      swapInTransaction: swapIn,
      transactions,
      swapId: swapOut?.swapDetails?.swapId || swapIn?.swapDetails?.swapId
    };
  } catch (error) {
    logger.error('Failed to find swap by Obiex ID', {
      obiexTransactionId,
      error: error.message
    });
    throw error;
  }
};

/**
 * Gets user transactions with filtering and pagination
 * @param {String} userId - User ID
 * @param {Object} options - Query options
 * @returns {Object} Paginated transaction results
 */
transactionSchema.statics.getUserTransactions = async function(userId, options = {}) {
  try {
    const {
      page = 1,
      limit = 20,
      type,
      status,
      currency,
      startDate,
      endDate,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = options;

    // Build query
    const query = { userId };
    
    if (type) {
      if (Array.isArray(type)) {
        query.type = { $in: type };
      } else {
        query.type = type;
      }
    }
    
    if (status) {
      if (Array.isArray(status)) {
        query.status = { $in: status };
      } else {
        query.status = status;
      }
    }
    
    if (currency) {
      query.currency = currency.toUpperCase();
    }
    
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    // Calculate pagination
    const skip = (page - 1) * limit;
    const sortDirection = sortOrder === 'desc' ? -1 : 1;

    // Execute query
    const [transactions, totalCount] = await Promise.all([
      this.find(query)
        .sort({ [sortBy]: sortDirection })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('relatedTransactionId', 'type currency amount status')
        .lean(),
      this.countDocuments(query)
    ]);

    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    logger.debug('Retrieved user transactions', {
      userId,
      page,
      limit,
      totalCount,
      totalPages,
      transactionCount: transactions.length
    });

    return {
      transactions,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        hasNextPage,
        hasPrevPage,
        limit: parseInt(limit)
      }
    };
  } catch (error) {
    logger.error('Failed to get user transactions', {
      userId,
      error: error.message
    });
    throw error;
  }
};

/**
 * Gets transaction statistics for a user
 * @param {String} userId - User ID
 * @param {Object} options - Query options
 * @returns {Object} Transaction statistics
 */
transactionSchema.statics.getUserTransactionStats = async function(userId, options = {}) {
  try {
    const {
      startDate,
      endDate,
      currency
    } = options;

    // Build match query
    const matchQuery = { userId };
    
    if (startDate || endDate) {
      matchQuery.createdAt = {};
      if (startDate) matchQuery.createdAt.$gte = new Date(startDate);
      if (endDate) matchQuery.createdAt.$lte = new Date(endDate);
    }
    
    if (currency) {
      matchQuery.currency = currency.toUpperCase();
    }

    const pipeline = [
      { $match: matchQuery },
      {
        $group: {
          _id: {
            type: '$type',
            status: '$status'
          },
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' }
        }
      },
      {
        $group: {
          _id: '$_id.type',
          statuses: {
            $push: {
              status: '$_id.status',
              count: '$count',
              totalAmount: '$totalAmount'
            }
          },
          totalCount: { $sum: '$count' },
          totalAmount: { $sum: '$totalAmount' }
        }
      }
    ];

    const stats = await this.aggregate(pipeline);
    
    logger.debug('Retrieved transaction stats', {
      userId,
      statsCount: stats.length,
      options
    });

    return stats;
  } catch (error) {
    logger.error('Failed to get transaction stats', {
      userId,
      error: error.message
    });
    throw error;
  }
};

/**
 * Creates a deposit transaction
 * @param {Object} depositData - Deposit transaction data
 * @returns {Object} Created transaction
 */
transactionSchema.statics.createDeposit = async function(depositData) {
  try {
    const {
      userId,
      currency,
      amount,
      address,
      hash,
      network,
      transactionId,
      status = 'PENDING'
    } = depositData;

    const deposit = new this({
      userId,
      type: 'DEPOSIT',
      currency: currency.toUpperCase(),
      amount: Math.abs(amount),
      address,
      hash,
      network,
      transactionId,
      status,
      source: 'CRYPTO_WALLET',
      narration: `Deposit ${currency.toUpperCase()}`
    });

    const savedDeposit = await deposit.save();
    
    logger.info('Deposit transaction created', {
      userId,
      transactionId: savedDeposit._id,
      currency,
      amount,
      status
    });

    return savedDeposit;
  } catch (error) {
    logger.error('Failed to create deposit transaction', {
      userId: depositData.userId,
      error: error.message
    });
    throw error;
  }
};

/**
 * Creates a withdrawal transaction
 * @param {Object} withdrawalData - Withdrawal transaction data
 * @returns {Object} Created transaction
 */
transactionSchema.statics.createWithdrawal = async function(withdrawalData) {
  try {
    const {
      userId,
      currency,
      amount,
      address,
      network,
      fee = 0,
      status = 'PENDING'
    } = withdrawalData;

    const withdrawal = new this({
      userId,
      type: 'WITHDRAWAL',
      currency: currency.toUpperCase(),
      amount: -Math.abs(amount),
      address,
      network,
      fee,
      status,
      source: 'CRYPTO_WALLET',
      narration: `Withdrawal ${currency.toUpperCase()}`
    });

    const savedWithdrawal = await withdrawal.save();
    
    logger.info('Withdrawal transaction created', {
      userId,
      transactionId: savedWithdrawal._id,
      currency,
      amount,
      fee,
      status
    });

    return savedWithdrawal;
  } catch (error) {
    logger.error('Failed to create withdrawal transaction', {
      userId: withdrawalData.userId,
      error: error.message
    });
    throw error;
  }
};

module.exports = mongoose.model('Transaction', transactionSchema);