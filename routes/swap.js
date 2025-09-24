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

// Pre-compiled token validation
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

// Default stablecoin for routing crypto-to-crypto swaps
const DEFAULT_STABLECOIN = 'USDT';

/**
 * Validate swap pair - supports crypto-to-crypto via stablecoin routing
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
  
  // Allow crypto to stablecoin or stablecoin to crypto (direct swaps)
  if ((fromIsCrypto && toIsStablecoin) || (fromIsStablecoin && toIsCrypto)) {
    return { success: true, swapType: 'DIRECT' };
  }
  
  // Allow crypto to crypto swaps (will be routed through stablecoin)
  if (fromIsCrypto && toIsCrypto) {
    return { 
      success: true, 
      swapType: 'CRYPTO_TO_CRYPTO',
      routingRequired: true,
      intermediateToken: DEFAULT_STABLECOIN
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
    message: 'Invalid swap pair'
  };
}

/**
 * Create two-step quote for crypto-to-crypto swaps
 */
async function createCryptoToCryptoQuote(fromCurrency, toCurrency, amount) {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  const intermediate = DEFAULT_STABLECOIN;
  
  // Step 1: Crypto -> Stablecoin
  const step1Result = await calculateCryptoExchange(from, intermediate, amount);
  if (!step1Result.success) {
    throw new Error(`Failed to calculate ${from} to ${intermediate} exchange`);
  }
  
  // Step 2: Stablecoin -> Crypto
  const step2Result = await calculateCryptoExchange(intermediate, to, step1Result.receiveAmount);
  if (!step2Result.success) {
    throw new Error(`Failed to calculate ${intermediate} to ${to} exchange`);
  }
  
  // Calculate overall exchange rate
  const overallRate = step2Result.receiveAmount / amount;
  
  return {
    success: true,
    step1: {
      fromCurrency: from,
      toCurrency: intermediate,
      amount: amount,
      receiveAmount: step1Result.receiveAmount,
      rate: step1Result.exchangeRate,
      fromPrice: step1Result.fromPrice,
      toPrice: step1Result.toPrice
    },
    step2: {
      fromCurrency: intermediate,
      toCurrency: to,
      amount: step1Result.receiveAmount,
      receiveAmount: step2Result.receiveAmount,
      rate: step2Result.exchangeRate,
      fromPrice: step2Result.fromPrice,
      toPrice: step2Result.toPrice
    },
    overall: {
      fromCurrency: from,
      toCurrency: to,
      amount: amount,
      receiveAmount: step2Result.receiveAmount,
      rate: overallRate
    }
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
    const { sourceCurrency, targetCurrency, amount, swapType } = quote;
    
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
        swapType: targetCurrency.toUpperCase() === 'NGNX' ? 'CRYPTO_TO_NGNX' : swapType
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
    
    // Handle different swap types
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
        
        await createObiexTransactionRecord(userId, swapId, obiexResult, 'CRYPTO_TO_NGNX', correlationId);
      } else {
        logger.error('Obiex crypto-to-NGNX swap failed', {
          userId,
          swapId,
          correlationId,
          error: obiexResult.error,
          statusCode: obiexResult.statusCode
        });
        
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
    } else if (quote.swapType === 'CRYPTO_TO_CRYPTO') {
      logger.info('Executing Obiex crypto-to-crypto swap in background', {
        userId,
        swapId,
        sourceCurrency,
        targetCurrency,
        amount,
        correlationId,
        intermediateToken: quote.intermediateToken
      });
      
      await executeObiexCryptoCryptoSwap(userId, swapId, sourceCurrency, targetCurrency, amount, quote.intermediateToken, correlationId, systemContext, auditStartTime);
    } else {
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
 * Execute crypto-to-crypto swap via Obiex (two-step process) with auditing
 */
async function executeObiexCryptoCryptoSwap(userId, swapId, sourceCurrency, targetCurrency, amount, intermediateToken, correlationId, systemContext, startTime) {
  try {
    logger.info('Starting Obiex crypto-to-crypto swap', {
      userId,
      swapId,
      sourceCurrency,
      targetCurrency,
      intermediateToken,
      amount,
      correlationId
    });

    // Get currency IDs
    const sourceId = await getCurrencyIdByCode(sourceCurrency);
    const intermediateId = await getCurrencyIdByCode(intermediateToken);
    const targetId = await getCurrencyIdByCode(targetCurrency);
    
    // Step 1: Crypto -> Stablecoin (e.g., BTC -> USDT)
    const step1QuoteResult = await createQuote({
      sourceId,
      targetId: intermediateId,
      amount,
      side: 'SELL'
    });
    
    if (!step1QuoteResult.success) {
      throw new Error(`Obiex step 1 quote creation failed: ${JSON.stringify(step1QuoteResult.error)}`);
    }
    
    const step1AcceptResult = await acceptQuote(step1QuoteResult.quoteId);
    if (!step1AcceptResult.success) {
      throw new Error(`Obiex step 1 quote acceptance failed: ${JSON.stringify(step1AcceptResult.error)}`);
    }
    
    const intermediateAmount = step1AcceptResult.data?.amountReceived || step1AcceptResult.data?.amount;
    
    logger.info('Obiex crypto-to-crypto step 1 completed', {
      userId,
      swapId,
      step: 1,
      from: sourceCurrency,
      to: intermediateToken,
      amountIn: amount,
      amountOut: intermediateAmount,
      correlationId
    });
    
    // Step 2: Stablecoin -> Crypto (e.g., USDT -> ETH)
    const step2QuoteResult = await createQuote({
      sourceId: targetId,
      targetId: intermediateId,
      amount: intermediateAmount,
      side: 'BUY'
    });
    
    if (!step2QuoteResult.success) {
      throw new Error(`Obiex step 2 quote creation failed: ${JSON.stringify(step2QuoteResult.error)}`);
    }
    
    const step2AcceptResult = await acceptQuote(step2QuoteResult.quoteId);
    const auditEndTime = new Date();
    
    if (step2AcceptResult.success) {
      const finalAmount = step2AcceptResult.data?.amountReceived || step2AcceptResult.data?.amount;
      
      logger.info('Obiex crypto-to-crypto swap completed successfully', {
        userId,
        swapId,
        sourceCurrency,
        targetCurrency,
        intermediateToken,
        sourceAmount: amount,
        finalAmount,
        correlationId,
        step1QuoteId: step1QuoteResult.quoteId,
        step2QuoteId: step2QuoteResult.quoteId
      });
      
      await createAuditEntry({
        userId,
        eventType: 'OBIEX_SWAP_COMPLETED',
        status: 'SUCCESS',
        source: 'OBIEX_API',
        action: 'Complete Crypto-to-Crypto Swap',
        description: `Successfully completed Obiex crypto-to-crypto swap via ${intermediateToken}`,
        swapDetails: {
          swapId,
          sourceCurrency,
          targetCurrency,
          intermediateToken,
          sourceAmount: amount,
          finalAmount,
          provider: 'OBIEX',
          swapType: 'CRYPTO_TO_CRYPTO'
        },
        obiexDetails: {
          step1QuoteId: step1QuoteResult.quoteId,
          step2QuoteId: step2QuoteResult.quoteId,
          step1Response: step1AcceptResult.data,
          step2Response: step2AcceptResult.data,
          obiexOperationType: 'CRYPTO_TO_CRYPTO_ROUTING'
        },
        relatedEntities: {
          correlationId
        },
        responseData: {
          step1: step1AcceptResult.data,
          step2: step2AcceptResult.data
        },
        systemContext,
        timing: {
          startTime,
          endTime: auditEndTime,
          duration: auditEndTime - startTime
        },
        tags: ['background', 'obiex', 'swap', 'crypto-to-crypto', 'success']
      });
      
      await createObiexTransactionRecord(userId, swapId, {
        step1QuoteId: step1QuoteResult.quoteId,
        step2QuoteId: step2QuoteResult.quoteId,
        step1Data: step1AcceptResult.data,
        step2Data: step2AcceptResult.data,
        intermediateToken,
        sourceAmount: amount,
        finalAmount
      }, 'CRYPTO_TO_CRYPTO', correlationId);
      
    } else {
      throw new Error(`Obiex step 2 quote acceptance failed: ${JSON.stringify(step2AcceptResult.error)}`);
    }
    
  } catch (error) {
    const auditEndTime = new Date();
    
    logger.error('Obiex crypto-to-crypto swap failed', {
      userId,
      swapId,
      sourceCurrency,
      targetCurrency,
      amount,
      correlationId,
      error: error.message
    });
    
    await createAuditEntry({
      userId,
      eventType: 'OBIEX_SWAP_FAILED',
      status: 'FAILED',
      source: 'OBIEX_API',
      action: 'Failed Crypto-to-Crypto Swap',
      description: `Obiex crypto-to-crypto swap failed: ${error.message}`,
      errorDetails: {
        message: error.message,
        code: 'OBIEX_CRYPTO_CRYPTO_ERROR',
        stack: error.stack
      },
      swapDetails: {
        swapId,
        sourceCurrency,
        targetCurrency,
        intermediateToken,
        sourceAmount: amount,
        provider: 'OBIEX',
        swapType: 'CRYPTO_TO_CRYPTO'
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
      flagReason: 'Obiex crypto-to-crypto swap operation failed',
      tags: ['background', 'obiex', 'swap', 'crypto-to-crypto', 'failed']
    });
  }
}

/**
 * Execute crypto-to-stablecoin swap via Obiex (background process) with auditing
 */
async function executeObiexCryptoStablecoinSwap(userId, swapId, sourceCurrency, targetCurrency, amount, correlationId, systemContext, startTime) {
  try {
    // Determine crypto and stablecoin for proper Obiex quote construction
    const isCryptoToStablecoin = CRYPTOCURRENCIES.has(sourceCurrency.toUpperCase());
    
    let cryptoCode, stablecoinCode, quoteSide, quoteAmount;
    
    if (isCryptoToStablecoin) {
      // Crypto → Stablecoin (e.g., BTC → USDT)
      cryptoCode = sourceCurrency;
      stablecoinCode = targetCurrency;
      quoteSide = 'SELL';
      quoteAmount = amount;
    } else {
      // Stablecoin → Crypto (e.g., USDT → BTC)
      cryptoCode = targetCurrency;
      stablecoinCode = sourceCurrency;
      quoteSide = 'BUY';
      quoteAmount = amount;
    }

    // Get currency IDs for Obiex - crypto as source, stablecoin as target
    const cryptoId = await getCurrencyIdByCode(cryptoCode);
    const stablecoinId = await getCurrencyIdByCode(stablecoinCode);
    
    // Create and accept quote for the swap
    const quoteResult = await createQuote({
      sourceId: cryptoId,
      targetId: stablecoinId,
      amount: quoteAmount,
      side: quoteSide
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
          swapType: 'DIRECT'
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
        requestData: { sourceId: cryptoId, targetId: stablecoinId, amount: quoteAmount, side: quoteSide },
        responseData: acceptResult.data,
        systemContext,
        timing: {
          startTime,
          endTime: auditEndTime,
          duration: auditEndTime - startTime
        },
        tags: ['background', 'obiex', 'swap', 'crypto-to-stablecoin', 'success']
      });
      
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
        swapType: 'DIRECT'
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
 * Create a transaction record for Obiex operations
 */
async function createObiexTransactionRecord(userId, swapId, obiexResult, swapType, correlationId) {
  try {
    const obiexTransaction = new Transaction({
      userId,
      type: 'OBIEX_SWAP',
      currency: 'MIXED',
      amount: 0,
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
  
  setTimeout(() => priceCache.delete(cacheKey), PRICE_CACHE_TTL);
  
  return prices;
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
 * Calculate crypto exchange rates
 */
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
 * Execute crypto-to-crypto swap with atomic balance updates
 */
async function executeCryptoCryptoSwap(userId, quote, correlationId, systemContext) {
  const session = await mongoose.startSession();
  session.startTransaction();
  const startTime = new Date();
  
  try {
    const { sourceCurrency, targetCurrency, amount, amountReceived, intermediateToken, step1, step2 } = quote;
    
    const fromKey = sourceCurrency.toLowerCase() + 'Balance';
    const toKey = targetCurrency.toLowerCase() + 'Balance';
    const swapReference = `CRYPTO_CRYPTO_SWAP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const userBefore = await User.findById(userId).select(`${fromKey} ${toKey}`).lean();
    
    const updatedUser = await User.findOneAndUpdate(
      { 
        _id: userId, 
        [fromKey]: { $gte: amount }
      },
      {
        $inc: {
          [fromKey]: -amount,
          [toKey]: amountReceived
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

    userCache.delete(`user_balance_${userId}`);

    const swapOutTransaction = new Transaction({
      userId,
      type: 'SWAP',
      currency: sourceCurrency,
      amount: -amount,
      status: 'SUCCESSFUL',
      source: 'INTERNAL',
      reference: swapReference,
      obiexTransactionId: `${swapReference}_OUT`,
      narration: `Crypto-to-Crypto Swap: ${amount} ${sourceCurrency} to ${amountReceived} ${targetCurrency} (via ${intermediateToken})`,
      completedAt: new Date(),
      metadata: {
        swapDirection: 'OUT',
        swapType: 'CRYPTO_TO_CRYPTO',
        exchangeRate: amountReceived / amount,
        relatedTransactionRef: swapReference,
        fromCurrency: sourceCurrency,
        toCurrency: targetCurrency,
        fromAmount: amount,
        toAmount: amountReceived,
        intermediateToken,
        step1Details: step1,
        step2Details: step2,
        correlationId
      }
    });

    const swapInTransaction = new Transaction({
      userId,
      type: 'SWAP',
      currency: targetCurrency,
      amount: amountReceived,
      status: 'SUCCESSFUL',
      source: 'INTERNAL',
      reference: swapReference,
      obiexTransactionId: `${swapReference}_IN`,
      narration: `Crypto-to-Crypto Swap: ${amount} ${sourceCurrency} to ${amountReceived} ${targetCurrency} (via ${intermediateToken})`,
      completedAt: new Date(),
      metadata: {
        swapDirection: 'IN',
        swapType: 'CRYPTO_TO_CRYPTO',
        exchangeRate: amountReceived / amount,
        relatedTransactionRef: swapReference,
        fromCurrency: sourceCurrency,
        toCurrency: targetCurrency,
        fromAmount: amount,
        toAmount: amountReceived,
        intermediateToken,
        step1Details: step1,
        step2Details: step2,
        correlationId
      }
    });

    await swapOutTransaction.save({ session });
    await swapInTransaction.save({ session });

    await session.commitTransaction();
    session.endSession();
    
    const endTime = new Date();

    logger.info('Crypto-to-crypto swap executed successfully', {
      userId,
      swapReference,
      correlationId,
      sourceCurrency,
      targetCurrency,
      intermediateToken,
      sourceAmount: amount,
      targetAmount: amountReceived,
      overallExchangeRate: amountReceived / amount,
      outTransactionId: swapOutTransaction._id,
      inTransactionId: swapInTransaction._id
    });
    
    await Promise.all([
      createAuditEntry({
        userId,
        eventType: 'BALANCE_UPDATED',
        status: 'SUCCESS',
        source: 'INTERNAL_SWAP',
        action: 'Update User Balances',
        description: `Updated balances for crypto-to-crypto swap: ${sourceCurrency} and ${targetCurrency}`,
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
          intermediateToken,
          sourceAmount: amount,
          targetAmount: amountReceived,
          exchangeRate: amountReceived / amount,
          provider: 'INTERNAL_EXCHANGE',
          swapType: 'CRYPTO_TO_CRYPTO'
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
        tags: ['balance-update', 'swap', 'internal', 'crypto-to-crypto']
      }),
      
      createAuditEntry({
        userId,
        eventType: 'SWAP_COMPLETED',
        status: 'SUCCESS',
        source: 'INTERNAL_SWAP',
        action: 'Complete Internal Crypto-to-Crypto Swap',
        description: `Successfully completed internal crypto-to-crypto swap via ${intermediateToken}`,
        swapDetails: {
          swapId: swapReference,
          sourceCurrency,
          targetCurrency,
          intermediateToken,
          sourceAmount: amount,
          targetAmount: amountReceived,
          exchangeRate: amountReceived / amount,
          provider: 'INTERNAL_EXCHANGE',
          swapType: 'CRYPTO_TO_CRYPTO'
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
        tags: ['swap', 'internal', 'completed', 'success', 'crypto-to-crypto']
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
    
    logger.error('Crypto-to-crypto swap execution failed', {
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
      source: 'INTERNAL_SWAP',
      action: 'Failed Internal Crypto-to-Crypto Swap',
      description: `Internal crypto-to-crypto swap failed: ${err.message}`,
      errorDetails: {
        message: err.message,
        code: 'INTERNAL_CRYPTO_CRYPTO_SWAP_ERROR',
        stack: err.stack
      },
      swapDetails: {
        sourceCurrency: quote.sourceCurrency,
        targetCurrency: quote.targetCurrency,
        sourceAmount: quote.amount,
        provider: 'INTERNAL_EXCHANGE',
        swapType: 'CRYPTO_TO_CRYPTO'
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
      flagReason: 'Internal crypto-to-crypto swap execution failed',
      tags: ['swap', 'internal', 'failed', 'critical-error', 'crypto-to-crypto']
    });
    
    throw err;
  }
}

/**
 * Execute crypto-to-stablecoin swap with atomic balance updates
 */
async function executeCryptoSwap(userId, quote, correlationId, systemContext) {
  const session = await mongoose.startSession();
  session.startTransaction();
  const startTime = new Date();
  
  try {
    const { sourceCurrency, targetCurrency, amount, amountReceived, type } = quote;
    
    const fromKey = sourceCurrency.toLowerCase() + 'Balance';
    const toKey = targetCurrency.toLowerCase() + 'Balance';
    const swapReference = `CRYPTO_SWAP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const userBefore = await User.findById(userId).select(`${fromKey} ${toKey}`).lean();
    
    const updatedUser = await User.findOneAndUpdate(
      { 
        _id: userId, 
        [fromKey]: { $gte: amount }
      },
      {
        $inc: {
          [fromKey]: -amount,
          [toKey]: amountReceived
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

    userCache.delete(`user_balance_${userId}`);

    const swapOutTransaction = new Transaction({
      userId,
      type: 'SWAP',
      currency: sourceCurrency,
      amount: -amount,
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

    const swapInTransaction = new Transaction({
      userId,
      type: 'SWAP',
      currency: targetCurrency,
      amount: amountReceived,
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

    await swapOutTransaction.save({ session });
    await swapInTransaction.save({ session });

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
      outTransactionId: swapOutTransaction._id,
      inTransactionId: swapInTransaction._id
    });
    
    await Promise.all([
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
          swapType: 'DIRECT'
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
      
      createAuditEntry({
        userId,
        eventType: 'SWAP_COMPLETED',
        status: 'SUCCESS',
        source: 'INTERNAL_SWAP',
        action: 'Complete Internal Swap',
        description: `Successfully completed internal crypto swap`,
        swapDetails: {
          swapId: swapReference,
          sourceCurrency,
          targetCurrency,
          sourceAmount: amount,
          targetAmount: amountReceived,
          exchangeRate: amountReceived / amount,
          provider: 'INTERNAL_EXCHANGE',
          swapType: 'DIRECT'
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
        swapType: 'DIRECT'
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

// POST /swap/quote - Create swap quote
router.post('/quote', async (req, res) => {
  const correlationId = generateCorrelationId();
  const systemContext = getSystemContext(req);
  const startTime = new Date();
  
  try {
    const { from, to, amount, side } = req.body;
    const userId = req.user?.id;
    
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
    
    if (!['BUY', 'SELL'].includes(side)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid side. Must be BUY or SELL.' 
      });
    }

    const pairValidation = validateSwapPair(from, to);
    if (!pairValidation.success) {
      return res.status(400).json({ 
        success: false, 
        message: pairValidation.message 
      });
    }

    let payload;
    const id = `crypto_swap_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const expiresAt = new Date(Date.now() + 30000).toISOString();

    if (pairValidation.swapType === 'CRYPTO_TO_CRYPTO') {
      const cryptoQuote = await createCryptoToCryptoQuote(from, to, amount);
      
      payload = {
        id,
        amount,
        amountReceived: cryptoQuote.overall.receiveAmount,
        rate: cryptoQuote.overall.rate,
        side,
        sourceCurrency: from.toUpperCase(),
        targetCurrency: to.toUpperCase(),
        provider: 'INTERNAL_EXCHANGE',
        type: 'CRYPTO_TO_CRYPTO',
        swapType: 'CRYPTO_TO_CRYPTO',
        intermediateToken: pairValidation.intermediateToken,
        expiresAt,
        correlationId,
        step1: cryptoQuote.step1,
        step2: cryptoQuote.step2,
        overall: cryptoQuote.overall
      };

      logger.info('Crypto-to-crypto swap quote created', {
        sourceAmount: amount,
        sourceCurrency: from.toUpperCase(),
        targetAmount: cryptoQuote.overall.receiveAmount,
        targetCurrency: to.toUpperCase(),
        intermediateToken: pairValidation.intermediateToken,
        step1Rate: cryptoQuote.step1.rate,
        step2Rate: cryptoQuote.step2.rate,
        overallRate: cryptoQuote.overall.rate,
        correlationId
      });
      
    } else {
      const result = await calculateCryptoExchange(from, to, amount);
      
      payload = {
        id,
        amount,
        amountReceived: result.receiveAmount,
        rate: result.exchangeRate,
        side,
        sourceCurrency: from.toUpperCase(),
        targetCurrency: to.toUpperCase(),
        provider: 'INTERNAL_EXCHANGE',
        type: 'CRYPTO_TO_STABLECOIN',
        swapType: 'DIRECT',
        expiresAt,
        fromPrice: result.fromPrice,
        toPrice: result.toPrice,
        correlationId
      };

      logger.info('Direct crypto swap quote created', {
        sourceAmount: amount,
        sourceCurrency: from.toUpperCase(),
        targetAmount: result.receiveAmount,
        targetCurrency: to.toUpperCase(),
        exchangeRate: result.exchangeRate,
        fromPrice: result.fromPrice,
        toPrice: result.toPrice,
        correlationId
      });
    }

    quoteCache.set(id, payload);
    setTimeout(() => quoteCache.delete(id), 30000);
    
    const endTime = new Date();

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
        targetAmount: payload.amountReceived,
        exchangeRate: payload.rate,
        provider: 'INTERNAL_EXCHANGE',
        swapType: payload.swapType,
        intermediateToken: payload.intermediateToken
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
      tags: ['quote', 'created', 'success', payload.swapType?.toLowerCase()]
    });

    return res.json({
      success: true,
      message: `${pairValidation.swapType === 'CRYPTO_TO_CRYPTO' ? 'Crypto-to-crypto' : 'Crypto'} swap quote created successfully`,
      data: { data: payload, ...payload }
    });

  } catch (err) {
    const endTime = new Date();
    
    logger.error('POST /swap/quote error', { error: err.stack, correlationId });
    
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

// POST /swap/quote/:quoteId - Execute swap
router.post('/quote/:quoteId', async (req, res) => {
  const systemContext = getSystemContext(req);
  const startTime = new Date();
  
  try {
    const { quoteId } = req.params;
    const userId = req.user.id;
    const quote = quoteCache.get(quoteId);
    
    const correlationId = quote?.correlationId || generateCorrelationId();

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
        availableBalance: validation.availableBalance,
        requiredAmount: quote.amount,
        currency: quote.sourceCurrency
      });
    }

    let swapResult;

    if (quote.swapType === 'CRYPTO_TO_CRYPTO') {
      swapResult = await executeCryptoCryptoSwap(userId, quote, correlationId, systemContext);
    } else {
      swapResult = await executeCryptoSwap(userId, quote, correlationId, systemContext);
    }

    // Execute Obiex swap in background
    setImmediate(() => {
      executeObiexSwapBackground(userId, quote, swapResult.swapId, correlationId, systemContext);
    });

    logger.info(`${quote.swapType === 'CRYPTO_TO_CRYPTO' ? 'Crypto-to-crypto' : 'Crypto'} swap completed, Obiex swap initiated in background`, { 
      userId, 
      quoteId, 
      correlationId,
      swapType: quote.swapType,
      swapId: swapResult.swapId,
      swapOutTransactionId: swapResult.swapOutTransaction._id,
      swapInTransactionId: swapResult.swapInTransaction._id
    });

    quoteCache.delete(quoteId);
    
    const endTime = new Date();

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
        swapType: quote.swapType,
        intermediateToken: quote.intermediateToken
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
      tags: ['quote', 'accepted', 'success', 'obiex-initiated', quote.swapType?.toLowerCase()]
    });

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
        provider: quote.provider,
        swapType: quote.swapType,
        intermediateToken: quote.intermediateToken,
        ...(quote.swapType === 'CRYPTO_TO_CRYPTO' && {
          step1Details: quote.step1,
          step2Details: quote.step2,
          overallDetails: quote.overall
        })
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
      obiexSwapInitiated: true,
      audit: {
        correlationId,
        trackingEnabled: true
      }
    };

    return res.json({
      success: true,
      message: `${quote.swapType === 'CRYPTO_TO_CRYPTO' ? 'Crypto-to-crypto' : 'Crypto'} swap completed successfully, Obiex swap initiated in background`,
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

// GET /swap/tokens - Get supported tokens
router.get('/tokens', (req, res) => {
  const systemContext = getSystemContext(req);
  
  try {
    const tokens = Object.entries(TOKEN_MAP).map(([code, info]) => ({
      code, 
      name: info.name, 
      currency: info.currency
    }));
    
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