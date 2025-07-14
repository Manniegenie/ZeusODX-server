const express = require('express');
const onrampService = require('../services/onramppriceservice');
const offrampService = require('../services/offramppriceservice');
const { validateUserBalance, getUserAvailableBalance } = require('../services/balance');
const { updateUserBalance, updateUserPortfolioBalance, getPricesWithCache } = require('../services/portfolio');
const Transaction = require('../models/transaction');
const User = require('../models/user');
const logger = require('../utils/logger');

const router = express.Router();

// NOTE: Authentication is handled globally in server.js via authenticateToken middleware
// No need for additional authentication here since req.user.id is already available

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

// Balance field mapping for NGNZ swaps
const CURRENCY_BALANCE_MAP = {
  'BTC': 'btcBalance',
  'ETH': 'ethBalance',
  'SOL': 'solBalance',
  'USDT': 'usdtBalance',
  'USDC': 'usdcBalance',
  'BNB': 'bnbBalance',
  'MATIC': 'maticBalance',
  'AVAX': 'avaxBalance',
  'NGNZ': 'ngnzBalance'
};

// Store quote data temporarily (in production, use Redis or database)
const quoteCache = new Map();

/**
 * Updates user balance for NGNZ swaps
 * @param {String} userId - User ID
 * @param {String} currency - Currency code
 * @param {Number} amount - Amount to add (positive) or subtract (negative)
 */
async function updateUserBalanceForNGNZ(userId, currency, amount) {
  const normalizedCurrency = currency.toUpperCase();
  const balanceField = CURRENCY_BALANCE_MAP[normalizedCurrency];
  
  if (!balanceField) {
    logger.warn(`No balance field mapping found for currency: ${normalizedCurrency}`);
    return;
  }
  
  const user = await User.findById(userId);
  if (!user) {
    throw new Error('User not found');
  }
  
  const currentBalance = user[balanceField] || 0;
  const newBalance = Math.max(0, currentBalance + amount); // Ensure no negative balances
  
  user[balanceField] = newBalance;
  await user.save();
  
  logger.info(`NGNZ Swap: Updated ${userId} ${balanceField}: ${currentBalance} -> ${newBalance} (${amount >= 0 ? '+' : ''}${amount})`);
}

/**
 * Calculate exchange rate between two currencies using internal price cache
 * @param {String} fromCurrency - Source currency
 * @param {String} toCurrency - Target currency
 * @param {Number} amount - Amount to convert
 * @param {String} side - BUY or SELL
 * @returns {Object} Exchange calculation result
 */
async function calculateInternalExchange(fromCurrency, toCurrency, amount, side) {
  try {
    const fromUpper = fromCurrency.toUpperCase();
    const toUpper = toCurrency.toUpperCase();
    
    logger.info('Calculating internal exchange rate', {
      fromCurrency: fromUpper,
      toCurrency: toUpper,
      amount,
      side
    });
    
    // Get current prices from portfolio service (already includes markdown)
    const prices = await getPricesWithCache([fromUpper, toUpper]);
    
    const fromPrice = prices[fromUpper];
    const toPrice = prices[toUpper];
    
    if (!fromPrice || fromPrice <= 0) {
      throw new Error(`Unable to get price for ${fromUpper}`);
    }
    
    if (!toPrice || toPrice <= 0) {
      throw new Error(`Unable to get price for ${toUpper}`);
    }
    
    // Calculate exchange rate and amounts (no additional spread - already in price cache)
    const exchangeRate = fromPrice / toPrice;
    let receiveAmount;
    
    if (side === 'SELL') {
      // User is selling fromCurrency to get toCurrency
      receiveAmount = amount * exchangeRate;
    } else {
      // User is buying fromCurrency with toCurrency
      receiveAmount = amount * exchangeRate;
    }
    
    logger.info('Internal exchange calculation completed', {
      fromCurrency: fromUpper,
      toCurrency: toUpper,
      fromPrice,
      toPrice,
      exchangeRate,
      amount,
      receiveAmount
    });
    
    return {
      success: true,
      fromPrice,
      toPrice,
      exchangeRate,
      receiveAmount
    };
    
  } catch (error) {
    logger.error('Failed to calculate internal exchange', {
      fromCurrency,
      toCurrency,
      amount,
      side,
      error: error.message
    });
    
    return {
      success: false,
      error: error.message
    };
  }
}

// Handle NGNZ swaps using onramp/offramp services
async function handleNGNZSwap(req, res, from, to, amount, side) {
  try {
    const userId = req.user?.id;
    
    logger.info('handleNGNZSwap - Starting NGNZ swap processing', {
      userId,
      from,
      to,
      amount,
      side
    });

    const fromUpper = from.toUpperCase();
    const toUpper = to.toUpperCase();
    
    // Determine if this is onramp (NGNZ -> crypto) or offramp (crypto -> NGNZ)
    const isOnramp = fromUpper === 'NGNZ' && toUpper !== 'NGNZ';
    const isOfframp = fromUpper !== 'NGNZ' && toUpper === 'NGNZ';
    
    logger.info('handleNGNZSwap - Swap type determined', {
      userId,
      isOnramp,
      isOfframp,
      fromUpper,
      toUpper
    });
    
    if (!isOnramp && !isOfframp) {
      const errorResponse = {
        success: false,
        message: "Invalid NGNZ swap configuration"
      };
      
      logger.warn('handleNGNZSwap - Invalid NGNZ swap configuration', {
        userId,
        fromUpper,
        toUpper,
        response: errorResponse
      });
      
      return res.status(400).json(errorResponse);
    }
    
    let cryptoCurrency, receiveAmount, payAmount;
    let quoteData;
    
    if (isOnramp) {
      // User is paying NGNZ to get crypto (onramp)
      cryptoCurrency = toUpper;
      payAmount = amount; // Amount of NGNZ user is paying
      
      logger.info('handleNGNZSwap - Processing onramp calculation', {
        userId,
        cryptoCurrency,
        payAmount
      });
      
      // Calculate how much crypto user gets for their NGNZ using onramp service
      receiveAmount = await onrampService.calculateCryptoFromNaira(amount, cryptoCurrency);
      const onrampRate = await onrampService.getOnrampRate();
      
      logger.info('handleNGNZSwap - Onramp calculation completed', {
        userId,
        payAmount,
        receiveAmount,
        rate: onrampRate.finalPrice
      });
      
      quoteData = {
        id: `ngnz_onramp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        sourceId: 'ngnz_source',
        targetId: 'crypto_target',
        side: side,
        amount: payAmount,
        receiveAmount: receiveAmount,
        rate: onrampRate.finalPrice,
        type: 'onramp',
        sourceCurrency: fromUpper,
        targetCurrency: toUpper,
        provider: 'INTERNAL_ONRAMP',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 1000).toISOString() // 30 seconds
      };
      
    } else if (isOfframp) {
      // User is selling crypto to get NGNZ (offramp)
      cryptoCurrency = fromUpper;
      payAmount = amount; // Amount of crypto user is selling
      
      logger.info('handleNGNZSwap - Processing offramp calculation', {
        userId,
        cryptoCurrency,
        payAmount
      });
      
      // Calculate how much NGNZ user gets for their crypto using offramp service
      receiveAmount = await offrampService.calculateNairaFromCrypto(amount, cryptoCurrency);
      const offrampRate = await offrampService.getCurrentRate();
      
      logger.info('handleNGNZSwap - Offramp calculation completed', {
        userId,
        payAmount,
        receiveAmount,
        rate: offrampRate.finalPrice
      });
      
      quoteData = {
        id: `ngnz_offramp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        sourceId: 'crypto_source',
        targetId: 'ngnz_target',
        side: side,
        amount: payAmount,
        receiveAmount: receiveAmount,
        rate: offrampRate.finalPrice,
        type: 'offramp',
        sourceCurrency: fromUpper,
        targetCurrency: toUpper,
        provider: 'INTERNAL_OFFRAMP',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 1000).toISOString() // 30 seconds
      };
    }
    
    // Store quote data for later use in acceptance
    quoteCache.set(quoteData.id, quoteData);
    
    logger.info('handleNGNZSwap - Quote cached successfully', {
      userId,
      quoteId: quoteData.id,
      cacheSize: quoteCache.size
    });
    
    const finalResponse = {
      success: true,
      message: `NGNZ ${isOnramp ? 'onramp' : 'offramp'} quote created successfully`,
      data: {
        data: {
          id: quoteData.id,
          amount: payAmount,
          amountReceived: receiveAmount,
          rate: quoteData.rate,
          side: side,
          expiresIn: 30,
          expiryDate: quoteData.expiresAt,
          sourceCurrency: fromUpper,
          targetCurrency: toUpper,
          provider: quoteData.provider,
          acceptable: true,
          sourceId: quoteData.sourceId,
          targetId: quoteData.targetId
        },
        // Also include flat structure for backward compatibility
        id: quoteData.id,
        amount: payAmount,
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

    logger.info('handleNGNZSwap - NGNZ swap quote created successfully', {
      userId,
      type: isOnramp ? 'ONRAMP' : 'OFFRAMP',
      pair: `${from}-${to}`,
      payAmount,
      receiveAmount,
      rate: quoteData.rate,
      quoteId: quoteData.id
    });
    
    return res.json(finalResponse);
    
  } catch (error) {
    const errorResponse = {
      success: false,
      message: "Failed to create NGNZ swap quote",
      error: error.message
    };
    
    logger.error('handleNGNZSwap - Error creating NGNZ swap quote', {
      userId: req.user?.id,
      from,
      to,
      amount,
      side,
      error: error.message,
      stack: error.stack
    });
    
    return res.status(500).json(errorResponse);
  }
}

router.post('/quote', async (req, res) => {
  try {
    const { from, to, amount, side } = req.body;

    // LOG: Request received
    logger.info('POST /swap/quote - Request received', {
      userId: req.user?.id,
      requestBody: { from, to, amount, side },
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });

    if (!from || !to || !amount || !side) {
      const errorResponse = {
        success: false,
        message: "Missing required fields: from, to, amount, side"
      };
      
      logger.warn('POST /swap/quote - Validation failed', {
        userId: req.user?.id,
        error: 'Missing required fields'
      });
      
      return res.status(400).json(errorResponse);
    }

    if (typeof amount !== 'number' || amount <= 0) {
      const errorResponse = {
        success: false,
        message: "Amount must be a positive number"
      };
      
      logger.warn('POST /swap/quote - Invalid amount', {
        userId: req.user?.id,
        amount
      });
      
      return res.status(400).json(errorResponse);
    }

    if (side !== 'BUY' && side !== 'SELL') {
      const errorResponse = {
        success: false,
        message: "Side must be BUY or SELL"
      };
      
      logger.warn('POST /swap/quote - Invalid side', {
        userId: req.user?.id,
        side
      });
      
      return res.status(400).json(errorResponse);
    }

    // Check if this is a NGNZ swap and handle it differently
    const isNGNZSwap = from.toUpperCase() === 'NGNZ' || to.toUpperCase() === 'NGNZ';
    
    logger.info('POST /swap/quote - Processing swap type', {
      userId: req.user?.id,
      isNGNZSwap,
      pair: `${from}-${to}`
    });
    
    if (isNGNZSwap) {
      // Handle NGNZ swaps using onramp/offramp services
      logger.info('POST /swap/quote - Delegating to NGNZ handler', {
        userId: req.user?.id,
        from,
        to,
        amount,
        side
      });
      
      return await handleNGNZSwap(req, res, from, to, amount, side);
    }

    // Regular crypto-to-crypto swap using internal pricing
    logger.info('POST /swap/quote - Creating internal quote', {
      userId: req.user?.id,
      from: from.toUpperCase(),
      to: to.toUpperCase(),
      amount,
      side
    });
    
    // Calculate exchange using internal price cache (already includes markdown)
    const exchangeResult = await calculateInternalExchange(from, to, amount, side);
    
    if (!exchangeResult.success) {
      const errorResponse = {
        success: false,
        message: "Failed to calculate exchange rate",
        error: exchangeResult.error
      };
      
      logger.error('POST /swap/quote - Internal exchange calculation failed', {
        userId: req.user?.id,
        from,
        to,
        amount,
        side,
        error: exchangeResult.error
      });
      
      return res.status(500).json(errorResponse);
    }

    // Create quote data for caching (compatible with client expectations)
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
      expiresIn: 30,
      expiryDate: new Date(Date.now() + 30 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 1000).toISOString(),
      // Store original amount for compatibility
      originalAmount: amount,
      // Add Obiex-compatible fields for client
      data: {
        id: quoteId,
        amount: amount,
        amountReceived: exchangeResult.receiveAmount,
        rate: exchangeResult.exchangeRate,
        side: side,
        acceptable: true
      }
    };
    
    // Store quote data for acceptance
    quoteCache.set(quoteId, quoteData);

    logger.info('POST /swap/quote - Internal quote created successfully', {
      userId: req.user?.id,
      quoteId,
      pair: `${from}-${to}`,
      amount,
      receiveAmount: exchangeResult.receiveAmount,
      rate: exchangeResult.exchangeRate
    });

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
          expiryDate: quoteData.expiryDate,
          sourceCurrency: from.toUpperCase(),
          targetCurrency: to.toUpperCase(),
          provider: 'INTERNAL_EXCHANGE',
          acceptable: true,
          sourceId: `internal_${from.toLowerCase()}`,
          targetId: `internal_${to.toLowerCase()}`,
          sourceDollarRate: exchangeResult.fromPrice,
          targetDollarRate: exchangeResult.toPrice
        },
        // Also include flat structure for backward compatibility
        id: quoteId,
        amount: amount,
        amountReceived: exchangeResult.receiveAmount,
        rate: exchangeResult.exchangeRate,
        side: side,
        expiresIn: 30,
        expiryDate: quoteData.expiryDate,
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
    
    const errorResponse = {
      success: false,
      message: "Internal server error",
      error: error.message
    };
    
    res.status(500).json(errorResponse);
  }
});

router.post('/quote/:quoteId', async (req, res) => {
  try {
    const { quoteId } = req.params;
    const userId = req.user.id;

    logger.info('POST /swap/quote/:quoteId - Request received', {
      userId,
      quoteId,
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });

    if (!quoteId) {
      const errorResponse = {
        success: false,
        message: "Quote ID is required"
      };
      
      return res.status(400).json(errorResponse);
    }

    // Get quote data from cache
    const quoteData = quoteCache.get(quoteId);
    
    logger.info('POST /swap/quote/:quoteId - Quote cache lookup', {
      userId,
      quoteId,
      found: !!quoteData,
      cacheSize: quoteCache.size
    });
    
    if (!quoteData) {
      const errorResponse = {
        success: false,
        message: "Quote not found or expired"
      };
      
      return res.status(404).json(errorResponse);
    }

    // Check if quote has expired
    if (quoteData.expiresAt && new Date() > new Date(quoteData.expiresAt)) {
      quoteCache.delete(quoteId);
      
      const errorResponse = {
        success: false,
        message: "Quote has expired"
      };
      
      return res.status(410).json(errorResponse);
    }

    // Determine swap type and parameters
    const isNGNZQuote = quoteId.includes('ngnz_onramp_') || quoteId.includes('ngnz_offramp_');
    
    let sourceCurrency, targetCurrency, payAmount, receiveAmount, swapType, provider;
    
    if (isNGNZQuote) {
      // NGNZ swap handling
      sourceCurrency = quoteData.sourceCurrency;
      targetCurrency = quoteData.targetCurrency;
      payAmount = quoteData.amount;
      receiveAmount = quoteData.receiveAmount;
      swapType = quoteData.type === 'onramp' ? 'ONRAMP' : 'OFFRAMP';
      provider = quoteData.provider;
    } else {
      // Regular internal swap handling
      sourceCurrency = quoteData.sourceCurrency;
      targetCurrency = quoteData.targetCurrency;
      payAmount = quoteData.amount || quoteData.originalAmount;
      receiveAmount = quoteData.amountReceived;
      swapType = 'CRYPTO_TO_CRYPTO';
      provider = 'INTERNAL_EXCHANGE';
    }
    
    logger.info('POST /swap/quote/:quoteId - Processing swap', {
      userId,
      quoteId,
      sourceCurrency,
      targetCurrency,
      payAmount,
      receiveAmount,
      swapType,
      provider
    });

    // Validate user has sufficient balance for the source currency
    const balanceValidation = await validateUserBalance(userId, sourceCurrency, payAmount);
    
    if (!balanceValidation.success) {
      const errorResponse = {
        success: false,
        message: `Insufficient balance: ${balanceValidation.message}`,
        balanceError: true,
        availableBalance: balanceValidation.availableBalance,
        requiredAmount: payAmount,
        currency: sourceCurrency
      };
      
      return res.status(400).json(errorResponse);
    }

    // Create swap transactions with SUCCESSFUL status for immediate completion
    try {
      // Calculate exchange rate
      const exchangeRate = receiveAmount / payAmount;

      // Create swap transaction pair
      const swapTransactions = await Transaction.createSwapTransactions({
        userId,
        quoteId,
        sourceCurrency,
        targetCurrency,
        sourceAmount: payAmount,
        targetAmount: receiveAmount,
        exchangeRate,
        swapType,
        provider,
        markdownApplied: 0, // Markdown already applied in price cache
        swapFee: 0,
        quoteExpiresAt: new Date(quoteData.expiresAt),
        status: 'SUCCESSFUL',
        obiexTransactionId: `internal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      });

      logger.info('POST /swap/quote/:quoteId - Swap transactions created', {
        userId,
        quoteId,
        swapId: swapTransactions.swapId
      });

      // Update balances directly
      try {
        if (isNGNZQuote) {
          // For NGNZ swaps, use the NGNZ helper function
          await updateUserBalanceForNGNZ(userId, sourceCurrency, -payAmount);
          await updateUserBalanceForNGNZ(userId, targetCurrency, receiveAmount);
        } else {
          // For regular swaps, use portfolio service
          await updateUserBalance(userId, sourceCurrency, -payAmount);
          await updateUserBalance(userId, targetCurrency, receiveAmount);
        }

        // Update portfolio balance (with error handling)
        try {
          await updateUserPortfolioBalance(userId);
        } catch (portfolioError) {
          logger.warn('Portfolio update failed (non-critical)', {
            userId,
            error: portfolioError.message
          });
        }

        logger.info('POST /swap/quote/:quoteId - Swap completed successfully', {
          userId,
          swapId: swapTransactions.swapId,
          sourceCurrency,
          targetCurrency,
          sourceAmount: payAmount,
          targetAmount: receiveAmount,
          provider
        });

      } catch (balanceError) {
        logger.error('POST /swap/quote/:quoteId - Failed to update balances', {
          userId,
          swapId: swapTransactions.swapId,
          error: balanceError.message
        });

        // Update transactions to FAILED status
        await Transaction.updateSwapStatus(swapTransactions.swapId, 'FAILED');

        const errorResponse = {
          success: false,
          message: "Swap failed during balance update. Please contact support.",
          error: balanceError.message
        };
        
        return res.status(500).json(errorResponse);
      }

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
            swapType,
            provider,
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
      const errorResponse = {
        success: false,
        message: "Failed to create swap transactions. Please contact support.",
        error: transactionError.message
      };
      
      logger.error('POST /swap/quote/:quoteId - Failed to create swap transactions', {
        userId,
        quoteId,
        error: transactionError.message,
        stack: transactionError.stack
      });
      
      return res.status(500).json(errorResponse);
    }

  } catch (error) {
    const errorResponse = {
      success: false,
      message: "Internal server error",
      error: error.message
    };
    
    logger.error('POST /swap/quote/:quoteId - Server error', {
      quoteId: req.params.quoteId,
      userId: req.user?.id,
      error: error.message,
      stack: error.stack
    });
    
    res.status(500).json(errorResponse);
  }
});

router.get('/tokens', (req, res) => {
  try {
    logger.info('GET /swap/tokens - Request received', {
      userId: req.user?.id,
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });

    const tokens = Object.entries(TOKEN_MAP).map(([code, info]) => ({
      code: code,
      name: info.name,
      currency: info.currency
    }));

    const finalResponse = {
      success: true,
      message: "Supported tokens retrieved successfully",
      data: tokens,
      total: tokens.length
    };

    res.json(finalResponse);

  } catch (error) {
    const errorResponse = {
      success: false,
      message: "Internal server error",
      error: error.message
    };
    
    logger.error('GET /swap/tokens - Server error', {
      userId: req.user?.id,
      error: error.message
    });
    
    res.status(500).json(errorResponse);
  }
});

// Helper endpoint to get user balance for a specific currency
router.get('/balance/:currency', async (req, res) => {
  try {
    const { currency } = req.params;
    const userId = req.user.id;
    
    logger.info('GET /swap/balance/:currency - Request received', {
      userId,
      currency,
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });
    
    const balanceInfo = await getUserAvailableBalance(userId, currency);
    
    if (!balanceInfo.success) {
      return res.status(400).json(balanceInfo);
    }
    
    const finalResponse = {
      success: true,
      message: "Balance retrieved successfully",
      data: balanceInfo
    };
    
    res.json(finalResponse);
    
  } catch (error) {
    const errorResponse = {
      success: false,
      message: "Failed to retrieve balance",
      error: error.message
    };
    
    logger.error('GET /swap/balance/:currency - Error fetching user balance', {
      userId: req.user?.id,
      currency: req.params.currency,
      error: error.message,
      stack: error.stack
    });
    
    res.status(500).json(errorResponse);
  }
});

// Log router initialization
logger.info('Clean swap router initialized with portfolio pricing', {
  endpoints: [
    'POST /swap/quote',
    'POST /swap/quote/:quoteId', 
    'GET /swap/tokens',
    'GET /swap/balance/:currency'
  ],
  tokenMapSize: Object.keys(TOKEN_MAP).length,
  supportedTokens: Object.keys(TOKEN_MAP),
  features: [
    'Portfolio service pricing (with built-in markdown)',
    'Immediate swap completion',
    'NGNZ onramp/offramp support',
    'No redundant spreads or markdowns',
    'Internal liquidity management'
  ]
});

module.exports = router;