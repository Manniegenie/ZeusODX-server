const express = require('express');
const axios = require('axios');
const { attachObiexAuth } = require('../utils/obiexAuth');
const tradingPairsService = require('../services/tradingPairsService');
const GlobalSwapMarkdown = require('../models/swapmarkdown');
const onrampService = require('../services/onramppriceservice');
const offrampService = require('../services/offramppriceservice');
const priceService = require('../services/priceService');
const { updateUserBalance, updateUserPortfolioBalance } = require('../services/portfolio');
const { validateUserBalance, getUserAvailableBalance } = require('../services/balance');
const logger = require('../utils/logger');

const router = express.Router();

const BASE_URL = process.env.OBIEX_BASE_URL || 'https://api.obiex.finance';
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

// Store quote data temporarily (in production, use Redis or database)
const quoteCache = new Map();

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

async function getCurrencyId(currencyCode) {
  const normalizedCode = currencyCode.toUpperCase();
  
  if (!TOKEN_MAP[normalizedCode]) {
    throw new Error(`Currency ${normalizedCode} not supported`);
  }

  const pairsResult = await tradingPairsService.getAllPairs();
  
  if (!pairsResult.success) {
    throw new Error('Failed to fetch trading pairs');
  }

  for (const pair of pairsResult.data) {
    if (pair.source?.code === normalizedCode) {
      return pair.source.id;
    }
    if (pair.target?.code === normalizedCode) {
      return pair.target.id;
    }
  }

  throw new Error(`Currency ID not found for ${normalizedCode}`);
}

async function createQuote(sourceId, targetId, side, amount) {
  try {
    const apiClient = createApiClient();
    
    const response = await apiClient.post('/v1/trades/quote', {
      sourceId: sourceId,
      targetId: targetId,
      side: side,
      amount: amount
    });

    return {
      success: true,
      data: response.data
    };

  } catch (error) {
    return {
      success: false,
      error: error.response?.data || error.message
    };
  }
}

async function acceptQuote(quoteId) {
  try {
    const apiClient = createApiClient();
    const response = await apiClient.post(`/v1/trades/quote/${quoteId}`);

    return {
      success: true,
      data: response.data
    };

  } catch (error) {
    return {
      success: false,
      error: error.response?.data || error.message
    };
  }
}

// Handle NGNZ swaps using onramp/offramp services
async function handleNGNZSwap(req, res, from, to, amount, side) {
  try {
    const fromUpper = from.toUpperCase();
    const toUpper = to.toUpperCase();
    
    // Determine if this is onramp (NGNZ -> crypto) or offramp (crypto -> NGNZ)
    const isOnramp = fromUpper === 'NGNZ' && toUpper !== 'NGNZ';
    const isOfframp = fromUpper !== 'NGNZ' && toUpper === 'NGNZ';
    
    if (!isOnramp && !isOfframp) {
      return res.status(400).json({
        success: false,
        message: "Invalid NGNZ swap configuration"
      });
    }
    
    let cryptoCurrency, receiveAmount, payAmount;
    let quoteData;
    
    if (isOnramp) {
      // User is paying NGNZ to get crypto (onramp)
      cryptoCurrency = toUpper;
      payAmount = amount; // Amount of NGNZ user is paying
      
      // Get current crypto price
      const cryptoPrices = await priceService.getPricesWithCache([cryptoCurrency]);
      const cryptoPrice = cryptoPrices[cryptoCurrency];
      
      if (!cryptoPrice || cryptoPrice <= 0) {
        return res.status(500).json({
          success: false,
          message: `Unable to get price for ${cryptoCurrency}`
        });
      }
      
      // Calculate how much crypto user gets for their NGNZ
      receiveAmount = await onrampService.calculateCryptoFromNaira(amount, cryptoCurrency, cryptoPrice);
      
      quoteData = {
        id: `ngnz_onramp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        sourceId: 'ngnz_source',
        targetId: 'crypto_target',
        side: side,
        amount: payAmount,
        receiveAmount: receiveAmount,
        rate: cryptoPrice,
        ngnzRate: (await onrampService.getOnrampRate()).finalPrice,
        type: 'onramp',
        sourceCurrency: fromUpper,
        targetCurrency: toUpper,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() // 5 minutes
      };
      
    } else if (isOfframp) {
      // User is selling crypto to get NGNZ (offramp)
      cryptoCurrency = fromUpper;
      payAmount = amount; // Amount of crypto user is selling
      
      // Get current crypto price
      const cryptoPrices = await priceService.getPricesWithCache([cryptoCurrency]);
      const cryptoPrice = cryptoPrices[cryptoCurrency];
      
      if (!cryptoPrice || cryptoPrice <= 0) {
        return res.status(500).json({
          success: false,
          message: `Unable to get price for ${cryptoCurrency}`
        });
      }
      
      // Calculate how much NGNZ user gets for their crypto
      receiveAmount = await offrampService.calculateNairaFromCrypto(amount, cryptoCurrency, cryptoPrice);
      
      quoteData = {
        id: `ngnz_offramp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        sourceId: 'crypto_source',
        targetId: 'ngnz_target',
        side: side,
        amount: payAmount,
        receiveAmount: receiveAmount,
        rate: cryptoPrice,
        ngnzRate: (await offrampService.getCurrentRate()).finalPrice,
        type: 'offramp',
        sourceCurrency: fromUpper,
        targetCurrency: toUpper,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() // 5 minutes
      };
    }
    
    // Store quote data for later use in acceptance
    quoteCache.set(quoteData.id, quoteData);
    
    console.log(`[NGNZ SWAP] ${isOnramp ? 'ONRAMP' : 'OFFRAMP'}: ${from}-${to}, Pay: ${payAmount}, Receive: ${receiveAmount}, Rate: ${quoteData.ngnzRate}`);
    
    return res.json({
      success: true,
      message: `NGNZ ${isOnramp ? 'onramp' : 'offramp'} quote created successfully`,
      data: quoteData
    });
    
  } catch (error) {
    console.error('Error creating NGNZ swap quote:', error);
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

    const pairCheck = await tradingPairsService.isPairAvailable(from, to);
    if (!pairCheck.success || !pairCheck.data.available) {
      return res.status(400).json({
        success: false,
        message: `Trading pair ${from}-${to} not available`
      });
    }

    if (side === 'BUY' && !pairCheck.data.buyable) {
      return res.status(400).json({
        success: false,
        message: `Buy operation not supported for ${from}-${to}`
      });
    }

    if (side === 'SELL' && !pairCheck.data.sellable) {
      return res.status(400).json({
        success: false,
        message: `Sell operation not supported for ${from}-${to}`
      });
    }

    // Check if this is a NGNZ swap and handle it differently
    const isNGNZSwap = from.toUpperCase() === 'NGNZ' || to.toUpperCase() === 'NGNZ';
    
    if (isNGNZSwap) {
      // Handle NGNZ swaps using onramp/offramp services
      return await handleNGNZSwap(req, res, from, to, amount, side);
    }

    // Regular non-NGNZ swap logic
    const sourceId = await getCurrencyId(from);
    const targetId = await getCurrencyId(to);

    const quoteResult = await createQuote(sourceId, targetId, side, amount);

    if (!quoteResult.success) {
      return res.status(500).json({
        success: false,
        message: "Failed to create quote",
        error: quoteResult.error
      });
    }

    // Apply global markdown to reduce the amount user receives
    try {
      const originalReceiveAmount = quoteResult.data.receiveAmount || quoteResult.data.amount;
      const markedDownAmount = await GlobalSwapMarkdown.applyGlobalMarkdown(originalReceiveAmount);
      
      // Server-side logging for internal monitoring
      const markdownConfig = await GlobalSwapMarkdown.getGlobalMarkdown();
      console.log(`[MARKDOWN APPLIED] Pair: ${from}-${to}, Original: ${originalReceiveAmount}, Final: ${markedDownAmount}, Reduction: ${originalReceiveAmount - markedDownAmount}, Rate: ${markdownConfig.markdownPercentage}%`);
      
      quoteResult.data.receiveAmount = markedDownAmount;
    } catch (markdownError) {
      console.error('Error applying markdown:', markdownError);
      // Continue without markdown if there's an error
    }

    // Store quote data with source/target currencies for balance validation
    const enrichedQuoteData = {
      ...quoteResult.data,
      sourceCurrency: from.toUpperCase(),
      targetCurrency: to.toUpperCase(),
      originalAmount: amount,
      side: side
    };
    
    quoteCache.set(quoteResult.data.id, enrichedQuoteData);

    res.json({
      success: true,
      message: "Quote created successfully",
      data: quoteResult.data
    });

  } catch (error) {
    console.error('Error creating quote:', error);
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
    const { userId } = req.body; // Assuming userId is passed in request body

    if (!quoteId) {
      return res.status(400).json({
        success: false,
        message: "Quote ID is required"
      });
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is required"
      });
    }

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

    // Check if this is a NGNZ quote
    const isNGNZQuote = quoteId.includes('ngnz_onramp_') || quoteId.includes('ngnz_offramp_');
    
    let sourceCurrency, targetCurrency, payAmount, receiveAmount;
    
    if (isNGNZQuote) {
      // NGNZ swap handling
      sourceCurrency = quoteData.sourceCurrency;
      targetCurrency = quoteData.targetCurrency;
      payAmount = quoteData.amount;
      receiveAmount = quoteData.receiveAmount;
      
      logger.info('Processing NGNZ swap', {
        userId,
        quoteId,
        type: quoteData.type,
        sourceCurrency,
        targetCurrency,
        payAmount,
        receiveAmount
      });
    } else {
      // Regular swap handling
      sourceCurrency = quoteData.sourceCurrency;
      targetCurrency = quoteData.targetCurrency;
      
      // Determine amounts based on side
      if (quoteData.side === 'BUY') {
        // User is buying target currency with source currency
        payAmount = quoteData.originalAmount;
        receiveAmount = quoteData.receiveAmount || quoteData.amount;
      } else {
        // User is selling source currency for target currency  
        payAmount = quoteData.originalAmount;
        receiveAmount = quoteData.receiveAmount || quoteData.amount;
      }
      
      logger.info('Processing regular swap', {
        userId,
        quoteId,
        side: quoteData.side,
        sourceCurrency,
        targetCurrency,
        payAmount,
        receiveAmount
      });
    }

    // Validate user has sufficient balance for the source currency
    const balanceValidation = await validateUserBalance(userId, sourceCurrency, payAmount);
    
    if (!balanceValidation.success) {
      logger.warn('Swap failed - insufficient balance', {
        userId,
        quoteId,
        sourceCurrency,
        requiredAmount: payAmount,
        error: balanceValidation.message
      });
      
      return res.status(400).json({
        success: false,
        message: `Insufficient balance: ${balanceValidation.message}`,
        balanceError: true,
        availableBalance: balanceValidation.availableBalance,
        requiredAmount: payAmount,
        currency: sourceCurrency
      });
    }

    let swapResult;
    
    if (isNGNZQuote) {
      // Handle NGNZ quote acceptance (mock processing)
      swapResult = {
        success: true,
        data: {
          id: quoteId,
          status: 'accepted',
          message: 'NGNZ swap quote accepted. Processing will be handled by the trading system.',
          acceptedAt: new Date().toISOString(),
          type: quoteData.type
        }
      };
    } else {
      // Regular quote acceptance through Obiex
      swapResult = await acceptQuote(quoteId);
      
      if (!swapResult.success) {
        logger.error('Obiex quote acceptance failed', {
          userId,
          quoteId,
          error: swapResult.error
        });
        
        return res.status(500).json({
          success: false,
          message: "Failed to accept quote",
          error: swapResult.error
        });
      }
    }

    // If swap was successful, update user balances
    try {
      logger.info('Updating user balances after successful swap', {
        userId,
        quoteId,
        deducting: `${payAmount} ${sourceCurrency}`,
        adding: `${receiveAmount} ${targetCurrency}`
      });

      // Deduct the source currency
      await updateUserBalance(userId, sourceCurrency, -payAmount);
      
      // Add the target currency
      await updateUserBalance(userId, targetCurrency, receiveAmount);
      
      // Update overall portfolio balance
      await updateUserPortfolioBalance(userId);
      
      // Clean up quote from cache
      quoteCache.delete(quoteId);
      
      logger.info('Swap completed successfully', {
        userId,
        quoteId,
        sourceCurrency,
        targetCurrency,
        payAmount,
        receiveAmount
      });

      res.json({
        success: true,
        message: "Swap completed successfully",
        data: {
          ...swapResult.data,
          swapDetails: {
            sourceCurrency,
            targetCurrency,
            payAmount,
            receiveAmount,
            completedAt: new Date().toISOString()
          }
        }
      });

    } catch (balanceUpdateError) {
      logger.error('Failed to update balances after successful swap', {
        userId,
        quoteId,
        error: balanceUpdateError.message
      });
      
      // This is a critical error - the swap succeeded but balance update failed
      // In production, this should trigger an alert and manual reconciliation
      return res.status(500).json({
        success: false,
        message: "Swap processed but balance update failed. Please contact support.",
        error: balanceUpdateError.message,
        criticalError: true,
        swapResult: swapResult.data
      });
    }

  } catch (error) {
    logger.error('Error processing swap', {
      quoteId: req.params.quoteId,
      error: error.message
    });
    
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
});

router.get('/pairs', async (req, res) => {
  try {
    const pairsResult = await tradingPairsService.getActivePairs();

    if (!pairsResult.success) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch trading pairs"
      });
    }

    const swapPairs = pairsResult.data
      .filter(pair => pair.isBuyable || pair.isSellable)
      .map(pair => ({
        id: pair.id,
        from: pair.source.code,
        to: pair.target.code,
        fromName: pair.source.name,
        toName: pair.target.name,
        buyable: pair.isBuyable,
        sellable: pair.isSellable
      }));

    res.json({
      success: true,
      message: "Trading pairs retrieved successfully",
      data: swapPairs,
      total: swapPairs.length
    });

  } catch (error) {
    console.error('Error fetching pairs:', error);
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
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
});

// Helper endpoint to get user balance for a specific currency
router.get('/balance/:userId/:currency', async (req, res) => {
  try {
    const { userId, currency } = req.params;
    
    const balanceInfo = await getUserAvailableBalance(userId, currency);
    
    if (!balanceInfo.success) {
      return res.status(400).json(balanceInfo);
    }
    
    res.json({
      success: true,
      message: "Balance retrieved successfully",
      data: balanceInfo
    });
    
  } catch (error) {
    logger.error('Error fetching user balance', {
      userId: req.params.userId,
      currency: req.params.currency,
      error: error.message
    });
    
    res.status(500).json({
      success: false,
      message: "Failed to retrieve balance",
      error: error.message
    });
  }
});

module.exports = router;