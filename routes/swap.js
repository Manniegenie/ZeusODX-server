const express = require('express');
const onrampService = require('../services/onramppriceservice');
const offrampService = require('../services/offramppriceservice');
const { updateUserPortfolioBalance, getPricesWithCache } = require('../services/portfolio');
const Transaction = require('../models/transaction');
const User = require('../models/user');
const logger = require('../utils/logger');

const router = express.Router();

const TOKEN_MAP = {
  'BTC': { currency: 'BTC', name: 'Bitcoin' },
  'ETH': { currency: 'ETH', name: 'Ethereum' },
  'SOL': { currency: 'SOL', name: 'Solana' },
  'USDT': { currency: 'USDT', name: 'Tether' },
  'USDC': { currency: 'USDC', name: 'USD Coin' },
  'BNB': { currency: 'BNB', name: 'Binance Coin' },
  'MATIC': { currency: 'MATIC', name: 'Polygon' },
  'AVAX': { currency: 'AVAX', name: 'Avalanche' },
  'NGNZ': { currency: 'NGNZ', name: 'Nigerian Naira Bank' }
};

// Store quote data temporarily
const quoteCache = new Map();

/**
 * Processes atomic balance updates for swap (EXACT COPY of your working NGNB code)
 * @param {Object} swapData - Swap parameters
 * @returns {Promise<Object>} Processing result
 */
async function processSwapBalances(swapData) {
  const { userId, fromCurrency, toCurrency, fromAmount, toAmount, transactionId } = swapData;

  try {
    // Get user document
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found for balance update');
    }

    // Helper function to get balance field name (EXACT SAME as your working code)
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

    // Perform atomic balance update (EXACT SAME as your working code)
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
      { 
        new: true, 
        runValidators: false  // ✅ Disable min: 0 validation that blocks updates
      }
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

/**
 * Validates user balance for swap (EXACT COPY of your working code)
 */
async function validateUserBalance(userId, currency, amount) {
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
 * Calculate exchange rate for crypto-to-crypto swaps using price cache
 */
async function calculateCryptoExchange(fromCurrency, toCurrency, amount) {
  try {
    const fromUpper = fromCurrency.toUpperCase();
    const toUpper = toCurrency.toUpperCase();
    
    // Get current prices from portfolio service
    const prices = await getPricesWithCache([fromUpper, toUpper]);
    
    const fromPrice = prices[fromUpper];
    const toPrice = prices[toUpper];
    
    if (!fromPrice || fromPrice <= 0) {
      throw new Error(`Unable to get price for ${fromUpper}`);
    }
    
    if (!toPrice || toPrice <= 0) {
      throw new Error(`Unable to get price for ${toUpper}`);
    }
    
    // Calculate exchange rate and amount
    const exchangeRate = fromPrice / toPrice;
    const receiveAmount = amount * exchangeRate;
    
    return {
      success: true,
      fromPrice,
      toPrice,
      exchangeRate,
      receiveAmount
    };
    
  } catch (error) {
    logger.error('Failed to calculate crypto exchange', {
      fromCurrency,
      toCurrency,
      amount,
      error: error.message
    });
    
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Handle NGNZ swaps (adapted from your NGNB code)
 */
async function handleNGNZSwap(req, res, from, to, amount, side) {
  try {
    const userId = req.user?.id;
    const fromUpper = from.toUpperCase();
    const toUpper = to.toUpperCase();
    
    // Determine swap type
    const isOnramp = fromUpper === 'NGNZ' && toUpper !== 'NGNZ';
    const isOfframp = fromUpper !== 'NGNZ' && toUpper === 'NGNZ';
    
    if (!isOnramp && !isOfframp) {
      return res.status(400).json({
        success: false,
        message: "Invalid NGNZ swap configuration"
      });
    }
    
    let receiveAmount, quoteData;
    
    if (isOnramp) {
      // NGNZ to Crypto
      receiveAmount = await onrampService.calculateCryptoFromNaira(amount, toUpper);
      const onrampRate = await onrampService.getOnrampRate();
      
      quoteData = {
        id: `ngnz_onramp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        amount: amount,
        receiveAmount: receiveAmount,
        rate: onrampRate.finalPrice,
        side: side,
        sourceCurrency: fromUpper,
        targetCurrency: toUpper,
        provider: 'INTERNAL_ONRAMP',
        type: 'onramp',
        expiresAt: new Date(Date.now() + 30 * 1000).toISOString()
      };
    } else {
      // Crypto to NGNZ
      receiveAmount = await offrampService.calculateNairaFromCrypto(amount, fromUpper);
      const offrampRate = await offrampService.getCurrentRate();
      
      quoteData = {
        id: `ngnz_offramp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        amount: amount,
        receiveAmount: receiveAmount,
        rate: offrampRate.finalPrice,
        side: side,
        sourceCurrency: fromUpper,
        targetCurrency: toUpper,
        provider: 'INTERNAL_OFFRAMP',
        type: 'offramp',
        expiresAt: new Date(Date.now() + 30 * 1000).toISOString()
      };
    }
    
    // Store quote
    quoteCache.set(quoteData.id, quoteData);
    
    const finalResponse = {
      success: true,
      message: `NGNZ ${isOnramp ? 'onramp' : 'offramp'} quote created successfully`,
      data: {
        data: {
          id: quoteData.id,
          amount: amount,
          amountReceived: receiveAmount,
          rate: quoteData.rate,
          side: side,
          expiresIn: 30,
          expiryDate: quoteData.expiresAt,
          sourceCurrency: fromUpper,
          targetCurrency: toUpper,
          provider: quoteData.provider,
          acceptable: true
        },
        id: quoteData.id,
        amount: amount,
        amountReceived: receiveAmount,
        rate: quoteData.rate,
        side: side,
        expiresIn: 30,
        expiryDate: quoteData.expiresAt,
        sourceCurrency: fromUpper,
        targetCurrency: toUpper,
        provider: quoteData.provider,
        acceptable: true
      }
    };

    return res.json(finalResponse);
    
  } catch (error) {
    logger.error('NGNZ swap error', {
      userId: req.user?.id,
      from,
      to,
      amount,
      side,
      error: error.message
    });
    
    return res.status(500).json({
      success: false,
      message: "Failed to create NGNZ swap quote",
      error: error.message
    });
  }
}

router.post('/quote', async (req, res) => {
  try {
    const { from, to, amount, side } = req.body;

    logger.info('POST /swap/quote - Request received', {
      userId: req.user?.id,
      requestBody: { from, to, amount, side },
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });

    if (!from || !to || !amount || !side) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: from, to, amount, side"
      });
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be a positive number"
      });
    }

    if (side !== 'BUY' && side !== 'SELL') {
      return res.status(400).json({
        success: false,
        message: "Side must be BUY or SELL"
      });
    }

    // Check if this is a NGNZ swap
    const isNGNZSwap = from.toUpperCase() === 'NGNZ' || to.toUpperCase() === 'NGNZ';
    
    if (isNGNZSwap) {
      return await handleNGNZSwap(req, res, from, to, amount, side);
    }

    // Regular crypto-to-crypto swap
    const exchangeResult = await calculateCryptoExchange(from, to, amount);
    
    if (!exchangeResult.success) {
      return res.status(500).json({
        success: false,
        message: "Failed to calculate exchange rate",
        error: exchangeResult.error
      });
    }

    // Create quote data
    const quoteId = `internal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const quoteData = {
      id: quoteId,
      amount: amount,
      amountReceived: exchangeResult.receiveAmount,
      rate: exchangeResult.exchangeRate,
      side: side,
      sourceCurrency: from.toUpperCase(),
      targetCurrency: to.toUpperCase(),
      provider: 'INTERNAL_EXCHANGE',
      fromPrice: exchangeResult.fromPrice,
      toPrice: exchangeResult.toPrice,
      expiresAt: new Date(Date.now() + 30 * 1000).toISOString()
    };
    
    // Store quote
    quoteCache.set(quoteId, quoteData);

    const finalResponse = {
      success: true,
      message: "Quote created successfully",
      data: {
        data: {
          id: quoteId,
          amount: amount,
          amountReceived: exchangeResult.receiveAmount,
          rate: exchangeResult.exchangeRate,
          side: side,
          expiresIn: 30,
          expiryDate: quoteData.expiresAt,
          sourceCurrency: from.toUpperCase(),
          targetCurrency: to.toUpperCase(),
          provider: 'INTERNAL_EXCHANGE',
          acceptable: true,
          sourceId: `internal_${from.toLowerCase()}`,
          targetId: `internal_${to.toLowerCase()}`,
          sourceDollarRate: exchangeResult.fromPrice,
          targetDollarRate: exchangeResult.toPrice
        },
        id: quoteId,
        amount: amount,
        amountReceived: exchangeResult.receiveAmount,
        rate: exchangeResult.exchangeRate,
        side: side,
        expiresIn: 30,
        expiryDate: quoteData.expiresAt,
        sourceCurrency: from.toUpperCase(),
        targetCurrency: to.toUpperCase(),
        provider: 'INTERNAL_EXCHANGE',
        acceptable: true
      }
    };

    res.json(finalResponse);

  } catch (error) {
    logger.error('POST /swap/quote - Server error', {
      userId: req.user?.id,
      error: error.message,
      stack: error.stack
    });
    
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
});

router.post('/quote/:quoteId', async (req, res) => {
  try {
    const { quoteId } = req.params;
    const userId = req.user.id;

    logger.info('POST /swap/quote/:quoteId - Request received', {
      userId,
      quoteId
    });

    // Get quote data from cache
    const quoteData = quoteCache.get(quoteId);
    
    if (!quoteData) {
      return res.status(404).json({
        success: false,
        message: "Quote not found or expired"
      });
    }

    // Check if quote has expired
    if (quoteData.expiresAt && new Date() > new Date(quoteData.expiresAt)) {
      quoteCache.delete(quoteId);
      return res.status(410).json({
        success: false,
        message: "Quote has expired"
      });
    }

    const sourceCurrency = quoteData.sourceCurrency;
    const targetCurrency = quoteData.targetCurrency;
    const payAmount = quoteData.amount;
    const receiveAmount = quoteData.amountReceived || quoteData.receiveAmount;

    // Validate user has sufficient balance
    const balanceValidation = await validateUserBalance(userId, sourceCurrency, payAmount);
    
    if (!balanceValidation.success) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance: ${balanceValidation.message}`,
        balanceError: true,
        availableBalance: balanceValidation.availableBalance,
        requiredAmount: payAmount,
        currency: sourceCurrency
      });
    }

    try {
      // Calculate exchange rate
      const exchangeRate = receiveAmount / payAmount;

      // Create swap transaction
      const swapTransactions = await Transaction.createSwapTransactions({
        userId,
        quoteId,
        sourceCurrency,
        targetCurrency,
        sourceAmount: payAmount,
        targetAmount: receiveAmount,
        exchangeRate,
        swapType: quoteData.type || 'CRYPTO_TO_CRYPTO',
        provider: quoteData.provider,
        markdownApplied: 0,
        swapFee: 0,
        quoteExpiresAt: new Date(quoteData.expiresAt),
        status: 'SUCCESSFUL',
        obiexTransactionId: `internal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      });

      logger.info('Swap transactions created', {
        userId,
        quoteId,
        swapId: swapTransactions.swapId
      });

      // Update balances using your working atomic update
      await processSwapBalances({
        userId,
        fromCurrency: sourceCurrency,
        toCurrency: targetCurrency,
        fromAmount: payAmount,
        toAmount: receiveAmount,
        transactionId: swapTransactions.swapId
      });

      // Update portfolio balance
      try {
        await updateUserPortfolioBalance(userId);
        logger.info(`Portfolio balance updated for user ${userId}`);
      } catch (portfolioError) {
        logger.warn('Portfolio update failed (non-critical)', {
          userId,
          error: portfolioError.message
        });
      }

      logger.info('Swap completed successfully', {
        userId,
        swapId: swapTransactions.swapId,
        sourceCurrency,
        targetCurrency,
        sourceAmount: payAmount,
        targetAmount: receiveAmount
      });

      // Clean up quote from cache
      quoteCache.delete(quoteId);
      
      const finalResponse = {
        success: true,
        message: "Swap completed successfully with balance updates.",
        data: {
          swapId: swapTransactions.swapId,
          quoteId,
          status: 'SUCCESSFUL',
          swapDetails: {
            sourceCurrency,
            targetCurrency,
            sourceAmount: payAmount,
            targetAmount: receiveAmount,
            exchangeRate,
            swapType: quoteData.type || 'CRYPTO_TO_CRYPTO',
            provider: quoteData.provider,
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          },
          transactions: {
            swapOut: {
              id: swapTransactions.swapOutTransaction._id,
              type: swapTransactions.swapOutTransaction.type,
              currency: sourceCurrency,
              amount: -payAmount
            },
            swapIn: {
              id: swapTransactions.swapInTransaction._id,
              type: swapTransactions.swapInTransaction.type,
              currency: targetCurrency,
              amount: receiveAmount
            }
          },
          balanceUpdated: true
        }
      };

      res.json(finalResponse);

    } catch (transactionError) {
      logger.error('Failed to create swap transactions', {
        userId,
        quoteId,
        error: transactionError.message,
        stack: transactionError.stack
      });
      
      return res.status(500).json({
        success: false,
        message: "Failed to create swap transactions. Please contact support.",
        error: transactionError.message
      });
    }

  } catch (error) {
    logger.error('POST /swap/quote/:quoteId - Server error', {
      quoteId: req.params.quoteId,
      userId: req.user?.id,
      error: error.message,
      stack: error.stack
    });
    
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
});

router.get('/tokens', (req, res) => {
  try {
    const tokens = Object.entries(TOKEN_MAP).map(([code, info]) => ({
      code: code,
      name: info.name,
      currency: info.currency
    }));

    res.json({
      success: true,
      message: "Supported tokens retrieved successfully",
      data: tokens,
      total: tokens.length
    });

  } catch (error) {
    logger.error('GET /swap/tokens - Server error', {
      userId: req.user?.id,
      error: error.message
    });
    
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
});

logger.info('Working swap router initialized', {
  endpoints: [
    'POST /swap/quote',
    'POST /swap/quote/:quoteId', 
    'GET /swap/tokens'
  ],
  supportedTokens: Object.keys(TOKEN_MAP),
  features: [
    'NGNZ onramp/offramp support',
    'Crypto-to-crypto swaps via price cache',
    'Atomic balance updates (proven working)',
    'Immediate swap completion'
  ]
});

module.exports = router;