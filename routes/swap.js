const express = require('express');
const axios = require('axios');
const { attachObiexAuth } = require('../utils/obiexAuth');
const tradingPairsService = require('../services/tradingPairsService');
const GlobalSwapMarkdown = require('../models/GlobalSwapMarkdown'); // Add this import
const onrampService = require('../services/onrampService'); // Add onramp service
const offrampService = require('../services/offrampService'); // Add offramp service
const priceService = require('../services/priceService'); // Add price service for crypto prices

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

// NEW: Handle NGNZ swaps using onramp/offramp services
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

    if (!quoteId) {
      return res.status(400).json({
        success: false,
        message: "Quote ID is required"
      });
    }

    // Check if this is a NGNZ quote (doesn't go through Obiex)
    const isNGNZQuote = quoteId.includes('ngnz_onramp_') || quoteId.includes('ngnz_offramp_');
    
    if (isNGNZQuote) {
      // Handle NGNZ quote acceptance
      return res.json({
        success: true,
        message: "NGNZ quote accepted successfully",
        data: {
          id: quoteId,
          status: 'accepted',
          message: 'NGNZ swap quote accepted. Processing will be handled by the trading system.',
          acceptedAt: new Date().toISOString(),
          type: quoteId.includes('onramp') ? 'onramp' : 'offramp'
        }
      });
    }

    // Regular quote acceptance through Obiex
    const acceptResult = await acceptQuote(quoteId);

    if (!acceptResult.success) {
      return res.status(500).json({
        success: false,
        message: "Failed to accept quote",
        error: acceptResult.error
      });
    }

    res.json({
      success: true,
      message: "Quote accepted successfully",
      data: acceptResult.data
    });

  } catch (error) {
    console.error('Error accepting quote:', error);
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

module.exports = router;