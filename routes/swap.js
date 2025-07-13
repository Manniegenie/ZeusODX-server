const express = require('express');
const router = express.Router();

const User = require('../models/user');
const Transaction = require('../models/transaction');
const { getPricesWithCache, SUPPORTED_TOKENS } = require('../services/portfolio');
const GlobalSwapMarkdown = require('../models/swapmarkdown'); // Import swap markdown model

// Import balance validation service
const { 
  validateUserBalance,
  getUserAvailableBalance,
  VALIDATION_CONFIG 
} = require('../services/balance');

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
  // Removed CRYPTO_TO_CRYPTO_FEE - using dynamic markdown instead
};

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
 * Determines swap type based on currencies
 * @param {string} fromCurrency - From currency
 * @param {string} toCurrency - To currency
 * @returns {string} Swap type: 'onramp', 'offramp', or 'crypto_to_crypto'
 */
function determineSwapType(fromCurrency, toCurrency) {
  const upperFrom = fromCurrency.toUpperCase();
  const upperTo = toCurrency.toUpperCase();
  
  if (upperFrom === 'NGNB' && SUPPORTED_TOKENS[upperTo]) {
    return 'onramp'; // NGNB → Crypto
  } else if (SUPPORTED_TOKENS[upperFrom] && upperTo === 'NGNB') {
    return 'offramp'; // Crypto → NGNB
  } else if (SUPPORTED_TOKENS[upperFrom] && SUPPORTED_TOKENS[upperTo] && upperFrom !== 'NGNB' && upperTo !== 'NGNB') {
    return 'crypto_to_crypto'; // Crypto → Crypto
  } else {
    return 'invalid';
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
 * @param {number} fromPrice - From currency price
 * @param {number} toPrice - To currency price
 * @param {Object} exchangeRate - Exchange rate object (for onramp)
 * @returns {Object} USD calculation result
 */
function calculateUSDValue(swapData, fromPrice = null, toPrice = null, exchangeRate = null) {
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
      if (!fromPrice || fromPrice <= 0) {
        throw new Error('Crypto price required for offramp USD calculation');
      }
      usdValue = amount * fromPrice;
    } else if (swapType === 'crypto_to_crypto') {
      // Crypto to Crypto: Convert from crypto amount to USD
      if (!fromPrice || fromPrice <= 0) {
        throw new Error('From crypto price required for crypto-to-crypto USD calculation');
      }
      usdValue = amount * fromPrice;
    }

    logger.debug('USD value calculation', {
      swapType,
      amount,
      fromPrice,
      toPrice,
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
 * Validates swap request parameters
 * @param {Object} body - Request body
 * @returns {Object} Validation result
 */
function validateSwapRequest(body) {
  const { fromCurrency, toCurrency, amount, swapType } = body;

  const errors = [];

  // Helper function to safely convert to string and trim
  const safeStringTrim = (value) => {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  };

  // Convert values to strings safely
  const fromCurrencyStr = safeStringTrim(fromCurrency);
  const toCurrencyStr = safeStringTrim(toCurrency);
  let swapTypeStr = safeStringTrim(swapType);

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

  // Same currency check
  if (upperFromCurrency === upperToCurrency) {
    errors.push('From and to currencies cannot be the same');
  }

  // Auto-detect swap type if not provided
  if (!swapTypeStr && fromCurrencyStr && toCurrencyStr) {
    swapTypeStr = determineSwapType(fromCurrencyStr, toCurrencyStr);
  }

  // Validate swap type and currencies
  if (swapTypeStr === 'invalid') {
    errors.push('Invalid currency pair. Supported swaps: NGNB ↔ Crypto, Crypto ↔ Crypto');
  } else if (swapTypeStr === 'onramp') {
    // NGNB to crypto
    if (upperFromCurrency !== 'NGNB') {
      errors.push('For onramp swaps, from currency must be NGNB');
    }
    if (upperToCurrency === 'NGNB' || !SUPPORTED_TOKENS[upperToCurrency]) {
      errors.push(`For onramp swaps, to currency must be a supported crypto: ${Object.keys(SUPPORTED_TOKENS).filter(t => t !== 'NGNB').join(', ')}`);
    }
  } else if (swapTypeStr === 'offramp') {
    // Crypto to NGNB
    if (upperToCurrency !== 'NGNB') {
      errors.push('For offramp swaps, to currency must be NGNB');
    }
    if (upperFromCurrency === 'NGNB' || !SUPPORTED_TOKENS[upperFromCurrency]) {
      errors.push(`For offramp swaps, from currency must be a supported crypto: ${Object.keys(SUPPORTED_TOKENS).filter(t => t !== 'NGNB').join(', ')}`);
    }
  } else if (swapTypeStr === 'crypto_to_crypto') {
    // Crypto to crypto
    if (!SUPPORTED_TOKENS[upperFromCurrency] || upperFromCurrency === 'NGNB') {
      errors.push(`From currency must be a supported crypto: ${Object.keys(SUPPORTED_TOKENS).filter(t => t !== 'NGNB').join(', ')}`);
    }
    if (!SUPPORTED_TOKENS[upperToCurrency] || upperToCurrency === 'NGNB') {
      errors.push(`To currency must be a supported crypto: ${Object.keys(SUPPORTED_TOKENS).filter(t => t !== 'NGNB').join(', ')}`);
    }
  } else if (swapTypeStr) {
    // Manual swap type provided but not valid
    const validSwapTypes = ['onramp', 'offramp', 'crypto_to_crypto'];
    if (!validSwapTypes.includes(swapTypeStr.toLowerCase())) {
      errors.push('Invalid swap type. Must be one of: onramp, offramp, crypto_to_crypto');
    }
  } else {
    errors.push('Swap type is required or could not be determined');
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
      swapType: swapTypeStr.toLowerCase()
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
      type: 'SWAP',
      fromCurrency,
      toCurrency,
      fromAmount: amount,
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
      type: 'SWAP',
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
 * Calculates swap rates and amounts with USD tracking and markdown application
 * @param {Object} swapData - Swap parameters
 * @returns {Promise<Object>} Calculation result
 */
async function calculateSwapRates(swapData) {
  const { fromCurrency, toCurrency, amount, swapType } = swapData;

  try {
    let result = {};
    let usdCalculation = {};
    let nairaUsdValue = 0;
    let nairaAmount = 0;
    let cryptoUsdValue = 0;
    let cryptoAmount = 0;
    let markdownApplied = null;

    if (swapType === 'onramp') {
      // NGNB to Crypto (onramp)
      const prices = await getPricesWithCache([toCurrency]);
      const cryptoPrice = prices[toCurrency];
      
      if (!cryptoPrice || cryptoPrice <= 0) {
        throw new Error(`Unable to fetch current price for ${toCurrency}`);
      }

      // Get onramp rate and calculate USD value for tracking
      const onrampRate = await getOnrampRate();
      
      // Calculate USD value
      usdCalculation = calculateUSDValue(swapData, null, cryptoPrice, onrampRate);

      // Calculate base crypto amount
      const baseCryptoAmount = await calculateCryptoFromNaira(amount, toCurrency, cryptoPrice);
      
      // Apply global swap markdown to the received amount
      cryptoAmount = await GlobalSwapMarkdown.applyGlobalMarkdown(baseCryptoAmount);
      
      // Get markdown details
      const markdownConfig = await GlobalSwapMarkdown.getGlobalMarkdown();
      markdownApplied = {
        percentage: markdownConfig.markdownPercentage,
        isActive: markdownConfig.isActive,
        baseAmount: parseFloat(baseCryptoAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
        markdownAmount: parseFloat((baseCryptoAmount - cryptoAmount).toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
        finalAmount: parseFloat(cryptoAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION))
      };

      // Calculate naira USD value for onramp (NGNB is the source)
      nairaAmount = amount;
      const nairaRateResult = await getNairaUSDRate('onramp');
      
      if (nairaRateResult.success) {
        nairaUsdValue = nairaAmount * nairaRateResult.data.ngnbToUsdRate;
      } else {
        logger.warn('Could not get naira USD rate for onramp', { error: nairaRateResult.message });
        nairaUsdValue = 0;
      }

      // Calculate crypto USD value
      cryptoUsdValue = cryptoAmount * cryptoPrice;

      result = {
        fromAmount: amount,
        toAmount: parseFloat(cryptoAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
        cryptoPrice,
        exchangeRate: onrampRate,
        usdValue: usdCalculation.usdValue || 0,
        markdownApplied,
        nairaInvolved: {
          amount: nairaAmount,
          usdValue: parseFloat(nairaUsdValue.toFixed(2)),
          currency: 'NGNB',
          role: 'source',
          rate: nairaRateResult.success ? nairaRateResult.data : null
        },
        cryptoInvolved: {
          amount: parseFloat(cryptoAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
          usdValue: parseFloat(cryptoUsdValue.toFixed(2)),
          currency: toCurrency,
          role: 'destination',
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

      // Calculate USD value for tracking
      usdCalculation = calculateUSDValue(swapData, cryptoPrice, null, null);

      // Get offramp rate and calculate base NGNB amount
      const offrampRate = await getCurrentRate();
      const baseNairaAmount = await calculateNairaFromCrypto(amount, fromCurrency, cryptoPrice);
      
      // Apply global swap markdown to the received amount
      nairaAmount = await GlobalSwapMarkdown.applyGlobalMarkdown(baseNairaAmount);
      
      // Get markdown details
      const markdownConfig = await GlobalSwapMarkdown.getGlobalMarkdown();
      markdownApplied = {
        percentage: markdownConfig.markdownPercentage,
        isActive: markdownConfig.isActive,
        baseAmount: parseFloat(baseNairaAmount.toFixed(2)),
        markdownAmount: parseFloat((baseNairaAmount - nairaAmount).toFixed(2)),
        finalAmount: parseFloat(nairaAmount.toFixed(2))
      };

      // Calculate naira USD value for offramp (NGNB is the destination)
      const nairaRateResult = await getNairaUSDRate('offramp');
      
      if (nairaRateResult.success) {
        nairaUsdValue = nairaAmount * nairaRateResult.data.ngnbToUsdRate;
      } else {
        logger.warn('Could not get naira USD rate for offramp', { error: nairaRateResult.message });
        nairaUsdValue = 0;
      }

      // Calculate crypto USD value
      cryptoAmount = amount;
      cryptoUsdValue = cryptoAmount * cryptoPrice;

      result = {
        fromAmount: amount,
        toAmount: parseFloat(nairaAmount.toFixed(2)),
        cryptoPrice,
        exchangeRate: offrampRate,
        usdValue: usdCalculation.usdValue || 0,
        markdownApplied,
        nairaInvolved: {
          amount: parseFloat(nairaAmount.toFixed(2)),
          usdValue: parseFloat(nairaUsdValue.toFixed(2)),
          currency: 'NGNB',
          role: 'destination',
          rate: nairaRateResult.success ? nairaRateResult.data : null
        },
        cryptoInvolved: {
          amount: parseFloat(cryptoAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
          usdValue: parseFloat(cryptoUsdValue.toFixed(2)),
          currency: fromCurrency,
          role: 'source',
          price: parseFloat(cryptoPrice.toFixed(2))
        }
      };

    } else if (swapType === 'crypto_to_crypto') {
      // Crypto to Crypto direct swap
      const prices = await getPricesWithCache([fromCurrency, toCurrency]);
      const fromPrice = prices[fromCurrency];
      const toPrice = prices[toCurrency];
      
      if (!fromPrice || fromPrice <= 0) {
        throw new Error(`Unable to fetch current price for ${fromCurrency}`);
      }
      if (!toPrice || toPrice <= 0) {
        throw new Error(`Unable to fetch current price for ${toCurrency}`);
      }

      // Calculate USD value for tracking
      usdCalculation = calculateUSDValue(swapData, fromPrice, toPrice, null);

      // Calculate conversion rate and base amount
      const baseRate = fromPrice / toPrice;
      const baseToAmount = amount * baseRate;
      
      // Apply global swap markdown to the received amount
      const finalToAmount = await GlobalSwapMarkdown.applyGlobalMarkdown(baseToAmount);
      
      // Get markdown details
      const markdownConfig = await GlobalSwapMarkdown.getGlobalMarkdown();
      markdownApplied = {
        percentage: markdownConfig.markdownPercentage,
        isActive: markdownConfig.isActive,
        baseAmount: parseFloat(baseToAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
        markdownAmount: parseFloat((baseToAmount - finalToAmount).toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
        finalAmount: parseFloat(finalToAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION))
      };

      result = {
        fromAmount: amount,
        toAmount: parseFloat(finalToAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
        fromPrice,
        toPrice,
        conversionRate: parseFloat(baseRate.toFixed(8)),
        markdownApplied,
        usdValue: usdCalculation.usdValue || 0,
        cryptoInvolved: {
          from: {
            amount: amount,
            usdValue: parseFloat((amount * fromPrice).toFixed(2)),
            currency: fromCurrency,
            role: 'source',
            price: parseFloat(fromPrice.toFixed(2))
          },
          to: {
            amount: parseFloat(finalToAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
            usdValue: parseFloat((finalToAmount * toPrice).toFixed(2)),
            currency: toCurrency,
            role: 'destination',
            price: parseFloat(toPrice.toFixed(2))
          }
        }
      };
    }

    return {
      success: true,
      data: result
    };

  } catch (error) {
    logger.error('Error calculating swap rates', { swapData, error: error.message });
    return {
      success: false,
      message: error.message
    };
  }
}

/**
 * Creates swap transaction record
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
    cryptoInvolved,
    markdownApplied
  } = transactionData;

  try {
    const transaction = await Transaction.create({
      userId,
      type: 'SWAP',
      currency: fromCurrency,
      fromCurrency,
      toCurrency,
      amount: fromAmount,
      fromAmount,
      toAmount,
      swapType,
      status: 'PENDING',
      metadata: {
        initiatedAt: new Date(),
        exchangeRate: exchangeRate?.finalPrice || exchangeRate,
        cryptoPrice,
        priceSource: exchangeRate?.source,
        usdValue,
        nairaInvolved,
        cryptoInvolved,
        markdownApplied,
        twoFactorRequired: false
      }
    });

    logger.info('Swap transaction created', {
      transactionId: transaction._id,
      userId,
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount,
      swapType,
      usdValue,
      markdownPercentage: markdownApplied?.percentage
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
 * Updates user balances for swap using atomic operations
 * @param {Object} swapData - Swap parameters
 * @returns {Promise<Object>} Processing result
 */
async function updateSwapBalances(swapData) {
  const { userId, fromCurrency, toCurrency, fromAmount, toAmount, transactionId } = swapData;

  try {
    // Helper function to get balance field name
    const getBalanceField = (currency) => {
      const currencyLower = currency.toLowerCase();
      return `${currencyLower}Balance`;
    };

    // Get balance field names
    const fromBalanceField = getBalanceField(fromCurrency);
    const toBalanceField = getBalanceField(toCurrency);

    // Prepare atomic update query
    const updateQuery = {
      $inc: {
        [fromBalanceField]: -fromAmount, // Debit source currency
        [toBalanceField]: toAmount // Credit destination currency
      }
    };

    // Add conditions to prevent negative balances
    const conditions = {
      _id: userId,
      [fromBalanceField]: { $gte: fromAmount } // Ensure sufficient balance
    };

    // Perform atomic balance update
    const updateResult = await User.findOneAndUpdate(
      conditions,
      updateQuery,
      { 
        new: true, 
        runValidators: true,
        select: `${fromBalanceField} ${toBalanceField}` // Only return balance fields for efficiency
      }
    );

    if (!updateResult) {
      throw new Error(`Failed to update balances - insufficient ${fromCurrency} balance or user not found`);
    }

    logger.info('Swap balances updated successfully', {
      userId,
      transactionId,
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount,
      newFromBalance: updateResult[fromBalanceField],
      newToBalance: updateResult[toBalanceField]
    });

    return { 
      success: true,
      balances: {
        [fromCurrency]: updateResult[fromBalanceField],
        [toCurrency]: updateResult[toBalanceField]
      }
    };

  } catch (error) {
    logger.error('Failed to update swap balances', { 
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
    // Get current markdown configuration
    const markdownConfig = await GlobalSwapMarkdown.getGlobalMarkdown();
    
    res.status(200).json({
      success: true,
      data: {
        maxDecimalPlaces: SWAP_CONFIG.MAX_DECIMAL_PLACES,
        maxPendingSwaps: SWAP_CONFIG.MAX_PENDING_SWAPS,
        duplicateCheckWindow: SWAP_CONFIG.DUPLICATE_CHECK_WINDOW / 1000, // in seconds
        markdownConfiguration: {
          percentage: markdownConfig.markdownPercentage,
          isActive: markdownConfig.isActive,
          description: 'Global markdown applied to received amounts'
        },
        supportedTokens: Object.keys(SUPPORTED_TOKENS),
        supportedSwapTypes: [
          {
            type: 'onramp',
            description: 'NGNB → Crypto',
            example: 'NGNB → BTC'
          },
          {
            type: 'offramp', 
            description: 'Crypto → NGNB',
            example: 'BTC → NGNB'
          },
          {
            type: 'crypto_to_crypto',
            description: 'Crypto → Crypto (with markdown)',
            example: 'ETH → USDT',
            markdown: `${markdownConfig.markdownPercentage}% applied to received amount`
          }
        ],
        restrictions: {
          maxValue: "No limits",
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

    logger.info('Processing swap request', {
      userId,
      fromCurrency,
      toCurrency,
      amount,
      swapType
    });

    // Validate user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check for duplicate swaps
    const duplicateCheck = await checkDuplicateSwap(userId, fromCurrency, toCurrency, amount);
    if (duplicateCheck.isDuplicate) {
      return res.status(400).json({
        success: false,
        message: duplicateCheck.message
      });
    }

    // Validate user balance using balance service
    const balanceValidation = await validateUserBalance(userId, fromCurrency, amount, {
      includeBalanceDetails: true,
      logValidation: true
    });
    
    if (!balanceValidation.success) {
      return res.status(400).json({
        success: false,
        message: balanceValidation.message,
        availableBalance: balanceValidation.availableBalance,
        shortfall: balanceValidation.shortfall
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

    const { toAmount, exchangeRate, cryptoPrice, usdValue, nairaInvolved, cryptoInvolved, markdownApplied } = rateCalculation.data;

    // Create transaction record
    transaction = await createSwapTransaction({
      userId,
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount,
      swapType,
      exchangeRate,
      cryptoPrice,
      usdValue,
      nairaInvolved,
      cryptoInvolved,
      markdownApplied
    });

    // Update balances using atomic operations
    await updateSwapBalances({
      userId,
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount,
      transactionId: transaction._id
    });

    // Update transaction status to completed
    transaction.status = 'COMPLETED';
    transaction.completedAt = new Date();
    await transaction.save();

    const processingTime = Date.now() - startTime;
    logger.info('Swap processed successfully', {
      userId,
      transactionId: transaction._id,
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount,
      usdValue,
      markdownPercentage: markdownApplied?.percentage,
      processingTime
    });

    // Prepare response data
    const responseData = {
      transactionId: transaction._id,
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount,
      swapType,
      usdValue,
      markdownApplied,
      status: 'COMPLETED',
      completedAt: transaction.completedAt
    };

    // Add swap-type specific data
    if (swapType === 'crypto_to_crypto') {
      responseData.conversionRate = rateCalculation.data.conversionRate;
      responseData.fromPrice = rateCalculation.data.fromPrice;
      responseData.toPrice = rateCalculation.data.toPrice;
      responseData.cryptoInvolved = cryptoInvolved;
    } else {
      responseData.exchangeRate = exchangeRate?.finalPrice || exchangeRate;
      responseData.cryptoPrice = cryptoPrice;
      responseData.nairaInvolved = nairaInvolved;
      responseData.cryptoInvolved = cryptoInvolved;
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

    res.json({
      success: true,
      message: 'Swap quote calculated successfully',
      data: {
        ...rateCalculation.data,
        fromCurrency,
        toCurrency,
        swapType,
        quoteValidFor: '2 minutes',
        quotedAt: new Date()
      }
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
      type: 'SWAP'
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
    
    // Use existing validation and processing logic
    const validation = validateSwapRequest({
      fromCurrency,
      toCurrency,
      amount
      // swapType will be auto-detected
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
      ...validatedData
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
    // But still validate balance using balance service
    const balanceValidation = await validateUserBalance(userId, validatedData.fromCurrency, validatedData.amount, {
      includeBalanceDetails: true,
      logValidation: false // Skip logging for quick swaps
    });
    
    if (!balanceValidation.success) {
      return res.status(400).json({
        success: false,
        message: balanceValidation.message,
        availableBalance: balanceValidation.availableBalance
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

    const { toAmount, exchangeRate, cryptoPrice, usdValue, nairaInvolved, cryptoInvolved, markdownApplied } = rateCalculation.data;

    // Create and process transaction
    transaction = await createSwapTransaction({
      userId,
      fromCurrency: validatedData.fromCurrency,
      toCurrency: validatedData.toCurrency,
      fromAmount: validatedData.amount,
      toAmount,
      swapType: validatedData.swapType,
      exchangeRate,
      cryptoPrice,
      usdValue,
      nairaInvolved,
      cryptoInvolved,
      markdownApplied
    });

    // Update balances using atomic operations
    await updateSwapBalances({
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
    
    // Prepare response data
    const responseData = {
      transactionId: transaction._id,
      fromCurrency: validatedData.fromCurrency,
      toCurrency: validatedData.toCurrency,
      fromAmount: validatedData.amount,
      toAmount,
      swapType: validatedData.swapType,
      usdValue,
      markdownApplied,
      status: 'COMPLETED',
      processingTime: `${processingTime}ms`
    };

    // Add swap-type specific data
    if (validatedData.swapType === 'crypto_to_crypto') {
      responseData.conversionRate = rateCalculation.data.conversionRate;
      responseData.cryptoInvolved = cryptoInvolved;
    } else {
      responseData.exchangeRate = exchangeRate?.finalPrice || exchangeRate;
      responseData.nairaInvolved = nairaInvolved;
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