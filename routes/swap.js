const express = require('express');
const axios = require('axios');
const { attachObiexAuth } = require('../utils/obiexAuth');
const GlobalSwapMarkdown = require('../models/swapmarkdown');
const onrampService = require('../services/onramppriceservice');
const offrampService = require('../services/offramppriceservice');
const { validateUserBalance, getUserAvailableBalance } = require('../services/balance');
const { updateUserPortfolioBalance } = require('../services/portfolio');
const Transaction = require('../models/transaction'); // Add Transaction model
const User = require('../models/user'); // Add User model for NGNZ balance updates
const logger = require('../utils/logger');

const router = express.Router();

// NOTE: Authentication is handled globally in server.js via authenticateToken middleware
// No need for additional authentication here since req.user.id is already available

const BASE_URL = process.env.OBIEX_BASE_URL || 'https://staging.api.obiex.finance/v1/';
const REQUEST_TIMEOUT = 10000;

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

function createApiClient() {
  const client = axios.create({
    baseURL: BASE_URL,
    timeout: REQUEST_TIMEOUT,
    headers: {
      'Content-Type': 'application/json'
    }
  });

  client.interceptors.request.use(attachObiexAuth);
  client.interceptors.response.use(
    response => response,
    error => {
      console.error('API Error:', error.response?.data || error.message);
      return Promise.reject(error);
    }
  );

  return client;
}

async function createQuote(sourceId, targetId, side, amount) {
  try {
    logger.info('createQuote - Creating Obiex quote', {
      sourceId,
      targetId,
      side,
      amount
    });

    const apiClient = createApiClient();
    
    const response = await apiClient.post('/trades/quote', {
      sourceId: sourceId,
      targetId: targetId,
      side: side,
      amount: amount
    });

    logger.info('createQuote - Obiex quote created successfully', {
      sourceId,
      targetId,
      side,
      amount,
      response: response.data
    });

    return {
      success: true,
      data: response.data
    };

  } catch (error) {
    logger.error('createQuote - Failed to create Obiex quote', {
      sourceId,
      targetId,
      side,
      amount,
      error: error.response?.data || error.message
    });

    return {
      success: false,
      error: error.response?.data || error.message
    };
  }
}

async function acceptQuote(quoteId) {
  try {
    logger.info('acceptQuote - Accepting Obiex quote', {
      quoteId
    });

    const apiClient = createApiClient();
    const response = await apiClient.post(`/trades/quote/${quoteId}`);

    logger.info('acceptQuote - Obiex quote accepted successfully', {
      quoteId,
      response: response.data
    });

    return {
      success: true,
      data: response.data
    };

  } catch (error) {
    logger.error('acceptQuote - Failed to accept Obiex quote', {
      quoteId,
      error: error.response?.data || error.message
    });

    return {
      success: false,
      error: error.response?.data || error.message
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
        ngnzRate: onrampRate.finalPrice,
        type: 'onramp',
        sourceCurrency: fromUpper,
        targetCurrency: toUpper,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 1000).toISOString() // 10 seconds
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
        ngnzRate: offrampRate.finalPrice,
        type: 'offramp',
        sourceCurrency: fromUpper,
        targetCurrency: toUpper,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 1000).toISOString() // 10 seconds
      };
    }
    
    // Store quote data for later use in acceptance
    quoteCache.set(quoteData.id, quoteData);
    
    logger.info('handleNGNZSwap - Quote cached successfully', {
      userId,
      quoteId: quoteData.id,
      cacheSize: quoteCache.size,
      quoteData: quoteData
    });
    
    const finalResponse = {
      success: true,
      message: `NGNZ ${isOnramp ? 'onramp' : 'offramp'} quote created successfully`,
      data: quoteData
    };

    logger.info('handleNGNZSwap - NGNZ swap quote created successfully', {
      userId,
      type: isOnramp ? 'ONRAMP' : 'OFFRAMP',
      pair: `${from}-${to}`,
      payAmount,
      receiveAmount,
      rate: quoteData.ngnzRate,
      quoteId: quoteData.id,
      response: finalResponse
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
      stack: error.stack,
      response: errorResponse
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
        error: 'Missing required fields',
        response: errorResponse
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
        amount,
        response: errorResponse
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
        side,
        response: errorResponse
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

    // Regular non-NGNZ swap logic
    logger.info('POST /swap/quote - Creating Obiex quote', {
      userId: req.user?.id,
      from: from.toUpperCase(),
      to: to.toUpperCase(),
      amount,
      side
    });
    
    // Use Obiex API directly to create quote
    const apiClient = createApiClient();
    
    const response = await apiClient.post('/trades/quote', {
      sourceId: from.toUpperCase(),
      targetId: to.toUpperCase(),
      side: side,
      amount: amount
    });

    logger.info('POST /swap/quote - Obiex API response received', {
      userId: req.user?.id,
      obiexResponse: response.data
    });

    const quoteResult = {
      success: true,
      data: response.data
    };

    // Apply global markdown to reduce the amount user receives
    try {
      const originalReceiveAmount = quoteResult.data.data.amountReceived || quoteResult.data.data.amount;
      const markedDownAmount = await GlobalSwapMarkdown.applyGlobalMarkdown(originalReceiveAmount);
      
      // Server-side logging for internal monitoring
      const markdownConfig = await GlobalSwapMarkdown.getGlobalMarkdown();
      logger.info('POST /swap/quote - Markdown applied', {
        userId: req.user?.id,
        pair: `${from}-${to}`,
        originalAmount: originalReceiveAmount,
        markedDownAmount,
        reduction: originalReceiveAmount - markedDownAmount,
        markdownPercentage: markdownConfig.markdownPercentage
      });
      
      // Set receiveAmount at the level frontend expects (data.receiveAmount)
      quoteResult.data.receiveAmount = markedDownAmount;
    } catch (markdownError) {
      logger.error('POST /swap/quote - Markdown error', {
        userId: req.user?.id,
        error: markdownError.message
      });
      // Continue without markdown if there's an error
    }

    // FIXED: Store quote data with correct quote ID path
    const quoteId = quoteResult.data.data.id;
    const enrichedQuoteData = {
      ...quoteResult.data,
      sourceCurrency: from.toUpperCase(),
      targetCurrency: to.toUpperCase(),
      originalAmount: amount,
      side: side,
      expiresAt: new Date(Date.now() + 10 * 1000).toISOString() // 10 seconds
    };
    
    // FIXED: Use correct quote ID path for cache storage
    console.log('🔍 Storing quote with ID:', quoteId);
    quoteCache.set(quoteId, enrichedQuoteData);

    logger.info('POST /swap/quote - Quote cached and response ready', {
      userId: req.user?.id,
      quoteId: quoteId,
      cacheSize: quoteCache.size,
      response: quoteResult.data
    });

    const finalResponse = {
      success: true,
      message: "Quote created successfully",
      data: quoteResult.data
    };

    logger.info('POST /swap/quote - Success response sent', {
      userId: req.user?.id,
      response: finalResponse
    });

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
    const userId = req.user.id; // Get userId from JWT token

    // LOG: Request received
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
      
      logger.warn('POST /swap/quote/:quoteId - Missing quote ID', {
        userId,
        response: errorResponse
      });
      
      return res.status(400).json(errorResponse);
    }

    // Get quote data from cache
    const quoteData = quoteCache.get(quoteId);
    
    logger.info('POST /swap/quote/:quoteId - Quote cache lookup', {
      userId,
      quoteId,
      found: !!quoteData,
      cacheSize: quoteCache.size,
      quoteData: quoteData ? {
        sourceCurrency: quoteData.sourceCurrency,
        targetCurrency: quoteData.targetCurrency,
        amount: quoteData.amount,
        expiresAt: quoteData.expiresAt
      } : null
    });
    
    if (!quoteData) {
      const errorResponse = {
        success: false,
        message: "Quote not found or expired"
      };
      
      logger.warn('POST /swap/quote/:quoteId - Quote not found', {
        userId,
        quoteId,
        response: errorResponse
      });
      
      return res.status(404).json(errorResponse);
    }

    // Check if quote has expired
    if (quoteData.expiresAt && new Date() > new Date(quoteData.expiresAt)) {
      quoteCache.delete(quoteId);
      
      const errorResponse = {
        success: false,
        message: "Quote has expired"
      };
      
      logger.warn('POST /swap/quote/:quoteId - Quote expired', {
        userId,
        quoteId,
        expiresAt: quoteData.expiresAt,
        currentTime: new Date().toISOString(),
        response: errorResponse
      });
      
      return res.status(410).json(errorResponse);
    }

    // Check if this is a NGNZ quote
    const isNGNZQuote = quoteId.includes('ngnz_onramp_') || quoteId.includes('ngnz_offramp_');
    
    let sourceCurrency, targetCurrency, payAmount, receiveAmount, swapType;
    
    if (isNGNZQuote) {
      // NGNZ swap handling
      sourceCurrency = quoteData.sourceCurrency;
      targetCurrency = quoteData.targetCurrency;
      payAmount = quoteData.amount;
      receiveAmount = quoteData.receiveAmount;
      swapType = quoteData.type === 'onramp' ? 'ONRAMP' : 'OFFRAMP';
      
      logger.info('POST /swap/quote/:quoteId - Processing NGNZ swap', {
        userId,
        quoteId,
        type: quoteData.type,
        sourceCurrency,
        targetCurrency,
        payAmount,
        receiveAmount,
        swapType
      });
    } else {
      // Regular swap handling
      sourceCurrency = quoteData.sourceCurrency;
      targetCurrency = quoteData.targetCurrency;
      swapType = 'CRYPTO_TO_CRYPTO';
      
      // Determine amounts based on side
      if (quoteData.side === 'BUY') {
        payAmount = quoteData.originalAmount;
        receiveAmount = quoteData.receiveAmount || quoteData.amountReceived || quoteData.amount;
      } else {
        payAmount = quoteData.originalAmount;
        receiveAmount = quoteData.receiveAmount || quoteData.amountReceived || quoteData.amount;
      }
      
      logger.info('POST /swap/quote/:quoteId - Processing regular swap', {
        userId,
        quoteId,
        side: quoteData.side,
        sourceCurrency,
        targetCurrency,
        payAmount,
        receiveAmount,
        swapType
      });
    }

    // Validate user has sufficient balance for the source currency
    logger.info('POST /swap/quote/:quoteId - Validating user balance', {
      userId,
      quoteId,
      sourceCurrency,
      requiredAmount: payAmount
    });
    
    const balanceValidation = await validateUserBalance(userId, sourceCurrency, payAmount);
    
    logger.info('POST /swap/quote/:quoteId - Balance validation result', {
      userId,
      quoteId,
      balanceValidation
    });
    
    if (!balanceValidation.success) {
      const errorResponse = {
        success: false,
        message: `Insufficient balance: ${balanceValidation.message}`,
        balanceError: true,
        availableBalance: balanceValidation.availableBalance,
        requiredAmount: payAmount,
        currency: sourceCurrency
      };
      
      logger.warn('POST /swap/quote/:quoteId - Insufficient balance', {
        userId,
        quoteId,
        sourceCurrency,
        requiredAmount: payAmount,
        error: balanceValidation.message,
        response: errorResponse
      });
      
      return res.status(400).json(errorResponse);
    }

    let swapResult = null;
    let obiexTransactionId = null;
    
    if (!isNGNZQuote) {
      // For regular swaps, accept quote through Obiex
      logger.info('POST /swap/quote/:quoteId - Accepting Obiex quote', {
        userId,
        quoteId
      });
      
      swapResult = await acceptQuote(quoteId);
      
      logger.info('POST /swap/quote/:quoteId - Obiex quote acceptance result', {
        userId,
        quoteId,
        success: swapResult.success,
        swapResult: swapResult.success ? swapResult.data : swapResult.error
      });
      
      if (!swapResult.success) {
        const errorResponse = {
          success: false,
          message: "Failed to accept quote",
          error: swapResult.error
        };
        
        logger.error('POST /swap/quote/:quoteId - Obiex quote acceptance failed', {
          userId,
          quoteId,
          error: swapResult.error,
          response: errorResponse
        });
        
        return res.status(500).json(errorResponse);
      }

      // Extract Obiex transaction ID for webhook integration
      if (swapResult?.data) {
        obiexTransactionId = swapResult.data.id || swapResult.data.transactionId || swapResult.data.reference;
        
        logger.info('POST /swap/quote/:quoteId - Extracted Obiex transaction ID', {
          userId,
          quoteId,
          obiexTransactionId
        });
      }
    }

    // Create swap transactions in PENDING status (webhooks will update balances for Obiex, direct update for NGNZ)
    try {
      logger.info('POST /swap/quote/:quoteId - Creating swap transactions', {
        userId,
        quoteId,
        sourceCurrency,
        targetCurrency,
        payAmount,
        receiveAmount,
        swapType,
        obiexTransactionId
      });

      // Calculate exchange rate
      const exchangeRate = receiveAmount / payAmount;

      // Get markdown info if available
      let markdownApplied = 0;
      try {
        const markdownConfig = await GlobalSwapMarkdown.getGlobalMarkdown();
        markdownApplied = markdownConfig.markdownPercentage || 0;
        
        logger.info('POST /swap/quote/:quoteId - Markdown config retrieved', {
          userId,
          quoteId,
          markdownApplied
        });
      } catch (err) {
        logger.warn('POST /swap/quote/:quoteId - Could not get markdown config', {
          userId,
          quoteId,
          error: err.message
        });
      }

      // Create swap transaction pair using your Transaction model
      const swapTransactions = await Transaction.createSwapTransactions({
        userId,
        quoteId,
        sourceCurrency,
        targetCurrency,
        sourceAmount: payAmount,
        targetAmount: receiveAmount,
        exchangeRate,
        swapType,
        provider: isNGNZQuote ? (swapType === 'ONRAMP' ? 'ONRAMP_SERVICE' : 'OFFRAMP_SERVICE') : 'OBIEX',
        markdownApplied,
        swapFee: 0, // You can calculate this if needed
        quoteExpiresAt: new Date(quoteData.expiresAt),
        status: 'PENDING',
        obiexTransactionId // Pass obiexTransactionId for webhook integration
      });

      logger.info('POST /swap/quote/:quoteId - Swap transactions created', {
        userId,
        quoteId,
        swapId: swapTransactions.swapId,
        swapOutTransactionId: swapTransactions.swapOutTransaction._id,
        swapInTransactionId: swapTransactions.swapInTransaction._id
      });

      // UPDATED: For NGNZ swaps, update balances directly and mark as SUCCESSFUL
      if (isNGNZQuote) {
        try {
          logger.info('POST /swap/quote/:quoteId - Processing NGNZ swap balance updates directly', {
            userId,
            swapId: swapTransactions.swapId,
            sourceCurrency,
            targetCurrency,
            payAmount,
            receiveAmount
          });

          // Update transaction status to SUCCESSFUL for NGNZ swaps
          await Transaction.updateSwapStatus(swapTransactions.swapId, 'SUCCESSFUL');

          // Deduct source currency (amount being paid)
          await updateUserBalanceForNGNZ(userId, sourceCurrency, -payAmount);
          logger.info(`POST /swap/quote/:quoteId - NGNZ Swap: Deducted ${payAmount} ${sourceCurrency} from user ${userId}`);

          // Add target currency (amount being received)
          await updateUserBalanceForNGNZ(userId, targetCurrency, receiveAmount);
          logger.info(`POST /swap/quote/:quoteId - NGNZ Swap: Added ${receiveAmount} ${targetCurrency} to user ${userId}`);

          // Update portfolio balance
          await updateUserPortfolioBalance(userId);
          logger.info(`POST /swap/quote/:quoteId - NGNZ Swap: Updated portfolio balance for user ${userId}`);

          logger.info('POST /swap/quote/:quoteId - NGNZ swap completed successfully with direct balance updates', {
            userId,
            swapId: swapTransactions.swapId,
            sourceCurrency,
            targetCurrency,
            sourceAmount: payAmount,
            targetAmount: receiveAmount,
            exchangeRate
          });

        } catch (balanceError) {
          logger.error('POST /swap/quote/:quoteId - Failed to update balances for NGNZ swap', {
            userId,
            swapId: swapTransactions.swapId,
            error: balanceError.message,
            stack: balanceError.stack
          });

          // Update transactions to FAILED status
          await Transaction.updateSwapStatus(swapTransactions.swapId, 'FAILED');

          const errorResponse = {
            success: false,
            message: "NGNZ swap failed during balance update. Please contact support.",
            error: balanceError.message
          };
          
          return res.status(500).json(errorResponse);
        }
      }

      // Clean up quote from cache
      quoteCache.delete(quoteId);
      
      logger.info('POST /swap/quote/:quoteId - Quote removed from cache', {
        userId,
        quoteId,
        remainingCacheSize: quoteCache.size
      });
      
      const finalResponse = {
        success: true,
        message: isNGNZQuote 
          ? "NGNZ swap completed successfully with balance updates." 
          : "Swap initiated successfully. Transactions created in pending status.",
        data: {
          swapId: swapTransactions.swapId,
          quoteId,
          status: isNGNZQuote ? 'SUCCESSFUL' : 'PENDING',
          swapDetails: {
            sourceCurrency,
            targetCurrency,
            sourceAmount: payAmount,
            targetAmount: receiveAmount,
            exchangeRate,
            swapType,
            createdAt: new Date().toISOString(),
            completedAt: isNGNZQuote ? new Date().toISOString() : null
          },
          transactions: {
            swapOut: {
              id: swapTransactions.swapOutTransaction._id,
              type: swapTransactions.swapOutTransaction.type,
              currency: sourceCurrency,
              amount: -payAmount,
              obiexTransactionId
            },
            swapIn: {
              id: swapTransactions.swapInTransaction._id,
              type: swapTransactions.swapInTransaction.type,
              currency: targetCurrency,
              amount: receiveAmount,
              obiexTransactionId
            }
          },
          obiexData: swapResult?.data || null,
          balanceUpdated: isNGNZQuote // Indicates if balance was updated directly
        }
      };

      logger.info('POST /swap/quote/:quoteId - Success response ready', {
        userId,
        quoteId,
        swapId: swapTransactions.swapId,
        finalStatus: isNGNZQuote ? 'SUCCESSFUL' : 'PENDING',
        response: finalResponse
      });

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
        stack: transactionError.stack,
        response: errorResponse
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
      stack: error.stack,
      response: errorResponse
    });
    
    res.status(500).json(errorResponse);
  }
});

router.get('/tokens', (req, res) => {
  try {
    // LOG: Request received
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

    logger.info('GET /swap/tokens - Tokens prepared', {
      userId: req.user?.id,
      tokenCount: tokens.length,
      tokens: tokens
    });

    const finalResponse = {
      success: true,
      message: "Supported tokens retrieved successfully",
      data: tokens,
      total: tokens.length
    };

    logger.info('GET /swap/tokens - Success response sent', {
      userId: req.user?.id,
      response: finalResponse
    });

    res.json(finalResponse);

  } catch (error) {
    const errorResponse = {
      success: false,
      message: "Internal server error",
      error: error.message
    };
    
    logger.error('GET /swap/tokens - Server error', {
      userId: req.user?.id,
      error: error.message,
      response: errorResponse
    });
    
    res.status(500).json(errorResponse);
  }
});

// Helper endpoint to get user balance for a specific currency
router.get('/balance/:currency', async (req, res) => {
  try {
    const { currency } = req.params;
    const userId = req.user.id; // Get userId from JWT token
    
    // LOG: Request received
    logger.info('GET /swap/balance/:currency - Request received', {
      userId,
      currency,
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });
    
    logger.info('GET /swap/balance/:currency - Fetching user balance', {
      userId,
      currency
    });
    
    const balanceInfo = await getUserAvailableBalance(userId, currency);
    
    logger.info('GET /swap/balance/:currency - Balance info retrieved', {
      userId,
      currency,
      success: balanceInfo.success,
      balanceInfo: balanceInfo
    });
    
    if (!balanceInfo.success) {
      logger.warn('GET /swap/balance/:currency - Balance retrieval failed', {
        userId,
        currency,
        error: balanceInfo.message || 'Unknown error',
        response: balanceInfo
      });
      
      return res.status(400).json(balanceInfo);
    }
    
    const finalResponse = {
      success: true,
      message: "Balance retrieved successfully",
      data: balanceInfo
    };

    logger.info('GET /swap/balance/:currency - Success response sent', {
      userId,
      currency,
      response: finalResponse
    });
    
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
      stack: error.stack,
      response: errorResponse
    });
    
    res.status(500).json(errorResponse);
  }
});

// Log router initialization
logger.info('Swap router initialized', {
  endpoints: [
    'POST /swap/quote',
    'POST /swap/quote/:quoteId', 
    'GET /swap/tokens',
    'GET /swap/balance/:currency'
  ],
  tokenMapSize: Object.keys(TOKEN_MAP).length,
  supportedTokens: Object.keys(TOKEN_MAP)
});

module.exports = router;