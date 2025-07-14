const express = require('express');
const router = express.Router();

const User = require('../models/user');
const Transaction = require('../models/transaction');
const { getPricesWithCache, SUPPORTED_TOKENS, updateUserBalance } = require('../services/portfolio');

// Import only used functions from offramp service
const { 
  calculateNairaFromCrypto,
  getCurrentRate
} = require('../services/offramppriceservice');

// Import only used functions from onramp service
const { 
  calculateCryptoFromNaira,
  getOnrampRate
} = require('../services/onramppriceservice');

// NGNZ swap cache for quotes
const ngnzQuoteCache = new Map();

// Import NGNB rate models for naira USD value calculation
const NairaMarkdown = require('../models/offramp'); // For offramp (buy NGNB)
const NairaMarkup = require('../models/onramp');     // For onramp (sell NGNB)

const logger = require('../utils/logger');

// Swap configuration constants
const SWAP_CONFIG = {
  MAX_PENDING_SWAPS: 3,
  DUPLICATE_CHECK_WINDOW: 5 * 60 * 1000, // 5 minutes
  AMOUNT_PRECISION: 8,
  MAX_DECIMAL_PLACES: 8 // Maximum decimal places allowed
  // Removed MAX_USD_VALUE - no limits on swap amounts
};

/**
 * Detects if a swap involves NGNZ
 * @param {string} fromCurrency - Source currency
 * @param {string} toCurrency - Destination currency
 * @returns {Object} NGNZ swap detection result
 */
function detectNGNZSwap(fromCurrency, toCurrency) {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  
  const isNGNZSwap = from === 'NGNZ' || to === 'NGNZ';
  
  if (!isNGNZSwap) {
    return { isNGNZSwap: false };
  }
  
  const isOnramp = from === 'NGNZ'; // NGNZ to crypto
  const isOfframp = to === 'NGNZ';  // crypto to NGNZ
  
  return {
    isNGNZSwap: true,
    isOnramp,
    isOfframp,
    cryptoCurrency: isOnramp ? to : from,
    ngnzAmount: isOnramp ? 'fromAmount' : 'toAmount',
    cryptoAmount: isOnramp ? 'toAmount' : 'fromAmount'
  };
}

/**
 * Calculates NGNZ swap rates using portfolio.js and offramp/onramp services
 * @param {Object} swapData - Swap parameters
 * @returns {Promise<Object>} NGNZ calculation result
 */
async function calculateNGNZSwapRates(swapData) {
  const { fromCurrency, toCurrency, amount, swapType } = swapData;
  
  try {
    const ngnzDetection = detectNGNZSwap(fromCurrency, toCurrency);
    
    if (!ngnzDetection.isNGNZSwap) {
      throw new Error('Not an NGNZ swap');
    }
    
    const { isOnramp, isOfframp, cryptoCurrency } = ngnzDetection;
    
    let result = {};
    
    if (isOfframp) {
      // Crypto to NGNZ
      logger.info('Processing NGNZ offramp calculation', {
        cryptoCurrency,
        payAmount: amount
      });
      
      // Get crypto price in USD using portfolio.js
      const prices = await getPricesWithCache([cryptoCurrency]);
      const cryptoPrice = prices[cryptoCurrency];
      
      if (!cryptoPrice || cryptoPrice <= 0) {
        throw new Error(`Unable to fetch current price for ${cryptoCurrency}`);
      }
      
      // Get offramp rate (USD to NGNZ rate)
      const offrampRate = await getCurrentRate();
      if (!offrampRate || !offrampRate.finalPrice) {
        throw new Error('Unable to get current offramp rate');
      }
      
      // Calculate: crypto amount * crypto USD price * offramp rate = NGNZ amount
      const cryptoUsdValue = amount * cryptoPrice;
      const ngnzAmount = cryptoUsdValue * offrampRate.finalPrice;
      
      result = {
        fromAmount: amount,
        toAmount: parseFloat(ngnzAmount.toFixed(2)),
        cryptoPrice,
        exchangeRate: offrampRate,
        usdValue: parseFloat(cryptoUsdValue.toFixed(2)),
        ngnzInvolved: {
          amount: parseFloat(ngnzAmount.toFixed(2)),
          usdValue: parseFloat(cryptoUsdValue.toFixed(2)),
          currency: 'NGNZ',
          role: 'destination',
          rate: {
            usdToNgnzRate: offrampRate.finalPrice,
            ngnzToUsdRate: parseFloat((1 / offrampRate.finalPrice).toFixed(8)),
            rateType: 'offramp',
            lastUpdated: new Date()
          }
        },
        cryptoInvolved: {
          amount: amount,
          usdValue: parseFloat(cryptoUsdValue.toFixed(2)),
          currency: cryptoCurrency,
          role: 'source',
          price: parseFloat(cryptoPrice.toFixed(2))
        }
      };
      
      logger.info('NGNZ offramp calculation completed', {
        payAmount: amount,
        receiveAmount: ngnzAmount,
        cryptoPrice,
        offrampRate: offrampRate.finalPrice,
        cryptoUsdValue
      });
      
    } else if (isOnramp) {
      // NGNZ to Crypto
      logger.info('Processing NGNZ onramp calculation', {
        cryptoCurrency,
        ngnzAmount: amount
      });
      
      // Get crypto price in USD using portfolio.js
      const prices = await getPricesWithCache([cryptoCurrency]);
      const cryptoPrice = prices[cryptoCurrency];
      
      if (!cryptoPrice || cryptoPrice <= 0) {
        throw new Error(`Unable to fetch current price for ${cryptoCurrency}`);
      }
      
      // Get onramp rate (NGNZ to USD rate)
      const onrampRate = await getOnrampRate();
      if (!onrampRate || !onrampRate.finalPrice) {
        throw new Error('Unable to get current onramp rate');
      }
      
      // Calculate: NGNZ amount / onramp rate = USD value, then USD value / crypto price = crypto amount
      const usdValue = amount / onrampRate.finalPrice;
      const cryptoAmount = usdValue / cryptoPrice;
      
      result = {
        fromAmount: amount,
        toAmount: parseFloat(cryptoAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
        cryptoPrice,
        exchangeRate: onrampRate,
        usdValue: parseFloat(usdValue.toFixed(2)),
        ngnzInvolved: {
          amount: amount,
          usdValue: parseFloat(usdValue.toFixed(2)),
          currency: 'NGNZ',
          role: 'source',
          rate: {
            ngnzToUsdRate: parseFloat((1 / onrampRate.finalPrice).toFixed(8)),
            usdToNgnzRate: onrampRate.finalPrice,
            rateType: 'onramp',
            lastUpdated: new Date()
          }
        },
        cryptoInvolved: {
          amount: parseFloat(cryptoAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
          usdValue: parseFloat(usdValue.toFixed(2)),
          currency: cryptoCurrency,
          role: 'destination',
          price: parseFloat(cryptoPrice.toFixed(2))
        }
      };
      
      logger.info('NGNZ onramp calculation completed', {
        ngnzAmount: amount,
        receiveAmount: cryptoAmount,
        cryptoPrice,
        onrampRate: onrampRate.finalPrice,
        usdValue
      });
    }
    
    return {
      success: true,
      data: result,
      isNGNZSwap: true
    };
    
  } catch (error) {
    logger.error('Error calculating NGNZ swap rates', { swapData, error: error.message });
    return {
      success: false,
      message: error.message,
      isNGNZSwap: true
    };
  }
}

/**
 * Processes NGNZ balance updates using portfolio.js service
 * @param {Object} swapData - Swap parameters
 * @returns {Promise<Object>} Processing result
 */
async function processNGNZSwapBalances(swapData) {
  const { userId, fromCurrency, toCurrency, fromAmount, toAmount, transactionId } = swapData;

  try {
    // Validate user exists
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found for NGNZ balance update');
    }

    // For NGNZ swaps, we need to handle balance field mapping
    const getBalanceField = (currency) => {
      const currencyLower = currency.toLowerCase();
      return `${currencyLower}Balance`;
    };

    // Check current balance before processing
    const fromBalanceField = getBalanceField(fromCurrency);
    const currentFromBalance = user[fromBalanceField] || 0;
    
    if (currentFromBalance < fromAmount) {
      throw new Error(`Insufficient ${fromCurrency} balance. Available: ${currentFromBalance}, Required: ${fromAmount}`);
    }

    logger.info('Processing NGNZ swap balances using portfolio service', {
      userId,
      transactionId,
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount,
      currentFromBalance
    });

    // Step 1: Debit the source currency
    // For NGNZ, we still use the portfolio service for supported tokens
    // For unsupported tokens like NGNZ, we'll handle manually
    if (SUPPORTED_TOKENS[fromCurrency.toUpperCase()]) {
      await updateUserBalance(userId, fromCurrency, -fromAmount);
    } else {
      // Manual NGNZ balance update
      await User.findByIdAndUpdate(
        userId,
        { 
          $inc: { [fromBalanceField]: -fromAmount },
          $set: { lastBalanceUpdate: new Date() }
        }
      );
    }
    
    logger.info('Successfully debited source currency for NGNZ swap', {
      userId,
      currency: fromCurrency,
      amount: -fromAmount,
      transactionId
    });

    // Step 2: Credit the destination currency
    if (SUPPORTED_TOKENS[toCurrency.toUpperCase()]) {
      await updateUserBalance(userId, toCurrency, toAmount);
    } else {
      // Manual NGNZ balance update
      const toBalanceField = getBalanceField(toCurrency);
      await User.findByIdAndUpdate(
        userId,
        { 
          $inc: { [toBalanceField]: toAmount },
          $set: { lastBalanceUpdate: new Date() }
        }
      );
    }
    
    logger.info('Successfully credited destination currency for NGNZ swap', {
      userId,
      currency: toCurrency,
      amount: toAmount,
      transactionId
    });

    // Get updated user data to return current balances
    const updatedUser = await User.findById(userId);
    const toBalanceField = getBalanceField(toCurrency);

    logger.info('NGNZ swap balances processed successfully', {
      userId,
      transactionId,
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount,
      newFromBalance: updatedUser[fromBalanceField],
      newToBalance: updatedUser[toBalanceField],
      totalPortfolioBalance: updatedUser.totalPortfolioBalance
    });

    return { 
      success: true,
      balances: {
        [fromCurrency]: updatedUser[fromBalanceField],
        [toCurrency]: updatedUser[toBalanceField]
      },
      totalPortfolioBalance: updatedUser.totalPortfolioBalance
    };

  } catch (error) {
    logger.error('Failed to process NGNZ swap balances', { 
      swapData, 
      error: error.message,
      stack: error.stack 
    });
    throw error;
  }
}

/**
 * Helper function to count decimal places in a string representation
 * @param {string} value - String representation of number to check
 * @returns {number} Number of decimal places
 */
function countDecimalPlaces(value) {
  // Convert to string if not already
  const str = String(value).trim();
  
  // Check for scientific notation
  if (str.includes('e') || str.includes('E')) {
    // Handle scientific notation (e.g., "1e-8" or "1.23e-5")
    const parts = str.toLowerCase().split('e');
    if (parts.length === 2) {
      const exponent = parseInt(parts[1], 10);
      const basePart = parts[0];
      
      if (exponent < 0) {
        // Negative exponent means decimal places
        const baseDecimals = basePart.includes('.') ? basePart.split('.')[1].length : 0;
        return Math.abs(exponent) + baseDecimals;
      } else {
        // Positive exponent might eliminate decimal places
        const baseDecimals = basePart.includes('.') ? basePart.split('.')[1].length : 0;
        return Math.max(0, baseDecimals - exponent);
      }
    }
  }
  
  // Handle normal decimal notation
  if (str.includes('.')) {
    return str.split('.')[1].length;
  }
  
  // No decimal point means 0 decimal places
  return 0;
}

/**
 * Validates user balance for swap
 * @param {string} userId - User ID
 * @param {string} currency - Currency to check
 * @param {number} amount - Amount to validate
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Validation result
 */
async function validateUserBalance(userId, currency, amount, options = {}) {
  try {
    const user = await User.findById(userId);
    if (!user) {
      return {
        success: false,
        message: 'User not found'
      };
    }

    // Helper function to get balance field name
    const getBalanceField = (curr) => {
      const currencyLower = curr.toLowerCase();
      return `${currencyLower}Balance`;
    };

    const balanceField = getBalanceField(currency);
    const availableBalance = user[balanceField] || 0;

    if (availableBalance < amount) {
      return {
        success: false,
        message: `Insufficient ${currency} balance. Available: ${availableBalance}, Required: ${amount}`,
        availableBalance: availableBalance
      };
    }

    return {
      success: true,
      availableBalance: availableBalance
    };

  } catch (error) {
    logger.error('Error validating user balance', {
      userId,
      currency,
      amount,
      error: error.message
    });
    return {
      success: false,
      message: 'Failed to validate balance'
    };
  }
}

/**
 * Gets the NGNB to USD rate for calculating naira dollar value
 * @param {string} swapType - "offramp" or "onramp"
 * @returns {Promise<Object>} Rate data
 */
async function getNairaUSDRate(swapType) {
  try {
    let rateData;
    let rateType;
    let effectiveRate;

    if (swapType === 'offramp') {
      // Offramp (crypto to NGNB) - use NairaMarkdown
      rateData = await NairaMarkdown.findOne().sort({ createdAt: -1 });
      rateType = 'offramp';
      effectiveRate = rateData?.offrampRate;
    } else {
      // Onramp (NGNB to crypto) - use NairaMarkup  
      rateData = await NairaMarkup.findOne().sort({ createdAt: -1 });
      rateType = 'onramp';
      effectiveRate = rateData?.onrampRate;
    }

    if (!rateData || !effectiveRate || effectiveRate <= 0) {
      throw new Error(`No valid ${rateType} rate found for naira USD conversion`);
    }

    // NGNB to USD conversion (1 USD = effectiveRate NGNB)
    const ngnbToUsdRate = 1 / effectiveRate;

    return {
      success: true,
      data: {
        ngnbToUsdRate: parseFloat(ngnbToUsdRate.toFixed(8)),
        usdToNgnbRate: parseFloat(effectiveRate.toFixed(2)),
        rateType,
        lastUpdated: rateData.updatedAt
      }
    };

  } catch (error) {
    logger.error('Error fetching naira USD rate for swap', {
      swapType,
      error: error.message
    });
    
    return {
      success: false,
      message: error.message
    };
  }
}

/**
 * Calculates USD value for swap (for tracking purposes only - no limits enforced)
 * @param {Object} swapData - Swap parameters
 * @param {number} cryptoPrice - Current crypto price (for offramp)
 * @param {Object} exchangeRate - Exchange rate object (for onramp)
 * @returns {Object} USD calculation result
 */
function calculateUSDValue(swapData, cryptoPrice = null, exchangeRate = null) {
  const { fromCurrency, toCurrency, amount, swapType } = swapData;

  try {
    let usdValue = 0;

    if (swapType === 'onramp') {
      // NGNB to Crypto: Convert NGNB amount to USD
      if (!exchangeRate || !exchangeRate.finalPrice) {
        throw new Error('Exchange rate required for onramp USD calculation');
      }
      usdValue = amount / exchangeRate.finalPrice;
    } else if (swapType === 'offramp') {
      // Crypto to NGNB: Convert crypto amount to USD
      if (!cryptoPrice || cryptoPrice <= 0) {
        throw new Error('Crypto price required for offramp USD calculation');
      }
      usdValue = amount * cryptoPrice;
    }

    logger.debug('USD value calculation', {
      swapType,
      amount,
      cryptoPrice,
      exchangeRate: exchangeRate?.finalPrice,
      calculatedUSDValue: usdValue
    });

    return {
      success: true,
      usdValue: parseFloat(usdValue.toFixed(2))
    };

  } catch (error) {
    logger.error('USD value calculation error', { 
      swapData, 
      error: error.message 
    });
    return {
      success: false,
      message: `Failed to calculate USD value: ${error.message}`,
      usdValue: 0
    };
  }
}

/**
 * Validates swap request parameters with frontend compatibility
 * @param {Object} body - Request body
 * @returns {Object} Validation result
 */
function validateSwapRequest(body) {
  // Support both frontend formats:
  // Frontend: { from, to, amount, side }
  // Backend: { fromCurrency, toCurrency, amount, swapType }
  
  const fromCurrency = body.fromCurrency || body.from;
  const toCurrency = body.toCurrency || body.to;
  const amount = body.amount;
  let swapType = body.swapType;
  
  // Map frontend 'side' to backend 'swapType' if needed
  if (!swapType && body.side) {
    // For frontend compatibility: side 'SELL' means selling crypto (offramp), 'BUY' means buying crypto (onramp)
    if (body.side === 'SELL') {
      // Selling means from crypto to fiat (offramp) or from high value to low value
      // We'll determine this based on currencies below
    } else if (body.side === 'BUY') {
      // Buying means from fiat to crypto (onramp) or from low value to high value  
      // We'll determine this based on currencies below
    }
  }

  const errors = [];

  // Helper function to safely convert to string and trim
  const safeStringTrim = (value) => {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  };

  // Convert values to strings safely
  const fromCurrencyStr = safeStringTrim(fromCurrency);
  const toCurrencyStr = safeStringTrim(toCurrency);

  // Required fields validation
  if (!fromCurrencyStr) {
    errors.push('From currency is required');
  }
  if (!toCurrencyStr) {
    errors.push('To currency is required');
  }
  if (!amount && amount !== 0) {
    errors.push('Swap amount is required');
  }

  // Convert amount to string for validation
  const amountStr = String(amount).trim();
  
  // Validate amount format using regex (allows integers and decimals)
  const amountRegex = /^(\d+\.?\d*|\.\d+)$/;
  if (!amountRegex.test(amountStr)) {
    errors.push('Invalid swap amount format. Amount must be a positive number.');
  } else {
    // Check decimal places on the original string representation
    const decimalPlaces = countDecimalPlaces(amountStr);
    if (decimalPlaces > SWAP_CONFIG.MAX_DECIMAL_PLACES) {
      errors.push(`Amount cannot have more than ${SWAP_CONFIG.MAX_DECIMAL_PLACES} decimal places.`);
    }

    // Convert to number and validate value
    const numericAmount = parseFloat(amountStr);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      errors.push('Invalid swap amount. Amount must be a positive number.');
    }
  }

  // Currency validation
  const upperFromCurrency = fromCurrencyStr.toUpperCase();
  const upperToCurrency = toCurrencyStr.toUpperCase();

  // Check for NGNZ swaps - auto-detect swap type
  const ngnzDetection = detectNGNZSwap(upperFromCurrency, upperToCurrency);
  let finalSwapType = swapType;
  
  if (ngnzDetection.isNGNZSwap) {
    // For NGNZ swaps, auto-detect swap type
    finalSwapType = ngnzDetection.isOnramp ? 'onramp' : 'offramp';
    
    // NGNZ swap validation
    if (ngnzDetection.isOnramp) {
      // NGNZ to crypto
      if (upperFromCurrency !== 'NGNZ') {
        errors.push('For NGNZ onramp swaps, from currency must be NGNZ');
      }
      if (upperToCurrency === 'NGNZ' || !SUPPORTED_TOKENS[upperToCurrency]) {
        errors.push(`For NGNZ onramp swaps, to currency must be a supported crypto: ${Object.keys(SUPPORTED_TOKENS).join(', ')}`);
      }
    } else if (ngnzDetection.isOfframp) {
      // crypto to NGNZ
      if (upperToCurrency !== 'NGNZ') {
        errors.push('For NGNZ offramp swaps, to currency must be NGNZ');
      }
      if (upperFromCurrency === 'NGNZ' || !SUPPORTED_TOKENS[upperFromCurrency]) {
        errors.push(`For NGNZ offramp swaps, from currency must be a supported crypto: ${Object.keys(SUPPORTED_TOKENS).join(', ')}`);
      }
    }
  } else {
    // Check if this is an NGNB swap
    const isNGNBSwap = upperFromCurrency === 'NGNB' || upperToCurrency === 'NGNB';
    
    if (isNGNBSwap) {
      // NGNB swap - auto-detect swap type if not provided
      if (!finalSwapType) {
        finalSwapType = upperFromCurrency === 'NGNB' ? 'onramp' : 'offramp';
      }
      
      // NGNB swap validation
      if (finalSwapType === 'onramp') {
        if (upperFromCurrency !== 'NGNB') {
          errors.push('For onramp swaps, from currency must be NGNB');
        }
        if (upperToCurrency === 'NGNB' || !SUPPORTED_TOKENS[upperToCurrency]) {
          errors.push(`For onramp swaps, to currency must be a supported crypto: ${Object.keys(SUPPORTED_TOKENS).join(', ')}`);
        }
      } else if (finalSwapType === 'offramp') {
        if (upperToCurrency !== 'NGNB') {
          errors.push('For offramp swaps, to currency must be NGNB');
        }
        if (upperFromCurrency === 'NGNB' || !SUPPORTED_TOKENS[upperFromCurrency]) {
          errors.push(`For offramp swaps, from currency must be a supported crypto: ${Object.keys(SUPPORTED_TOKENS).join(', ')}`);
        }
      }
    } else {
      // Crypto to crypto swap - determine swap type based on side if provided
      if (body.side === 'SELL') {
        // For crypto-to-crypto, we'll default to treating the first crypto as being "sold"
        // This is a simple crypto-to-crypto swap, but we still need a swap type
        // We'll default to 'offramp' for crypto-to-crypto SELL operations
        finalSwapType = 'offramp';
      } else if (body.side === 'BUY') {
        finalSwapType = 'onramp'; 
      } else {
        errors.push('Swap type is required (onramp/offramp) for non-NGNB/NGNZ swaps');
      }
      
      // Validate both currencies are supported for crypto-to-crypto
      if (!SUPPORTED_TOKENS[upperFromCurrency]) {
        errors.push(`Unsupported from currency: ${upperFromCurrency}. Supported: ${Object.keys(SUPPORTED_TOKENS).join(', ')}`);
      }
      if (!SUPPORTED_TOKENS[upperToCurrency]) {
        errors.push(`Unsupported to currency: ${upperToCurrency}. Supported: ${Object.keys(SUPPORTED_TOKENS).join(', ')}`);
      }
    }
  }

  // Same currency check
  if (upperFromCurrency === upperToCurrency) {
    errors.push('From and to currencies cannot be the same');
  }

  if (errors.length > 0) {
    return {
      success: false,
      errors,
      message: errors.join('; ')
    };
  }

  // Parse the final numeric amount
  const finalAmount = parseFloat(amountStr);

  return {
    success: true,
    validatedData: {
      fromCurrency: upperFromCurrency,
      toCurrency: upperToCurrency,
      amount: finalAmount,
      swapType: finalSwapType
    }
  };
}

/**
 * Checks for duplicate pending swaps
 * @param {string} userId - User ID
 * @param {string} fromCurrency - From currency
 * @param {string} toCurrency - To currency
 * @param {number} amount - Amount
 * @returns {Promise<Object>} Check result
 */
async function checkDuplicateSwap(userId, fromCurrency, toCurrency, amount) {
  try {
    const checkTime = new Date(Date.now() - SWAP_CONFIG.DUPLICATE_CHECK_WINDOW);
    
    const existingTransaction = await Transaction.findOne({
      userId,
      type: 'SWAP', // Updated to use 'SWAP' type
      fromCurrency,
      toCurrency,
      fromAmount: amount, // Use fromAmount field instead of amount
      status: { $in: ['PENDING', 'PROCESSING'] },
      createdAt: { $gte: checkTime }
    });

    if (existingTransaction) {
      return {
        isDuplicate: true,
        message: `A similar swap request is already pending. Transaction ID: ${existingTransaction._id}`,
        existingTransactionId: existingTransaction._id
      };
    }

    // Check for too many pending swaps
    const pendingCount = await Transaction.countDocuments({
      userId,
      type: 'SWAP', // Updated to use 'SWAP' type
      status: { $in: ['PENDING', 'PROCESSING'] }
    });

    if (pendingCount >= SWAP_CONFIG.MAX_PENDING_SWAPS) {
      return {
        isDuplicate: true,
        message: `Too many pending swaps. Maximum allowed: ${SWAP_CONFIG.MAX_PENDING_SWAPS}`,
        pendingCount
      };
    }

    return { isDuplicate: false };
  } catch (error) {
    logger.error('Error checking duplicate swap', { userId, error: error.message });
    throw new Error('Failed to validate swap request');
  }
}

/**
 * Calculates crypto-to-crypto swap rates using portfolio.js
 * @param {Object} swapData - Swap parameters
 * @returns {Promise<Object>} Crypto-to-crypto calculation result
 */
async function calculateCryptoToCryptoRates(swapData) {
  const { fromCurrency, toCurrency, amount } = swapData;
  
  try {
    logger.info('Processing crypto-to-crypto swap calculation', {
      fromCurrency,
      toCurrency,
      amount
    });
    
    // Get crypto prices in USD using portfolio.js
    const prices = await getPricesWithCache([fromCurrency, toCurrency]);
    const fromPrice = prices[fromCurrency];
    const toPrice = prices[toCurrency];
    
    if (!fromPrice || fromPrice <= 0) {
      throw new Error(`Unable to fetch current price for ${fromCurrency}`);
    }
    
    if (!toPrice || toPrice <= 0) {
      throw new Error(`Unable to fetch current price for ${toCurrency}`);
    }
    
    // Calculate: from amount * from USD price / to USD price = to amount
    const fromUsdValue = amount * fromPrice;
    const toAmount = fromUsdValue / toPrice;
    
    const result = {
      fromAmount: amount,
      toAmount: parseFloat(toAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
      fromPrice,
      toPrice,
      exchangeRate: {
        finalPrice: fromPrice / toPrice, // How many TO tokens per FROM token
        source: 'portfolio_service',
        updatedAt: new Date()
      },
      usdValue: parseFloat(fromUsdValue.toFixed(2)),
      cryptoInvolved: {
        fromToken: {
          amount: amount,
          usdValue: parseFloat(fromUsdValue.toFixed(2)),
          currency: fromCurrency,
          role: 'source',
          price: parseFloat(fromPrice.toFixed(2))
        },
        toToken: {
          amount: parseFloat(toAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
          usdValue: parseFloat(fromUsdValue.toFixed(2)), // Same USD value
          currency: toCurrency,
          role: 'destination',
          price: parseFloat(toPrice.toFixed(2))
        }
      }
    };
    
    logger.info('Crypto-to-crypto calculation completed', {
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount,
      fromPrice,
      toPrice,
      exchangeRate: result.exchangeRate.finalPrice,
      usdValue: fromUsdValue
    });
    
    return {
      success: true,
      data: result,
      isCryptoToCrypto: true
    };
    
  } catch (error) {
    logger.error('Error calculating crypto-to-crypto swap rates', { swapData, error: error.message });
    return {
      success: false,
      message: error.message,
      isCryptoToCrypto: true
    };
  }
}

/**
 * Calculates swap rates and amounts with USD tracking and naira USD value
 * @param {Object} swapData - Swap parameters
 * @returns {Promise<Object>} Calculation result
 */
async function calculateSwapRates(swapData) {
  const { fromCurrency, toCurrency, amount, swapType } = swapData;

  try {
    // Check if this is an NGNZ swap first
    const ngnzDetection = detectNGNZSwap(fromCurrency, toCurrency);
    
    if (ngnzDetection.isNGNZSwap) {
      logger.info('Detected NGNZ swap, using NGNZ calculation logic', {
        fromCurrency,
        toCurrency,
        amount,
        isOnramp: ngnzDetection.isOnramp,
        isOfframp: ngnzDetection.isOfframp
      });
      
      return await calculateNGNZSwapRates(swapData);
    }
    
    // Check if this is an NGNB swap
    const isNGNBSwap = fromCurrency === 'NGNB' || toCurrency === 'NGNB';
    
    if (isNGNBSwap) {
      logger.info('Detected NGNB swap, using NGNB calculation logic', {
        fromCurrency,
        toCurrency,
        amount,
        swapType
      });
      
      // Original NGNB swap logic (unchanged)
      let result = {};
      let usdCalculation = {};
      let nairaUsdValue = 0;
      let nairaAmount = 0;
      let cryptoUsdValue = 0;
      let cryptoAmount = 0;

      if (swapType === 'onramp') {
        // NGNB to Crypto (onramp)
        const prices = await getPricesWithCache([toCurrency]);
        const cryptoPrice = prices[toCurrency];
        
        if (!cryptoPrice || cryptoPrice <= 0) {
          throw new Error(`Unable to fetch current price for ${toCurrency}`);
        }

        // Get onramp rate and calculate USD value for tracking
        const onrampRate = await getOnrampRate();
        
        // Calculate USD value (no limit validation)
        usdCalculation = calculateUSDValue(swapData, null, onrampRate);

        cryptoAmount = await calculateCryptoFromNaira(amount, toCurrency, cryptoPrice);

        // Calculate naira USD value for onramp (NGNB is the source)
        nairaAmount = amount; // The NGNB amount being swapped
        const nairaRateResult = await getNairaUSDRate('onramp');
        
        if (nairaRateResult.success) {
          nairaUsdValue = nairaAmount * nairaRateResult.data.ngnbToUsdRate;
        } else {
          logger.warn('Could not get naira USD rate for onramp', { error: nairaRateResult.message });
          nairaUsdValue = 0; // fallback
        }

        // Calculate crypto USD value (crypto is the destination)
        cryptoUsdValue = cryptoAmount * cryptoPrice;

        result = {
          fromAmount: amount,
          toAmount: parseFloat(cryptoAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
          cryptoPrice,
          exchangeRate: onrampRate,
          usdValue: usdCalculation.usdValue || 0,
          nairaInvolved: {
            amount: nairaAmount,
            usdValue: parseFloat(nairaUsdValue.toFixed(2)),
            currency: 'NGNB',
            role: 'source', // NGNB is being spent
            rate: nairaRateResult.success ? {
              ngnbToUsdRate: nairaRateResult.data.ngnbToUsdRate,
              usdToNgnbRate: nairaRateResult.data.usdToNgnbRate,
              rateType: nairaRateResult.data.rateType,
              lastUpdated: nairaRateResult.data.lastUpdated
            } : null
          },
          cryptoInvolved: {
            amount: parseFloat(cryptoAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
            usdValue: parseFloat(cryptoUsdValue.toFixed(2)),
            currency: toCurrency,
            role: 'destination', // Crypto is being received
            price: parseFloat(cryptoPrice.toFixed(2))
          }
        };

      } else if (swapType === 'offramp') {
        // Crypto to NGNB (offramp)
        const prices = await getPricesWithCache([fromCurrency]);
        const cryptoPrice = prices[fromCurrency];
        
        if (!cryptoPrice || cryptoPrice <= 0) {
          throw new Error(`Unable to fetch current price for ${fromCurrency}`);
        }

        // Calculate USD value for tracking (no limit validation)
        usdCalculation = calculateUSDValue(swapData, cryptoPrice, null);

        // Get offramp rate and calculate NGNB amount
        const offrampRate = await getCurrentRate();
        nairaAmount = await calculateNairaFromCrypto(amount, fromCurrency, cryptoPrice);

        // Calculate naira USD value for offramp (NGNB is the destination)
        const nairaRateResult = await getNairaUSDRate('offramp');
        
        if (nairaRateResult.success) {
          nairaUsdValue = nairaAmount * nairaRateResult.data.ngnbToUsdRate;
        } else {
          logger.warn('Could not get naira USD rate for offramp', { error: nairaRateResult.message });
          nairaUsdValue = 0; // fallback
        }

        // Calculate crypto USD value (crypto is the source)
        cryptoAmount = amount; // The crypto amount being swapped
        cryptoUsdValue = cryptoAmount * cryptoPrice;

        result = {
          fromAmount: amount,
          toAmount: parseFloat(nairaAmount.toFixed(2)),
          cryptoPrice,
          exchangeRate: offrampRate,
          usdValue: usdCalculation.usdValue || 0,
          nairaInvolved: {
            amount: parseFloat(nairaAmount.toFixed(2)),
            usdValue: parseFloat(nairaUsdValue.toFixed(2)),
            currency: 'NGNB',
            role: 'destination', // NGNB is being received
            rate: nairaRateResult.success ? {
              ngnbToUsdRate: nairaRateResult.data.ngnbToUsdRate,
              usdToNgnbRate: nairaRateResult.data.usdToNgnbRate,
              rateType: nairaRateResult.data.rateType,
              lastUpdated: nairaRateResult.data.lastUpdated
            } : null
          },
          cryptoInvolved: {
            amount: parseFloat(cryptoAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
            usdValue: parseFloat(cryptoUsdValue.toFixed(2)),
            currency: fromCurrency,
            role: 'source', // Crypto is being spent
            price: parseFloat(cryptoPrice.toFixed(2))
          }
        };
      }

      return {
        success: true,
        data: result
      };
    }
    
    // If neither NGNZ nor NGNB swap, it's a crypto-to-crypto swap
    logger.info('Detected crypto-to-crypto swap', {
      fromCurrency,
      toCurrency,
      amount
    });
    
    return await calculateCryptoToCryptoRates(swapData);

  } catch (error) {
    logger.error('Error calculating swap rates', { swapData, error: error.message });
    return {
      success: false,
      message: error.message
    };
  }
}

/**
 * Creates swap transaction record with naira and crypto USD values
 * @param {Object} transactionData - Transaction parameters
 * @returns {Promise<Object>} Created transaction
 */
async function createSwapTransaction(transactionData) {
  const {
    userId,
    fromCurrency,
    toCurrency,
    fromAmount,
    toAmount,
    swapType,
    exchangeRate,
    cryptoPrice,
    usdValue,
    nairaInvolved,
    cryptoInvolved
  } = transactionData;

  try {
    const transaction = await Transaction.create({
      userId,
      type: 'SWAP', // Now supported in the updated schema
      currency: fromCurrency, // Required currency field (source currency)
      fromCurrency, // Swap-specific field
      toCurrency, // Swap-specific field
      amount: fromAmount, // Required amount field (source amount)
      fromAmount, // Swap-specific field
      toAmount, // Swap-specific field
      swapType, // Swap-specific field (onramp/offramp)
      status: 'PENDING',
      metadata: {
        initiatedAt: new Date(),
        exchangeRate: exchangeRate?.finalPrice || exchangeRate,
        cryptoPrice,
        priceSource: exchangeRate?.source,
        usdValue,
        nairaInvolved, // Add naira USD value to metadata
        cryptoInvolved, // Add crypto USD value to metadata
        twoFactorRequired: false
      }
    });

    logger.info('Swap transaction created with naira and crypto USD values', {
      transactionId: transaction._id,
      userId,
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount,
      swapType,
      usdValue,
      nairaUsdValue: nairaInvolved?.usdValue,
      cryptoUsdValue: cryptoInvolved?.usdValue
    });

    return transaction;
  } catch (error) {
    logger.error('Failed to create swap transaction', {
      userId,
      fromCurrency,
      toCurrency,
      error: error.message
    });
    throw error;
  }
}

/**
 * Processes the actual balance updates for swap using portfolio.js service
 * @param {Object} swapData - Swap parameters
 * @returns {Promise<Object>} Processing result
 */
async function processSwapBalances(swapData) {
  const { userId, fromCurrency, toCurrency, fromAmount, toAmount, transactionId } = swapData;

  try {
    // Check if this is an NGNZ swap
    const ngnzDetection = detectNGNZSwap(fromCurrency, toCurrency);
    
    if (ngnzDetection.isNGNZSwap) {
      logger.info('Detected NGNZ swap, using NGNZ balance processing', {
        userId,
        transactionId,
        fromCurrency,
        toCurrency,
        isOnramp: ngnzDetection.isOnramp,
        isOfframp: ngnzDetection.isOfframp
      });
      
      return await processNGNZSwapBalances(swapData);
    }
    
    // Check if this is an NGNB swap
    const isNGNBSwap = fromCurrency === 'NGNB' || toCurrency === 'NGNB';
    
    if (isNGNBSwap) {
      logger.info('Detected NGNB swap, using NGNB balance processing', {
        userId,
        transactionId,
        fromCurrency,
        toCurrency
      });
      
      // Original NGNB swap balance processing
      // Validate user exists
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found for balance update');
      }

      // Get balance field name for validation
      const getBalanceField = (currency) => {
        const currencyLower = currency.toLowerCase();
        return `${currencyLower}Balance`;
      };

      // Check current balance before processing
      const fromBalanceField = getBalanceField(fromCurrency);
      const currentFromBalance = user[fromBalanceField] || 0;
      
      if (currentFromBalance < fromAmount) {
        throw new Error(`Insufficient ${fromCurrency} balance. Available: ${currentFromBalance}, Required: ${fromAmount}`);
      }

      logger.info('Processing NGNB swap balances using portfolio service', {
        userId,
        transactionId,
        fromCurrency,
        toCurrency,
        fromAmount,
        toAmount,
        currentFromBalance
      });

      // Step 1: Debit the source currency using portfolio.js
      // Note: We pass negative amount to debit the balance
      await updateUserBalance(userId, fromCurrency, -fromAmount);
      
      logger.info('Successfully debited source currency', {
        userId,
        currency: fromCurrency,
        amount: -fromAmount,
        transactionId
      });

      // Step 2: Credit the destination currency using portfolio.js
      await updateUserBalance(userId, toCurrency, toAmount);
      
      logger.info('Successfully credited destination currency', {
        userId,
        currency: toCurrency,
        amount: toAmount,
        transactionId
      });

      // Get updated user data to return current balances
      const updatedUser = await User.findById(userId);
      const fromBalanceFieldUpdated = getBalanceField(fromCurrency);
      const toBalanceFieldUpdated = getBalanceField(toCurrency);

      logger.info('NGNB swap balances processed successfully using portfolio service', {
        userId,
        transactionId,
        fromCurrency,
        toCurrency,
        fromAmount,
        toAmount,
        newFromBalance: updatedUser[fromBalanceFieldUpdated],
        newToBalance: updatedUser[toBalanceFieldUpdated],
        totalPortfolioBalance: updatedUser.totalPortfolioBalance
      });

      return { 
        success: true,
        balances: {
          [fromCurrency]: updatedUser[fromBalanceFieldUpdated],
          [toCurrency]: updatedUser[toBalanceFieldUpdated]
        },
        totalPortfolioBalance: updatedUser.totalPortfolioBalance
      };
    }
    
    // Crypto-to-crypto swap processing
    logger.info('Detected crypto-to-crypto swap, using portfolio service for both currencies', {
      userId,
      transactionId,
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount
    });

    // Validate user exists
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found for crypto-to-crypto balance update');
    }

    // Get balance field name for validation
    const getBalanceField = (currency) => {
      const currencyLower = currency.toLowerCase();
      return `${currencyLower}Balance`;
    };

    // Check current balance before processing
    const fromBalanceField = getBalanceField(fromCurrency);
    const currentFromBalance = user[fromBalanceField] || 0;
    
    if (currentFromBalance < fromAmount) {
      throw new Error(`Insufficient ${fromCurrency} balance. Available: ${currentFromBalance}, Required: ${fromAmount}`);
    }

    // Step 1: Debit the source currency using portfolio.js
    await updateUserBalance(userId, fromCurrency, -fromAmount);
    
    logger.info('Successfully debited source currency for crypto-to-crypto swap', {
      userId,
      currency: fromCurrency,
      amount: -fromAmount,
      transactionId
    });

    // Step 2: Credit the destination currency using portfolio.js
    await updateUserBalance(userId, toCurrency, toAmount);
    
    logger.info('Successfully credited destination currency for crypto-to-crypto swap', {
      userId,
      currency: toCurrency,
      amount: toAmount,
      transactionId
    });

    // Get updated user data to return current balances
    const updatedUser = await User.findById(userId);
    const fromBalanceFieldUpdated = getBalanceField(fromCurrency);
    const toBalanceFieldUpdated = getBalanceField(toCurrency);

    logger.info('Crypto-to-crypto swap balances processed successfully', {
      userId,
      transactionId,
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount,
      newFromBalance: updatedUser[fromBalanceFieldUpdated],
      newToBalance: updatedUser[toBalanceFieldUpdated],
      totalPortfolioBalance: updatedUser.totalPortfolioBalance
    });

    return { 
      success: true,
      balances: {
        [fromCurrency]: updatedUser[fromBalanceFieldUpdated],
        [toCurrency]: updatedUser[toBalanceFieldUpdated]
      },
      totalPortfolioBalance: updatedUser.totalPortfolioBalance
    };

  } catch (error) {
    logger.error('Failed to process swap balances using portfolio service', { 
      swapData, 
      error: error.message,
      stack: error.stack 
    });
    throw error;
  }
}

/**
 * GET /swap/limits - Get current swap limits and restrictions
 */
router.get('/limits', async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      data: {
        maxDecimalPlaces: SWAP_CONFIG.MAX_DECIMAL_PLACES,
        maxPendingSwaps: SWAP_CONFIG.MAX_PENDING_SWAPS,
        duplicateCheckWindow: SWAP_CONFIG.DUPLICATE_CHECK_WINDOW / 1000, // in seconds
        supportedTokens: Object.keys(SUPPORTED_TOKENS),
        restrictions: {
          onramp: "NGNB → Crypto",
          offramp: "Crypto → NGNB",
          maxValue: "No limits", // Updated to reflect no USD limit
          precision: `Maximum ${SWAP_CONFIG.MAX_DECIMAL_PLACES} decimal places`
        }
      },
      message: 'Swap limits and restrictions retrieved successfully'
    });
  } catch (error) {
    logger.error('Error fetching swap limits', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch swap limits'
    });
  }
});

/**
 * Main swap endpoint
 */
router.post('/crypto', async (req, res) => {
  const startTime = Date.now();
  let transaction = null;

  try {
    const userId = req.user.id;
    
    // Validate request parameters
    const validation = validateSwapRequest(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: validation.message,
        errors: validation.errors
      });
    }

    const { fromCurrency, toCurrency, amount, swapType } = validation.validatedData;

    // Detect swap type internally
    const ngnzDetection = detectNGNZSwap(fromCurrency, toCurrency);
    const isNGNZSwap = ngnzDetection.isNGNZSwap;
    const isNGNBSwap = fromCurrency === 'NGNB' || toCurrency === 'NGNB';
    const isCryptoToCrypto = !isNGNZSwap && !isNGNBSwap;

    logger.info('Processing swap request', {
      userId,
      fromCurrency,
      toCurrency,
      amount,
      swapType,
      isNGNZSwap,
      isNGNBSwap,
      isCryptoToCrypto
    });

    // Validate user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check for duplicate swaps (skip for NGNZ immediate swaps)
    if (!isNGNZSwap) {
      const duplicateCheck = await checkDuplicateSwap(userId, fromCurrency, toCurrency, amount);
      if (duplicateCheck.isDuplicate) {
        return res.status(400).json({
          success: false,
          message: duplicateCheck.message
        });
      }
    }

    // Validate user balance for from currency
    const balanceValidation = await validateUserBalance(userId, fromCurrency, amount);
    
    if (!balanceValidation.success) {
      return res.status(400).json({
        success: false,
        message: balanceValidation.message,
        availableBalance: balanceValidation.availableBalance
      });
    }

    // Calculate swap rates and amounts
    const rateCalculation = await calculateSwapRates({
      fromCurrency,
      toCurrency,
      amount,
      swapType
    });

    if (!rateCalculation.success) {
      return res.status(400).json({
        success: false,
        message: rateCalculation.message
      });
    }

    const { toAmount, exchangeRate, cryptoPrice, usdValue, nairaInvolved, cryptoInvolved, ngnzInvolved } = rateCalculation.data;

    // Create transaction record
    const transactionData = {
      userId,
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount,
      swapType,
      exchangeRate,
      cryptoPrice,
      usdValue
    };

    if (isNGNZSwap) {
      transactionData.ngnzInvolved = ngnzInvolved;
      transactionData.cryptoInvolved = cryptoInvolved;
    } else if (isNGNBSwap) {
      transactionData.nairaInvolved = nairaInvolved;
      transactionData.cryptoInvolved = cryptoInvolved;
    } else {
      // Crypto-to-crypto swap
      transactionData.cryptoInvolved = cryptoInvolved;
    }

    transaction = await createSwapTransaction(transactionData);

    // Process balance updates using portfolio.js service
    const balanceResult = await processSwapBalances({
      userId,
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount,
      transactionId: transaction._id
    });

    // Mark as completed immediately (all swaps are processed instantly)
    transaction.status = 'COMPLETED';
    transaction.completedAt = new Date();
    await transaction.save();

    const processingTime = Date.now() - startTime;
    
    const logData = {
      userId,
      transactionId: transaction._id,
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount,
      usdValue,
      totalPortfolioBalance: balanceResult.totalPortfolioBalance,
      processingTime,
      swapType: isNGNZSwap ? 'NGNZ' : isNGNBSwap ? 'NGNB' : 'crypto-to-crypto'
    };

    logger.info('Swap processed successfully with portfolio service integration', logData);

    // Build response data - keep original format, just add new fields conditionally
    const responseData = {
      transactionId: transaction._id,
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount,
      swapType,
      exchangeRate: exchangeRate?.finalPrice || exchangeRate,
      cryptoPrice: rateCalculation.data.fromPrice || cryptoPrice, // For crypto-to-crypto, use fromPrice
      usdValue,
      status: 'COMPLETED',
      completedAt: transaction.completedAt,
      balances: balanceResult.balances,
      totalPortfolioBalance: balanceResult.totalPortfolioBalance
    };

    // Add involved data based on swap type (existing field names for compatibility)
    if (isNGNZSwap) {
      // For NGNZ swaps, use nairaInvolved field for compatibility
      responseData.nairaInvolved = ngnzInvolved;
      responseData.cryptoInvolved = cryptoInvolved;
    } else if (isNGNBSwap) {
      responseData.nairaInvolved = nairaInvolved;
      responseData.cryptoInvolved = cryptoInvolved;
    } else {
      // For crypto-to-crypto swaps, use cryptoInvolved field
      responseData.cryptoInvolved = cryptoInvolved;
      // Add receive amount for frontend compatibility
      responseData.receiveAmount = toAmount;
    }

    res.status(200).json({
      success: true,
      message: 'Swap completed successfully',
      data: responseData
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    // Mark transaction as failed if it was created
    if (transaction) {
      try {
        transaction.status = 'FAILED';
        transaction.failedAt = new Date();
        transaction.metadata.error = error.message;
        await transaction.save();
      } catch (saveError) {
        logger.error('Failed to update transaction status to FAILED', {
          transactionId: transaction._id,
          error: saveError.message
        });
      }
    }

    logger.error('Swap processing failed', {
      userId: req.user?.id,
      transactionId: transaction?._id,
      error: error.message,
      stack: error.stack,
      processingTime
    });

    res.status(500).json({
      success: false,
      message: 'Internal server error during swap processing. Please contact support if this persists.',
      transactionId: transaction?._id
    });
  }
});

/**
 * Get swap quote endpoint (preview without executing)
 */
router.post('/quote', async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Validate request parameters
    const validation = validateSwapRequest(req.body);
    
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: validation.message,
        errors: validation.errors
      });
    }

    const { fromCurrency, toCurrency, amount, swapType } = validation.validatedData;

    // Detect swap type internally
    const ngnzDetection = detectNGNZSwap(fromCurrency, toCurrency);
    const isNGNZSwap = ngnzDetection.isNGNZSwap;
    const isNGNBSwap = fromCurrency === 'NGNB' || toCurrency === 'NGNB';
    const isCryptoToCrypto = !isNGNZSwap && !isNGNBSwap;

    logger.info('Processing swap quote request', {
      userId,
      fromCurrency,
      toCurrency,
      amount,
      swapType,
      isNGNZSwap,
      isNGNBSwap,
      isCryptoToCrypto
    });

    // Calculate swap rates
    const rateCalculation = await calculateSwapRates({
      fromCurrency,
      toCurrency,
      amount,
      swapType
    });

    if (!rateCalculation.success) {
      return res.status(400).json({
        success: false,
        message: rateCalculation.message
      });
    }

    // Build response data maintaining original format but adding receiveAmount for frontend
    const responseData = {
      ...rateCalculation.data,
      fromCurrency,
      toCurrency,
      swapType,
      quoteValidFor: '2 minutes',
      quotedAt: new Date(),
      // Add receiveAmount field for frontend compatibility
      receiveAmount: rateCalculation.data.toAmount
    };

    logger.info('Swap quote calculated successfully', {
      userId,
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount: rateCalculation.data.toAmount,
      receiveAmount: rateCalculation.data.toAmount,
      swapType: isNGNZSwap ? 'NGNZ' : isNGNBSwap ? 'NGNB' : 'crypto-to-crypto',
      usdValue: rateCalculation.data.usdValue
    });

    res.json({
      success: true,
      message: 'Swap quote calculated successfully',
      data: responseData
    });

  } catch (error) {
    logger.error('Swap quote calculation failed', {
      userId: req.user?.id,
      error: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to calculate swap quote'
    });
  }
});

/**
 * Get swap status endpoint
 */
router.get('/status/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const userId = req.user.id;

    const transaction = await Transaction.findOne({
      _id: transactionId,
      userId,
      type: 'SWAP' // Updated to use 'SWAP' type
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Swap transaction not found'
      });
    }

    res.json({
      success: true,
      data: {
        transactionId: transaction._id,
        status: transaction.status,
        fromCurrency: transaction.fromCurrency,
        toCurrency: transaction.toCurrency,
        fromAmount: transaction.fromAmount,
        toAmount: transaction.toAmount,
        swapType: transaction.swapType,
        createdAt: transaction.createdAt,
        completedAt: transaction.completedAt,
        failedAt: transaction.failedAt,
        metadata: transaction.metadata
      }
    });

  } catch (error) {
    logger.error('Error fetching swap status', {
      userId: req.user?.id,
      transactionId: req.params.transactionId,
      error: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to fetch swap status'
    });
  }
});

/**
 * Quick swap endpoint (simplified version for frequent traders)
 */
router.post('/quick', async (req, res) => {
  const startTime = Date.now();
  let transaction = null;

  try {
    const userId = req.user.id;
    const { fromCurrency, toCurrency, amount } = req.body;
    
    // Auto-detect swap type based on currencies
    let swapType;
    let isNGNZSwap = false;
    let isNGNBSwap = false;
    let isCryptoToCrypto = false;
    
    // Check for NGNZ first
    const ngnzDetection = detectNGNZSwap(fromCurrency, toCurrency);
    if (ngnzDetection.isNGNZSwap) {
      isNGNZSwap = true;
      swapType = ngnzDetection.isOnramp ? 'onramp' : 'offramp';
    } else if (fromCurrency?.toUpperCase() === 'NGNB') {
      isNGNBSwap = true;
      swapType = 'onramp';
    } else if (toCurrency?.toUpperCase() === 'NGNB') {
      isNGNBSwap = true;
      swapType = 'offramp';
    } else {
      // Crypto-to-crypto swap
      isCryptoToCrypto = true;
      swapType = 'offramp'; // Default for crypto-to-crypto
    }

    // Use existing validation and processing logic
    const validation = validateSwapRequest({
      fromCurrency,
      toCurrency,
      amount,
      swapType
    });

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: validation.message,
        errors: validation.errors
      });
    }

    const validatedData = validation.validatedData;

    logger.info('Processing quick swap request', {
      userId,
      ...validatedData,
      isNGNZSwap,
      isNGNBSwap,
      isCryptoToCrypto
    });

    // Check user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Skip duplicate check for quick swaps (traders need speed)
    // But still validate balance
    const balanceValidation = await validateUserBalance(userId, validatedData.fromCurrency, validatedData.amount);
    
    if (!balanceValidation.success) {
      return res.status(400).json({
        success: false,
        message: balanceValidation.message
      });
    }

    // Calculate rates and execute swap
    const rateCalculation = await calculateSwapRates(validatedData);

    if (!rateCalculation.success) {
      return res.status(400).json({
        success: false,
        message: rateCalculation.message
      });
    }

    const { toAmount, exchangeRate, cryptoPrice, usdValue, nairaInvolved, cryptoInvolved, ngnzInvolved } = rateCalculation.data;

    // Create and process transaction
    const transactionData = {
      userId,
      fromCurrency: validatedData.fromCurrency,
      toCurrency: validatedData.toCurrency,
      fromAmount: validatedData.amount,
      toAmount,
      swapType: validatedData.swapType,
      exchangeRate,
      cryptoPrice,
      usdValue
    };

    if (isNGNZSwap) {
      transactionData.ngnzInvolved = ngnzInvolved;
      transactionData.cryptoInvolved = cryptoInvolved;
    } else if (isNGNBSwap) {
      transactionData.nairaInvolved = nairaInvolved;
      transactionData.cryptoInvolved = cryptoInvolved;
    } else {
      // Crypto-to-crypto swap
      transactionData.cryptoInvolved = cryptoInvolved;
    }

    transaction = await createSwapTransaction(transactionData);

    // Process balance updates using portfolio.js service
    const balanceResult = await processSwapBalances({
      userId,
      fromCurrency: validatedData.fromCurrency,
      toCurrency: validatedData.toCurrency,
      fromAmount: validatedData.amount,
      toAmount,
      transactionId: transaction._id
    });

    transaction.status = 'COMPLETED';
    transaction.completedAt = new Date();
    await transaction.save();

    const processingTime = Date.now() - startTime;
    
    // Build response data maintaining original format
    const responseData = {
      transactionId: transaction._id,
      fromCurrency: validatedData.fromCurrency,
      toCurrency: validatedData.toCurrency,
      fromAmount: validatedData.amount,
      toAmount,
      swapType: validatedData.swapType,
      exchangeRate: exchangeRate?.finalPrice || exchangeRate,
      usdValue,
      status: 'COMPLETED',
      processingTime: `${processingTime}ms`,
      balances: balanceResult.balances,
      totalPortfolioBalance: balanceResult.totalPortfolioBalance,
      // Add receiveAmount for frontend compatibility
      receiveAmount: toAmount
    };

    // Add involved data using existing field names for compatibility
    if (isNGNZSwap) {
      responseData.nairaInvolved = ngnzInvolved; // Use same field name for client compatibility
      responseData.cryptoInvolved = cryptoInvolved;
    } else if (isNGNBSwap) {
      responseData.nairaInvolved = nairaInvolved;
      responseData.cryptoInvolved = cryptoInvolved;
    } else {
      // Crypto-to-crypto swap
      responseData.cryptoInvolved = cryptoInvolved;
    }
    
    res.status(200).json({
      success: true,
      message: 'Quick swap completed successfully',
      data: responseData
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    if (transaction) {
      try {
        transaction.status = 'FAILED';
        transaction.failedAt = new Date();
        transaction.metadata.error = error.message;
        await transaction.save();
      } catch (saveError) {
        logger.error('Failed to update transaction status', {
          transactionId: transaction._id,
          error: saveError.message
        });
      }
    }

    logger.error('Quick swap processing failed', {
      userId: req.user?.id,
      error: error.message,
      processingTime
    });

    res.status(500).json({
      success: false,
      message: 'Quick swap failed. Please try again.',
      transactionId: transaction?._id
    });
  }
});

// Ensure proper export
module.exports = router;