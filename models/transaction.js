// models/transaction.js

const mongoose = require('mongoose');
const logger = require('../utils/logger');

const transactionSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  type: { 
    type: String, 
    enum: [
      'DEPOSIT', 
      'WITHDRAWAL', 
      'SWAP_IN', 
      'SWAP_OUT', 
      'ONRAMP', 
      'OFFRAMP'
    ], 
    required: true 
  },
  currency: { type: String, required: true },
  amount:   { type: Number, required: true },

  address:       String,
  fee:           { type: Number, default: 0 },
  obiexFee:      { type: Number, default: 0 },

  status: {
    type: String,
    enum: [
      'PENDING', 
      'APPROVED', 
      'PROCESSING', 
      'SUCCESSFUL', 
      'FAILED', 
      'REJECTED', 
      'CONFIRMED'
    ],
    required: true
  },

  network:     String,
  hash:        String,
  reference:   String,
  obiexTransactionId: { 
    type: String, 
    unique: true, 
    sparse: true 
  },

  source: {
    type: String,
    enum: ['CRYPTO_WALLET', 'BANK', 'INTERNAL'],
    default: 'CRYPTO_WALLET'
  },

  narration: String,
  memo:      String,

  swapDetails: {
    quoteId:        String,
    swapId:         String,
    sourceCurrency: String,
    targetCurrency: String,
    sourceAmount:   Number,
    targetAmount:   Number,
    exchangeRate:   Number,
    swapType: {
      type: String,
      enum: ['CRYPTO_TO_CRYPTO', 'ONRAMP', 'OFFRAMP']
    },
    quoteExpiresAt:  Date,
    quoteAcceptedAt: Date,
    swapFee:         { type: Number, default: 0 },
    markdownApplied: { type: Number, default: 0 },
    provider: {
      type: String,
      enum: [
        'OBIEX', 
        'ONRAMP_SERVICE', 
        'OFFRAMP_SERVICE', 
        'INTERNAL_EXCHANGE', 
        'INTERNAL_ONRAMP', 
        'INTERNAL_OFFRAMP'
      ],
      default: 'OBIEX'
    }
  },

  relatedTransactionId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Transaction' 
  },
  metadata: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Auto-update updatedAt
transactionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

/**
 * Create a SWAP_OUT / SWAP_IN pair atomically
 */
transactionSchema.statics.createSwapTransactions = async function(data) {
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
    status = 'SUCCESSFUL'
  } = data;

  const swapId = `swap_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const baseId = `swap_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const outId  = `${baseId}_out`;
  const inId   = `${baseId}_in`;

  const common = {
    userId,
    status,
    source: 'INTERNAL',
    narration: `Swap ${sourceCurrency} → ${targetCurrency}`,
    swapDetails: {
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
    }
  };

  const swapOut = new this({
    ...common,
    type: 'SWAP_OUT',
    currency: sourceCurrency,
    amount: -Math.abs(sourceAmount),
    obiexTransactionId: outId
  });

  const swapIn = new this({
    ...common,
    type: 'SWAP_IN',
    currency: targetCurrency,
    amount:  Math.abs(targetAmount),
    obiexTransactionId: inId
  });

  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const savedOut = await swapOut.save({ session });
      const savedIn  = await swapIn.save({ session });

      savedOut.relatedTransactionId = savedIn._id;
      savedIn.relatedTransactionId  = savedOut._id;

      await savedOut.save({ session });
      await savedIn.save({ session });

      result = {
        swapOutTransaction: savedOut,
        swapInTransaction:  savedIn,
        swapId
      };
    });
    logger.info('Swap transactions created', { userId, swapId });
    return result;
  } catch (err) {
    logger.error('Error creating swap transactions', { error: err.stack });
    throw err;
  } finally {
    session.endSession();
  }
};

/**
 * Update status of all transactions in a swap
 */
transactionSchema.statics.updateSwapStatus = async function(swapId, newStatus) {
  const session = await mongoose.startSession();
  try {
    let res;
    await session.withTransaction(async () => {
      res = await this.updateMany(
        { 'swapDetails.swapId': swapId },
        { $set: { status: newStatus, updatedAt: new Date() } },
        { session }
      );
      logger.info('Swap status updated', { swapId, newStatus, modifiedCount: res.modifiedCount });
    });
    return res;
  } catch (err) {
    logger.error('Failed to update swap status', { swapId, newStatus, error: err.stack });
    throw err;
  } finally {
    session.endSession();
  }
};

/**
 * Retrieve swap transactions by swapId
 */
transactionSchema.statics.getSwapTransactions = async function(swapId) {
  try {
    const txs = await this.find({ 'swapDetails.swapId': swapId });
    const swapOut = txs.find(tx => tx.type === 'SWAP_OUT' || tx.type === 'ONRAMP');
    const swapIn  = txs.find(tx => tx.type === 'SWAP_IN'  || tx.type === 'OFFRAMP');
    logger.debug('Retrieved swap transactions', {
      swapId,
      count: txs.length,
      hasSwapOut: !!swapOut,
      hasSwapIn:  !!swapIn
    });
    return { swapOutTransaction: swapOut, swapInTransaction: swapIn, transactions: txs };
  } catch (err) {
    logger.error('Failed to get swap transactions', { swapId, error: err.stack });
    throw err;
  }
};

/**
 * Find swap by Obiex transaction ID
 */
transactionSchema.statics.findSwapByObiexId = async function(obiexTransactionId) {
  try {
    const txs = await this.find({ obiexTransactionId });
    if (txs.length === 0) {
      logger.debug('No transactions for Obiex ID', { obiexTransactionId });
      return null;
    }
    const swapOut = txs.find(tx => ['SWAP_OUT','ONRAMP'].includes(tx.type));
    const swapIn  = txs.find(tx => ['SWAP_IN','OFFRAMP'].includes(tx.type));
    logger.debug('Found transactions by Obiex ID', {
      obiexTransactionId,
      count: txs.length,
      hasSwapOut: !!swapOut,
      hasSwapIn:  !!swapIn
    });
    return {
      swapOutTransaction: swapOut,
      swapInTransaction:  swapIn,
      transactions:       txs,
      swapId:             swapOut?.swapDetails?.swapId || swapIn?.swapDetails?.swapId
    };
  } catch (err) {
    logger.error('Failed to find swap by Obiex ID', { obiexTransactionId, error: err.stack });
    throw err;
  }
};

/**
 * Paginated user transaction query
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

    const query = { userId };
    if (type) query.type   = Array.isArray(type) ? { $in: type } : type;
    if (status) query.status = Array.isArray(status) ? { $in: status } : status;
    if (currency) query.currency = currency.toUpperCase();
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate)   query.createdAt.$lte = new Date(endDate);
    }

    const skip = (page - 1) * limit;
    const sortDir = sortOrder === 'desc' ? -1 : 1;

    const [txs, count] = await Promise.all([
      this.find(query)
        .sort({ [sortBy]: sortDir })
        .skip(skip)
        .limit(limit)
        .populate('relatedTransactionId', 'type currency amount status')
        .lean(),
      this.countDocuments(query)
    ]);

    const totalPages = Math.ceil(count / limit);

    return {
      transactions: txs,
      pagination: {
        currentPage: page,
        totalPages,
        totalCount: count,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
        limit
      }
    };
  } catch (err) {
    logger.error('Failed to get user transactions', { userId, error: err.stack });
    throw err;
  }
};

/**
 * Transaction stats aggregation
 */
transactionSchema.statics.getUserTransactionStats = async function(userId, options = {}) {
  try {
    const { startDate, endDate, currency } = options;
    const match = { userId };
    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) match.createdAt.$gte = new Date(startDate);
      if (endDate)   match.createdAt.$lte = new Date(endDate);
    }
    if (currency) match.currency = currency.toUpperCase();

    const pipeline = [
      { $match: match },
      { $group: {
          _id: { type: '$type', status: '$status' },
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' }
        }
      },
      { $group: {
          _id: '$_id.type',
          statuses: {
            $push: { status: '$_id.status', count: '$count', totalAmount: '$totalAmount' }
          },
          totalCount: { $sum: '$count' },
          totalAmount: { $sum: '$totalAmount' }
        }
      }
    ];

    const stats = await this.aggregate(pipeline);
    logger.debug('Retrieved transaction stats', { userId, statsCount: stats.length });
    return stats;
  } catch (err) {
    logger.error('Failed to get transaction stats', { userId, error: err.stack });
    throw err;
  }
};

/**
 * Create a deposit transaction
 */
transactionSchema.statics.createDeposit = async function(data) {
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
    } = data;

    const deposit = new this({
      userId,
      type: 'DEPOSIT',
      currency: currency.toUpperCase(),
      amount: Math.abs(amount),
      address,
      hash,
      network,
      reference: transactionId,
      status,
      source: 'CRYPTO_WALLET',
      narration: `Deposit ${currency.toUpperCase()}`
    });

    const saved = await deposit.save();
    logger.info('Deposit transaction created', {
      userId, id: saved._id, currency, amount, status
    });
    return saved;
  } catch (err) {
    logger.error('Failed to create deposit', { userId: data.userId, error: err.stack });
    throw err;
  }
};

/**
 * Create a withdrawal transaction
 */
transactionSchema.statics.createWithdrawal = async function(data) {
  try {
    const {
      userId,
      currency,
      amount,
      address,
      network,
      fee = 0,
      status = 'PENDING'
    } = data;

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

    const saved = await withdrawal.save();
    logger.info('Withdrawal transaction created', {
      userId, id: saved._id, currency, amount, fee, status
    });
    return saved;
  } catch (err) {
    logger.error('Failed to create withdrawal', { userId: data.userId, error: err.stack });
    throw err;
  }
};

module.exports = mongoose.model('Transaction', transactionSchema);
