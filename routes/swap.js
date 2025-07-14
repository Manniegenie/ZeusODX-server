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
  BTC:  { currency: 'BTC',  name: 'Bitcoin' },
  ETH:  { currency: 'ETH',  name: 'Ethereum' },
  SOL:  { currency: 'SOL',  name: 'Solana' },
  USDT: { currency: 'USDT', name: 'Tether' },
  USDC: { currency: 'USDC', name: 'USD Coin' },
  BNB:  { currency: 'BNB',  name: 'Binance Coin' },
  MATIC:{ currency: 'MATIC',name: 'Polygon' },
  AVAX: { currency: 'AVAX', name: 'Avalanche' },
  NGNZ: { currency: 'NGNZ', name: 'Nigerian Naira Bank' },
};

// In-memory quote cache
const quoteCache = new Map();

/**
 * Validates that the user has enough balance
 */
async function validateUserBalance(userId, currency, amount) {
  const user = await User.findById(userId);
  if (!user) return { success: false, message: 'User not found' };
  const field = `${currency.toLowerCase()}Balance`;
  const avail = user[field] || 0;
  if (avail < amount) {
    return {
      success: false,
      message: `Insufficient ${currency} balance. Available: ${avail}, Required: ${amount}`,
      availableBalance: avail
    };
  }
  return { success: true, availableBalance: avail };
}

/**
 * Calculate price for a crypto-to-crypto swap
 */
async function calculateCryptoExchange(fromCurrency, toCurrency, amount) {
  const from = fromCurrency.toUpperCase();
  const to   = toCurrency.toUpperCase();
  const prices = await getPricesWithCache([from, to]);
  const fromPrice = prices[from], toPrice = prices[to];
  if (!fromPrice || !toPrice) {
    throw new Error(`Price unavailable for ${!fromPrice ? from : to}`);
  }
  const rate = fromPrice / toPrice;
  return { 
    success: true,
    fromPrice,
    toPrice,
    exchangeRate: rate,
    receiveAmount: amount * rate 
  };
}

/**
 * Handle NGNZ onramp/offramp swaps
 */
async function handleNGNZSwap(req, res, from, to, amount, side) {
  try {
    const userId = req.user.id;
    const fromU = from.toUpperCase(), toU = to.toUpperCase();
    const isOn  = fromU === 'NGNZ' && toU !== 'NGNZ';
    const isOff = fromU !== 'NGNZ' && toU === 'NGNZ';
    if (!isOn && !isOff) {
      return res.status(400).json({ success: false, message: 'Invalid NGNZ swap' });
    }

    let receiveAmount, rate;
    if (isOn) {
      receiveAmount = await onrampService.calculateCryptoFromNaira(amount, toU);
      rate          = (await onrampService.getOnrampRate()).finalPrice;
    } else {
      receiveAmount = await offrampService.calculateNairaFromCrypto(amount, fromU);
      rate          = (await offrampService.getCurrentRate()).finalPrice;
    }

    const id        = `ngnz_${isOn ? 'on' : 'off'}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    const payload   = {
      id,
      amount,
      amountReceived: receiveAmount,
      rate,
      side,
      sourceCurrency: fromU,
      targetCurrency: toU,
      provider: isOn ? 'INTERNAL_ONRAMP' : 'INTERNAL_OFFRAMP',
      type:     isOn ? 'onramp' : 'offramp',
      expiresAt
    };

    quoteCache.set(id, payload);

    return res.json({
      success: true,
      message: `NGNZ ${isOn ? 'onramp' : 'offramp'} quote created`,
      data: {
        data: payload,
        ...payload
      }
    });
  } catch (err) {
    logger.error('NGNZ swap error', { error: err.stack });
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * POST /swap/quote — create a fresh quote
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

    // NGNZ special case?
    if ([from,to].some(c => c.toUpperCase() === 'NGNZ')) {
      return handleNGNZSwap(req, res, from, to, amount, side);
    }

    // Crypto-to-crypto
    const result   = await calculateCryptoExchange(from, to, amount);
    const id       = `internal_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const expiresAt= new Date(Date.now() + 30_000).toISOString();
    const payload  = {
      id,
      amount,
      amountReceived: result.receiveAmount,
      rate: result.exchangeRate,
      side,
      sourceCurrency: from.toUpperCase(),
      targetCurrency: to.toUpperCase(),
      provider: 'INTERNAL_EXCHANGE',
      expiresAt
    };

    quoteCache.set(id, payload);

    return res.json({
      success: true,
      message: 'Quote created successfully',
      data: {
        data: payload,
        ...payload
      }
    });
  } catch (err) {
    logger.error('POST /swap/quote error', { error: err.stack });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * POST /swap/quote/:quoteId — execute a swap from a quote
 */
router.post('/quote/:quoteId', async (req, res) => {
  try {
    const { quoteId } = req.params;
    const userId      = req.user.id;
    const quote       = quoteCache.get(quoteId);

    if (!quote) {
      return res.status(404).json({ success: false, message: 'Quote not found or expired' });
    }
    if (new Date() > new Date(quote.expiresAt)) {
      quoteCache.delete(quoteId);
      return res.status(410).json({ success: false, message: 'Quote has expired' });
    }

    // Validate balance
    const val = await validateUserBalance(userId, quote.sourceCurrency, quote.amount);
    if (!val.success) {
      return res.status(400).json({
        success: false,
        message: val.message,
        balanceError: true,
        availableBalance: val.availableBalance,
        requiredAmount: quote.amount,
        currency: quote.sourceCurrency
      });
    }

    // Create two swap transactions under the hood
    const swapTx = await Transaction.createSwapTransactions({
      userId,
      quoteId,
      sourceCurrency: quote.sourceCurrency,
      targetCurrency: quote.targetCurrency,
      sourceAmount: quote.amount,
      targetAmount: quote.amountReceived,
      exchangeRate: quote.amountReceived / quote.amount,
      swapType: quote.type || 'CRYPTO_TO_CRYPTO',
      provider: quote.provider,
      markdownApplied: 0,
      swapFee: 0,
      quoteExpiresAt: new Date(quote.expiresAt),
      status: 'SUCCESSFUL',
      obiexTransactionId: `internal_${Date.now()}_${Math.random().toString(36).slice(2)}`
    });
    logger.info('Swap transactions created', { userId, quoteId, swapId: swapTx.swapId });

    // Update balances just like webhook
    try {
      await updateUserPortfolioBalance(userId);
      logger.info('Balances updated via portfolio service after swap', { userId });
    } catch (e) {
      logger.error('Portfolio update failed after swap', { userId, error: e.message });
    }

    // Clean up
    quoteCache.delete(quoteId);

    const responsePayload = {
      swapId:    swapTx.swapId,
      quoteId,
      status:    'SUCCESSFUL',
      swapDetails: {
        sourceCurrency: quote.sourceCurrency,
        targetCurrency: quote.targetCurrency,
        sourceAmount:   quote.amount,
        targetAmount:   quote.amountReceived,
        exchangeRate:   quote.amountReceived / quote.amount,
        swapType:       quote.type || 'CRYPTO_TO_CRYPTO',
        provider:       quote.provider,
        createdAt:      new Date().toISOString(),
        completedAt:    new Date().toISOString()
      },
      transactions: {
        swapOut: {
          id:       swapTx.swapOutTransaction._id,
          type:     swapTx.swapOutTransaction.type,
          currency: quote.sourceCurrency,
          amount:  -quote.amount
        },
        swapIn: {
          id:       swapTx.swapInTransaction._id,
          type:     swapTx.swapInTransaction.type,
          currency: quote.targetCurrency,
          amount:   quote.amountReceived
        }
      },
      balanceUpdated: true
    };

    return res.json({
      success: true,
      message: 'Swap completed successfully',
      data: {
        data: responsePayload,
        ...responsePayload
      }
    });
  } catch (err) {
    logger.error('POST /swap/quote/:quoteId error', { error: err.stack });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * GET /swap/tokens — list supported tokens
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
  endpoints: ['/swap/quote', '/swap/quote/:quoteId', '/swap/tokens'],
  supportedTokens: Object.keys(TOKEN_MAP)
});

module.exports = router;
