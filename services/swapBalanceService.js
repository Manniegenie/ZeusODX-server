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
 * updateBalancesOnSwap(userId, fromCurrency, toCurrency, fromAmount, toAmount)
 *
 *  - Creates a SWAP_OUT / SWAP_IN pair in transactions
 *  - Adjusts on‑chain balances atomically
 *  - Throws on insufficent balance or DB errors
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

    // 1) create swap transactions
    const { swapOutTransaction, swapInTransaction, swapId } =
      await Transaction.createSwapTransactions({
        userId,
        quoteId:        null,
        sourceCurrency: fromCurrency,
        targetCurrency: toCurrency,
        sourceAmount:   fromAmount,
        targetAmount:   toAmount,
        exchangeRate:   toAmount / fromAmount,
        swapType:       (fromCurrency === 'NGNZ' || toCurrency === 'NGNZ')
                        ? (fromCurrency === 'NGNZ' ? 'ONRAMP' : 'OFFRAMP')
                        : 'CRYPTO_TO_CRYPTO',
        provider:       'INTERNAL_EXCHANGE',
        markdownApplied: 0,
        swapFee:         0,
        quoteExpiresAt:  null,
        status:         'SUCCESSFUL'
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
    if (!res) throw new Error('Balance update failed');

    await session.commitTransaction();
    session.endSession();

    logger.info('Swap complete', {
      userId, swapId,
      fromCurrency, toCurrency, fromAmount, toAmount
    });

    return res;

  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    logger.error('Swap balance service failed', { error: err.stack });
    throw err;
  }
}

module.exports = {
  updateBalancesOnSwap,
  getCurrencyPrice
};
