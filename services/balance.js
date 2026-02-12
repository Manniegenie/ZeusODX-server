const User = require('../models/user');
const { getPricesWithCache, SUPPORTED_TOKENS } = require('./portfolio');
const logger = require('../utils/logger');

// Configuration constants
const VALIDATION_CONFIG = {
  BALANCE_PRECISION: 8,
  PRICE_PRECISION: 8,
};

/**
 * Validates if a token is supported
 * @param {string} token - Token symbol
 * @returns {boolean}
 */
function isTokenSupported(token) {
  return SUPPORTED_TOKENS.hasOwnProperty(token.toUpperCase());
}

/**
 * Gets user balance information for a specific currency
 * @param {Object} user - User document
 * @param {string} currency - Currency symbol (BTC, ETH, SOL, USDT, USDC, NGNZ)
 * @returns {Object} Balance information
 */
function getUserBalanceInfo(user, currency) {
  const currencyLower = currency.toLowerCase();
  const balanceKey = `${currencyLower}Balance`;
  const pendingBalanceKey = `${currencyLower}PendingBalance`;
  
  const currentBalance = user[balanceKey];
  const pendingBalance = user[pendingBalanceKey] || 0;
  
  // Validate balance data existence
  if (currentBalance == null || currentBalance === undefined) {
    return {
      success: false,
      message: `Balance data for ${currency} is missing. Please contact support.`,
    };
  }
  
  // Check for negative balances (data integrity issue)
  if (currentBalance < 0 || pendingBalance < 0) {
    return {
      success: false,
      message: `Balance data for ${currency} appears invalid (negative values). Please contact support.`,
    };
  }
  
  const availableBalance = Math.max(0, currentBalance - pendingBalance);
  
  return {
    success: true,
    currentBalance: parseFloat(currentBalance.toFixed(VALIDATION_CONFIG.BALANCE_PRECISION)),
    pendingBalance: parseFloat(pendingBalance.toFixed(VALIDATION_CONFIG.BALANCE_PRECISION)),
    availableBalance: parseFloat(availableBalance.toFixed(VALIDATION_CONFIG.BALANCE_PRECISION)),
  };
}

/**
 * Validates if user has sufficient balance for a transaction
 * @param {string} userId - User ID
 * @param {string} currency - Currency symbol (BTC, ETH, SOL, USDT, USDC, NGNZ)
 * @param {number} amount - Amount required in the specified currency
 * @param {Object} options - Additional validation options
 * @returns {Promise<Object>} Validation result
 */
async function validateUserBalance(userId, currency, amount, options = {}) {
  const {
    includeBalanceDetails = false,
    logValidation = true,
  } = options;

  // Input validation
  if (!userId) {
    return { success: false, message: 'User ID is required' };
  }
  
  if (!currency) {
    return { success: false, message: 'Currency is required' };
  }
  
  if (typeof amount !== 'number' || amount <= 0) {
    return { 
      success: false, 
      message: 'Invalid amount specified. Amount must be a positive number.' 
    };
  }

  try {
    const currencyUpper = currency.toUpperCase();
    
    // Validate currency support
    if (!isTokenSupported(currencyUpper)) {
      return {
        success: false,
        message: `Currency ${currencyUpper} is not supported. Supported currencies: ${Object.keys(SUPPORTED_TOKENS).join(', ')}`
      };
    }
    
    if (logValidation) {
      logger.info('Starting balance validation', {
        userId,
        currency: currencyUpper,
        amount
      });
    }

    // Fetch user data
    const user = await User.findById(userId).lean();
    if (!user) {
      return { success: false, message: 'User not found' };
    }

    // Get balance information
    const balanceInfo = getUserBalanceInfo(user, currencyUpper);
    if (!balanceInfo.success) {
      if (logValidation) {
        logger.warn('Balance validation failed - missing balance data', { 
          userId,
          currency: currencyUpper,
          reason: balanceInfo.message 
        });
      }
      return balanceInfo;
    }

    const { availableBalance, currentBalance, pendingBalance } = balanceInfo;

    // Check sufficient balance
    if (availableBalance < amount) {
      const shortfall = amount - availableBalance;
      return {
        success: false,
        message: `Insufficient balance. Required: ${amount.toFixed(VALIDATION_CONFIG.BALANCE_PRECISION)} ${currencyUpper}, Available: ${availableBalance.toFixed(VALIDATION_CONFIG.BALANCE_PRECISION)}, Shortfall: ${shortfall.toFixed(VALIDATION_CONFIG.BALANCE_PRECISION)}`,
        availableBalance,
        requiredAmount: amount,
        shortfall: parseFloat(shortfall.toFixed(VALIDATION_CONFIG.BALANCE_PRECISION)),
        currency: currencyUpper
      };
    }

    if (logValidation) {
      logger.info('Balance validation successful', {
        userId,
        currency: currencyUpper,
        amount,
        availableBalance
      });
    }

    // Prepare success response
    const response = { 
      success: true, 
      availableBalance,
      currency: currencyUpper
    };

    // Include additional balance details if requested
    if (includeBalanceDetails) {
      response.balanceDetails = {
        currentBalance,
        pendingBalance,
        availableBalance,
      };
    }

    return response;
  } catch (error) {
    logger.error('Balance validation failed due to internal error', {
      userId,
      currency,
      amount,
      error: error.message
    });
    
    return { 
      success: false, 
      message: 'Balance validation failed due to an internal error. Please try again.' 
    };
  }
}

/**
 * Gets available balance for a user and currency without extensive validation
 * @param {string} userId - User ID
 * @param {string} currency - Currency symbol
 * @returns {Promise<Object>} Balance information
 */
async function getUserAvailableBalance(userId, currency) {
  try {
    const currencyUpper = currency.toUpperCase();
    
    if (!isTokenSupported(currencyUpper)) {
      return {
        success: false,
        message: `Currency ${currencyUpper} is not supported`
      };
    }
    
    const user = await User.findById(userId).lean();
    if (!user) {
      return { success: false, message: 'User not found' };
    }

    const balanceInfo = getUserBalanceInfo(user, currencyUpper);
    if (!balanceInfo.success) {
      return balanceInfo;
    }

    return {
      success: true,
      currency: currencyUpper,
      ...balanceInfo
    };
  } catch (error) {
    logger.error('Failed to get user available balance', {
      userId,
      currency,
      error: error.message
    });
    
    return {
      success: false,
      message: 'Failed to retrieve balance information'
    };
  }
}

/**
 * Gets current price information for a currency
 * @param {string} currency - Currency symbol
 * @returns {Promise<Object>} Price information
 */
async function getCurrentPrice(currency) {
  try {
    const currencyUpper = currency.toUpperCase();
    
    if (!isTokenSupported(currencyUpper)) {
      return {
        success: false,
        message: `Currency ${currencyUpper} is not supported`
      };
    }
    
    // Special handling for NGNZ (naira-pegged stablecoin)
    if (currencyUpper === 'NGNZ') {
      // NGNZ is pegged to Naira, approximate USD value
      const ngnToUsdRate = 1 / 1554.42; // Approximate NGN to USD rate
      return {
        success: true,
        currency: currencyUpper,
        priceInUSD: parseFloat(ngnToUsdRate.toFixed(VALIDATION_CONFIG.PRICE_PRECISION)),
        isNairaPegged: true,
        timestamp: new Date().toISOString()
      };
    }
    
    const prices = await getPricesWithCache([currencyUpper]);
    const priceInUSD = prices[currencyUpper] || 0;
    
    if (!priceInUSD || priceInUSD <= 0) {
      return {
        success: false,
        message: `Unable to fetch current price for ${currencyUpper}`
      };
    }
    
    return {
      success: true,
      currency: currencyUpper,
      priceInUSD: parseFloat(priceInUSD.toFixed(VALIDATION_CONFIG.PRICE_PRECISION)),
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Failed to get current price', {
      currency,
      error: error.message
    });
    
    return {
      success: false,
      message: 'Failed to retrieve price information'
    };
  }
}

/**
 * Calculates USD value for a crypto amount using current prices
 * @param {string} currency - Currency symbol
 * @param {number} amount - Amount in cryptocurrency
 * @returns {Promise<Object>} USD value calculation result
 */
async function calculateUSDValue(currency, amount) {
  if (typeof amount !== 'number' || amount <= 0) {
    return {
      success: false,
      message: 'Invalid amount specified'
    };
  }
  
  try {
    const priceResult = await getCurrentPrice(currency);
    if (!priceResult.success) {
      return priceResult;
    }
    
    const usdValue = amount * priceResult.priceInUSD;
    
    return {
      success: true,
      currency: priceResult.currency,
      cryptoAmount: amount,
      priceInUSD: priceResult.priceInUSD,
      usdValue: parseFloat(usdValue.toFixed(2)),
      isNairaPegged: priceResult.isNairaPegged || false,
      timestamp: priceResult.timestamp
    };
  } catch (error) {
    logger.error('Failed to calculate USD value', {
      currency,
      amount,
      error: error.message
    });
    
    return {
      success: false,
      message: 'Failed to calculate USD value'
    };
  }
}

/**
 * Checks if a currency is a stablecoin
 * @param {string} currency - Currency symbol
 * @returns {boolean} True if stablecoin, false otherwise
 */
function isStablecoin(currency) {
  const upperCurrency = currency.toUpperCase();
  return SUPPORTED_TOKENS[upperCurrency]?.isStablecoin || false;
}

/**
 * Checks if a currency is NGNZ (naira-pegged stablecoin)
 * @param {string} currency - Currency symbol
 * @returns {boolean} True if NGNZ, false otherwise
 */
function isNGNZ(currency) {
  return currency.toUpperCase() === 'NGNZ';
}

module.exports = {
  validateUserBalance,
  getUserAvailableBalance,
  getCurrentPrice,
  calculateUSDValue,
  isTokenSupported,
  isStablecoin,
  isNGNZ,
  getUserBalanceInfo,
  VALIDATION_CONFIG,
};

/**
 * Gets available balance for a user and currency without extensive validation
 * @param {string} userId - User ID
 * @param {string} currency - Currency symbol
 * @returns {Promise<Object>} Balance information
 */
async function getUserAvailableBalance(userId, currency) {
  try {
    const currencyUpper = currency.toUpperCase();
    
    if (!isTokenSupported(currencyUpper)) {
      return {
        success: false,
        message: `Currency ${currencyUpper} is not supported`
      };
    }
    
    const user = await User.findById(userId).lean();
    if (!user) {
      return { success: false, message: 'User not found' };
    }

    const balanceInfo = getUserBalanceInfo(user, currencyUpper);
    if (!balanceInfo.success) {
      return balanceInfo;
    }

    return {
      success: true,
      currency: currencyUpper,
      ...balanceInfo
    };
  } catch (error) {
    logger.error('Failed to get user available balance', {
      userId,
      currency,
      error: error.message
    });
    
    return {
      success: false,
      message: 'Failed to retrieve balance information'
    };
  }
}

/**
 * Gets current price information for a currency
 * @param {string} currency - Currency symbol
 * @returns {Promise<Object>} Price information
 */
async function getCurrentPrice(currency) {
  try {
    const currencyUpper = currency.toUpperCase();
    
    if (!isTokenSupported(currencyUpper)) {
      return {
        success: false,
        message: `Currency ${currencyUpper} is not supported`
      };
    }
    
    // Special handling for NGNZ (naira-pegged stablecoin)
    if (currencyUpper === 'NGNZ') {
      // NGNZ is pegged to Naira, approximate USD value
      const ngnToUsdRate = 1 / 1554.42; // Approximate NGN to USD rate
      return {
        success: true,
        currency: currencyUpper,
        priceInUSD: parseFloat(ngnToUsdRate.toFixed(VALIDATION_CONFIG.PRICE_PRECISION)),
        isNairaPegged: true,
        timestamp: new Date().toISOString()
      };
    }
    
    const prices = await getPricesWithCache([currencyUpper]);
    const priceInUSD = prices[currencyUpper] || 0;
    
    if (!priceInUSD || priceInUSD <= 0) {
      return {
        success: false,
        message: `Unable to fetch current price for ${currencyUpper}`
      };
    }
    
    return {
      success: true,
      currency: currencyUpper,
      priceInUSD: parseFloat(priceInUSD.toFixed(VALIDATION_CONFIG.PRICE_PRECISION)),
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Failed to get current price', {
      currency,
      error: error.message
    });
    
    return {
      success: false,
      message: 'Failed to retrieve price information'
    };
  }
}

/**
 * Calculates USD value for a crypto amount using current prices
 * @param {string} currency - Currency symbol
 * @param {number} amount - Amount in cryptocurrency
 * @returns {Promise<Object>} USD value calculation result
 */
async function calculateUSDValue(currency, amount) {
  if (typeof amount !== 'number' || amount <= 0) {
    return {
      success: false,
      message: 'Invalid amount specified'
    };
  }
  
  try {
    const priceResult = await getCurrentPrice(currency);
    if (!priceResult.success) {
      return priceResult;
    }
    
    const usdValue = amount * priceResult.priceInUSD;
    
    return {
      success: true,
      currency: priceResult.currency,
      cryptoAmount: amount,
      priceInUSD: priceResult.priceInUSD,
      usdValue: parseFloat(usdValue.toFixed(2)),
      isNairaPegged: priceResult.isNairaPegged || false,
      timestamp: priceResult.timestamp
    };
  } catch (error) {
    logger.error('Failed to calculate USD value', {
      currency,
      amount,
      error: error.message
    });
    
    return {
      success: false,
      message: 'Failed to calculate USD value'
    };
  }
}

/**
 * Checks if a currency is a stablecoin
 * @param {string} currency - Currency symbol
 * @returns {boolean} True if stablecoin, false otherwise
 */
function isStablecoin(currency) {
  const upperCurrency = currency.toUpperCase();
  return SUPPORTED_TOKENS[upperCurrency]?.isStablecoin || false;
}

/**
 * Checks if a currency is NGNZ (naira-pegged stablecoin)
 * @param {string} currency - Currency symbol
 * @returns {boolean} True if NGNZ, false otherwise
 */
function isNGNZ(currency) {
  return currency.toUpperCase() === 'NGNZ';
}

module.exports = {
  validateUserBalance,
  getUserAvailableBalance,
  getCurrentPrice,
  calculateUSDValue,
  isTokenSupported,
  isStablecoin,
  isNGNZ,
  getUserBalanceInfo,
  VALIDATION_CONFIG,
};