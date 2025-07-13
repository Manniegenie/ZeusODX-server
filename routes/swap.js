const express = require('express');
const router = express.Router();

const User = require('../models/user');
const Transaction = require('../models/transaction');
const { getPricesWithCache, SUPPORTED_TOKENS } = require('../services/portfolio');

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
};

/**
 * Helper function to count decimal places in a string representation
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
 * Gets the NGNB to USD rate for calculating naira dollar value
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
    } else if (swapType === 'crypto_to_crypto') {
      // Crypto to Crypto: Convert crypto amount to USD using Obiex prices
      if (!cryptoPrice || cryptoPrice <= 0) {
        throw new Error('Crypto price required for crypto-to-crypto USD calculation');
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
 * Gets crypto to crypto swap quote from Obiex API
 */
async function getObiexQuote(fromCurrency, toCurrency, amount) {
  try {
    // Call Obiex API for quote using correct endpoint and fields
    const obiexApiUrl = process.env.OBIEX_API_URL || 'https://api.obiex.finance';
    const response = await fetch(`${obiexApiUrl}/trades/quote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OBIEX_API_KEY}`,
      },
      body: JSON.stringify({
        sourceId: fromCurrency, // source currency id or code
        targetId: toCurrency,   // target currency id or code
        side: 'SELL',          // BUY or SELL
        amount: amount
      })
    });

    if (!response.ok) {
      throw new Error(`Obiex API error: ${response.status} ${response.statusText}`);
    }

    const obiexData = await response.json();
    
    if (!obiexData || !obiexData.id) {
      throw new Error(`Obiex quote failed: ${obiexData?.message || 'Invalid response format'}`);
    }

    // Extract data from Obiex response
    const quoteId = obiexData.id;
    const receiveAmount = obiexData.receiveAmount || obiexData.targetAmount || 0;
    const sourcePrice = obiexData.sourcePrice || 0;
    const targetPrice = obiexData.targetPrice || 0;
    const validUntil = obiexData.validUntil || obiexData.expiresAt;
    
    return {
      success: true,
      data: {
        fromAmount: amount,
        toAmount: parseFloat(receiveAmount),
        fromPrice: parseFloat(sourcePrice),
        toPrice: parseFloat(targetPrice),
        conversionRate: parseFloat((receiveAmount / amount).toFixed(8)),
        quoteId: quoteId,
        validUntil: validUntil,
        obiexQuote: obiexData
      }
    };

  } catch (error) {
    logger.error('Error getting Obiex quote', {
      fromCurrency,
      toCurrency,
      amount,
      error: error.message
    });
    
    return {
      success: false,
      message: error.message
    };
  }
}

/**
 * Executes crypto-to-crypto swap using Obiex API
 */
async function executeObiexSwap(quoteId) {
  try {
    const obiexApiUrl = process.env.OBIEX_API_URL || 'https://api.obiex.finance';
    const response = await fetch(`${obiexApiUrl}/trades/${quoteId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OBIEX_API_KEY}`,
      },
      body: JSON.stringify({
        // Execute the trade using the quote ID
      })
    });

    if (!response.ok) {
      throw new Error(`Obiex execution error: ${response.status} ${response.statusText}`);
    }

    const obiexData = await response.json();
    
    if (!obiexData) {
      throw new Error(`Obiex execution failed: Invalid response`);
    }

    return {
      success: true,
      data: obiexData
    };

  } catch (error) {
    logger.error('Error executing Obiex swap', {
      quoteId,
      error: error.message
    });
    
    return {
      success: false,
      message: error.message
    };
  }
}

/**
 * Validates swap request parameters
 */
function validateSwapRequest(body) {
  // Handle both field name variations
  const fromCurrency = body.fromCurrency || body.from;
  const toCurrency = body.toCurrency || body.to;
  const amount = body.amount || body.quantity || body.value;
  const swapType = body.swapType || body.swap_type || body.type;

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

  // Auto-detect swap type if not provided
  if (!swapTypeStr && fromCurrencyStr && toCurrencyStr) {
    if (upperFromCurrency === 'NGNB' && SUPPORTED_TOKENS[upperToCurrency]) {
      swapTypeStr = 'onramp'; // NGNB to crypto
    } else if (SUPPORTED_TOKENS[upperFromCurrency] && upperToCurrency === 'NGNB') {
      swapTypeStr = 'offramp'; // Crypto to NGNB
    } else if (SUPPORTED_TOKENS[upperFromCurrency] && SUPPORTED_TOKENS[upperToCurrency] && 
               upperFromCurrency !== 'NGNB' && upperToCurrency !== 'NGNB') {
      swapTypeStr = 'crypto_to_crypto'; // Crypto to crypto
    }
  }

  // Swap type validation
  const validSwapTypes = ['onramp', 'offramp', 'crypto_to_crypto'];
  if (swapTypeStr && !validSwapTypes.includes(swapTypeStr.toLowerCase())) {
    errors.push('Invalid swap type. Must be either "onramp", "offramp", or "crypto_to_crypto"');
  }

  // For onramp: NGNB to crypto
  if (swapTypeStr && swapTypeStr.toLowerCase() === 'onramp') {
    if (upperFromCurrency !== 'NGNB') {
      errors.push('For onramp swaps, from currency must be NGNB');
    }
    if (upperToCurrency === 'NGNB' || !SUPPORTED_TOKENS[upperToCurrency]) {
      errors.push(`For onramp swaps, to currency must be a supported crypto: ${Object.keys(SUPPORTED_TOKENS).join(', ')}`);
    }
  }

  // For offramp: crypto to NGNB
  if (swapTypeStr && swapTypeStr.toLowerCase() === 'offramp') {
    if (upperToCurrency !== 'NGNB') {
      errors.push('For offramp swaps, to currency must be NGNB');
    }
    if (upperFromCurrency === 'NGNB' || !SUPPORTED_TOKENS[upperFromCurrency]) {
      errors.push(`For offramp swaps, from currency must be a supported crypto: ${Object.keys(SUPPORTED_TOKENS).join(', ')}`);
    }
  }

  // For crypto_to_crypto: both must be supported tokens but not NGNB
  if (swapTypeStr && swapTypeStr.toLowerCase() === 'crypto_to_crypto') {
    if (!SUPPORTED_TOKENS[upperFromCurrency] || upperFromCurrency === 'NGNB') {
      errors.push(`For crypto-to-crypto swaps, from currency must be a supported crypto (not NGNB): ${Object.keys(SUPPORTED_TOKENS).filter(t => t !== 'NGNB').join(', ')}`);
    }
    if (!SUPPORTED_TOKENS[upperToCurrency] || upperToCurrency === 'NGNB') {
      errors.push(`For crypto-to-crypto swaps, to currency must be a supported crypto (not NGNB): ${Object.keys(SUPPORTED_TOKENS).filter(t => t !== 'NGNB').join(', ')}`);
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
      swapType: swapTypeStr ? swapTypeStr.toLowerCase() : null
    }
  };
}

/**
 * Checks for duplicate pending swaps
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
 * Calculates swap rates and amounts with USD tracking and naira USD value
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

    } else if (swapType === 'crypto_to_crypto') {
      // Crypto to Crypto using Obiex API quote
      const obiexQuoteResult = await getObiexQuote(fromCurrency, toCurrency, amount);
      
      if (!obiexQuoteResult.success) {
        throw new Error(obiexQuoteResult.message);
      }

      const { fromPrice, toPrice, conversionRate, toAmount, quoteId, validUntil, obiexQuote } = obiexQuoteResult.data;

      // Calculate USD value for tracking using Obiex prices
      usdCalculation = calculateUSDValue(swapData, fromPrice, null);

      result = {
        fromAmount: amount,
        toAmount,
        fromPrice,
        toPrice,
        conversionRate,
        quoteId,
        validUntil,
        usdValue: usdCalculation.usdValue || 0,
        obiexQuote,
        cryptoInvolved: {
          from: {
            amount: amount,
            usdValue: parseFloat((amount * fromPrice).toFixed(2)),
            currency: fromCurrency,
            role: 'source',
            price: fromPrice
          },
          to: {
            amount: toAmount,
            usdValue: parseFloat((toAmount * toPrice).toFixed(2)),
            currency: toCurrency,
            role: 'destination',
            price: toPrice
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
 * Creates swap transaction record with naira and crypto USD values
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
    quoteId,
    obiexQuote
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
        quoteId,
        obiexQuote,
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
      quoteId
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
 * Processes the actual balance updates for swap - directly updating user balances
 */
async function processSwapBalances(swapData) {
  const { userId, fromCurrency, toCurrency, fromAmount, toAmount, transactionId } = swapData;

  try {
    // Get user document
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found for balance update');
    }

    // Helper function to get balance field name
    const getBalanceField = (currency) => {
      const currencyLower = currency.toLowerCase();
      return `${currencyLower}Balance`;
    };

    // Get balance field names
    const fromBalanceField = getBalanceField(fromCurrency);
    const toBalanceField = getBalanceField(toCurrency);

    // Check if user has sufficient balance
    const currentFromBalance = user[fromBalanceField] || 0;
    if (currentFromBalance < fromAmount) {
      throw new Error(`Insufficient ${fromCurrency} balance. Available: ${currentFromBalance}, Required: ${fromAmount}`);
    }

    // Perform atomic balance update
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

    const updateResult = await User.findOneAndUpdate(
      conditions,
      updateQuery,
      { new: true, runValidators: true }
    );

    if (!updateResult) {
      throw new Error(`Failed to update balances - insufficient ${fromCurrency} balance or user not found`);
    }

    logger.info('Swap balances processed successfully', {
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
    logger.error('Failed to process swap balances', { 
      swapData, 
      error: error.message,
      stack: error.stack 
    });
    throw error;
  }
}

// Main swap endpoint
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

    // Calculate swap rates and amounts (includes USD tracking and naira USD value)
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

    const { toAmount, exchangeRate, cryptoPrice, usdValue, nairaInvolved, cryptoInvolved, quoteId, obiexQuote } = rateCalculation.data;

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
      quoteId,
      obiexQuote
    });

    // For crypto-to-crypto swaps, execute the Obiex swap first
    if (swapType === 'crypto_to_crypto') {
      const obiexExecution = await executeObiexSwap(quoteId);
      
      if (!obiexExecution.success) {
        // Mark transaction as failed
        transaction.status = 'FAILED';
        transaction.failedAt = new Date();
        transaction.metadata.error = `Obiex execution failed: ${obiexExecution.message}`;
        await transaction.save();
        
        return res.status(400).json({
          success: false,
          message: `Swap execution failed: ${obiexExecution.message}`,
          transactionId: transaction._id
        });
      }
      
      // Store Obiex execution details
      transaction.metadata.obiexExecution = obiexExecution.data;
      await transaction.save();
    }

    // Process balance updates - directly updating user balances
    await processSwapBalances({
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
      nairaUsdValue: nairaInvolved?.usdValue,
      cryptoUsdValue: cryptoInvolved?.usdValue,
      processingTime
    });

    // Prepare response based on swap type
    const responseData = {
      transactionId: transaction._id,
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount,
      swapType,
      usdValue,
      status: 'COMPLETED',
      completedAt: transaction.completedAt
    };

    // Add swap-type specific data
    if (swapType === 'crypto_to_crypto') {
      responseData.fromPrice = rateCalculation.data.fromPrice;
      responseData.toPrice = rateCalculation.data.toPrice;
      responseData.conversionRate = rateCalculation.data.conversionRate;
      responseData.quoteId = rateCalculation.data.quoteId;
      responseData.cryptoInvolved = cryptoInvolved;
      responseData.rateSource = 'Obiex API';
      responseData.obiexExecution = transaction.metadata.obiexExecution;
    } else {
      responseData.exchangeRate = exchangeRate?.finalPrice || exchangeRate;
      responseData.cryptoPrice = cryptoPrice;
      responseData.nairaInvolved = nairaInvolved;
      responseData.cryptoInvolved = cryptoInvolved;
      responseData.rateSource = swapType === 'onramp' ? 'Onramp service' : 'Offramp service';
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

// Get swap quote endpoint (preview without executing)
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

    // Calculate swap rates (includes USD tracking and naira USD value)
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

module.exports = router;