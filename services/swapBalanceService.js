// services/swapBalanceService.js

const User = require('../models/user');
const { getPricesWithCache } = require('./portfolio');
const onrampService = require('./onramppriceservice');
const offrampService = require('./offramppriceservice');
const logger = require('../utils/logger');

/**
 * Get price for any currency, including NGNZ
 * @param {string} currency - Currency symbol
 * @returns {Promise<number>} Price in USD
 */
async function getCurrencyPrice(currency) {
  const currencyUpper = currency.toUpperCase();
  
  if (currencyUpper === 'NGNZ') {
    // For NGNZ, we need to get the current exchange rate
    // NGNZ rate is typically NGN per USD, so we need 1/rate to get USD per NGNZ
    try {
      // Try onramp service first, fallback to offramp
      let ngnzRate;
      try {
        const onrampRate = await onrampService.getOnrampRate();
        ngnzRate = onrampRate.finalPrice;
      } catch (onrampError) {
        logger.warn('Failed to get onramp rate, trying offramp rate:', onrampError.message);
        const offrampRate = await offrampService.getCurrentRate();
        ngnzRate = offrampRate.finalPrice;
      }
      
      if (!ngnzRate || ngnzRate <= 0) {
        throw new Error('Invalid NGNZ exchange rate');
      }
      
      // NGNZ rate is NGN per USD, so 1 NGNZ = 1/rate USD
      const ngnzPriceInUSD = 1 / ngnzRate;
      
      logger.debug(`NGNZ price calculation: 1 NGNZ = $${ngnzPriceInUSD.toFixed(6)} (rate: ₦${ngnzRate}/$1)`);
      return ngnzPriceInUSD;
      
    } catch (error) {
      logger.error('Failed to get NGNZ exchange rate for balance update:', error.message);
      // Fallback to a default rate or throw error
      throw new Error(`Failed to get NGNZ exchange rate: ${error.message}`);
    }
  } else {
    // For regular cryptocurrencies, use the existing price service
    const prices = await getPricesWithCache([currency]);
    const price = prices[currencyUpper];
    
    if (!price || price <= 0) {
      throw new Error(`Price not available for ${currency}`);
    }
    
    return price;
  }
}

/**
 * Atomically deducts `fromAmount` of fromCurrency and credits `toAmount` of toCurrency
 * on the user's record, including USD equivalents. Throws if insufficient balance.
 * Now supports NGNZ operations.
 */
async function updateBalancesOnSwap(userId, fromCurrency, toCurrency, fromAmount, toAmount) {
  const fromKey    = fromCurrency.toLowerCase();
  const toKey      = toCurrency.toLowerCase();

  const fromBal    = `${fromKey}Balance`;
  const fromBalUSD = `${fromKey}BalanceUSD`;
  const toBal      = `${toKey}Balance`;
  const toBalUSD   = `${toKey}BalanceUSD`;

  try {
    // Get prices for both currencies (handles NGNZ specially)
    const [fromRate, toRate] = await Promise.all([
      getCurrencyPrice(fromCurrency),
      getCurrencyPrice(toCurrency)
    ]);

    const fromUsdDelta = fromAmount * fromRate;
    const toUsdDelta   = toAmount   * toRate;

    logger.info('Balance update calculation', {
      userId,
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount,
      fromRate,
      toRate,
      fromUsdDelta: fromUsdDelta.toFixed(6),
      toUsdDelta: toUsdDelta.toFixed(6)
    });

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
      userId, 
      fromCurrency, 
      toCurrency, 
      fromAmount, 
      toAmount,
      newFromBalance: updated[fromBal],
      newToBalance: updated[toBal],
      newFromBalanceUSD: updated[fromBalUSD]?.toFixed(6),
      newToBalanceUSD: updated[toBalUSD]?.toFixed(6)
    });

    return updated;

  } catch (error) {
    logger.error('Swap balance update failed', {
      userId,
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount,
      error: error.message
    });
    throw error;
  }
}

/**
 * Validate that user has sufficient balance for a swap
 * @param {string} userId - User ID
 * @param {string} currency - Currency to check
 * @param {number} amount - Amount needed
 * @returns {Promise<Object>} Validation result
 */
async function validateSwapBalance(userId, currency, amount) {
  try {
    const user = await User.findById(userId);
    if (!user) {
      return { success: false, message: 'User not found' };
    }

    const balanceField = `${currency.toLowerCase()}Balance`;
    const availableBalance = user[balanceField] || 0;

    if (availableBalance < amount) {
      return {
        success: false,
        message: `Insufficient ${currency} balance. Available: ${availableBalance}, Required: ${amount}`,
        availableBalance,
        requiredAmount: amount,
        currency
      };
    }

    return {
      success: true,
      availableBalance,
      currency
    };

  } catch (error) {
    logger.error('Balance validation failed', {
      userId,
      currency,
      amount,
      error: error.message
    });
    
    return {
      success: false,
      message: 'Failed to validate balance',
      error: error.message
    };
  }
}

/**
 * Get user balance for a specific currency
 * @param {string} userId - User ID
 * @param {string} currency - Currency symbol
 * @returns {Promise<Object>} Balance information
 */
async function getUserBalance(userId, currency) {
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const balanceField = `${currency.toLowerCase()}Balance`;
    const balanceUSDField = `${currency.toLowerCase()}BalanceUSD`;
    
    const balance = user[balanceField] || 0;
    const balanceUSD = user[balanceUSDField] || 0;

    return {
      success: true,
      currency: currency.toUpperCase(),
      balance,
      balanceUSD,
      lastUpdated: user.portfolioLastUpdated
    };

  } catch (error) {
    logger.error('Get user balance failed', {
      userId,
      currency,
      error: error.message
    });
    
    return {
      success: false,
      message: 'Failed to get user balance',
      error: error.message
    };
  }
}

module.exports = { 
  updateBalancesOnSwap,
  validateSwapBalance,
  getUserBalance,
  getCurrencyPrice
};