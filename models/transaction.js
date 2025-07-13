const mongoose = require('mongoose');
const portfolioService = require('../services/portfolio'); // Added import for balance updates
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
      enum: ['OBIEX', 'ONRAMP_SERVICE', 'OFFRAMP_SERVICE'],
      default: 'OBIEX'
    }
  },
  relatedTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
  metadata: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

transactionSchema.index({ transactionId: 1 }, { sparse: true });
transactionSchema.index({ obiexTransactionId: 1 }, { unique: true, sparse: true });
transactionSchema.index({ reference: 1 }, { sparse: true });
transactionSchema.index({ userId: 1, type: 1, status: 1 });
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ currency: 1, status: 1 });
transactionSchema.index({ 'swapDetails.swapId': 1 }, { sparse: true });
transactionSchema.index({ 'swapDetails.quoteId': 1 }, { sparse: true });
transactionSchema.index({ userId: 1, type: 1, 'swapDetails.swapType': 1 });
transactionSchema.index({ relatedTransactionId: 1 }, { sparse: true });

transactionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

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
    status = 'PENDING',
    obiexTransactionId = null
  } = swapData;

  const swapId = `swap_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  // Generate unique obiexTransactionId for each transaction
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

  // Create SWAP_OUT transaction (debit)
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

  // Create SWAP_IN transaction (credit)
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

  // Save both transactions in a session for atomicity
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const savedSwapOut = await swapOutTransaction.save({ session });
      const savedSwapIn = await swapInTransaction.save({ session });

      // Link transactions to each other
      savedSwapOut.relatedTransactionId = savedSwapIn._id;
      savedSwapIn.relatedTransactionId = savedSwapOut._id;

      await savedSwapOut.save({ session });
      await savedSwapIn.save({ session });

      // For crypto-to-crypto swaps, update balances if status is SUCCESSFUL
      if (swapType === 'CRYPTO_TO_CRYPTO' && status === 'SUCCESSFUL') {
        await portfolioService.updateUserBalance(userId, sourceCurrency, -Math.abs(sourceAmount), session);
        await portfolioService.updateUserBalance(userId, targetCurrency, Math.abs(targetAmount), session);
        await portfolioService.updateUserPortfolioBalance(userId, null, session);
        logger.info(`Crypto-to-crypto swap balance updated: Deducted ${sourceAmount} ${sourceCurrency}, Added ${targetAmount} ${targetCurrency}`, { userId, swapId });
      }

      return { swapOutTransaction: savedSwapOut, swapInTransaction: savedSwapIn, swapId };
    });
    return { swapOutTransaction, swapInTransaction, swapId };
  } catch (error) {
    logger.error('Failed to create swap transactions', { userId, quoteId, error: error.message });
    throw error;
  } finally {
    session.endSession();
  }
};

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

      // For crypto-to-crypto swaps, update balances when status becomes SUCCESSFUL
      if (newStatus === 'SUCCESSFUL') {
        const { swapOutTransaction, swapInTransaction } = await this.getSwapTransactions(swapId);
        if (swapOutTransaction && swapInTransaction && swapOutTransaction.swapDetails.swapType === 'CRYPTO_TO_CRYPTO') {
          const userId = swapOutTransaction.userId;
          const sourceCurrency = swapOutTransaction.currency;
          const sourceAmount = Math.abs(swapOutTransaction.amount);
          const targetCurrency = swapInTransaction.currency;
          const targetAmount = Math.abs(swapInTransaction.amount);
          
          await portfolioService.updateUserBalance(userId, sourceCurrency, -sourceAmount, session);
          await portfolioService.updateUserBalance(userId, targetCurrency, targetAmount, session);
          await portfolioService.updateUserPortfolioBalance(userId, null, session);
          logger.info(`Crypto-to-crypto swap balance updated via status change: Deducted ${sourceAmount} ${sourceCurrency}, Added ${targetAmount} ${targetCurrency}`, { userId, swapId });
        }
      }
    });
    return result;
  } catch (error) {
    logger.error('Failed to update swap status', { swapId, newStatus, error: error.message });
    throw error;
  } finally {
    session.endSession();
  }
};

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

transactionSchema.statics.findSwapByObiexId = async function(obiexTransactionId) {
  const transactions = await this.find({ obiexTransactionId });
  
  if (transactions.length === 0) {
    return null;
  }
  
  const swapOut = transactions.find(tx => ['SWAP_OUT', 'ONRAMP'].includes(tx.type));
  const swapIn = transactions.find(tx => ['SWAP_IN', 'OFFRAMP'].includes(tx.type));
  
  return {
    swapOutTransaction: swapOut,
    swapInTransaction: swapIn,
    transactions,
    swapId: swapOut?.swapDetails?.swapId || swapIn?.swapDetails?.swapId
  };
};

module.exports = mongoose.model('Transaction', transactionSchema);