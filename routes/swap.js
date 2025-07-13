const express = require('express');
const axios = require('axios');
const { attachObiexAuth } = require('../utils/obiexAuth');
const GlobalSwapMarkdown = require('../models/swapmarkdown');
const onrampService = require('../services/onramppriceservice');
const offrampService = require('../services/offramppriceservice');
const { validateUserBalance } = require('../services/balance');
const { updateUserPortfolioBalance } = require('../services/portfolio');
const Transaction = require('../models/transaction');
const User = require('../models/user');
const logger = require('../utils/logger');

const router = express.Router();

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

const quoteCache = new Map();

async function updateUserBalanceForNGNZ(userId, currency, amount) {
  const normalizedCurrency = currency.toUpperCase();
  const balanceField = CURRENCY_BALANCE_MAP[normalizedCurrency];
  
  if (!balanceField) {
    logger.warn(`No balance field mapping for currency: ${normalizedCurrency}`);
    return;
  }
  
  const user = await User.findById(userId);
  if (!user) {
    throw new Error('User not found');
  }
  
  const currentBalance = user[balanceField] || 0;
  const newBalance = Math.max(0, currentBalance + amount);
  
  user[balanceField] = newBalance;
  await user.save();
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
    const apiClient = createApiClient();
    const response = await apiClient.post('/trades/quote', {
      sourceId,
      targetId,
      side,
      amount
    });

    return {
      success: true,
      data: response.data
    };
  } catch (error) {
    logger.error('createQuote - Failed', { error: error.response?.data || error.message });
    return {
      success: false,
      error: error.response?.data || error.message
    };
  }
}

async function acceptQuote(quoteId) {
  try {
    const apiClient = createApiClient();
    const response = await apiClient.post(`/trades/quote/${quoteId}`);
    return {
      success: true,
      data: response.data
    };
  } catch (error) {
    logger.error('acceptQuote - Failed', { quoteId, error: error.response?.data || error.message });
    return {
      success: false,
      error: error.response?.data || error.message
    };
  }
}

async function handleNGNZSwap(req, res, from, to, amount, side) {
  try {
    const userId = req.user?.id;
    const fromUpper = from.toUpperCase();
    const toUpper = to.toUpperCase();
    
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
      cryptoCurrency = toUpper;
      payAmount = amount;
      receiveAmount = await onrampService.calculateCryptoFromNaira(amount, cryptoCurrency);
      const onrampRate = await onrampService.getOnrampRate();
      
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
        expiresAt: new Date(Date.now() + 10 * 1000).toISOString()
      };
    } else if (isOfframp) {
      cryptoCurrency = fromUpper;
      payAmount = amount;
      receiveAmount = await offrampService.calculateNairaFromCrypto(amount, cryptoCurrency);
      const offrampRate = await offrampService.getCurrentRate();
      
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
        expiresAt: new Date(Date.now() + 10 * 1000).toISOString()
      };
    }
    
    quoteCache.set(quoteData.id, quoteData);
    
    return res.json({
      success: true,
      message: `NGNZ ${isOnramp ? 'onramp' : 'offramp'} quote created successfully`,
      data: quoteData
    });
    
  } catch (error) {
    logger.error('handleNGNZSwap - Error', {
      userId: req.user?.id,
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

    const isNGNZSwap = from.toUpperCase() === 'NGNZ' || to.toUpperCase() === 'NGNZ';
    
    if (isNGNZSwap) {
      return await handleNGNZSwap(req, res, from, to, amount, side);
    }

    const apiClient = createApiClient();
    const response = await apiClient.post('/trades/quote', {
      sourceId: from.toUpperCase(),
      targetId: to.toUpperCase(),
      side: side,
      amount: amount
    });

    const quoteResult = {
      success: true,
      data: response.data
    };

    try {
      const originalReceiveAmount = quoteResult.data.data.amountReceived || quoteResult.data.data.amount;
      const markedDownAmount = await GlobalSwapMarkdown.applyGlobalMarkdown(originalReceiveAmount);
      quoteResult.data.receiveAmount = markedDownAmount;
    } catch (markdownError) {
      logger.error('POST /swap/quote - Markdown error', { error: markdownError.message });
    }

    const quoteId = quoteResult.data.data.id;
    const enrichedQuoteData = {
      ...quoteResult.data,
      sourceCurrency: from.toUpperCase(),
      targetCurrency: to.toUpperCase(),
      originalAmount: amount,
      side: side,
      expiresAt: new Date(Date.now() + 10 * 1000).toISOString()
    };
    
    quoteCache.set(quoteId, enrichedQuoteData);

    res.json({
      success: true,
      message: "Quote created successfully",
      data: quoteResult.data
    });

  } catch (error) {
    logger.error('POST /swap/quote - Server error', { error: error.message });
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

    if (!quoteId) {
      return res.status(400).json({
        success: false,
        message: "Quote ID is required"
      });
    }

    const quoteData = quoteCache.get(quoteId);
    
    if (!quoteData) {
      return res.status(404).json({
        success: false,
        message: "Quote not found or expired"
      });
    }

    if (quoteData.expiresAt && new Date() > new Date(quoteData.expiresAt)) {
      quoteCache.delete(quoteId);
      return res.status(410).json({
        success: false,
        message: "Quote has expired"
      });
    }

    const isNGNZQuote = quoteId.includes('ngnz_onramp_') || quoteId.includes('ngnz_offramp_');
    let sourceCurrency, targetCurrency, payAmount, receiveAmount, swapType;
    
    if (isNGNZQuote) {
      sourceCurrency = quoteData.sourceCurrency;
      targetCurrency = quoteData.targetCurrency;
      payAmount = quoteData.amount;
      receiveAmount = quoteData.receiveAmount;
      swapType = quoteData.type === 'onramp' ? 'ONRAMP' : 'OFFRAMP';
    } else {
      sourceCurrency = quoteData.sourceCurrency;
      targetCurrency = quoteData.targetCurrency;
      swapType = 'CRYPTO_TO_CRYPTO';
      payAmount = quoteData.originalAmount;
      receiveAmount = quoteData.receiveAmount || quoteData.amountReceived || quoteData.amount;
    }

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

    let swapResult = null;
    let transactionId = null;
    
    if (!isNGNZQuote) {
      swapResult = await acceptQuote(quoteId);
      
      if (!swapResult.success) {
        return res.status(500).json({
          success: false,
          message: "Failed to accept quote",
          error: swapResult.error
        });
      }

      if (swapResult?.data) {
        transactionId = swapResult.data.id || swapResult.data.transactionId || swapResult.data.reference;
      }
    } else {
      transactionId = `ngnz_${swapType.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    try {
      const exchangeRate = receiveAmount / payAmount;
      let markdownApplied = 0;
      try {
        const markdownConfig = await GlobalSwapMarkdown.getGlobalMarkdown();
        markdownApplied = markdownConfig.markdownPercentage || 0;
      } catch (err) {
        logger.warn('POST /swap/quote/:quoteId - Could not get markdown config', { error: err.message });
      }

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
        swapFee: 0,
        quoteExpiresAt: new Date(quoteData.expiresAt),
        status: 'PENDING',
        obiexTransactionId: transactionId
      });

      if (isNGNZQuote) {
        try {
          await Transaction.updateSwapStatus(swapTransactions.swapId, 'SUCCESSFUL');
          await updateUserBalanceForNGNZ(userId, sourceCurrency, -payAmount);
          await updateUserBalanceForNGNZ(userId, targetCurrency, receiveAmount);
          await updateUserPortfolioBalance(userId);
        } catch (balanceError) {
          await Transaction.updateSwapStatus(swapTransactions.swapId, 'FAILED');
          logger.error('POST /swap/quote/:quoteId - Failed to update NGNZ balances', {
            userId,
            swapId: swapTransactions.swapId,
            error: balanceError.message
          });
          return res.status(500).json({
            success: false,
            message: "NGNZ swap failed during balance update. Please contact support.",
            error: balanceError.message
          });
        }
      }

      quoteCache.delete(quoteId);
      
      res.json({
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
              transactionId
            },
            swapIn: {
              id: swapTransactions.swapInTransaction._id,
              type: swapTransactions.swapInTransaction.type,
              currency: targetCurrency,
              amount: receiveAmount,
              transactionId
            }
          },
          obiexData: swapResult?.data || null,
          balanceUpdated: isNGNZQuote
        }
      });

    } catch (transactionError) {
      logger.error('POST /swap/quote/:quoteId - Failed to create swap transactions', {
        userId,
        quoteId,
        error: transactionError.message
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
      error: error.message
    });
    
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
});

module.exports = router;