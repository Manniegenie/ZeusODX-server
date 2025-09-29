// routes/swap.js
const express = require('express');
const mongoose = require('mongoose');
const { getPricesWithCache, getGlobalMarkdownPercentage } = require('../services/portfolio');
const { swapCryptoToNGNX, getCurrencyIdByCode, createQuote, acceptQuote } = require('../services/ObiexSwap');
const Transaction = require('../models/transaction');
const User = require('../models/user');
const TransactionAudit = require('../models/TransactionAudit');
const logger = require('../utils/logger');
const GlobalMarkdown = require('../models/pricemarkdown'); // adjust path if needed

const router = express.Router();

// Cache management
const quoteCache = new Map();
const userCache = new Map();
const CACHE_TTL = 30000; // 30 seconds
const QUOTE_TTL = 30000; // 30 seconds for quotes

// Supported tokens
const SUPPORTED_TOKENS = new Set(['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'TRX']);
const TOKEN_MAP = {
  BTC: { name: 'Bitcoin', currency: 'btc' },
  ETH: { name: 'Ethereum', currency: 'eth' },
  SOL: { name: 'Solana', currency: 'sol' },
  USDT: { name: 'Tether', currency: 'usdt' },
  USDC: { name: 'USD Coin', currency: 'usdc' },
  BNB: { name: 'BNB', currency: 'bnb' },
  MATIC: { name: 'Polygon', currency: 'matic' },
  TRX: { name: 'Tron', currency: 'trx' }
};

const STABLECOINS = new Set(['USDT', 'USDC']);
const CRYPTOCURRENCIES = new Set(['BTC', 'ETH', 'SOL', 'BNB', 'MATIC', 'TRX']);
const DEFAULT_STABLECOIN = 'USDT';

/**
 * Validate swap pair
 */
function validateSwapPair(from, to) {
  const fromUpper = String(from).toUpperCase();
  const toUpper = String(to).toUpperCase();
  if (!SUPPORTED_TOKENS.has(fromUpper) || !SUPPORTED_TOKENS.has(toUpper)) {
    return {
      success: false,
      message: `Unsupported currency. Supported tokens: ${Array.from(SUPPORTED_TOKENS).join(', ')}`
    };
  }
  if (fromUpper === toUpper) {
    return { success: false, message: 'Cannot swap the same currency' };
  }
  const fromIsStablecoin = STABLECOINS.has(fromUpper);
  const toIsStablecoin = STABLECOINS.has(toUpper);
  const fromIsCrypto = CRYPTOCURRENCIES.has(fromUpper);
  const toIsCrypto = CRYPTOCURRENCIES.has(toUpper);

  if ((fromIsCrypto && toIsStablecoin) || (fromIsStablecoin && toIsCrypto)) {
    return { success: true, swapType: 'DIRECT' };
  }
  if (fromIsCrypto && toIsCrypto) {
    return { success: true, swapType: 'CRYPTO_TO_CRYPTO', routingRequired: true, intermediateToken: DEFAULT_STABLECOIN };
  }
  if (fromIsStablecoin && toIsStablecoin) {
    return { success: false, message: 'Stablecoin-to-stablecoin swaps are not supported' };
  }
  return { success: false, message: 'Invalid swap pair' };
}

/**
 * Apply markdown reduction to Obiex target amount (what user will receive).
 * Returns adjusted amount and reduction metadata.
 */
async function applyMarkdownReduction(obiexAmount, currency) {
  try {
    const currencyUpper = String(currency).toUpperCase();
    if (STABLECOINS.has(currencyUpper)) {
      return { adjustedAmount: Number(obiexAmount), markdownApplied: false, markdownPercentage: 0, reductionAmount: 0 };
    }
    const markdownDoc = await GlobalMarkdown.getCurrentMarkdown();
    if (!markdownDoc || !markdownDoc.isActive || !markdownDoc.markdownPercentage || markdownDoc.markdownPercentage <= 0) {
      return { adjustedAmount: Number(obiexAmount), markdownApplied: false, markdownPercentage: 0, reductionAmount: 0 };
    }
    const percent = Number(markdownDoc.markdownPercentage); // treat as percent (e.g., 0.3 = 0.3%)
    const multiplier = 1 - (percent / 100);
    const adjustedAmount = Number(obiexAmount) * multiplier;
    const reductionAmount = Number(obiexAmount) - adjustedAmount;
    logger.info('Applied markdown reduction to Obiex amount', {
      currency: currencyUpper,
      obiexAmount,
      markdownPercentage: percent,
      adjustedAmount,
      reductionAmount,
      markdownSource: markdownDoc.source
    });
    return { adjustedAmount, markdownApplied: true, markdownPercentage: percent, reductionAmount };
  } catch (err) {
    logger.warn('applyMarkdownReduction failed, returning original amount', { error: err.message });
    return { adjustedAmount: Number(obiexAmount), markdownApplied: false, markdownPercentage: 0, reductionAmount: 0 };
  }
}

/**
 * Helper to safely read numeric fields (returns undefined if not present)
 */
function pickNumber(obj, ...keys) {
  for (const k of keys) {
    if (!obj) continue;
    const parts = String(k).split('.');
    let cur = obj;
    let ok = true;
    for (const p of parts) {
      if (cur && (cur[p] !== undefined && cur[p] !== null)) cur = cur[p];
      else { ok = false; break; }
    }
    if (ok && cur !== undefined && cur !== null) {
      const n = Number(cur);
      if (!Number.isNaN(n)) return n;
    }
  }
  return undefined;
}

/**
 * Create Obiex quote for direct swap (defensive & returns structured result instead of throwing).
 * - returns { success: true, ... } or { success: false, statusCode, error }
 */
async function createObiexDirectQuote(fromCurrency, toCurrency, amount, side) {
  const from = String(fromCurrency).toUpperCase();
  const to = String(toCurrency).toUpperCase();
  const quoteSide = String((side || 'SELL')).toUpperCase();
  const quoteAmount = Number(amount);

  // Resolve currency IDs safely
  let sourceId, targetId;
  try {
    sourceId = await getCurrencyIdByCode(from);
    targetId = await getCurrencyIdByCode(to);
  } catch (err) {
    logger.error('Failed to resolve currency IDs for createQuote', { from, to, err: err.message });
    return { success: false, statusCode: 400, error: `OBIEX_CURRENCY_ID_ERROR: ${err.message}` };
  }

  // Call Obiex
  const quoteResult = await createQuote({ sourceId, targetId, amount: quoteAmount, side: quoteSide });
  if (!quoteResult || !quoteResult.success) {
    logger.warn('Obiex createQuote returned error', { payload: { sourceId, targetId, amount: quoteAmount, side: quoteSide }, quoteResult });
    return { success: false, statusCode: quoteResult?.statusCode || 502, error: quoteResult?.error || 'OBIEX_QUOTE_FAILED' };
  }

  const data = quoteResult.data || {};

  // Determine rate and candidate fields
  const rate = pickNumber(data, 'rate', 'price', 'summary.rate', 'summary.price') || undefined;

  // Determine raw source (authoritative: the requested amount)
  const rawSource = quoteAmount;

  // Determine raw target (what Obiex intends to deliver) deterministically by side
  let rawTarget = 0;
  if (quoteSide === 'BUY') {
    // User is spending 'from' to BUY 'to' (e.g., spending USDT to buy BTC)
    if (rate && rawSource > 0) {
      rawTarget = rawSource * rate;
    } else {
      rawTarget = pickNumber(data, 'receiveAmount', 'amountReceived', 'estimatedAmount', 'summary.receiveAmount', 'summary.amount') || 0;
    }
  } else {
    // SELL: user sends crypto -> receives stablecoin (provider typically returns estimated/receive fields)
    rawTarget = pickNumber(data, 'estimatedAmount', 'amountReceived', 'receiveAmount', 'summary.amount') || 0;
    if ((!rawTarget || rawTarget === 0) && rate && rawSource > 0) {
      rawTarget = rawSource * rate;
    }
  }

  // final fallback to generic fields
  if (!rawTarget || rawTarget === 0) {
    rawTarget = Number(data?.estimatedAmount || data?.receiveAmount || data?.amount || 0) || 0;
  }

  // Apply markdown reduction to the target (user receives less after markdown)
  const markdownResult = await applyMarkdownReduction(rawTarget, to);

  return {
    success: true,
    obiexQuoteId: quoteResult.quoteId || data?.id || null,
    obiexData: data,
    rawSourceAmount: rawSource,
    rawTargetAmount: rawTarget,
    adjustedAmount: markdownResult.adjustedAmount,
    markdownApplied: markdownResult.markdownApplied,
    markdownPercentage: markdownResult.markdownPercentage,
    reductionAmount: markdownResult.reductionAmount,
    rate: rate || (rawSource ? (rawTarget / rawSource) : 0)
  };
}

/**
 * Create Obiex quote for crypto-to-crypto swap (two steps).
 * Returns { success: true, step1, step2, overall } or { success: false, ... }
 */
async function createObiexCryptoToCryptoQuote(fromCurrency, toCurrency, amount) {
  const from = String(fromCurrency).toUpperCase();
  const to = String(toCurrency).toUpperCase();
  const intermediate = DEFAULT_STABLECOIN;

  // Step 1: sell `from` -> intermediate stablecoin
  const step1 = await createObiexDirectQuote(from, intermediate, amount, 'SELL');
  if (!step1.success) return step1;

  // Step 2: buy `to` using intermediate stablecoin amount (use adjustedAmount after markdown)
  const step2 = await createObiexDirectQuote(intermediate, to, step1.adjustedAmount, 'BUY');
  if (!step2.success) return step2;

  return {
    success: true,
    step1: {
      ...step1
    },
    step2: {
      ...step2
    },
    overall: {
      fromCurrency: from,
      toCurrency: to,
      amount,
      adjustedAmount: step2.adjustedAmount,
      rate: step2.rate || (step2.adjustedAmount / amount)
    }
  };
}

/**
 * Create audit entry (safe)
 */
async function createAuditEntry(auditData) {
  try {
    await TransactionAudit.createAudit(auditData);
  } catch (err) {
    logger.error('Failed to create audit entry', { error: err.message });
  }
}

function generateCorrelationId() {
  return `CORR_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function getSystemContext(req) {
  return {
    ipAddress: req.ip || req.connection?.remoteAddress || 'unknown',
    userAgent: req.get('User-Agent') || 'unknown',
    sessionId: req.sessionID || 'unknown',
    apiVersion: req.get('API-Version') || '1.0',
    platform: req.get('Platform') || 'unknown',
    environment: process.env.NODE_ENV || 'production'
  };
}

/**
 * Get cached user balance
 */
async function getCachedUserBalance(userId, currencies = []) {
  const cacheKey = `user_balance_${userId}`;
  const cached = userCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) return cached.user;

  const selectFields = ['_id', 'lastBalanceUpdate', 'portfolioLastUpdated'];
  if (currencies.length > 0) {
    currencies.forEach(currency => selectFields.push(`${currency.toLowerCase()}Balance`));
  } else {
    Object.values(TOKEN_MAP).forEach(token => selectFields.push(`${token.currency}Balance`));
  }

  const user = await User.findById(userId).select(selectFields.join(' ')).lean();
  if (user) {
    userCache.set(cacheKey, { user, timestamp: Date.now() });
    setTimeout(() => userCache.delete(cacheKey), CACHE_TTL);
  }
  return user;
}

/**
 * Validate user balance
 */
async function validateUserBalance(userId, currency, amount) {
  const user = await getCachedUserBalance(userId, [currency]);
  if (!user) return { success: false, message: 'User not found' };
  const field = `${currency.toLowerCase()}Balance`;
  const available = user[field] || 0;
  if (available < amount) {
    return { success: false, message: `Insufficient ${currency} balance. Available: ${available}, Required: ${amount}`, availableBalance: available };
  }
  return { success: true, availableBalance: available };
}

/**
 * Execute Obiex swap and update user balances
 * (left largely as-is but uses deterministic parsing on accept)
 */
async function executeObiexSwapWithBalanceUpdate(userId, quote, correlationId, systemContext) {
  const session = await mongoose.startSession();
  session.startTransaction();
  const startTime = new Date();

  try {
    const { sourceCurrency, targetCurrency, amount, swapType } = quote;
    const validation = await validateUserBalance(userId, sourceCurrency, amount);
    if (!validation.success) throw new Error(validation.message);

    let obiexResult, finalAmountReceived;

    if (swapType === 'CRYPTO_TO_CRYPTO') {
      const step1QuoteId = quote.obiexStep1QuoteId;
      const step2QuoteId = quote.obiexStep2QuoteId;

      const step1Accept = await acceptQuote(step1QuoteId);
      if (!step1Accept.success) throw new Error(`Obiex step1 accept failed: ${JSON.stringify(step1Accept.error)}`);

      const step2Accept = await acceptQuote(step2QuoteId);
      if (!step2Accept.success) throw new Error(`Obiex step2 accept failed: ${JSON.stringify(step2Accept.error)}`);

      // For execution we rely on provider accept response fields (defensive)
      const step2Received = Number(step2Accept.data?.amountReceived || step2Accept.data?.receiveAmount || step2Accept.data?.estimatedAmount || step2Accept.data?.amount || 0);
      const markdown = await applyMarkdownReduction(step2Received, targetCurrency);
      finalAmountReceived = markdown.adjustedAmount;

      obiexResult = { step1: step1Accept.data, step2: step2Accept.data, markdownReduction: markdown };
    } else {
      const obiexQuoteId = quote.obiexQuoteId;
      const acceptResult = await acceptQuote(obiexQuoteId);
      if (!acceptResult.success) throw new Error(`Obiex accept failed: ${JSON.stringify(acceptResult.error)}`);

      const rawReceived = Number(acceptResult.data?.amountReceived || acceptResult.data?.receiveAmount || acceptResult.data?.estimatedAmount || acceptResult.data?.amount || 0);
      const markdown = await applyMarkdownReduction(rawReceived, targetCurrency);
      finalAmountReceived = markdown.adjustedAmount;

      obiexResult = { acceptData: acceptResult.data, markdownReduction: markdown };
    }

    // Update balances
    const fromKey = `${sourceCurrency.toLowerCase()}Balance`;
    const toKey = `${targetCurrency.toLowerCase()}Balance`;
    const swapReference = `OBIEX_SWAP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const updatedUser = await User.findOneAndUpdate(
      { _id: userId, [fromKey]: { $gte: amount } },
      { $inc: { [fromKey]: -amount, [toKey]: finalAmountReceived }, $set: { lastBalanceUpdate: new Date(), portfolioLastUpdated: new Date() } },
      { new: true, runValidators: true, session }
    );

    if (!updatedUser) throw new Error(`Balance update failed - insufficient ${sourceCurrency} balance`);
    userCache.delete(`user_balance_${userId}`);

    // Create transactions & audit
    const metadata = {
      swapType,
      exchangeRate: finalAmountReceived / amount,
      relatedTransactionRef: swapReference,
      fromCurrency: sourceCurrency,
      toCurrency: targetCurrency,
      fromAmount: amount,
      toAmount: finalAmountReceived,
      provider: 'OBIEX',
      swapPair: `${sourceCurrency}-${targetCurrency}`,
      executionTimestamp: new Date(),
      correlationId,
      obiexQuoteId: quote.obiexQuoteId || null,
      markdownApplied: obiexResult.markdownReduction?.markdownApplied || false,
      markdownPercentage: obiexResult.markdownReduction?.markdownPercentage || 0,
      reductionAmount: obiexResult.markdownReduction?.reductionAmount || 0,
      ...(swapType === 'CRYPTO_TO_CRYPTO' && { intermediateToken: quote.intermediateToken, routingPath: quote.routingPath })
    };

    const swapOutTransaction = new Transaction({
      userId,
      type: 'SWAP',
      currency: sourceCurrency,
      amount: -amount,
      status: 'SUCCESSFUL',
      source: 'OBIEX',
      reference: swapReference,
      obiexTransactionId: `${swapReference}_OUT`,
      narration: `Obiex Swap: ${amount} ${sourceCurrency} to ${finalAmountReceived} ${targetCurrency}`,
      completedAt: new Date(),
      metadata: { ...metadata, swapDirection: 'OUT' }
    });

    const swapInTransaction = new Transaction({
      userId,
      type: 'SWAP',
      currency: targetCurrency,
      amount: finalAmountReceived,
      status: 'SUCCESSFUL',
      source: 'OBIEX',
      reference: swapReference,
      obiexTransactionId: `${swapReference}_IN`,
      narration: `Obiex Swap: ${amount} ${sourceCurrency} to ${finalAmountReceived} ${targetCurrency}`,
      completedAt: new Date(),
      metadata: { ...metadata, swapDirection: 'IN' }
    });

    await swapOutTransaction.save({ session });
    await swapInTransaction.save({ session });

    await session.commitTransaction();
    session.endSession();

    logger.info('Obiex swap executed successfully', {
      userId, swapReference, correlationId, sourceCurrency, targetCurrency, sourceAmount: amount, targetAmount: finalAmountReceived
    });

    await createAuditEntry({
      userId,
      eventType: 'SWAP_COMPLETED',
      status: 'SUCCESS',
      source: 'OBIEX',
      action: 'Complete Obiex Swap',
      description: `Successfully completed Obiex swap with markdown reduction`,
      swapDetails: { swapId: swapReference, sourceCurrency, targetCurrency, sourceAmount: amount, targetAmount: finalAmountReceived, exchangeRate: finalAmountReceived / amount, provider: 'OBIEX', swapType },
      relatedEntities: { correlationId, relatedTransactionIds: [swapOutTransaction._id, swapInTransaction._id] },
      systemContext,
      timing: { startTime, endTime: new Date(), duration: new Date() - startTime },
      tags: ['swap', 'obiex', 'completed', 'success', 'markdown-reduced']
    });

    return { user: updatedUser, swapOutTransaction, swapInTransaction, swapId: swapReference, obiexResult };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    logger.error('Obiex swap execution failed', { error: err.message, stack: err.stack, userId: userId, quote });
    await createAuditEntry({
      userId,
      eventType: 'SWAP_FAILED',
      status: 'FAILED',
      source: 'OBIEX',
      action: 'Failed Obiex Swap',
      description: `Obiex swap failed: ${err.message}`,
      errorDetails: { message: err.message, stack: err.stack },
      swapDetails: { sourceCurrency: quote?.sourceCurrency, targetCurrency: quote?.targetCurrency, sourceAmount: quote?.amount, provider: 'OBIEX', swapType: quote?.swapType },
      relatedEntities: { correlationId },
      systemContext,
      timing: { startTime, endTime: new Date(), duration: new Date() - startTime },
      riskLevel: 'HIGH',
      flagged: true,
      flagReason: 'Obiex swap execution failed',
      tags: ['swap', 'obiex', 'failed', 'critical-error']
    });
    throw err;
  }
}

// POST /swap/quote - Create swap quote
router.post('/quote', async (req, res) => {
  const correlationId = generateCorrelationId();
  const systemContext = getSystemContext(req);
  const startTime = new Date();

  try {
    const { from, to, amount, side } = req.body;
    const userId = req.user?.id;

    if (!from || !to || !amount || !side) {
      return res.status(400).json({ success: false, message: 'Missing required fields: from, to, amount, side' });
    }
    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount. Must be a positive number.' });
    }

    const pairValidation = validateSwapPair(from, to);
    if (!pairValidation.success) {
      return res.status(400).json({ success: false, message: pairValidation.message });
    }

    const id = `obiex_swap_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const expiresAt = new Date(Date.now() + QUOTE_TTL).toISOString();

    let payload;

    if (pairValidation.swapType === 'CRYPTO_TO_CRYPTO') {
      const cryptoQuote = await createObiexCryptoToCryptoQuote(from, to, amount);
      if (!cryptoQuote.success) {
        return res.status(502).json({ success: false, message: 'Failed to create crypto->crypto quote', error: cryptoQuote.error || cryptoQuote });
      }

      payload = {
        id,
        amount,
        amountReceived: cryptoQuote.overall.adjustedAmount,
        rate: cryptoQuote.overall.rate,
        side,
        sourceCurrency: from.toUpperCase(),
        targetCurrency: to.toUpperCase(),
        provider: 'OBIEX',
        swapType: 'CRYPTO_TO_CRYPTO',
        intermediateToken: pairValidation.intermediateToken,
        routingPath: `${from.toUpperCase()} → ${pairValidation.intermediateToken} → ${to.toUpperCase()}`,
        expiresAt,
        correlationId,
        obiexStep1QuoteId: cryptoQuote.step1.obiexQuoteId,
        obiexStep2QuoteId: cryptoQuote.step2.obiexQuoteId,
        step1: cryptoQuote.step1,
        step2: cryptoQuote.step2,
        markdownApplied: cryptoQuote.step2.markdownApplied,
        markdownPercentage: cryptoQuote.step2.markdownPercentage,
        reductionAmount: cryptoQuote.step2.reductionAmount
      };

      logger.info('Crypto-to-crypto Obiex quote created', { sourceAmount: amount, sourceCurrency: from.toUpperCase(), targetAmount: cryptoQuote.overall.adjustedAmount, targetCurrency: to.toUpperCase(), correlationId });
    } else {
      // DIRECT
      const directQuote = await createObiexDirectQuote(from, to, amount, side);
      if (!directQuote.success) {
        return res.status(directQuote.statusCode || 502).json({ success: false, message: 'Failed to create Obiex quote', error: directQuote.error });
      }

      payload = {
        id,
        amount,
        amountReceived: directQuote.adjustedAmount,
        rawTargetAmount: directQuote.rawTargetAmount,
        rawSourceAmount: directQuote.rawSourceAmount,
        rate: directQuote.rate,
        side,
        sourceCurrency: from.toUpperCase(),
        targetCurrency: to.toUpperCase(),
        provider: 'OBIEX',
        swapType: 'DIRECT',
        expiresAt,
        correlationId,
        obiexQuoteId: directQuote.obiexQuoteId,
        markdownApplied: directQuote.markdownApplied,
        markdownPercentage: directQuote.markdownPercentage,
        reductionAmount: directQuote.reductionAmount
      };

      logger.info('Direct Obiex quote created', { sourceAmount: amount, sourceCurrency: from.toUpperCase(), targetAmount: directQuote.adjustedAmount, targetCurrency: to.toUpperCase(), markdownApplied: directQuote.markdownApplied, correlationId });
    }

    quoteCache.set(id, payload);
    setTimeout(() => quoteCache.delete(id), QUOTE_TTL);

    return res.json({ success: true, message: 'Obiex swap quote created successfully', data: { data: payload, ...payload } });
  } catch (err) {
    logger.error('POST /swap/quote error', { error: err.stack, correlationId });
    return res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// POST /swap/quote/:quoteId - Execute swap
router.post('/quote/:quoteId', async (req, res) => {
  const systemContext = getSystemContext(req);
  const startTime = new Date();

  try {
    const { quoteId } = req.params;
    const userId = req.user.id;
    const quote = quoteCache.get(quoteId);
    const correlationId = quote?.correlationId || generateCorrelationId();

    if (!quote) return res.status(404).json({ success: false, message: 'Quote not found or expired' });
    if (new Date() > new Date(quote.expiresAt)) { quoteCache.delete(quoteId); return res.status(410).json({ success: false, message: 'Quote has expired' }); }

    const validation = await validateUserBalance(userId, quote.sourceCurrency, quote.amount);
    if (!validation.success) return res.status(400).json({ success: false, message: validation.message, balanceError: true, availableBalance: validation.availableBalance });

    const swapResult = await executeObiexSwapWithBalanceUpdate(userId, quote, correlationId, systemContext);

    logger.info('Obiex swap completed successfully', { userId, quoteId, correlationId, swapId: swapResult.swapId });

    quoteCache.delete(quoteId);

    const responsePayload = {
      swapId: swapResult.swapId,
      quoteId,
      correlationId,
      status: 'SUCCESSFUL',
      swapDetails: {
        sourceCurrency: quote.sourceCurrency,
        targetCurrency: quote.targetCurrency,
        sourceAmount: quote.amount,
        targetAmount: quote.amountReceived,
        exchangeRate: quote.rate,
        provider: 'OBIEX',
        swapType: quote.swapType,
        markdownApplied: quote.markdownApplied,
        markdownPercentage: quote.markdownPercentage,
        reductionAmount: quote.reductionAmount
      },
      transactions: { swapId: swapResult.swapId, swapOutTransactionId: swapResult.swapOutTransaction._id, swapInTransactionId: swapResult.swapInTransaction._id },
      balanceUpdated: true,
      newBalances: {
        [quote.sourceCurrency.toLowerCase()]: swapResult.user[`${quote.sourceCurrency.toLowerCase()}Balance`],
        [quote.targetCurrency.toLowerCase()]: swapResult.user[`${quote.targetCurrency.toLowerCase()}Balance`]
      }
    };

    return res.json({ success: true, message: 'Obiex swap completed successfully', data: { data: responsePayload, ...responsePayload } });
  } catch (err) {
    logger.error('POST /swap/quote/:quoteId error', { error: err.stack, userId: req.user?.id, quoteId: req.params?.quoteId });
    return res.status(500).json({ success: false, message: 'Swap failed - please try again' });
  }
});

// GET /swap/tokens
router.get('/tokens', (req, res) => {
  try {
    const tokens = Object.entries(TOKEN_MAP).map(([code, info]) => ({ code, name: info.name, currency: info.currency }));
    res.json({ success: true, message: 'Supported tokens retrieved successfully', data: tokens, total: tokens.length });
  } catch (err) {
    logger.error('GET /swap/tokens error', { error: err.stack });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Clean up expired quotes and stale user cache entries
setInterval(() => {
  const now = Date.now();
  for (const [key, quote] of quoteCache.entries()) {
    if (now > new Date(quote.expiresAt).getTime()) quoteCache.delete(key);
  }
  for (const [key, entry] of userCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL) userCache.delete(key);
  }
}, 60000);

module.exports = router;
