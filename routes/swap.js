const express = require('express');
const mongoose = require('mongoose');
const { getPricesWithCache } = require('../services/portfolio');
const { swapCryptoToNGNX, getCurrencyIdByCode, createQuote, acceptQuote } = require('../services/ObiexSwap');
const Transaction = require('../models/transaction');
const User = require('../models/user');
const TransactionAudit = require('../models/TransactionAudit');
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

// Define stablecoins and other cryptocurrencies
const STABLECOINS = new Set(['USDT', 'USDC']);
const CRYPTOCURRENCIES = new Set(['BTC', 'ETH', 'SOL', 'BNB', 'MATIC', 'AVAX']);

/**
 * Validate swap pair - only allow crypto to stablecoin and vice versa
 */
function validateSwapPair(from, to) {
  const fromUpper = from.toUpperCase();
  const toUpper = to.toUpperCase();
  
  // Check if both currencies are supported
  if (!SUPPORTED_TOKENS.has(fromUpper) || !SUPPORTED_TOKENS.has(toUpper)) {
    return {
      success: false,
      message: `Unsupported currency. Supported tokens: ${Array.from(SUPPORTED_TOKENS).join(', ')}`
    };
  }
  
  // Check if trying to swap same currency
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
  
  // Only allow crypto to stablecoin or stablecoin to crypto
  if ((fromIsCrypto && toIsStablecoin) || (fromIsStablecoin && toIsCrypto)) {
    return { success: true };
  }
  
  // Block crypto to crypto swaps
  if (fromIsCrypto && toIsCrypto) {
    return {
      success: false,
      message: 'Direct crypto-to-crypto swaps are not supported. Please swap through a stablecoin (USDT or USDC)'
    };
  }
  
  // Block stablecoin to stablecoin swaps
  if (fromIsStablecoin && toIsStablecoin) {
    return {
      success: false,
      message: 'Stablecoin-to-stablecoin swaps are not supported'
    };
  }
  
  return {
    success: false,
    message: 'Invalid swap pair. Only crypto-to-stablecoin and stablecoin-to-crypto swaps are allowed'
  };
}

/**
 * Create audit entry with error handling
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

/**
 * Generate correlation ID for tracking related operations
 */
function generateCorrelationId() {
  return `CORR_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get system context from request
 */
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
 * Execute Obiex swap in background (non-blocking) with comprehensive auditing
 */
async function executeObiexSwapBackground(userId, quote, swapId, correlationId, systemContext) {
  const auditStartTime = new Date();
  
  try {
    const { sourceCurrency, targetCurrency, amount } = quote;
    
    // Create initial audit entry
    await createAuditEntry({
      userId,
      eventType: 'OBIEX_SWAP_INITIATED',
      status: 'PENDING',
      source: 'BACKGROUND_JOB',
      action: 'Initiate Background Obiex Swap',
      description: `Starting Obiex swap: ${amount} ${sourceCurrency} to ${targetCurrency}`,
      swapDetails: {
        swapId,
        sourceCurrency,
        targetCurrency,
        sourceAmount: amount,
        provider: 'OBIEX',
        swapType: targetCurrency.toUpperCase() === 'NGNX' ? 'CRYPTO_TO_NGNX' : 'CRYPTO_TO_STABLECOIN'
      },
      relatedEntities: {
        correlationId
      },
      systemContext,
      timing: {
        startTime: auditStartTime
      },
      tags: ['background', 'obiex', 'swap']
    });
    
    // Check if this is a crypto-to-NGNX swap
    if (targetCurrency.toUpperCase() === 'NGNX') {
      logger.info('Executing Obiex crypto-to-NGNX swap in background', {
        userId,
        swapId,
        sourceCurrency,
        amount,
        correlationId
      });
      
      const obiexResult = await swapCryptoToNGNX({
        sourceCode: sourceCurrency,
        amount: amount
      });
      
      const auditEndTime = new Date();
      
      if (obiexResult.success) {
        logger.info('Obiex crypto-to-NGNX swap completed successfully', {
          userId,
          swapId,
          correlationId,
          obiexData: obiexResult.data
        });
        
        // Create success audit entry
        await createAuditEntry({
          userId,
          eventType: 'OBIEX_SWAP_COMPLETED',
          status: 'SUCCESS',
          source: 'OBIEX_API',
          action: 'Complete Crypto-to-NGNX Swap',
          description: `Successfully completed Obiex crypto-to-NGNX swap`,
          swapDetails: {
            swapId,
            sourceCurrency,
            targetCurrency,
            sourceAmount: amount,
            provider: 'OBIEX',
            swapType: 'CRYPTO_TO_NGNX'
          },
          obiexDetails: {
            obiexTransactionId: obiexResult.data?.id || obiexResult.data?.reference,
            obiexStatus: obiexResult.data?.status || 'COMPLETED',
            obiexResponse: obiexResult.data,
            obiexOperationType: 'CRYPTO_TO_NGNX'
          },
          relatedEntities: {
            correlationId
          },
          responseData: obiexResult.data,
          systemContext,
          timing: {
            startTime: auditStartTime,
            endTime: auditEndTime,
            duration: auditEndTime - auditStartTime
          },
          tags: ['background', 'obiex', 'swap', 'success']
        });
        
        // Optional: Create a record of the Obiex transaction
        await createObiexTransactionRecord(userId, swapId, obiexResult, 'CRYPTO_TO_NGNX', correlationId);
      } else {
        logger.error('Obiex crypto-to-NGNX swap failed', {
          userId,
          swapId,
          correlationId,
          error: obiexResult.error,
          statusCode: obiexResult.statusCode
        });
        
        // Create failure audit entry
        await createAuditEntry({
          userId,
          eventType: 'OBIEX_SWAP_FAILED',
          status: 'FAILED',
          source: 'OBIEX_API',
          action: 'Failed Crypto-to-NGNX Swap',
          description: `Obiex crypto-to-NGNX swap failed: ${obiexResult.error?.message || 'Unknown error'}`,
          errorDetails: {
            message: obiexResult.error?.message || 'Unknown error',
            code: obiexResult.error?.code || 'OBIEX_ERROR',
            httpStatus: obiexResult.statusCode,
            providerError: obiexResult.error
          },
          swapDetails: {
            swapId,
            sourceCurrency,
            targetCurrency,
            sourceAmount: amount,
            provider: 'OBIEX',
            swapType: 'CRYPTO_TO_NGNX'
          },
          relatedEntities: {
            correlationId
          },
          responseData: obiexResult,
          systemContext,
          timing: {
            startTime: auditStartTime,
            endTime: auditEndTime,
            duration: auditEndTime - auditStartTime
          },
          riskLevel: 'MEDIUM',
          flagged: true,
          flagReason: 'Obiex swap operation failed',
          tags: ['background', 'obiex', 'swap', 'failed', 'error']
        });
      }
    } else {
      // For crypto-to-stablecoin swaps, execute two separate Obiex operations
      logger.info('Executing Obiex crypto-to-stablecoin swap in background', {
        userId,
        swapId,
        sourceCurrency,
        targetCurrency,
        amount,
        correlationId
      });
      
      await executeObiexCryptoStablecoinSwap(userId, swapId, sourceCurrency, targetCurrency, amount, correlationId, systemContext, auditStartTime);
    }
    
  } catch (error) {
    const auditEndTime = new Date();
    
    logger.error('Background Obiex swap execution failed', {
      userId,
      swapId,
      correlationId,
      error: error.message,
      stack: error.stack
    });
    
    // Create error audit entry
    await createAuditEntry({
      userId,
      eventType: 'OBIEX_SWAP_FAILED',
      status: 'FAILED',
      source: 'BACKGROUND_JOB',
      action: 'Background Obiex Swap Error',
      description: `Background Obiex swap failed with error: ${error.message}`,
      errorDetails: {
        message: error.message,
        code: 'BACKGROUND_SWAP_ERROR',
        stack: error.stack
      },
      swapDetails: {
        swapId,
        sourceCurrency: quote.sourceCurrency,
        targetCurrency: quote.targetCurrency,
        sourceAmount: quote.amount,
        provider: 'OBIEX',
        swapType: 'UNKNOWN'
      },
      relatedEntities: {
        correlationId
      },
      systemContext,
      timing: {
        startTime: auditStartTime,
        endTime: auditEndTime,
        duration: auditEndTime - auditStartTime
      },
      riskLevel: 'HIGH',
      flagged: true,
      flagReason: 'Critical error in background Obiex swap',
      tags: ['background', 'obiex', 'swap', 'critical-error']
    });
  }
}

/**
 * Execute crypto-to-stablecoin swap via Obiex (background process) with auditing
 */
async function executeObiexCryptoStablecoinSwap(userId, swapId, sourceCurrency, targetCurrency, amount, correlationId, systemContext, startTime) {
  try {
    // Get currency IDs for Obiex
    const sourceId = await getCurrencyIdByCode(sourceCurrency);
    const targetId = await getCurrencyIdByCode(targetCurrency);
    
    // Create and accept quote for the swap
    const quoteResult = await createQuote({
      sourceId,
      targetId,
      amount,
      side: 'SELL'
    });
    
    if (!quoteResult.success) {
      throw new Error(`Obiex quote creation failed: ${JSON.stringify(quoteResult.error)}`);
    }
    
    const acceptResult = await acceptQuote(quoteResult.quoteId);
    const auditEndTime = new Date();
    
    if (acceptResult.success) {
      logger.info('Obiex crypto-to-stablecoin swap completed successfully', {
        userId,
        swapId,
        sourceCurrency,
        targetCurrency,
        amount,
        correlationId,
        quoteId: quoteResult.quoteId,
        obiexData: acceptResult.data
      });
      
      // Create success audit entry
      await createAuditEntry({
        userId,
        eventType: 'OBIEX_SWAP_COMPLETED',
        status: 'SUCCESS',
        source: 'OBIEX_API',
        action: 'Complete Crypto-to-Stablecoin Swap',
        description: `Successfully completed Obiex crypto-to-stablecoin swap`,
        swapDetails: {
          swapId,
          sourceCurrency,
          targetCurrency,
          sourceAmount: amount,
          provider: 'OBIEX',
          swapType: 'CRYPTO_TO_STABLECOIN'
        },
        obiexDetails: {
          obiexTransactionId: acceptResult.data?.id || acceptResult.data?.reference,
          obiexQuoteId: quoteResult.quoteId,
          obiexStatus: acceptResult.data?.status || 'COMPLETED',
          obiexResponse: acceptResult.data,
          obiexOperationType: 'QUOTE_ACCEPT'
        },
        relatedEntities: {
          correlationId
        },
        requestData: { sourceId, targetId, amount, side: 'SELL' },
        responseData: acceptResult.data,
        systemContext,
        timing: {
          startTime,
          endTime: auditEndTime,
          duration: auditEndTime - startTime
        },
        tags: ['background', 'obiex', 'swap', 'crypto-to-stablecoin', 'success']
      });
      
      // Create a record of the Obiex transaction
      await createObiexTransactionRecord(userId, swapId, {
        quoteId: quoteResult.quoteId,
        quoteData: quoteResult.data,
        acceptData: acceptResult.data
      }, 'CRYPTO_TO_STABLECOIN', correlationId);
      
    } else {
      throw new Error(`Obiex quote acceptance failed: ${JSON.stringify(acceptResult.error)}`);
    }
    
  } catch (error) {
    const auditEndTime = new Date();
    
    logger.error('Obiex crypto-to-stablecoin swap failed', {
      userId,
      swapId,
      sourceCurrency,
      targetCurrency,
      amount,
      correlationId,
      error: error.message
    });
    
    // Create failure audit entry
    await createAuditEntry({
      userId,
      eventType: 'OBIEX_SWAP_FAILED',
      status: 'FAILED',
      source: 'OBIEX_API',
      action: 'Failed Crypto-to-Stablecoin Swap',
      description: `Obiex crypto-to-stablecoin swap failed: ${error.message}`,
      errorDetails: {
        message: error.message,
        code: 'OBIEX_CRYPTO_STABLECOIN_ERROR',
        stack: error.stack
      },
      swapDetails: {
        swapId,
        sourceCurrency,
        targetCurrency,
        sourceAmount: amount,
        provider: 'OBIEX',
        swapType: 'CRYPTO_TO_STABLECOIN'
      },
      relatedEntities: {
        correlationId
      },
      systemContext,
      timing: {
        startTime,
        endTime: auditEndTime,
        duration: auditEndTime - startTime
      },
      riskLevel: 'MEDIUM',
      flagged: true,
      flagReason: 'Obiex crypto-to-stablecoin swap operation failed',
      tags: ['background', 'obiex', 'swap', 'crypto-to-stablecoin', 'failed']
    });
  }
}

/**
 * Create a transaction record for Obiex operations (optional) with auditing
 */
async function createObiexTransactionRecord(userId, swapId, obiexResult, swapType, correlationId) {
  try {
    const obiexTransaction = new Transaction({
      userId,
      type: 'OBIEX_SWAP',
      currency: 'MIXED', // Since it involves multiple currencies
      amount: 0, // This is a tracking transaction
      status: 'SUCCESSFUL',
      source: 'OBIEX',
      reference: `OBIEX_${swapId}`,
      obiexTransactionId: obiexResult.quoteId || obiexResult.data?.id || `OBIEX_${Date.now()}`,
      narration: `Obiex background swap - ${swapType}`,
      completedAt: new Date(),
      metadata: {
        originalSwapId: swapId,
        obiexSwapType: swapType,
        obiexResult: obiexResult,
        isBackgroundOperation: true,
        correlationId
      }
    });
    
    await obiexTransaction.save();
    
    logger.info('Obiex transaction record created', {
      userId,
      swapId,
      correlationId,
      obiexTransactionId: obiexTransaction._id
    });
    
    // Create audit for transaction record creation
    await createAuditEntry({
      userId,
      transactionId: obiexTransaction._id,
      eventType: 'TRANSACTION_CREATED',
      status: 'SUCCESS',
      source: 'BACKGROUND_JOB',
      action: 'Create Obiex Transaction Record',
      description: `Created Obiex transaction record for swap ${swapId}`,
      relatedEntities: {
        correlationId
      },
      metadata: {
        transactionType: 'OBIEX_SWAP',
        originalSwapId: swapId,
        obiexSwapType: swapType
      },
      tags: ['transaction', 'obiex', 'record-creation']
    });
    
  } catch (error) {
    logger.error('Failed to create Obiex transaction record', {
      userId,
      swapId,
      correlationId,
      error: error.message
    });
    
    // Create audit for transaction record failure
    await createAuditEntry({
      userId,
      eventType: 'TRANSACTION_CREATED',
      status: 'FAILED',
      source: 'BACKGROUND_JOB',
      action: 'Failed Obiex Transaction Record',
      description: `Failed to create Obiex transaction record: ${error.message}`,
      errorDetails: {
        message: error.message,
        code: 'TRANSACTION_RECORD_ERROR',
        stack: error.stack
      },
      relatedEntities: {
        correlationId
      },
      riskLevel: 'LOW',
      tags: ['transaction', 'obiex', 'record-creation', 'failed']
    });
  }
}

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
 * Execute crypto-to-stablecoin swap with atomic balance updates, transaction creation, and comprehensive auditing
 */
async function executeCryptoSwap(userId, quote, correlationId, systemContext) {
  const session = await mongoose.startSession();
  session.startTransaction();
  const startTime = new Date();
  
  try {
    const { sourceCurrency, targetCurrency, amount, amountReceived, type } = quote;
    
    // Balance field names
    const fromKey = sourceCurrency.toLowerCase() + 'Balance';
    const toKey = targetCurrency.toLowerCase() + 'Balance';
    
    // Generate swap reference
    const swapReference = `CRYPTO_SWAP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Get current balances for audit trail
    const userBefore = await User.findById(userId).select(`${fromKey} ${toKey}`).lean();
    
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
        toAmount: amountReceived,
        correlationId
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
        toAmount: amountReceived,
        correlationId
      }
    });

    // 4. Save both transactions (could be optimized with insertMany but maintaining original logic)
    await swapOutTransaction.save({ session });
    await swapInTransaction.save({ session });

    // 5. Commit everything
    await session.commitTransaction();
    session.endSession();
    
    const endTime = new Date();

    logger.info('Crypto swap executed successfully', {
      userId,
      swapReference,
      correlationId,
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
    
    // Create comprehensive audit entries
    await Promise.all([
      // Balance update audit
      createAuditEntry({
        userId,
        eventType: 'BALANCE_UPDATED',
        status: 'SUCCESS',
        source: 'INTERNAL_SWAP',
        action: 'Update User Balances',
        description: `Updated balances for crypto swap: ${sourceCurrency} and ${targetCurrency}`,
        beforeState: {
          [fromKey]: userBefore[fromKey],
          [toKey]: userBefore[toKey]
        },
        afterState: {
          [fromKey]: updatedUser[fromKey],
          [toKey]: updatedUser[toKey]
        },
        financialImpact: {
          currency: sourceCurrency,
          amount: -amount,
          balanceBefore: userBefore[fromKey],
          balanceAfter: updatedUser[fromKey],
          exchangeRate: amountReceived / amount
        },
        swapDetails: {
          swapId: swapReference,
          sourceCurrency,
          targetCurrency,
          sourceAmount: amount,
          targetAmount: amountReceived,
          exchangeRate: amountReceived / amount,
          provider: 'INTERNAL_EXCHANGE',
          swapType: 'CRYPTO_TO_STABLECOIN'
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
        tags: ['balance-update', 'swap', 'internal']
      }),
      
      // Swap completion audit
      createAuditEntry({
        userId,
        eventType: 'SWAP_COMPLETED',
        status: 'SUCCESS',
        source: 'INTERNAL_SWAP',
        action: 'Complete Internal Swap',
        description: `Successfully completed internal crypto-to-stablecoin swap`,
        swapDetails: {
          swapId: swapReference,
          sourceCurrency,
          targetCurrency,
          sourceAmount: amount,
          targetAmount: amountReceived,
          exchangeRate: amountReceived / amount,
          provider: 'INTERNAL_EXCHANGE',
          swapType: 'CRYPTO_TO_STABLECOIN'
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
        tags: ['swap', 'internal', 'completed', 'success']
      }),
      
      // Transaction creation audits
      createAuditEntry({
        userId,
        transactionId: swapOutTransaction._id,
        eventType: 'TRANSACTION_CREATED',
        status: 'SUCCESS',
        source: 'INTERNAL_SWAP',
        action: 'Create Outgoing Swap Transaction',
        description: `Created outgoing transaction for ${sourceCurrency} swap`,
        financialImpact: {
          currency: sourceCurrency,
          amount: -amount,
          balanceBefore: userBefore[fromKey],
          balanceAfter: updatedUser[fromKey]
        },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['transaction', 'swap', 'outgoing']
      }),
      
      createAuditEntry({
        userId,
        transactionId: swapInTransaction._id,
        eventType: 'TRANSACTION_CREATED',
        status: 'SUCCESS',
        source: 'INTERNAL_SWAP',
        action: 'Create Incoming Swap Transaction',
        description: `Created incoming transaction for ${targetCurrency} swap`,
        financialImpact: {
          currency: targetCurrency,
          amount: amountReceived,
          balanceBefore: userBefore[toKey],
          balanceAfter: updatedUser[toKey]
        },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['transaction', 'swap', 'incoming']
      })
    ]);

    return {
      user: updatedUser,
      swapOutTransaction,
      swapInTransaction,
      swapId: swapReference
    };

  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    
    const endTime = new Date();
    
    logger.error('Crypto swap execution failed', {
      error: err.message,
      stack: err.stack,
      userId,
      correlationId,
      quote
    });
    
    // Create failure audit entry
    await createAuditEntry({
      userId,
      eventType: 'SWAP_FAILED',
      status: 'FAILED',
      source: 'INTERNAL_SWAP',
      action: 'Failed Internal Swap',
      description: `Internal crypto swap failed: ${err.message}`,
      errorDetails: {
        message: err.message,
        code: 'INTERNAL_SWAP_ERROR',
        stack: err.stack
      },
      swapDetails: {
        sourceCurrency: quote.sourceCurrency,
        targetCurrency: quote.targetCurrency,
        sourceAmount: quote.amount,
        provider: 'INTERNAL_EXCHANGE',
        swapType: 'CRYPTO_TO_STABLECOIN'
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
      flagReason: 'Internal swap execution failed',
      tags: ['swap', 'internal', 'failed', 'critical-error']
    });
    
    throw err;
  }
}

// UPDATED QUOTE ENDPOINT WITH SWAP PAIR VALIDATION
router.post('/quote', async (req, res) => {
  const correlationId = generateCorrelationId();
  const systemContext = getSystemContext(req);
  const startTime = new Date();
  
  try {
    const { from, to, amount, side } = req.body;
    const userId = req.user?.id;
    
    // Create audit for quote request
    await createAuditEntry({
      userId,
      eventType: 'QUOTE_CREATED',
      status: 'PENDING',
      source: 'API_ENDPOINT',
      action: 'Create Swap Quote',
      description: `Quote request: ${amount} ${from} to ${to}`,
      requestData: { from, to, amount, side },
      relatedEntities: {
        correlationId
      },
      systemContext,
      timing: {
        startTime
      },
      tags: ['quote', 'request']
    });
    
    // Validation - MAINTAINING ORIGINAL ERROR MESSAGES
    if (!from || !to || !amount || !side) {
      await createAuditEntry({
        userId,
        eventType: 'QUOTE_CREATED',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'Failed Quote Validation',
        description: 'Quote request failed validation - missing required fields',
        errorDetails: {
          message: 'Missing required fields: from, to, amount, side',
          code: 'VALIDATION_ERROR'
        },
        requestData: { from, to, amount, side },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['quote', 'validation', 'failed']
      });
      
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: from, to, amount, side' 
      });
    }
    
    if (typeof amount !== 'number' || amount <= 0) {
      await createAuditEntry({
        userId,
        eventType: 'QUOTE_CREATED',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'Failed Quote Validation',
        description: 'Quote request failed validation - invalid amount',
        errorDetails: {
          message: 'Invalid amount. Must be a positive number.',
          code: 'INVALID_AMOUNT'
        },
        requestData: { from, to, amount, side },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['quote', 'validation', 'failed']
      });
      
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid amount. Must be a positive number.' 
      });
    }
    
    if (!['BUY', 'SELL'].includes(side)) {
      await createAuditEntry({
        userId,
        eventType: 'QUOTE_CREATED',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'Failed Quote Validation',
        description: 'Quote request failed validation - invalid side',
        errorDetails: {
          message: 'Invalid side. Must be BUY or SELL.',
          code: 'INVALID_SIDE'
        },
        requestData: { from, to, amount, side },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['quote', 'validation', 'failed']
      });
      
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid side. Must be BUY or SELL.' 
      });
    }

    // NEW: Validate swap pair - only allow crypto to stablecoin and vice versa
    const pairValidation = validateSwapPair(from, to);
    if (!pairValidation.success) {
      await createAuditEntry({
        userId,
        eventType: 'QUOTE_CREATED',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'Failed Swap Pair Validation',
        description: `Invalid swap pair: ${from} to ${to}`,
        errorDetails: {
          message: pairValidation.message,
          code: 'INVALID_SWAP_PAIR'
        },
        requestData: { from, to, amount, side },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['quote', 'validation', 'swap-pair', 'failed']
      });
      
      return res.status(400).json({ 
        success: false, 
        message: pairValidation.message 
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
      type: 'CRYPTO_TO_STABLECOIN',
      expiresAt,
      fromPrice: result.fromPrice,
      toPrice: result.toPrice,
      correlationId // Add correlation ID to payload
    };

    logger.info('Crypto swap quote created', {
      sourceAmount: amount,
      sourceCurrency: from.toUpperCase(),
      targetAmount: result.receiveAmount,
      targetCurrency: to.toUpperCase(),
      exchangeRate: result.exchangeRate,
      fromPrice: result.fromPrice,
      toPrice: result.toPrice,
      correlationId
    });

    // OPTIMIZED CACHING WITH AUTO-CLEANUP
    quoteCache.set(id, payload);
    setTimeout(() => quoteCache.delete(id), 30000);
    
    const endTime = new Date();

    // Create successful quote audit
    await createAuditEntry({
      userId,
      eventType: 'QUOTE_CREATED',
      status: 'SUCCESS',
      source: 'API_ENDPOINT',
      action: 'Create Swap Quote',
      description: `Successfully created quote for ${amount} ${from} to ${to}`,
      requestData: { from, to, amount, side },
      responseData: payload,
      swapDetails: {
        quoteId: id,
        sourceCurrency: from.toUpperCase(),
        targetCurrency: to.toUpperCase(),
        sourceAmount: amount,
        targetAmount: result.receiveAmount,
        exchangeRate: result.exchangeRate,
        provider: 'INTERNAL_EXCHANGE',
        swapType: 'CRYPTO_TO_STABLECOIN'
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
      tags: ['quote', 'created', 'success']
    });

    // MAINTAINING ORIGINAL RESPONSE STRUCTURE
    return res.json({
      success: true,
      message: 'Crypto swap quote created successfully',
      data: { data: payload, ...payload }
    });

  } catch (err) {
    const endTime = new Date();
    
    logger.error('POST /swap/quote error', { error: err.stack, correlationId });
    
    // Create error audit entry
    await createAuditEntry({
      userId: req.user?.id,
      eventType: 'QUOTE_CREATED',
      status: 'FAILED',
      source: 'API_ENDPOINT',
      action: 'Failed Quote Creation',
      description: `Quote creation failed with error: ${err.message}`,
      errorDetails: {
        message: err.message,
        code: 'QUOTE_CREATION_ERROR',
        stack: err.stack
      },
      requestData: req.body,
      relatedEntities: {
        correlationId
      },
      systemContext,
      timing: {
        startTime,
        endTime,
        duration: endTime - startTime
      },
      riskLevel: 'MEDIUM',
      flagged: true,
      flagReason: 'Quote creation system error',
      tags: ['quote', 'creation', 'system-error']
    });
    
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
});

// ENHANCED SWAP EXECUTION ENDPOINT WITH OBIEX INTEGRATION AND COMPREHENSIVE AUDITING
router.post('/quote/:quoteId', async (req, res) => {
  const systemContext = getSystemContext(req);
  const startTime = new Date();
  
  try {
    const { quoteId } = req.params;
    const userId = req.user.id;
    const quote = quoteCache.get(quoteId);
    
    // Use existing correlation ID from quote or generate new one
    const correlationId = quote?.correlationId || generateCorrelationId();

    // Create audit for quote acceptance attempt
    await createAuditEntry({
      userId,
      eventType: 'QUOTE_ACCEPTED',
      status: 'PENDING',
      source: 'API_ENDPOINT',
      action: 'Accept Swap Quote',
      description: `Attempting to accept quote ${quoteId}`,
      swapDetails: {
        quoteId
      },
      relatedEntities: {
        correlationId
      },
      systemContext,
      timing: {
        startTime
      },
      tags: ['quote', 'acceptance', 'pending']
    });

    // MAINTAINING ORIGINAL ERROR HANDLING
    if (!quote) {
      await createAuditEntry({
        userId,
        eventType: 'QUOTE_ACCEPTED',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'Quote Not Found',
        description: `Quote ${quoteId} not found or expired`,
        errorDetails: {
          message: 'Quote not found or expired',
          code: 'QUOTE_NOT_FOUND'
        },
        swapDetails: {
          quoteId
        },
        relatedEntities: {
          correlationId
        },
        systemContext,
        riskLevel: 'LOW',
        tags: ['quote', 'not-found']
      });
      
      return res.status(404).json({ 
        success: false, 
        message: 'Quote not found or expired' 
      });
    }

    if (new Date() > new Date(quote.expiresAt)) {
      quoteCache.delete(quoteId);
      
      await createAuditEntry({
        userId,
        eventType: 'QUOTE_EXPIRED',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'Quote Expired',
        description: `Quote ${quoteId} has expired`,
        errorDetails: {
          message: 'Quote has expired',
          code: 'QUOTE_EXPIRED'
        },
        swapDetails: {
          quoteId,
          expiresAt: quote.expiresAt
        },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['quote', 'expired']
      });
      
      return res.status(410).json({ 
        success: false, 
        message: 'Quote has expired' 
      });
    }

    // Validate user balance - OPTIMIZED WITH CACHING
    const validation = await validateUserBalance(userId, quote.sourceCurrency, quote.amount);
    if (!validation.success) {
      await createAuditEntry({
        userId,
        eventType: 'BALANCE_SYNC',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'Insufficient Balance',
        description: `Insufficient balance for swap: ${validation.message}`,
        errorDetails: {
          message: validation.message,
          code: 'INSUFFICIENT_BALANCE'
        },
        financialImpact: {
          currency: quote.sourceCurrency,
          amount: quote.amount,
          balanceBefore: validation.availableBalance
        },
        swapDetails: {
          quoteId,
          sourceCurrency: quote.sourceCurrency,
          requiredAmount: quote.amount,
          availableAmount: validation.availableBalance
        },
        relatedEntities: {
          correlationId
        },
        systemContext,
        riskLevel: 'LOW',
        tags: ['balance', 'insufficient', 'validation']
      });
      
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
    const swapResult = await executeCryptoSwap(userId, quote, correlationId, systemContext);

    // *** NEW: Execute Obiex swap in background ***
    // This runs asynchronously and won't block the response
    setImmediate(() => {
      executeObiexSwapBackground(userId, quote, swapResult.swapId, correlationId, systemContext);
    });

    logger.info('Crypto swap completed, Obiex swap initiated in background', { 
      userId, 
      quoteId, 
      correlationId,
      swapId: swapResult.swapId,
      swapOutTransactionId: swapResult.swapOutTransaction._id,
      swapInTransactionId: swapResult.swapInTransaction._id
    });

    // Clean up quote from cache
    quoteCache.delete(quoteId);
    
    const endTime = new Date();

    // Create successful quote acceptance audit
    await createAuditEntry({
      userId,
      eventType: 'QUOTE_ACCEPTED',
      status: 'SUCCESS',
      source: 'API_ENDPOINT',
      action: 'Accept Swap Quote',
      description: `Successfully accepted and executed quote ${quoteId}`,
      swapDetails: {
        quoteId,
        swapId: swapResult.swapId,
        sourceCurrency: quote.sourceCurrency,
        targetCurrency: quote.targetCurrency,
        sourceAmount: quote.amount,
        targetAmount: quote.amountReceived,
        exchangeRate: quote.rate,
        provider: 'INTERNAL_EXCHANGE',
        swapType: 'CRYPTO_TO_STABLECOIN'
      },
      relatedEntities: {
        correlationId,
        relatedTransactionIds: [swapResult.swapOutTransaction._id, swapResult.swapInTransaction._id]
      },
      systemContext,
      timing: {
        startTime,
        endTime,
        duration: endTime - startTime
      },
      tags: ['quote', 'accepted', 'success', 'obiex-initiated']
    });

    // MAINTAINING ORIGINAL RESPONSE PAYLOAD STRUCTURE
    const responsePayload = {
      swapId: swapResult.swapId,
      quoteId,
      correlationId, // Include correlation ID in response
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
      },
      // NEW: Indicate that Obiex swap is running in background
      obiexSwapInitiated: true,
      audit: {
        correlationId,
        trackingEnabled: true
      }
    };

    // MAINTAINING ORIGINAL RESPONSE STRUCTURE
    return res.json({
      success: true,
      message: 'Crypto swap completed successfully, Obiex swap initiated in background',
      data: { data: responsePayload, ...responsePayload }
    });

  } catch (err) {
    const endTime = new Date();
    const correlationId = generateCorrelationId();
    
    logger.error('POST /swap/quote/:quoteId error', { 
      error: err.stack,
      userId: req.user?.id,
      quoteId: req.params?.quoteId,
      correlationId
    });
    
    // Create comprehensive error audit
    await createAuditEntry({
      userId: req.user?.id,
      eventType: 'SWAP_FAILED',
      status: 'FAILED',
      source: 'API_ENDPOINT',
      action: 'Failed Swap Execution',
      description: `Swap execution failed: ${err.message}`,
      errorDetails: {
        message: err.message,
        code: 'SWAP_EXECUTION_ERROR',
        stack: err.stack
      },
      swapDetails: {
        quoteId: req.params?.quoteId
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
      flagReason: 'Critical swap execution failure',
      tags: ['swap', 'execution', 'critical-error', 'api-endpoint']
    });
    
    return res.status(500).json({ 
      success: false, 
      message: err.message || 'Swap failed - please try again'
    });
  }
});

// MAINTAINING ORIGINAL TOKENS ENDPOINT STRUCTURE WITH BASIC AUDITING
router.get('/tokens', (req, res) => {
  const systemContext = getSystemContext(req);
  
  try {
    const tokens = Object.entries(TOKEN_MAP).map(([code, info]) => ({
      code, 
      name: info.name, 
      currency: info.currency
    }));
    
    // Simple audit for tokens request
    setImmediate(async () => {
      await createAuditEntry({
        userId: req.user?.id,
        eventType: 'USER_ACTION',
        status: 'SUCCESS',
        source: 'API_ENDPOINT',
        action: 'Fetch Supported Tokens',
        description: 'Retrieved supported tokens list',
        responseData: { tokenCount: tokens.length },
        systemContext,
        tags: ['tokens', 'fetch', 'info']
      });
    });
    
    res.json({
      success: true,
      message: 'Supported tokens retrieved successfully',
      data: tokens,
      total: tokens.length
    });
  } catch (err) {
    logger.error('GET /swap/tokens error', { error: err.stack });
    
    // Error audit for tokens request
    setImmediate(async () => {
      await createAuditEntry({
        userId: req.user?.id,
        eventType: 'SYSTEM_ERROR',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'Failed Tokens Fetch',
        description: `Failed to fetch tokens: ${err.message}`,
        errorDetails: {
          message: err.message,
          code: 'TOKENS_FETCH_ERROR',
          stack: err.stack
        },
        systemContext,
        tags: ['tokens', 'fetch', 'error']
      });
    });
    
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