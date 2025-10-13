// routes/swap.js
const express = require('express');
const mongoose = require('mongoose');
const { getPricesWithCache, getGlobalMarkdownPercentage } = require('../services/portfolio');
const { swapCryptoToNGNX, getCurrencyIdByCode, createQuote, acceptQuote } = require('../services/ObiexSwap');
const Transaction = require('../models/transaction');
const User = require('../models/user');
const TransactionAudit = require('../models/TransactionAudit');
const logger = require('../utils/logger');
const GlobalMarkdown = require('../models/pricemarkdown');
const { sendSwapCompletionNotification } = require('../services/notificationService');

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
 * Apply markdown reduction to Obiex amounts (reduce what Obiex gives us by percentage).
 * Reads markdown directly from the GlobalMarkdown model.
 */
async function applyMarkdownReduction(obiexAmount, currency) {
  try {
    // Read markdown document directly from DB
    const markdownDoc = await GlobalMarkdown.getCurrentMarkdown();

    if (!markdownDoc || !markdownDoc.isActive || !markdownDoc.markdownPercentage || markdownDoc.markdownPercentage <= 0) {
      return { adjustedAmount: obiexAmount, markdownApplied: false, markdownPercentage: 0, reductionAmount: 0 };
    }

    const percent = markdownDoc.markdownPercentage; // e.g. 0.3 for 0.3%
    const reductionMultiplier = 1 - (percent / 100);
    const adjustedAmount = obiexAmount * reductionMultiplier;
    const reductionAmount = obiexAmount - adjustedAmount;

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
 * Create audit entry
 */
async function createAuditEntry(auditData) {
  try {
    await TransactionAudit.createAudit(auditData);
  } catch (error) {
    logger.error('Failed to create audit entry', {
      error: error.message,
      auditData: { ...auditData, requestData: '[REDACTED]', responseData: '[REDACTED]' }
    });
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
  
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.user;
  }
  
  const selectFields = ['_id', 'lastBalanceUpdate', 'portfolioLastUpdated'];
  if (currencies.length > 0) {
    currencies.forEach(currency => {
      selectFields.push(`${currency.toLowerCase()}Balance`);
    });
  } else {
    Object.values(TOKEN_MAP).forEach(token => {
      selectFields.push(`${token.currency}Balance`);
    });
  }
  
  const user = await User.findById(userId)
    .select(selectFields.join(' '))
    .lean();
  
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
    return {
      success: false,
      message: `Insufficient ${currency} balance. Available: ${available}, Required: ${amount}`,
      availableBalance: available
    };
  }
  
  return { success: true, availableBalance: available };
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
    // For Obiex, source is always the crypto, target is stablecoin
    sourceId = await getCurrencyIdByCode(to); // crypto
    targetId = await getCurrencyIdByCode(from); // stablecoin
    quoteSide = 'BUY';
    quoteAmount = amount; // stablecoin amount to spend
  }
  
  const quoteResult = await createQuote({
    sourceId,
    targetId,
    amount: quoteAmount,
    side: quoteSide
  });
  
  if (!quoteResult.success) {
    throw new Error(`Obiex quote creation failed: ${JSON.stringify(quoteResult.error)}`);
  }
  
  // Extract the amount user will receive from Obiex
  let obiexAmount;
  
  // Try to get the received amount from various possible fields
  if (quoteResult.data?.amountReceived) {
    obiexAmount = quoteResult.data.amountReceived;
  } else if (quoteResult.data?.estimatedAmount) {
    obiexAmount = quoteResult.data.estimatedAmount;
  } else if (quoteResult.data?.receiveAmount) {
    obiexAmount = quoteResult.data.receiveAmount;
  } else if (quoteResult.data?.estimatedReceiveAmount) {
    obiexAmount = quoteResult.data.estimatedReceiveAmount;
  } else if (quoteResult.data?.rate && quoteResult.data?.amount) {
    // Calculate received amount from rate and input amount
    const rate = quoteResult.data.rate;
    const inputAmount = quoteResult.data.amount;
    
    if (quoteSide === 'BUY') {
      // When buying crypto with stablecoin: receivedCrypto = stablecoinAmount × rate
      obiexAmount = inputAmount * rate;
    } else {
      // When selling crypto for stablecoin: receivedStablecoin = cryptoAmount × rate
      obiexAmount = inputAmount * rate;
    }
    
    logger.info('Calculated Obiex received amount from rate', {
      quoteSide,
      inputAmount,
      rate,
      calculatedAmount: obiexAmount,
      from,
      to
    });
  } else {
    // Fallback - but this is likely wrong
    obiexAmount = quoteResult.data?.amount || 0;
    logger.warn('Could not find received amount in Obiex quote, using fallback', {
      quoteData: quoteResult.data,
      from,
      to,
      quoteSide
    });
  }
  
  // Apply markdown reduction (reduce Obiex amount by configured percentage)
  const markdownResult = await applyMarkdownReduction(obiexAmount, to);
  
  return {
    success: true,
    obiexQuoteId: quoteResult.quoteId || quoteResult.id || null,
    obiexData: quoteResult.data,
    obiexAmount,
    adjustedAmount: markdownResult.adjustedAmount,
    markdownApplied: markdownResult.markdownApplied,
    markdownPercentage: markdownResult.markdownPercentage,
    reductionAmount: markdownResult.reductionAmount,
    rate: (markdownResult.adjustedAmount / amount) || 0
  };
}

/**
 * Create Obiex quote for crypto-to-crypto swap (two steps)
 */
async function createObiexCryptoToCryptoQuote(fromCurrency, toCurrency, amount) {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  const intermediate = DEFAULT_STABLECOIN;
  
  // Step 1: Crypto → Stablecoin (e.g., BTC → USDT)
  const step1Result = await createObiexDirectQuote(from, intermediate, amount, 'SELL');
  if (!step1Result.success) {
    throw new Error(`Obiex step 1 quote failed`);
  }
  
  // Step 2: Stablecoin → Crypto (e.g., USDT → ETH)
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
      reductionAmount: step1Result.reductionAmount
    },
    step2: {
      obiexQuoteId: step2Result.obiexQuoteId,
      fromCurrency: intermediate,
      toCurrency: to,
      amount: step1Result.adjustedAmount,
      adjustedAmount: step2Result.adjustedAmount,
      markdownApplied: step2Result.markdownApplied,
      markdownPercentage: step2Result.markdownPercentage,
      reductionAmount: step2Result.reductionAmount
    },
    overall: {
      fromCurrency: from,
      toCurrency: to,
      amount,
      adjustedAmount: step2Result.adjustedAmount,
      rate: step2Result.adjustedAmount / amount
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
      
      // Get final amount from Obiex (what Obiex will provide) and apply markdown reduction
      const step2Amount = step2Accept.data?.amountReceived || step2Accept.data?.amount || 0;
      const markdownResult = await applyMarkdownReduction(step2Amount, targetCurrency);
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
      
      // Get amount and apply markdown reduction
      const obiexAmount = acceptResult.data?.amountReceived || acceptResult.data?.amount || 0;
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

    // Send swap completion notification
    try {
      await sendSwapCompletionNotification(
        userId,
        amount,
        sourceCurrency,
        finalAmountReceived,
        targetCurrency,
        false, // not NGNZ swap
        {
          swapId: swapReference,
          correlationId,
          markdownApplied: metadata.markdownApplied,
          markdownPercentage: metadata.markdownPercentage,
          provider: 'OBIEX'
        }
      );
      logger.info('Swap completion notification sent', { 
        userId, 
        swapReference, 
        sourceCurrency, 
        targetCurrency 
      });
    } catch (notificationError) {
      logger.error('Failed to send swap completion notification', {
        userId,
        swapReference,
        error: notificationError.message
      });
    }
    
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
      // Crypto-to-crypto via stablecoin routing
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