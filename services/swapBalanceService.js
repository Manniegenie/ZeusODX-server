// services/swapBalanceService.js

const mongoose = require('mongoose');
const User = require('../models/user');
const Transaction = require('../models/transaction');
const { getPricesWithCache } = require('./portfolio');
const logger = require('../utils/logger');

/**
 * Get USD price for any currency (crypto or NGNZ)
 */
async function getCurrencyPrice(currency) {
  const uc = currency.toUpperCase();
  if (uc === 'NGNZ') {
    // NGNZ pegged logic
    const { getOnrampRate } = require('./onramppriceservice');
    const { getCurrentRate } = require('./offramppriceservice');
    let rate;
    try {
      rate = (await getOnrampRate()).finalPrice;
    } catch {
      rate = (await getCurrentRate()).finalPrice;
    }
    return 1 / rate; 
  }
  const prices = await getPricesWithCache([uc]);
  if (!prices[uc] || prices[uc] <= 0) {
    throw new Error(`No price for ${uc}`);
  }
  return prices[uc];
}

/**
 * Create swap transaction records
 */
async function createSwapTransactions({
  userId,
  fromCurrency,
  toCurrency,
  fromAmount,
  toAmount,
  swapType,
  session
}) {
  // Generate a unique reference for this swap pair
  const swapReference = `SWAP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Create the outgoing transaction (debit)
  const swapOutTransaction = new Transaction({
    userId,
    type: 'SWAP',
    currency: fromCurrency,
    amount: -fromAmount, // Negative for outgoing
    status: 'SUCCESSFUL',
    source: 'INTERNAL',
    fromCurrency,
    toCurrency,
    fromAmount,
    toAmount,
    swapType,
    reference: swapReference,
    narration: `Swap ${fromAmount} ${fromCurrency} to ${toAmount} ${toCurrency}`,
    completedAt: new Date(),
    metadata: {
      swapDirection: 'OUT',
      exchangeRate: toAmount / fromAmount,
      relatedTransactionRef: swapReference
    }
  });

  // Create the incoming transaction (credit)
  const swapInTransaction = new Transaction({
    userId,
    type: 'SWAP',
    currency: toCurrency,
    amount: toAmount, // Positive for incoming
    status: 'SUCCESSFUL',
    source: 'INTERNAL',
    fromCurrency,
    toCurrency,
    fromAmount,
    toAmount,
    swapType,
    reference: swapReference,
    narration: `Swap ${fromAmount} ${fromCurrency} to ${toAmount} ${toCurrency}`,
    completedAt: new Date(),
    metadata: {
      swapDirection: 'IN',
      exchangeRate: toAmount / fromAmount,
      relatedTransactionRef: swapReference
    }
  });

  // Save both transactions
  await swapOutTransaction.save({ session });
  await swapInTransaction.save({ session });

  return {
    swapOutTransaction,
    swapInTransaction,
    swapId: swapReference
  };
}

/**
 * updateBalancesOnSwap(userId, fromCurrency, toCurrency, fromAmount, toAmount)
 *
 *  - Creates a SWAP transaction pair
 *  - Adjusts on‑chain balances atomically
 *  - Throws on insufficient balance or DB errors
 */
async function updateBalancesOnSwap(userId, fromCurrency, toCurrency, fromAmount, toAmount) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const u = await User.findById(userId).session(session);
    if (!u) throw new Error('User not found');

    const fromKey = fromCurrency.toLowerCase() + 'Balance';
    const toKey   = toCurrency.toLowerCase()   + 'Balance';

    // check balance
    if ((u[fromKey] || 0) < fromAmount) {
      throw new Error(`Insufficient ${fromCurrency} balance`);
    }

    // prices for USD‐fields
    const [fromPrice, toPrice] = await Promise.all([
      getCurrencyPrice(fromCurrency),
      getCurrencyPrice(toCurrency)
    ]);
    const fromUsdDelta = fromAmount * fromPrice;
    const toUsdDelta   = toAmount   * toPrice;

    // Determine swap type based on currencies
    let swapType;
    if (fromCurrency.toUpperCase() === 'NGNZ') {
      swapType = 'onramp'; // NGNZ to crypto
    } else if (toCurrency.toUpperCase() === 'NGNZ') {
      swapType = 'offramp'; // crypto to NGNZ
    } else {
      swapType = 'crypto_to_crypto'; // crypto to crypto
    }

    // 1) create swap transactions
    const { swapOutTransaction, swapInTransaction, swapId } =
      await createSwapTransactions({
        userId,
        fromCurrency,
        toCurrency,
        fromAmount,
        toAmount,
        swapType,
        session
      });

    // 2) adjust balances
    const res = await User.findOneAndUpdate(
      { _id: userId, [fromKey]: { $gte: fromAmount } },
      {
        $inc: {
          [fromKey]:              -fromAmount,
          [toKey]:                 toAmount,
          [`${fromCurrency.toLowerCase()}BalanceUSD`]: -fromUsdDelta,
          [`${toCurrency.toLowerCase()}BalanceUSD`]:    toUsdDelta
        },
        $set: { portfolioLastUpdated: new Date() }
      },
      { new: true, runValidators: true, session }
    );
    if (!res) throw new Error('Balance update failed - insufficient balance or user not found');

    await session.commitTransaction();
    session.endSession();

    logger.info('Swap complete', {
      userId, 
      swapId,
      fromCurrency, 
      toCurrency, 
      fromAmount, 
      toAmount,
      swapOutTransactionId: swapOutTransaction._id,
      swapInTransactionId: swapInTransaction._id
    });

    return {
      user: res,
      swapOutTransaction,
      swapInTransaction,
      swapId
    };

  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    logger.error('Swap balance service failed', { 
      error: err.message,
      stack: err.stack,
      userId,
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount
    });
    throw err;
  }
}

module.exports = {
  updateBalancesOnSwap,
  getCurrencyPrice
};