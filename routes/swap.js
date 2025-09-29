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
  const fromUpper = from.toUpperCase();
  const toUpper = to.toUpperCase();
  
  if (!SUPPORTED_TOKENS.has(fromUpper) || !SUPPORTED_TOKENS.has(toUpper)) {
    return {
      success: false,
      message: `Unsupported currency. Supported tokens: ${Array.from(SUPPORTED_TOKENS).join(', ')}`
    };
  }
  
  if (fromUpper === toUpper) {
    return {
      success: false,
      message: 'Cannot swap the same currency'
    };
  }
  
  const fromIsStablecoin = STABLECOINS.has(fromUpper);
  const toIsStablecoin = STABLECOINS.has(toUpper);
  const fromIsCrypto = CRYPTOCURRENCIES.has(fromUpper);
  const toIsCrypto = CRYPTOCURRENCIES.has(toUpper);
  
  if ((fromIsCrypto && toIsStablecoin) || (fromIsStablecoin && toIsCrypto)) {
    return { success: true, swapType: 'DIRECT' };
  }
  
  if (fromIsCrypto && toIsCrypto) {
    return { 
      success: true, 
      swapType: 'CRYPTO_TO_CRYPTO',
      routingRequired: true,
      intermediateToken: DEFAULT_STABLECOIN
    };
  }
  
  if (fromIsStablecoin && toIsStablecoin) {
    return {
      success: false,
      message: 'Stablecoin-to-stablecoin swaps are not supported'
    };
  }
  
  return {
    success: false,
    message: 'Invalid swap pair'
  };
}

/**
 * Extract target/source amounts and rate from an Obiex quote/accept response.
 * This is defensive: it tries many possible fields and falls back to computing using rate when possible.
 *
 * returns { rawSourceAmount, rawTargetAmount, rate }
 * - rawSourceAmount: amount provided as "source" (if available)
 * - rawTargetAmount: amount expected to be received (if available)
 * - rate: rate if present or computed (target / source)
 */
function parseObiexResponseForAmounts(respData, passedAmount, quoteSide) {
  if (!respData) return { rawSourceAmount: 0, rawTargetAmount: 0, rate: 0 };

  const pick = (obj, ...keys) => {
    for (const k of keys) {
      if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
    }
    return undefined;
  };

  // common fields to check
  const fieldsCheck = [
    'amountReceived', 'receiveAmount', 'estimatedAmount', 'estimated_received', 'estimated_amount',
    'amount', 'receive', 'receive_amount'
  ];

  // 1) try direct fields on root
  let rawTarget = undefined;
  for (const f of fieldsCheck) {
    if (respData[f] !== undefined && respData[f] !== null) {
      rawTarget = respData[f];
      break;
    }
  }

  // 2) try summary object
  const summary = respData.summary || {};
  if (rawTarget === undefined) {
    for (const f of fieldsCheck) {
      if (summary[f] !== undefined && summary[f] !== null) {
        rawTarget = summary[f];
        break;
      }
    }
    // also consider summary.amount as candidate
    if (rawTarget === undefined && summary.amount !== undefined) {
      rawTarget = summary.amount;
    }
  }

  // 3) determine rate if present
  const rate = pick(respData, 'rate', 'summary.rate', 'summary?.rate', 'exchangeRate') || summary.rate || respData.rate || undefined;

  // 4) rawSource candidate: attempt common fields that may represent source
  let rawSource = undefined;
  // If quote API echoes our requested amount somewhere, prefer passedAmount
  if (passedAmount !== undefined && passedAmount !== null) rawSource = passedAmount;
  // fallback to fields on respData that might represent source
  if (rawSource === undefined) {
    const sourceCandidates = ['amount', 'sourceAmount', 'requestedAmount', 'quoteAmount'];
    for (const c of sourceCandidates) {
      if (respData[c] !== undefined && respData[c] !== null) {
        rawSource = respData[c];
        break;
      }
      if (summary[c] !== undefined && summary[c] !== null) {
        rawSource = summary[c];
        break;
      }
    }
  }

  // 5) If still missing rawTarget but we have rate & source -> compute
  if ((rawTarget === undefined || rawTarget === null) && rate !== undefined && rawSource !== undefined) {
    // try rate as target-per-source
    rawTarget = Number(rawSource) * Number(rate);
  }

  // 6) If still missing rawTarget but rawSource exists and rate exists - try alternate inversion
  if ((rawTarget === undefined || rawTarget === null) && rate !== undefined && rawSource !== undefined) {
    const alt = Number(rawSource) / Number(rate);
    rawTarget = alt;
  }

  // final fallbacks
  if (rawTarget === undefined || rawTarget === null) rawTarget = 0;
  if (rawSource === undefined || rawSource === null) rawSource = 0;

  return {
    rawSourceAmount: Number(rawSource),
    rawTargetAmount: Number(rawTarget),
    rate: rate ? Number(rate) : (Number(rawSource) ? Number(rawTarget) / Number(rawSource) : 0)
  };
}

/**
 * Apply markdown reduction to Obiex amounts (reduce what Obiex gives us by percentage).
 * Reads markdown directly from the GlobalMarkdown model.
 *
 * Returns:
 *  {
 *    adjustedAmount,        // obiexAmount after reduction
 *    markdownApplied,       // boolean
 *    markdownPercentage,    // numeric (e.g. 0.3 for 0.3%)
 *    reductionAmount        // positive number removed from obiexAmount
 *  }
 */
async function applyMarkdownReduction(obiexAmount, currency) {
  try {
    // Do not apply to stablecoins
    if (STABLECOINS.has(currency.toUpperCase())) {
      return { adjustedAmount: obiexAmount, markdownApplied: false, markdownPercentage: 0, reductionAmount: 0 };
    }

    // Read markdown document directly from DB
    const markdownDoc = await GlobalMarkdown.getCurrentMarkdown();

    if (!markdownDoc || !markdownDoc.isActive || !markdownDoc.markdownPercentage || markdownDoc.markdownPercentage <= 0) {
      return { adjustedAmount: obiexAmount, markdownApplied: false, markdownPercentage: 0, reductionAmount: 0 };
    }

    const percent = markdownDoc.markdownPercentage; // treat as normal percent (e.g. 0.3 = 0.3%)
    const reductionMultiplier = 1 - (percent / 100);
    const adjustedAmount = Number(obiexAmount) * reductionMultiplier;
    const reductionAmount = Number(obiexAmount) - adjustedAmount;

    logger.info('Applied markdown reduction to Obiex amount', {
      currency,
      obiexAmount,
      markdownPercentage: percent,
      adjustedAmount,
      reductionAmount,
      markdownSource: markdownDoc.source
    });

    return {
      adjustedAmount,
      markdownApplied: true,
      markdownPercentage: percent,
      reductionAmount
    };
  } catch (err) {
    logger.warn('applyMarkdownReduction failed, returning original amount', { error: err.message });
    return { adjustedAmount: obiexAmount, markdownApplied: false, markdownPercentage: 0, reductionAmount: 0 };
  }
}

/**
 * Create Obiex quote for direct crypto swap
 */
async function createObiexDirectQuote(fromCurrency, toCurrency, amount, side) {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();

  const isCryptoToStablecoin = CRYPTOCURRENCIES.has(from) && STABLECOINS.has(to);

  let sourceId, targetId, quoteSide, quoteAmount;

  if (isCryptoToStablecoin) {
    // Crypto → Stablecoin (e.g., BTC → USDT): SELL crypto
    sourceId = await getCurrencyIdByCode(from);
    targetId = await getCurrencyIdByCode(to);
    quoteSide = 'SELL';
    quoteAmount = amount;
  } else {
    // Stablecoin → Crypto (e.g., USDT → BTC): BUY crypto
    // For Obiex, we pass the source as the currency being sent by the user.
    // Keep quoteAmount as the amount the user is sending.
    sourceId = await getCurrencyIdByCode(from);
    targetId = await getCurrencyIdByCode(to);
    quoteSide = 'BUY';
    quoteAmount = amount; // stablecoin amount user will spend
  }

  // Request quote from Obiex
  const quoteResult = await createQuote({
    sourceId,
    targetId,
    amount: quoteAmount,
    side: quoteSide
  });

  if (!quoteResult.success) {
    throw new Error(`Obiex quote creation failed: ${JSON.stringify(quoteResult.error)}`);
  }

  // Parse Obiex result defensively
  // pass quoteSide & passed amount so parser can choose correct fields
  const { rawSourceAmount, rawTargetAmount, rate } = parseObiexResponseForAmounts(quoteResult.data, quoteAmount, quoteSide);

  // If rawTargetAmount is zero but rate & rawSourceAmount are present, compute
  let obiexTarget = rawTargetAmount || (rawSourceAmount && rate ? rawSourceAmount * rate : 0);

  // If that is still zero, use raw fields as last resort
  obiexTarget = obiexTarget || Number(quoteResult.data?.estimatedAmount || quoteResult.data?.receiveAmount || quoteResult.data?.amount || 0);

  // Apply markdown reduction (reduce Obiex target amount by configured percentage)
  const markdownResult = await applyMarkdownReduction(obiexTarget, to);

  return {
    success: true,
    obiexQuoteId: quoteResult.quoteId || quoteResult.quote_id || null,
    obiexData: quoteResult.data,
    rawSourceAmount,
    rawTargetAmount: obiexTarget,
    adjustedAmount: markdownResult.adjustedAmount,
    markdownApplied: markdownResult.markdownApplied,
    markdownPercentage: markdownResult.markdownPercentage,
    reductionAmount: markdownResult.reductionAmount,
    rate: rate || (markdownResult.adjustedAmount && rawSourceAmount ? markdownResult.adjustedAmount / rawSourceAmount : 0)
  };
}

/**
 * Create Obiex quote for crypto-to-crypto swap (two steps)
 */
async function createObiexCryptoToCryptoQuote(fromCurrency, toCurrency, amount) {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  const intermediate = DEFAULT_STABLECOIN;

  // Step 1: Crypto → Stablecoin (SELL)
  const step1Result = await createObiexDirectQuote(from, intermediate, amount, 'SELL');
  if (!step1Result.success) {
    throw new Error(`Obiex step 1 quote failed`);
  }

  // Step 2: Stablecoin → Crypto (BUY) - use the step1Result.adjustedAmount as the available stablecoin
  const step2Result = await createObiexDirectQuote(intermediate, to, step1Result.adjustedAmount, 'BUY');
  if (!step2Result.success) {
    throw new Error(`Obiex step 2 quote failed`);
  }

  return {
    success: true,
    step1: {
      obiexQuoteId: step1Result.obiexQuoteId,
      fromCurrency: from,
      toCurrency: intermediate,
      amount,
      adjustedAmount: step1Result.adjustedAmount,
      markdownApplied: step1Result.markdownApplied,
      markdownPercentage: step1Result.markdownPercentage,
      reductionAmount: step1Result.reductionAmount,
      rawSourceAmount: step1Result.rawSourceAmount,
      rawTargetAmount: step1Result.rawTargetAmount,
      rate: step1Result.rate
    },
    step2: {
      obiexQuoteId: step2Result.obiexQuoteId,
      fromCurrency: intermediate,
      toCurrency: to,
      amount: step1Result.adjustedAmount,
      adjustedAmount: step2Result.adjustedAmount,
      markdownApplied: step2Result.markdownApplied,
      markdownPercentage: step2Result.markdownPercentage,
      reductionAmount: step2Result.reductionAmount,
      rawSourceAmount: step2Result.rawSourceAmount,
      rawTargetAmount: step2Result.rawTargetAmount,
      rate: step2Result.rate
    },
    overall: {
      fromCurrency: from,
      toCurrency: to,
      amount,
      adjustedAmount: step2Result.adjustedAmount,
      rate: step2Result.rate ? step2Result.rate / 1 : (step2Result.adjustedAmount / amount)
    }
  };
}

/**
 * Execute Obiex swap and update user balances
 */
async function executeObiexSwapWithBalanceUpdate(userId, quote, correlationId, systemContext) {
  const session = await mongoose.startSession();
  session.startTransaction();
  const startTime = new Date();

  try {
    const { sourceCurrency, targetCurrency, amount, swapType } = quote;

    // Validate balance before executing
    const validation = await validateUserBalance(userId, sourceCurrency, amount);
    if (!validation.success) {
      throw new Error(validation.message);
    }

    let obiexResult, finalAmountReceived;

    if (swapType === 'CRYPTO_TO_CRYPTO') {
      // Execute two-step Obiex swap
      const step1QuoteId = quote.obiexStep1QuoteId;
      const step2QuoteId = quote.obiexStep2QuoteId;

      // Accept step 1
      const step1Accept = await acceptQuote(step1QuoteId);
      if (!step1Accept.success) {
        throw new Error(`Obiex step 1 failed: ${JSON.stringify(step1Accept.error)}`);
      }

      // Accept step 2
      const step2Accept = await acceptQuote(step2QuoteId);
      if (!step2Accept.success) {
        throw new Error(`Obiex step 2 failed: ${JSON.stringify(step2Accept.error)}`);
      }

      // Parse accept responses defensively to get the actual amounts returned by Obiex
      const step2ObiexReceived = (
        Number(step2Accept.data?.amountReceived) ||
        Number(step2Accept.data?.receiveAmount) ||
        Number(step2Accept.data?.estimatedAmount) ||
        Number(step2Accept.data?.amount) || 0
      );
      const markdownResult = await applyMarkdownReduction(step2ObiexReceived, targetCurrency);
      finalAmountReceived = markdownResult.adjustedAmount;

      obiexResult = {
        step1: step1Accept.data,
        step2: step2Accept.data,
        markdownReduction: markdownResult
      };

    } else {
      // Execute direct Obiex swap
      const obiexQuoteId = quote.obiexQuoteId;

      const acceptResult = await acceptQuote(obiexQuoteId);
      if (!acceptResult.success) {
        throw new Error(`Obiex swap failed: ${JSON.stringify(acceptResult.error)}`);
      }

      const obiexAmount = (
        Number(acceptResult.data?.amountReceived) ||
        Number(acceptResult.data?.receiveAmount) ||
        Number(acceptResult.data?.estimatedAmount) ||
        Number(acceptResult.data?.amount) || 0
      );

      const markdownResult = await applyMarkdownReduction(obiexAmount, targetCurrency);
      finalAmountReceived = markdownResult.adjustedAmount;

      obiexResult = {
        acceptData: acceptResult.data,
        markdownReduction: markdownResult
      };
    }

    // Update user balances
    const fromKey = `${sourceCurrency.toLowerCase()}Balance`;
    const toKey = `${targetCurrency.toLowerCase()}Balance`;
    const swapReference = `OBIEX_SWAP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const userBefore = await User.findById(userId).select(`${fromKey} ${toKey}`).lean();

    const updatedUser = await User.findOneAndUpdate(
      {
        _id: userId,
        [fromKey]: { $gte: amount }
      },
      {
        $inc: {
          [fromKey]: -amount,
          [toKey]: finalAmountReceived
        },
        $set: {
          lastBalanceUpdate: new Date(),
          portfolioLastUpdated: new Date()
        }
      },
      {
        new: true,
        runValidators: true,
        session
      }
    );

    if (!updatedUser) {
      throw new Error(`Balance update failed - insufficient ${sourceCurrency} balance`);
    }

    userCache.delete(`user_balance_${userId}`);

    // Create transaction records
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
      obiexQuoteId: quote.obiexQuoteId,
      markdownApplied: obiexResult.markdownReduction?.markdownApplied || false,
      markdownPercentage: obiexResult.markdownReduction?.markdownPercentage || 0,
      reductionAmount: obiexResult.markdownReduction?.reductionAmount || 0,
      ...(swapType === 'CRYPTO_TO_CRYPTO' && {
        intermediateToken: quote.intermediateToken,
        routingPath: quote.routingPath
      })
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

    const endTime = new Date();

    logger.info('Obiex swap executed successfully', {
      userId,
      swapReference,
      correlationId,
      sourceCurrency,
      targetCurrency,
      sourceAmount: amount,
      targetAmount: finalAmountReceived,
      markdownApplied: metadata.markdownApplied,
      markdownPercentage: metadata.markdownPercentage,
      reductionAmount: metadata.reductionAmount
    });

    await createAuditEntry({
      userId,
      eventType: 'SWAP_COMPLETED',
      status: 'SUCCESS',
      source: 'OBIEX',
      action: 'Complete Obiex Swap',
      description: `Successfully completed Obiex swap with markdown reduction`,
      swapDetails: {
        swapId: swapReference,
        sourceCurrency,
        targetCurrency,
        sourceAmount: amount,
        targetAmount: finalAmountReceived,
        exchangeRate: finalAmountReceived / amount,
        provider: 'OBIEX',
        swapType,
        markdownApplied: metadata.markdownApplied,
        markdownPercentage: metadata.markdownPercentage,
        reductionAmount: metadata.reductionAmount
      },
      relatedEntities: {
        correlationId,
        relatedTransactionIds: [swapOutTransaction._id, swapInTransaction._id]
      },
      systemContext,
      timing: {
        startTime,
        endTime,
        duration: endTime - startTime
      },
      tags: ['swap', 'obiex', 'completed', 'success', 'markdown-reduced']
    });

    return {
      user: updatedUser,
      swapOutTransaction,
      swapInTransaction,
      swapId: swapReference,
      obiexResult
    };

  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    const endTime = new Date();

    logger.error('Obiex swap execution failed', {
      error: err.message,
      stack: err.stack,
      userId,
      correlationId,
      quote
    });

    await createAuditEntry({
      userId,
      eventType: 'SWAP_FAILED',
      status: 'FAILED',
      source: 'OBIEX',
      action: 'Failed Obiex Swap',
      description: `Obiex swap failed: ${err.message}`,
      errorDetails: {
        message: err.message,
        code: 'OBIEX_SWAP_ERROR',
        stack: err.stack
      },
      swapDetails: {
        sourceCurrency: quote.sourceCurrency,
        targetCurrency: quote.targetCurrency,
        sourceAmount: quote.amount,
        provider: 'OBIEX',
        swapType: quote.swapType
      },
      relatedEntities: {
        correlationId
      },
      systemContext,
      timing: {
        startTime,
        endTime,
        duration: endTime - startTime
      },
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

    // Validation
    if (!from || !to || !amount || !side) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: from, to, amount, side'
      });
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount. Must be a positive number.'
      });
    }

    const pairValidation = validateSwapPair(from, to);
    if (!pairValidation.success) {
      return res.status(400).json({
        success: false,
        message: pairValidation.message
      });
    }

    const id = `obiex_swap_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const expiresAt = new Date(Date.now() + QUOTE_TTL).toISOString();

    let payload;

    if (pairValidation.swapType === 'CRYPTO_TO_CRYPTO') {
      const cryptoQuote = await createObiexCryptoToCryptoQuote(from, to, amount);

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

      logger.info('Crypto-to-crypto Obiex quote created', {
        sourceAmount: amount,
        sourceCurrency: from.toUpperCase(),
        targetAmount: cryptoQuote.overall.adjustedAmount,
        targetCurrency: to.toUpperCase(),
        intermediateToken: pairValidation.intermediateToken,
        correlationId
      });

    } else {
      // Direct swap
      const directQuote = await createObiexDirectQuote(from, to, amount, side);

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

      logger.info('Direct Obiex quote created', {
        sourceAmount: amount,
        sourceCurrency: from.toUpperCase(),
        targetAmount: directQuote.adjustedAmount,
        targetCurrency: to.toUpperCase(),
        markdownApplied: directQuote.markdownApplied,
        correlationId
      });
    }

    quoteCache.set(id, payload);
    setTimeout(() => quoteCache.delete(id), QUOTE_TTL);

    return res.json({
      success: true,
      message: 'Obiex swap quote created successfully',
      data: { data: payload, ...payload }
    });

  } catch (err) {
    logger.error('POST /swap/quote error', { error: err.stack, correlationId });

    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to create quote'
    });
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

    if (!quote) {
      return res.status(404).json({
        success: false,
        message: 'Quote not found or expired'
      });
    }

    if (new Date() > new Date(quote.expiresAt)) {
      quoteCache.delete(quoteId);
      return res.status(410).json({
        success: false,
        message: 'Quote has expired'
      });
    }

    const validation = await validateUserBalance(userId, quote.sourceCurrency, quote.amount);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: validation.message,
        balanceError: true,
        availableBalance: validation.availableBalance
      });
    }

    // Execute Obiex swap and update balances
    const swapResult = await executeObiexSwapWithBalanceUpdate(
      userId,
      quote,
      correlationId,
      systemContext
    );

    logger.info('Obiex swap completed successfully', {
      userId,
      quoteId,
      correlationId,
      swapId: swapResult.swapId
    });

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
      transactions: {
        swapId: swapResult.swapId,
        swapOutTransactionId: swapResult.swapOutTransaction._id,
        swapInTransactionId: swapResult.swapInTransaction._id
      },
      balanceUpdated: true,
      newBalances: {
        [quote.sourceCurrency.toLowerCase()]: swapResult.user[`${quote.sourceCurrency.toLowerCase()}Balance`],
        [quote.targetCurrency.toLowerCase()]: swapResult.user[`${quote.targetCurrency.toLowerCase()}Balance`]
      }
    };

    return res.json({
      success: true,
      message: 'Obiex swap completed successfully',
      data: { data: responsePayload, ...responsePayload }
    });

  } catch (err) {
    logger.error('POST /swap/quote/:quoteId error', {
      error: err.stack,
      userId: req.user?.id,
      quoteId: req.params?.quoteId
    });

    return res.status(500).json({
      success: false,
      message: err.message || 'Swap failed - please try again'
    });
  }
});

// GET /swap/tokens - Get supported tokens
router.get('/tokens', (req, res) => {
  try {
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
  } catch (err) {
    logger.error('GET /swap/tokens error', { error: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Clean up expired quotes and stale user cache entries
setInterval(() => {
  const now = Date.now();
  for (const [key, quote] of quoteCache.entries()) {
    if (now > new Date(quote.expiresAt).getTime()) {
      quoteCache.delete(key);
    }
  }
  for (const [key, entry] of userCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL) {
      userCache.delete(key);
    }
  }
}, 60000);

module.exports = router;
