// routes/swap.js

const express = require('express');
const { getPricesWithCache }         = require('../services/portfolio');
const { updateBalancesOnSwap }       = require('../services/swapBalanceService');
const Transaction                    = require('../models/transaction');
const User                           = require('../models/user');
const logger                         = require('../utils/logger');

const router = express.Router();
const quoteCache = new Map();

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

async function calculateCryptoExchange(fromCurrency, toCurrency, amount) {
  const from = fromCurrency.toUpperCase();
  const to   = toCurrency.toUpperCase();
  const prices = await getPricesWithCache([from, to]);
  const f = prices[from], t = prices[to];
  if (!f || !t) throw new Error(`Price unavailable for ${!f?from:to}`);
  const rate = f / t;
  return { success: true, fromPrice: f, toPrice: t, exchangeRate: rate, receiveAmount: amount * rate };
}

router.post('/quote', async (req, res) => {
  try {
    const { from, to, amount, side } = req.body;
    if (!from||!to||!amount||!side) return res.status(400).json({ success:false, message:'Missing fields' });
    if (typeof amount!=='number'||amount<=0)   return res.status(400).json({ success:false, message:'Invalid amount' });
    if (!['BUY','SELL'].includes(side))        return res.status(400).json({ success:false, message:'Invalid side' });

    const result = await calculateCryptoExchange(from, to, amount);
    const id     = `internal_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const expiresAt = new Date(Date.now()+30000).toISOString();
    const payload = {
      id, amount, amountReceived: result.receiveAmount, rate: result.exchangeRate,
      side, sourceCurrency:from.toUpperCase(), targetCurrency:to.toUpperCase(),
      provider:'INTERNAL_EXCHANGE', type:'CRYPTO_TO_CRYPTO', expiresAt
    };

    quoteCache.set(id, payload);
    return res.json({ success:true, message:'Quote created successfully', data:{ data:payload, ...payload } });

  } catch (err) {
    logger.error('POST /swap/quote error', { error: err.stack });
    return res.status(500).json({ success:false, message:'Internal server error' });
  }
});

router.post('/quote/:quoteId', async (req, res) => {
  try {
    const { quoteId } = req.params;
    const userId      = req.user.id;
    const quote       = quoteCache.get(quoteId);

    if (!quote) {
      return res.status(404).json({ success:false, message:'Quote not found or expired' });
    }
    if (new Date()>new Date(quote.expiresAt)) {
      quoteCache.delete(quoteId);
      return res.status(410).json({ success:false, message:'Quote has expired' });
    }

    // validate
    const val = await validateUserBalance(userId, quote.sourceCurrency, quote.amount);
    if (!val.success) {
      return res.status(400).json({
        success:false,
        message: val.message,
        balanceError: true,
        availableBalance: val.availableBalance,
        requiredAmount: quote.amount,
        currency: quote.sourceCurrency
      });
    }

    // create swap txs
    const swapTx = await Transaction.createSwapTransactions({
      userId,
      quoteId,
      sourceCurrency: quote.sourceCurrency,
      targetCurrency: quote.targetCurrency,
      sourceAmount: quote.amount,
      targetAmount: quote.amountReceived,
      exchangeRate: quote.amountReceived/quote.amount,
      swapType: quote.type||'CRYPTO_TO_CRYPTO',
      provider: quote.provider,
      markdownApplied:0,
      swapFee:0,
      quoteExpiresAt: new Date(quote.expiresAt),
      status:'SUCCESSFUL',
      obiexTransactionId: `internal_${Date.now()}_${Math.random().toString(36).slice(2)}`
    });
    logger.info('Swap transactions created', { userId, quoteId, swapId: swapTx.swapId });

    // *** CUSTOM BALANCE UPDATE ***
    await updateBalancesOnSwap(
      userId,
      quote.sourceCurrency,
      quote.targetCurrency,
      quote.amount,
      quote.amountReceived
    );
    logger.info('Balances updated via custom swap service', { userId });

    quoteCache.delete(quoteId);

    const responsePayload = {
      swapId: swapTx.swapId,
      quoteId,
      status:'SUCCESSFUL',
      swapDetails:{ /* …same as before… */ },
      transactions:{ /* …same as before…*/ },
      balanceUpdated:true
    };

    return res.json({
      success:true,
      message:'Swap completed successfully',
      data:{ data:responsePayload, ...responsePayload }
    });

  } catch (err) {
    logger.error('POST /swap/quote/:quoteId error', { error: err.stack });
    return res.status(500).json({ success:false, message:'Internal server error' });
  }
});

router.get('/tokens', (req, res) => {
  const tokens = Object.entries(TOKEN_MAP).map(([code, info]) => ({
    code, name: info.name, currency: info.currency
  }));
  res.json({
    success: true,
    message: 'Supported tokens retrieved successfully',
    data: tokens,
    total: tokens.length
  });
});

module.exports = router;