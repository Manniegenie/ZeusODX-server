const express = require('express');
const mongoose = require('mongoose');
const { getPricesWithCache } = require('../services/portfolio');
const Transaction = require('../models/transaction');
const User = require('../models/user');
const logger = require('../utils/logger');

const router = express.Router();

// Optimized caching
const quoteCache = new Map();
const userCache = new Map();
const priceCache = new Map();
const CACHE_TTL = 30000; // 30 seconds
const QUOTE_TTL = 30000; // 30 seconds for quotes
const PRICE_CACHE_TTL = 5000; // 5 seconds for prices

// Pre-compiled token validation - MAINTAINING ORIGINAL TOKEN_MAP STRUCTURE
const SUPPORTED_TOKENS = new Set(['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX']);
const TOKEN_MAP = {
  BTC: { name: 'Bitcoin', currency: 'btc' },
  ETH: { name: 'Ethereum', currency: 'eth' },
  SOL: { name: 'Solana', currency: 'sol' },
  USDT: { name: 'Tether', currency: 'usdt' },
  USDC: { name: 'USD Coin', currency: 'usdc' },
  BNB: { name: 'BNB', currency: 'bnb' },
  MATIC: { name: 'Polygon', currency: 'matic' },
  AVAX: { name: 'Avalanche', currency: 'avax' }
};

/**
 * Optimized user balance retrieval with caching
 */
async function getCachedUserBalance(userId, currencies = []) {
  const cacheKey = `user_balance_${userId}`;
  const cached = userCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.user;
  }
  
  // Build select fields dynamically based on needed currencies
  const selectFields = ['_id', 'lastBalanceUpdate', 'portfolioLastUpdated'];
  if (currencies.length > 0) {
    currencies.forEach(currency => {
      selectFields.push(`${currency.toLowerCase()}Balance`);
    });
  } else {
    // Select all balance fields if no specific currencies requested
    Object.values(TOKEN_MAP).forEach(token => {
      selectFields.push(`${token.currency}Balance`);
    });
  }
  
  const user = await User.findById(userId)
    .select(selectFields.join(' '))
    .lean(); // Use lean for better performance
  
  if (user) {
    userCache.set(cacheKey, { user, timestamp: Date.now() });
    // Auto-cleanup cache
    setTimeout(() => userCache.delete(cacheKey), CACHE_TTL);
  }
  
  return user;
}

/**
 * Optimized price fetching with enhanced caching
 */
async function getCachedPrices(currencies) {
  const cacheKey = currencies.sort().join('_');
  const cached = priceCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp) < PRICE_CACHE_TTL) {
    return cached.prices;
  }
  
  const prices = await getPricesWithCache(currencies);
  priceCache.set(cacheKey, { prices, timestamp: Date.now() });
  
  // Auto-cleanup cache
  setTimeout(() => priceCache.delete(cacheKey), PRICE_CACHE_TTL);
  
  return prices;
}

// MAINTAINING ORIGINAL VALIDATION FUNCTION SIGNATURE
async function validateUserBalance(userId, currency, amount) {
  const user = await getCachedUserBalance(userId, [currency]);
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

// MAINTAINING ORIGINAL FUNCTION SIGNATURE BUT OPTIMIZED
async function calculateCryptoExchange(fromCurrency, toCurrency, amount) {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  const prices = await getCachedPrices([from, to]);
  const fromPrice = prices[from];
  const toPrice = prices[to];
  
  if (!fromPrice || !toPrice) {
    throw new Error(`Price unavailable for ${!fromPrice ? from : to}`);
  }
  
  const exchangeRate = fromPrice / toPrice;
  const receiveAmount = amount * exchangeRate;
  
  return { 
    success: true, 
    fromPrice, 
    toPrice, 
    exchangeRate, 
    receiveAmount 
  };
}

/**
 * Execute crypto-to-crypto swap with atomic balance updates and transaction creation
 * MAINTAINING ORIGINAL FUNCTION SIGNATURE AND BEHAVIOR BUT OPTIMIZED
 */
async function executeCryptoSwap(userId, quote) {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { sourceCurrency, targetCurrency, amount, amountReceived, type } = quote;
    
    // Balance field names
    const fromKey = sourceCurrency.toLowerCase() + 'Balance';
    const toKey = targetCurrency.toLowerCase() + 'Balance';
    
    // Generate swap reference
    const swapReference = `CRYPTO_SWAP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // 1. Update balances atomically with balance validation (like webhook does)
    const updatedUser = await User.findOneAndUpdate(
      { 
        _id: userId, 
        [fromKey]: { $gte: amount } // Ensure sufficient balance
      },
      {
        $inc: {
          [fromKey]: -amount,      // Deduct source currency
          [toKey]: amountReceived  // Add target currency
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
      throw new Error(`Balance update failed - insufficient ${sourceCurrency} balance or user not found`);
    }

    // Clear user cache
    userCache.delete(`user_balance_${userId}`);

    // 2. Create outgoing transaction (debit) - MAINTAINING ORIGINAL STRUCTURE
    const swapOutTransaction = new Transaction({
      userId,
      type: 'SWAP',
      currency: sourceCurrency,
      amount: -amount, // Negative for outgoing
      status: 'SUCCESSFUL',
      source: 'INTERNAL',
      reference: swapReference,
      obiexTransactionId: `${swapReference}_OUT`,
      narration: `Crypto Swap: ${amount} ${sourceCurrency} to ${amountReceived} ${targetCurrency}`,
      completedAt: new Date(),
      metadata: {
        swapDirection: 'OUT',
        swapType: type,
        exchangeRate: amountReceived / amount,
        relatedTransactionRef: swapReference,
        fromCurrency: sourceCurrency,
        toCurrency: targetCurrency,
        fromAmount: amount,
        toAmount: amountReceived
      }
    });

    // 3. Create incoming transaction (credit) - MAINTAINING ORIGINAL STRUCTURE
    const swapInTransaction = new Transaction({
      userId,
      type: 'SWAP',
      currency: targetCurrency,
      amount: amountReceived, // Positive for incoming
      status: 'SUCCESSFUL',
      source: 'INTERNAL',
      reference: swapReference,
      obiexTransactionId: `${swapReference}_IN`,
      narration: `Crypto Swap: ${amount} ${sourceCurrency} to ${amountReceived} ${targetCurrency}`,
      completedAt: new Date(),
      metadata: {
        swapDirection: 'IN',
        swapType: type,
        exchangeRate: amountReceived / amount,
        relatedTransactionRef: swapReference,
        fromCurrency: sourceCurrency,
        toCurrency: targetCurrency,
        fromAmount: amount,
        toAmount: amountReceived
      }
    });

    // 4. Save both transactions (could be optimized with insertMany but maintaining original logic)
    await swapOutTransaction.save({ session });
    await swapInTransaction.save({ session });

    // 5. Commit everything
    await session.commitTransaction();
    session.endSession();

    logger.info('Crypto swap executed successfully', {
      userId,
      swapReference,
      sourceCurrency,
      targetCurrency,
      sourceAmount: amount,
      targetAmount: amountReceived,
      exchangeRate: amountReceived / amount,
      newFromBalance: updatedUser[fromKey],
      newToBalance: updatedUser[toKey],
      outTransactionId: swapOutTransaction._id,
      inTransactionId: swapInTransaction._id
    });

    return {
      user: updatedUser,
      swapOutTransaction,
      swapInTransaction,
      swapId: swapReference
    };

  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    
    logger.error('Crypto swap execution failed', {
      error: err.message,
      stack: err.stack,
      userId,
      quote
    });
    
    throw err;
  }
}

// MAINTAINING ORIGINAL QUOTE ENDPOINT STRUCTURE BUT OPTIMIZED
router.post('/quote', async (req, res) => {
  try {
    const { from, to, amount, side } = req.body;
    
    // Validation - MAINTAINING ORIGINAL ERROR MESSAGES
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
    
    if (!['BUY', 'SELL'].includes(side)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid side. Must be BUY or SELL.' 
      });
    }

    // Calculate crypto exchange rate - OPTIMIZED WITH CACHING
    const result = await calculateCryptoExchange(from, to, amount);
    
    const id = `crypto_swap_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const expiresAt = new Date(Date.now() + 30000).toISOString(); // 30 seconds

    // MAINTAINING ORIGINAL PAYLOAD STRUCTURE
    const payload = {
      id,
      amount,
      amountReceived: result.receiveAmount,
      rate: result.exchangeRate,
      side,
      sourceCurrency: from.toUpperCase(),
      targetCurrency: to.toUpperCase(),
      provider: 'INTERNAL_EXCHANGE',
      type: 'CRYPTO_TO_CRYPTO',
      expiresAt,
      fromPrice: result.fromPrice,
      toPrice: result.toPrice
    };

    logger.info('Crypto swap quote created', {
      sourceAmount: amount,
      sourceCurrency: from.toUpperCase(),
      targetAmount: result.receiveAmount,
      targetCurrency: to.toUpperCase(),
      exchangeRate: result.exchangeRate,
      fromPrice: result.fromPrice,
      toPrice: result.toPrice
    });

    // OPTIMIZED CACHING WITH AUTO-CLEANUP
    quoteCache.set(id, payload);
    setTimeout(() => quoteCache.delete(id), 30000);

    // MAINTAINING ORIGINAL RESPONSE STRUCTURE
    return res.json({
      success: true,
      message: 'Crypto swap quote created successfully',
      data: { data: payload, ...payload }
    });

  } catch (err) {
    logger.error('POST /swap/quote error', { error: err.stack });
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
});

// MAINTAINING ORIGINAL SWAP EXECUTION ENDPOINT STRUCTURE BUT OPTIMIZED
router.post('/quote/:quoteId', async (req, res) => {
  try {
    const { quoteId } = req.params;
    const userId = req.user.id;
    const quote = quoteCache.get(quoteId);

    // MAINTAINING ORIGINAL ERROR HANDLING
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

    // Validate user balance - OPTIMIZED WITH CACHING
    const validation = await validateUserBalance(userId, quote.sourceCurrency, quote.amount);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: validation.message,
        balanceError: true,
        availableBalance: validation.availableBalance,
        requiredAmount: quote.amount,
        currency: quote.sourceCurrency
      });
    }

    // Execute swap directly (like your webhook does) - NO SERVICE LAYER
    const swapResult = await executeCryptoSwap(userId, quote);

    logger.info('Crypto swap completed', { 
      userId, 
      quoteId, 
      swapId: swapResult.swapId,
      swapOutTransactionId: swapResult.swapOutTransaction._id,
      swapInTransactionId: swapResult.swapInTransaction._id
    });

    // Clean up quote from cache
    quoteCache.delete(quoteId);

    // MAINTAINING ORIGINAL RESPONSE PAYLOAD STRUCTURE
    const responsePayload = {
      swapId: swapResult.swapId,
      quoteId,
      status: 'SUCCESSFUL',
      swapDetails: {
        sourceCurrency: quote.sourceCurrency,
        targetCurrency: quote.targetCurrency,
        sourceAmount: quote.amount,
        targetAmount: quote.amountReceived,
        exchangeRate: quote.rate,
        provider: quote.provider,
        swapType: quote.type
      },
      transactions: {
        swapId: swapResult.swapId,
        swapOutTransactionId: swapResult.swapOutTransaction._id,
        swapInTransactionId: swapResult.swapInTransaction._id,
        obiexTransactionId: swapResult.swapId
      },
      balanceUpdated: true,
      newBalances: {
        [quote.sourceCurrency.toLowerCase()]: swapResult.user[`${quote.sourceCurrency.toLowerCase()}Balance`],
        [quote.targetCurrency.toLowerCase()]: swapResult.user[`${quote.targetCurrency.toLowerCase()}Balance`]
      }
    };

    // MAINTAINING ORIGINAL RESPONSE STRUCTURE
    return res.json({
      success: true,
      message: 'Crypto swap completed successfully',
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

// MAINTAINING ORIGINAL TOKENS ENDPOINT STRUCTURE
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

// Clean up caches periodically to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  
  // Clean expired quotes
  for (const [key, quote] of quoteCache.entries()) {
    if (now > new Date(quote.expiresAt).getTime()) {
      quoteCache.delete(key);
    }
  }
  
  // Clean old user cache entries
  for (const [key, entry] of userCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL) {
      userCache.delete(key);
    }
  }
  
  // Clean old price cache entries
  for (const [key, entry] of priceCache.entries()) {
    if (now - entry.timestamp > PRICE_CACHE_TTL) {
      priceCache.delete(key);
    }
  }
}, 60000); // Clean every minute

module.exports = router;