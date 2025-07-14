// services/swapBalanceService.js

const User = require('../models/user');
const { getPricesWithCache } = require('./portfolio');
const logger = require('../utils/logger');

/**
 * Atomically deducts `fromAmount` of fromCurrency and credits `toAmount` of toCurrency
 * on the user's record, including USD equivalents. Throws if insufficient balance.
 */
async function updateBalancesOnSwap(userId, fromCurrency, toCurrency, fromAmount, toAmount) {
  const fromKey    = fromCurrency.toLowerCase();
  const toKey      = toCurrency.toLowerCase();

  const fromBal    = `${fromKey}Balance`;
  const fromBalUSD = `${fromKey}BalanceUSD`;
  const toBal      = `${toKey}Balance`;
  const toBalUSD   = `${toKey}BalanceUSD`;

  // fetch up‐to‐date USD prices
  const prices   = await getPricesWithCache([fromCurrency, toCurrency]);
  const fromRate = prices[fromCurrency] || 0;
  const toRate   = prices[toCurrency]   || 0;

  const fromUsdDelta = fromAmount * fromRate;
  const toUsdDelta   = toAmount   * toRate;

  const conditions = {
    _id: userId,
    [fromBal]: { $gte: fromAmount }
  };

  const update = {
    $inc: {
      [fromBal]:    -fromAmount,
      [fromBalUSD]: -fromUsdDelta,
      [toBal]:       toAmount,
      [toBalUSD]:    toUsdDelta
    },
    $set: { portfolioLastUpdated: new Date() }
  };

  const options = { new: true, runValidators: true };

  const updated = await User.findOneAndUpdate(conditions, update, options);
  if (!updated) {
    throw new Error(`Insufficient ${fromCurrency} balance to perform swap`);
  }

  logger.info('Swap balance update successful', {
    userId, fromCurrency, toCurrency, fromAmount, toAmount,
    newFromBalance: updated[fromBal],
    newToBalance:   updated[toBal]
  });

  return updated;
}

module.exports = { updateBalancesOnSwap };
