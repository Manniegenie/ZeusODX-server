// routes/swap.js

const express = require('express');
const onrampService = require('../services/onramppriceservice');
const offrampService = require('../services/offramppriceservice');
const { updateUserPortfolioBalance, getPricesWithCache } = require('../services/portfolio');
const Transaction = require('../models/transaction');
const User = require('../models/user');
const logger = require('../utils/logger');

const router = express.Router();

const TOKEN_MAP = {
  BTC: { currency: 'BTC', name: 'Bitcoin' },
  ETH: { currency: 'ETH', name: 'Ethereum' },
  SOL: { currency: 'SOL', name: 'Solana' },
  USDT: { currency: 'USDT', name: 'Tether' },
  USDC: { currency: 'USDC', name: 'USD Coin' },
  BNB: { currency: 'BNB', name: 'Binance Coin' },
  MATIC: { currency: 'MATIC', name: 'Polygon' },
  AVAX: { currency: 'AVAX', name: 'Avalanche' },
  NGNZ: { currency: 'NGNZ', name: 'Nigerian Naira Bank' }
};

// In-memory cache for quotes
const quoteCache = new Map();

/**
 * Validate that user has enough balance for a swap
 */
async function validateUserBalance(userId, currency, amount) {
  const user = await User.findById(userId);
  if (!user) {
    return { success: false, message: 'User not found' };
  }
  const field = `${currency.toLowerCase()}Balance`;
  const available = user[field] || 0;
  if (available < amount) {
    return {
      success: false,
      message: `Insufficient ${currency} balance. Available: ${available}, Required: ${amount}`,
      availableBalance: available
    };
  }
  return { success: true, availableBalance: available };
}

/**
 * Calculate cross-crypto exchange via price cache
 */
async function calculateCryptoExchange(fromCurrency, toCurrency, amount) {
  const from = fromCurrency.toUpperCase();
  const to   = toCurrency.toUpperCase();

  const prices = await getPricesWithCache([from, to]);
  const fromPrice = prices[from];
  const toPrice   = prices[to];

  if (!fromPrice || !toPrice) {
    throw new Error(`Price unavailable for ${!fromPrice ? from : to}`);
  }

  const rate = fromPrice / toPrice;
  const receiveAmount = amount * rate;

  return {
    success: true,
    fromPrice,
    toPrice,
    exchangeRate: rate,
    receiveAmount
  };
}

/**
 * Handle NGNZ on- and off-ramps
 */
async function handleNGNZSwap(req, res, from, to, amount, side) {
  try {
    const userId = req.user.id;
    const fromU = from.toUpperCase();
    const toU   = to.toUpperCase();

    const isOnramp  = fromU === 'NGNZ' && toU !== 'NGNZ';
    const isOfframp = fromU !== 'NGNZ' && toU === 'NGNZ';
    if (!isOnramp && !isOfframp) {
      return res.status(400).json({ success: false, message: 'Invalid NGNZ swap' });
    }

    let receiveAmount, rate;
    if (isOnramp) {
      receiveAmount = await onrampService.calculateCryptoFromNaira(amount, toU);
      rate = (await onrampService.getOnrampRate()).finalPrice;
    } else {
      receiveAmount = await offrampService.calculateNairaFromCrypto(amount, fromU);
      rate = (await offrampService.getCurrentRate()).finalPrice;
    }

    const quoteId = `ngnz_${isOnramp ? 'on' : 'off'}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const expiresAt = new Date(Date.now() + 30_000).toISOString();

    const quote = {
      id: quoteId,
      amount,
      amountReceived: receiveAmount,
      rate,
      side,
      sourceCurrency: fromU,
      targetCurrency: toU,
      provider: isOnramp ? 'INTERNAL_ONRAMP' : 'INTERNAL_OFFRAMP',
      type: isOnramp ? 'onramp' : 'offramp',
      expiresAt
    };

    quoteCache.set(quoteId, quote);

    return res.json({
      success: true,
      message: `NGNZ ${isOnramp ? 'onramp' : 'offramp'} quote created`,
      data: {
        id: quoteId,
        amount,
        amountReceived: receiveAmount,
        rate,
        side,
        expiresIn: 30,
        expiryDate: expiresAt,
        sourceCurrency: fromU,
        targetCurrency: toU,
        provider: quote.provider,
        acceptable: true
      }
    });
  } catch (err) {
    logger.error('NGNZ swap error', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * Create a new swap quote
 */
router.post('/quote', async (req, res) => {
  try {
    const { from, to, amount, side } = req.body;
    if (!from || !to || !amount || !side) {
      return res.status(400).json({ success: false, message: 'Missing from/to/amount/side' });
    }
    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be positive' });
    }
    if (!['BUY','SELL'].includes(side)) {
      return res.status(400).json({ success: false, message: 'Side must be BUY or SELL' });
    }

    // NGNZ on/off-ramp?
    if ([from,to].some(c => c.toUpperCase() === 'NGNZ')) {
      return handleNGNZSwap(req, res, from, to, amount, side);
    }

    // Crypto ↔ Crypto
    const result = await calculateCryptoExchange(from, to, amount);
    const quoteId = `internal_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const expiresAt = new Date(Date.now() + 30_000).toISOString();

    const quote = {
      id: quoteId,
      amount,
      amountReceived: result.receiveAmount,
      rate: result.exchangeRate,
      side,
      sourceCurrency: from.toUpperCase(),
      targetCurrency: to.toUpperCase(),
      provider: 'INTERNAL_EXCHANGE',
      fromPrice: result.fromPrice,
      toPrice: result.toPrice,
      expiresAt
    };

    quoteCache.set(quoteId, quote);

    return res.json({
      success: true,
      message: 'Quote created successfully',
      data: {
        id: quoteId,
        amount,
        amountReceived: result.receiveAmount,
        rate: result.exchangeRate,
        side,
        expiresIn: 30,
        expiryDate: expiresAt,
        sourceCurrency: quote.sourceCurrency,
        targetCurrency: quote.targetCurrency,
        provider: quote.provider,
        acceptable: true
      }
    });
  } catch (err) {
    logger.error('POST /swap/quote error', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * Execute a swap against a previously created quote
 */
router.post('/quote/:quoteId', async (req, res) => {
  try {
    const { quoteId } = req.params;
    const userId = req.user.id;
    const quote = quoteCache.get(quoteId);

    if (!quote) {
      return res.status(404).json({ success: false, message: 'Quote not found or expired' });
    }
    if (new Date() > new Date(quote.expiresAt)) {
      quoteCache.delete(quoteId);
      return res.status(410).json({ success: false, message: 'Quote has expired' });
    }

    const { sourceCurrency, targetCurrency, amount: payAmount, amountReceived: receiveAmount } = quote;
    // Validate available balance
    const balanceCheck = await validateUserBalance(userId, sourceCurrency, payAmount);
    if (!balanceCheck.success) {
      return res.status(400).json({
        success: false,
        message: balanceCheck.message,
        balanceError: true,
        availableBalance: balanceCheck.availableBalance,
        requiredAmount: payAmount,
        currency: sourceCurrency
      });
    }

    // Create the swap transactions
    const swapTx = await Transaction.createSwapTransactions({
      userId,
      quoteId,
      sourceCurrency,
      targetCurrency,
      sourceAmount: payAmount,
      targetAmount: receiveAmount,
      exchangeRate: receiveAmount / payAmount,
      swapType: quote.type || 'CRYPTO_TO_CRYPTO',
      provider: quote.provider,
      markdownApplied: 0,
      swapFee: 0,
      quoteExpiresAt: new Date(quote.expiresAt),
      status: 'SUCCESSFUL',
      obiexTransactionId: `internal_${Date.now()}_${Math.random().toString(36).slice(2)}`
    });
    logger.info('Swap transactions created', { userId, quoteId, swapId: swapTx.swapId });

    // ——— Use portfolio service to update balances exactly like the webhook does ———
    try {
      await updateUserPortfolioBalance(userId);
      logger.info('Balances updated via portfolio service after swap', { userId });
    } catch (updateErr) {
      logger.error('Portfolio update failed after swap', { userId, error: updateErr.message });
      // You can choose to return a warning here if desired
    }

    // Clean up the quote
    quoteCache.delete(quoteId);

    // Respond
    return res.json({
      success: true,
      message: 'Swap completed successfully',
      data: {
        swapId: swapTx.swapId,
        quoteId,
        status: 'SUCCESSFUL',
        swapDetails: {
          sourceCurrency,
          targetCurrency,
          sourceAmount: payAmount,
          targetAmount: receiveAmount,
          exchangeRate: receiveAmount / payAmount,
          swapType: quote.type || 'CRYPTO_TO_CRYPTO',
          provider: quote.provider,
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        },
        transactions: {
          swapOut: {
            id: swapTx.swapOutTransaction._id,
            type: swapTx.swapOutTransaction.type,
            currency: sourceCurrency,
            amount: -payAmount
          },
          swapIn: {
            id: swapTx.swapInTransaction._id,
            type: swapTx.swapInTransaction.type,
            currency: targetCurrency,
            amount: receiveAmount
          }
        },
        balanceUpdated: true
      }
    });
  } catch (err) {
    logger.error('POST /swap/quote/:quoteId error', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * List supported tokens
 */
router.get('/tokens', (req, res) => {
  const tokens = Object.entries(TOKEN_MAP).map(([code, info]) => ({
    code,
    name: info.name,
    currency: info.currency
  }));
  res.json({
    success: true,
    message: 'Supported tokens retrieved successfully',
    data: tokens,
    total: tokens.length
  });
});

logger.info('Working swap router initialized', {
  endpoints: ['POST /swap/quote', 'POST /swap/quote/:quoteId', 'GET /swap/tokens'],
  supportedTokens: Object.keys(TOKEN_MAP),
  features: [
    'NGNZ onramp/offramp support',
    'Crypto-to-crypto swaps via price cache',
    'Unified balance updates via portfolio service',
    'Immediate swap completion'
  ]
});

module.exports = router;
