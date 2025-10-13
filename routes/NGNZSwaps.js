const express = require('express');
const mongoose = require('mongoose');
const onrampService = require('../services/onramppriceservice');
const offrampService = require('../services/offramppriceservice');
const { getPricesWithCache } = require('../services/portfolio');
const { swapCryptoToNGNX, getCurrencyIdByCode, createQuote, acceptQuote } = require('../services/ObiexSwap');
const Transaction = require('../models/transaction');
const User = require('../models/user');
const TransactionAudit = require('../models/TransactionAudit');
const logger = require('../utils/logger');
const { sendSwapCompletionNotification } = require('../services/notificationService');

const router = express.Router();

// Optimized caching
const ngnzQuoteCache = new Map();
const userCache = new Map();
const priceCache = new Map();
const CACHE_TTL = 30000; // 30 seconds
const PRICE_CACHE_TTL = 5000; // 5 seconds for prices

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
  return `NGNZ_CORR_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
 * Execute Obiex NGNZ swap in background (non-blocking) with comprehensive auditing
 * Updated to always use crypto as sourceId and NGNX as targetId
 */
async function executeObiexNGNZSwapBackground(userId, quote, swapId, correlationId, systemContext) {
  const auditStartTime = new Date();
  
  try {
    const { sourceCurrency, targetCurrency, amount, flow } = quote;
    
    // Always use crypto as source and NGNX as target for Obiex
    const cryptoCurrency = flow === 'ONRAMP' ? targetCurrency : sourceCurrency;
    const isOfframp = flow === 'OFFRAMP';
    
    // Create initial audit entry
    await createAuditEntry({
      userId,
      eventType: 'OBIEX_SWAP_INITIATED',
      status: 'PENDING',
      source: 'BACKGROUND_JOB',
      action: 'Initiate Background Obiex NGNZ Swap',
      description: `Starting Obiex NGNZ ${flow}: ${amount} ${sourceCurrency} to ${targetCurrency} (Obiex: ${cryptoCurrency}-NGNX ${isOfframp ? 'SELL' : 'BUY'})`,
      swapDetails: {
        swapId,
        sourceCurrency,
        targetCurrency,
        sourceAmount: amount,
        provider: 'OBIEX',
        swapType: flow === 'ONRAMP' ? 'NGNX_TO_CRYPTO' : 'CRYPTO_TO_NGNX',
        flow
      },
      obiexDetails: {
        obiexCryptoCurrency: cryptoCurrency,
        obiexTargetCurrency: 'NGNX',
        obiexSide: isOfframp ? 'SELL' : 'BUY',
        obiexOperationType: flow === 'ONRAMP' ? 'NGNX_TO_CRYPTO' : 'CRYPTO_TO_NGNX'
      },
      relatedEntities: {
        correlationId
      },
      systemContext,
      timing: {
        startTime: auditStartTime
      },
      tags: ['background', 'obiex', 'ngnz-swap', flow.toLowerCase()]
    });
    
    // Execute Obiex operation with standardized crypto-NGNX pairing
    if (isOfframp) {
      // OFFRAMP: Crypto to NGNZ (Obiex: SELL crypto for NGNX)
      logger.info('Executing Obiex crypto-NGNX SELL swap for NGNZ offramp', {
        userId,
        swapId,
        cryptoCurrency,
        amount,
        side: 'SELL',
        correlationId
      });
      
      await executeObiexCryptoNGNXSwap(userId, swapId, cryptoCurrency, amount, 'SELL', correlationId, systemContext, auditStartTime, 'OFFRAMP');
    } else {
      // ONRAMP: NGNZ to crypto (Obiex: BUY crypto with NGNX)
      logger.info('Executing Obiex crypto-NGNX BUY swap for NGNZ onramp', {
        userId,
        swapId,
        cryptoCurrency,
        amount,
        side: 'BUY',
        correlationId
      });
      
      await executeObiexCryptoNGNXSwap(userId, swapId, cryptoCurrency, amount, 'BUY', correlationId, systemContext, auditStartTime, 'ONRAMP');
    }
    
  } catch (error) {
    const auditEndTime = new Date();
    
    logger.error('Background Obiex NGNZ swap execution failed', {
      userId,
      swapId,
      correlationId,
      flow: quote.flow,
      error: error.message,
      stack: error.stack
    });
    
    await createAuditEntry({
      userId,
      eventType: 'OBIEX_SWAP_FAILED',
      status: 'FAILED',
      source: 'BACKGROUND_JOB',
      action: 'Background Obiex NGNZ Swap Error',
      description: `Background Obiex NGNZ swap failed with error: ${error.message}`,
      errorDetails: {
        message: error.message,
        code: 'BACKGROUND_NGNZ_SWAP_ERROR',
        stack: error.stack
      },
      swapDetails: {
        swapId,
        sourceCurrency: quote.sourceCurrency,
        targetCurrency: quote.targetCurrency,
        sourceAmount: quote.amount,
        provider: 'OBIEX',
        swapType: quote.flow || 'UNKNOWN',
        flow: quote.flow
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
      flagReason: 'Critical error in background Obiex NGNZ swap',
      tags: ['background', 'obiex', 'ngnz-swap', 'critical-error']
    });
  }
}

/**
 * Execute crypto-NGNX swap via Obiex with standardized pairing
 * Always uses crypto as sourceId and NGNX as targetId, with side determining direction
 */
async function executeObiexCryptoNGNXSwap(userId, swapId, cryptoCurrency, amount, side, correlationId, systemContext, startTime, flow) {
  try {
    // Always get crypto as sourceId and NGNX as targetId
    const cryptoId = await getCurrencyIdByCode(cryptoCurrency);
    const ngnxId = await getCurrencyIdByCode('NGNX');
    
    logger.info('Executing standardized Obiex crypto-NGNX swap', {
      userId,
      swapId,
      cryptoCurrency,
      cryptoId,
      ngnxId,
      amount,
      side,
      flow,
      correlationId
    });
    
    // Create quote with standardized crypto-NGNX pairing
    const quoteResult = await createQuote({
      sourceId: cryptoId,  // Always crypto as source
      targetId: ngnxId,    // Always NGNX as target
      amount,
      side: side           // 'SELL' for offramp, 'BUY' for onramp
    });
    
    if (!quoteResult.success) {
      throw new Error(`Obiex crypto-NGNX quote creation failed: ${JSON.stringify(quoteResult.error)}`);
    }
    
    const acceptResult = await acceptQuote(quoteResult.quoteId);
    const auditEndTime = new Date();
    
    if (acceptResult.success) {
      logger.info('Obiex crypto-NGNX swap completed successfully', {
        userId,
        swapId,
        cryptoCurrency,
        side,
        flow,
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
        action: `Complete NGNZ ${flow} Swap`,
        description: `Successfully completed Obiex crypto-NGNX ${side} swap for NGNZ ${flow}`,
        swapDetails: {
          swapId,
          sourceCurrency: flow === 'ONRAMP' ? 'NGNZ' : cryptoCurrency,
          targetCurrency: flow === 'ONRAMP' ? cryptoCurrency : 'NGNZ',
          sourceAmount: amount,
          provider: 'OBIEX',
          swapType: `CRYPTO_NGNX_${side}`,
          flow
        },
        obiexDetails: {
          obiexTransactionId: acceptResult.data?.id || acceptResult.data?.reference,
          obiexQuoteId: quoteResult.quoteId,
          obiexStatus: acceptResult.data?.status || 'COMPLETED',
          obiexResponse: acceptResult.data,
          obiexOperationType: 'QUOTE_ACCEPT',
          obiexCryptoCurrency: cryptoCurrency,
          obiexSide: side,
          obiexPairing: `${cryptoCurrency}-NGNX`
        },
        relatedEntities: {
          correlationId
        },
        requestData: { 
          sourceId: cryptoId, 
          targetId: ngnxId, 
          amount, 
          side,
          pairing: `${cryptoCurrency}-NGNX`
        },
        responseData: acceptResult.data,
        systemContext,
        timing: {
          startTime,
          endTime: auditEndTime,
          duration: auditEndTime - startTime
        },
        tags: ['background', 'obiex', 'ngnz-swap', flow.toLowerCase(), side.toLowerCase(), 'success']
      });
      
      await createObiexNGNZTransactionRecord(userId, swapId, {
        quoteId: quoteResult.quoteId,
        quoteData: quoteResult.data,
        acceptData: acceptResult.data,
        obiexPairing: `${cryptoCurrency}-NGNX`,
        obiexSide: side
      }, flow, correlationId);
      
    } else {
      throw new Error(`Obiex crypto-NGNX quote acceptance failed: ${JSON.stringify(acceptResult.error)}`);
    }
    
  } catch (error) {
    const auditEndTime = new Date();
    
    logger.error('Obiex crypto-NGNX swap failed', {
      userId,
      swapId,
      cryptoCurrency,
      side,
      flow,
      amount,
      correlationId,
      error: error.message
    });
    
    await createAuditEntry({
      userId,
      eventType: 'OBIEX_SWAP_FAILED',
      status: 'FAILED',
      source: 'OBIEX_API',
      action: `Failed NGNZ ${flow} Swap`,
      description: `Obiex crypto-NGNX ${side} swap failed for NGNZ ${flow}: ${error.message}`,
      errorDetails: {
        message: error.message,
        code: 'OBIEX_CRYPTO_NGNX_ERROR',
        stack: error.stack
      },
      swapDetails: {
        swapId,
        sourceCurrency: flow === 'ONRAMP' ? 'NGNZ' : cryptoCurrency,
        targetCurrency: flow === 'ONRAMP' ? cryptoCurrency : 'NGNZ',
        sourceAmount: amount,
        provider: 'OBIEX',
        swapType: `CRYPTO_NGNX_${side}`,
        flow
      },
      obiexDetails: {
        obiexCryptoCurrency: cryptoCurrency,
        obiexSide: side,
        obiexPairing: `${cryptoCurrency}-NGNX`,
        obiexOperationType: 'QUOTE_ACCEPT'
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
      flagReason: `Obiex NGNZ ${flow} swap operation failed`,
      tags: ['background', 'obiex', 'ngnz-swap', flow.toLowerCase(), side.toLowerCase(), 'failed']
    });
  }
}

/**
 * Updated transaction record creation with Obiex pairing info
 */
async function createObiexNGNZTransactionRecord(userId, swapId, obiexResult, flow, correlationId) {
  try {
    const obiexTransaction = new Transaction({
      userId,
      type: 'OBIEX_SWAP',
      currency: 'MIXED',
      amount: 0,
      status: 'SUCCESSFUL',
      source: 'OBIEX',
      reference: `OBIEX_NGNZ_${swapId}`,
      obiexTransactionId: obiexResult.quoteId || obiexResult.data?.id || `OBIEX_NGNZ_${Date.now()}`,
      narration: `Obiex background NGNZ ${flow} swap - ${obiexResult.obiexPairing} ${obiexResult.obiexSide}`,
      completedAt: new Date(),
      metadata: {
        originalSwapId: swapId,
        obiexSwapType: `NGNZ_${flow}`,
        obiexResult: obiexResult,
        isBackgroundOperation: true,
        flow: flow,
        obiexPairing: obiexResult.obiexPairing,
        obiexSide: obiexResult.obiexSide,
        correlationId
      }
    });
    
    await obiexTransaction.save();
    
    logger.info('Obiex NGNZ transaction record created', {
      userId,
      swapId,
      flow,
      obiexPairing: obiexResult.obiexPairing,
      obiexSide: obiexResult.obiexSide,
      correlationId,
      obiexTransactionId: obiexTransaction._id
    });
    
    await createAuditEntry({
      userId,
      transactionId: obiexTransaction._id,
      eventType: 'TRANSACTION_CREATED',
      status: 'SUCCESS',
      source: 'BACKGROUND_JOB',
      action: 'Create Obiex NGNZ Transaction Record',
      description: `Created Obiex NGNZ transaction record for ${flow} swap ${swapId} - ${obiexResult.obiexPairing} ${obiexResult.obiexSide}`,
      relatedEntities: {
        correlationId
      },
      metadata: {
        transactionType: 'OBIEX_SWAP',
        originalSwapId: swapId,
        obiexSwapType: `NGNZ_${flow}`,
        obiexPairing: obiexResult.obiexPairing,
        obiexSide: obiexResult.obiexSide,
        flow
      },
      tags: ['transaction', 'obiex', 'ngnz', 'record-creation']
    });
    
  } catch (error) {
    logger.error('Failed to create Obiex NGNZ transaction record', {
      userId,
      swapId,
      flow,
      correlationId,
      error: error.message
    });
    
    await createAuditEntry({
      userId,
      eventType: 'TRANSACTION_CREATED',
      status: 'FAILED',
      source: 'BACKGROUND_JOB',
      action: 'Failed Obiex NGNZ Transaction Record',
      description: `Failed to create Obiex NGNZ transaction record: ${error.message}`,
      errorDetails: {
        message: error.message,
        code: 'NGNZ_TRANSACTION_RECORD_ERROR',
        stack: error.stack
      },
      relatedEntities: {
        correlationId
      },
      metadata: {
        originalSwapId: swapId,
        flow
      },
      riskLevel: 'LOW',
      tags: ['transaction', 'obiex', 'ngnz', 'record-creation', 'failed']
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
  
  // Build select fields dynamically
  const selectFields = ['_id', 'lastBalanceUpdate', 'portfolioLastUpdated'];
  if (currencies.length > 0) {
    currencies.forEach(currency => {
      selectFields.push(`${currency.toLowerCase()}Balance`);
    });
  } else {
    // Common NGNZ swap currencies
    const commonCurrencies = ['ngnz', 'btc', 'eth', 'sol', 'usdt', 'usdc', 'trx', 'bnb', 'matic'];
    commonCurrencies.forEach(currency => {
      selectFields.push(`${currency}Balance`);
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

async function validateNGNZSwap(from, to) {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  
  const isOnramp = f === 'NGNZ' && t !== 'NGNZ';
  const isOfframp = f !== 'NGNZ' && t === 'NGNZ';
  
  if (!isOnramp && !isOfframp) {
    return {
      success: false,
      message: 'Invalid NGNZ swap. One currency must be NGNZ.'
    };
  }
  
  return {
    success: true,
    isOnramp,
    isOfframp,
    sourceCurrency: f,
    targetCurrency: t
  };
}

/**
 * Execute NGNZ swap with atomic balance updates, transaction creation, and comprehensive auditing
 */
async function executeNGNZSwap(userId, quote, correlationId, systemContext) {
  const session = await mongoose.startSession();
  session.startTransaction();
  const startTime = new Date();
  
  try {
    const { sourceCurrency, targetCurrency, amount, amountReceived, flow, type } = quote;
    
    // Balance field names
    const fromKey = sourceCurrency.toLowerCase() + 'Balance';
    const toKey = targetCurrency.toLowerCase() + 'Balance';
    
    // Generate swap reference
    const swapReference = `NGNZ_SWAP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Get current balances for audit trail
    const userBefore = await User.findById(userId).select(`${fromKey} ${toKey}`).lean();
    
    // 1. Update balances atomically with balance validation
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

    // 2. Create outgoing transaction (debit)
    const swapOutTransaction = new Transaction({
      userId,
      type: 'SWAP',
      currency: sourceCurrency,
      amount: -amount, // Negative for outgoing
      status: 'SUCCESSFUL',
      source: 'INTERNAL',
      reference: swapReference,
      obiexTransactionId: `${swapReference}_OUT`,
      narration: `NGNZ ${flow}: Swap ${amount} ${sourceCurrency} to ${amountReceived} ${targetCurrency}`,
      completedAt: new Date(),
      metadata: {
        swapDirection: 'OUT',
        swapType: type,
        flow: flow,
        exchangeRate: amountReceived / amount,
        relatedTransactionRef: swapReference,
        fromCurrency: sourceCurrency,
        toCurrency: targetCurrency,
        fromAmount: amount,
        toAmount: amountReceived,
        correlationId
      }
    });

    // 3. Create incoming transaction (credit)
    const swapInTransaction = new Transaction({
      userId,
      type: 'SWAP',
      currency: targetCurrency,
      amount: amountReceived, // Positive for incoming
      status: 'SUCCESSFUL',
      source: 'INTERNAL',
      reference: swapReference,
      obiexTransactionId: `${swapReference}_IN`,
      narration: `NGNZ ${flow}: Swap ${amount} ${sourceCurrency} to ${amountReceived} ${targetCurrency}`,
      completedAt: new Date(),
      metadata: {
        swapDirection: 'IN',
        swapType: type,
        flow: flow,
        exchangeRate: amountReceived / amount,
        relatedTransactionRef: swapReference,
        fromCurrency: sourceCurrency,
        toCurrency: targetCurrency,
        fromAmount: amount,
        toAmount: amountReceived,
        correlationId
      }
    });

    // 4. Save both transactions
    await swapOutTransaction.save({ session });
    await swapInTransaction.save({ session });

    // 5. Commit everything
    await session.commitTransaction();
    session.endSession();
    
    const endTime = new Date();

    logger.info('NGNZ swap executed successfully', {
      userId,
      swapReference,
      correlationId,
      flow,
      sourceCurrency,
      targetCurrency,
      sourceAmount: amount,
      targetAmount: amountReceived,
      newFromBalance: updatedUser[fromKey],
      newToBalance: updatedUser[toKey],
      outTransactionId: swapOutTransaction._id,
      inTransactionId: swapInTransaction._id
    });

    // Send NGNZ swap completion notification
    try {
      await sendSwapCompletionNotification(
        userId,
        amount,
        sourceCurrency,
        amountReceived,
        targetCurrency,
        true, // is NGNZ swap
        {
          swapId: swapReference,
          correlationId,
          flow,
          provider: 'INTERNAL_NGNZ',
          rate: amountReceived / amount
        }
      );
      logger.info('NGNZ swap completion notification sent', { 
        userId, 
        swapReference, 
        flow, 
        sourceCurrency, 
        targetCurrency 
      });
    } catch (notificationError) {
      logger.error('Failed to send NGNZ swap completion notification', {
        userId,
        swapReference,
        flow,
        error: notificationError.message
      });
    }

    // Create comprehensive audit entries
    await Promise.all([
      // Balance update audit
      createAuditEntry({
        userId,
        eventType: 'BALANCE_UPDATED',
        status: 'SUCCESS',
        source: 'INTERNAL_SWAP',
        action: 'Update User Balances',
        description: `Updated balances for NGNZ ${flow}: ${sourceCurrency} and ${targetCurrency}`,
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
          balanceAfter: updatedUser[fromKey]
        },
        swapDetails: {
          swapId: swapReference,
          sourceCurrency,
          targetCurrency,
          sourceAmount: amount,
          targetAmount: amountReceived,
          provider: 'INTERNAL_NGNZ',
          swapType: flow,
          flow
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
        tags: ['balance-update', 'ngnz-swap', flow.toLowerCase(), 'internal']
      }),
      
      // Swap completion audit
      createAuditEntry({
        userId,
        eventType: 'SWAP_COMPLETED',
        status: 'SUCCESS',
        source: 'INTERNAL_SWAP',
        action: 'Complete NGNZ Swap',
        description: `Successfully completed internal NGNZ ${flow} swap`,
        swapDetails: {
          swapId: swapReference,
          sourceCurrency,
          targetCurrency,
          sourceAmount: amount,
          targetAmount: amountReceived,
          provider: 'INTERNAL_NGNZ',
          swapType: flow,
          flow
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
        tags: ['swap', 'ngnz-swap', flow.toLowerCase(), 'completed', 'success']
      }),
      
      // Transaction creation audits
      createAuditEntry({
        userId,
        transactionId: swapOutTransaction._id,
        eventType: 'TRANSACTION_CREATED',
        status: 'SUCCESS',
        source: 'INTERNAL_SWAP',
        action: 'Create Outgoing NGNZ Transaction',
        description: `Created outgoing transaction for NGNZ ${flow}`,
        financialImpact: {
          currency: sourceCurrency,
          amount: -amount,
          balanceBefore: userBefore[fromKey],
          balanceAfter: updatedUser[fromKey]
        },
        swapDetails: {
          flow
        },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['transaction', 'ngnz-swap', flow.toLowerCase(), 'outgoing']
      }),
      
      createAuditEntry({
        userId,
        transactionId: swapInTransaction._id,
        eventType: 'TRANSACTION_CREATED',
        status: 'SUCCESS',
        source: 'INTERNAL_SWAP',
        action: 'Create Incoming NGNZ Transaction',
        description: `Created incoming transaction for NGNZ ${flow}`,
        financialImpact: {
          currency: targetCurrency,
          amount: amountReceived,
          balanceBefore: userBefore[toKey],
          balanceAfter: updatedUser[toKey]
        },
        swapDetails: {
          flow
        },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['transaction', 'ngnz-swap', flow.toLowerCase(), 'incoming']
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
    
    logger.error('NGNZ swap execution failed', {
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
      action: 'Failed NGNZ Swap',
      description: `Internal NGNZ swap failed: ${err.message}`,
      errorDetails: {
        message: err.message,
        code: 'INTERNAL_NGNZ_SWAP_ERROR',
        stack: err.stack
      },
      swapDetails: {
        sourceCurrency: quote.sourceCurrency,
        targetCurrency: quote.targetCurrency,
        sourceAmount: quote.amount,
        provider: 'INTERNAL_NGNZ',
        swapType: quote.flow,
        flow: quote.flow
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
      flagReason: 'Internal NGNZ swap execution failed',
      tags: ['swap', 'ngnz-swap', 'failed', 'critical-error']
    });
    
    throw err;
  }
}

// MAINTAINING ORIGINAL QUOTE ENDPOINT STRUCTURE BUT OPTIMIZED WITH AUDITING
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
      action: 'Create NGNZ Swap Quote',
      description: `NGNZ quote request: ${amount} ${from} to ${to}`,
      requestData: { from, to, amount, side },
      relatedEntities: {
        correlationId
      },
      systemContext,
      timing: {
        startTime
      },
      tags: ['quote', 'ngnz-swap', 'request']
    });
    
    // Validation - MAINTAINING ORIGINAL ERROR MESSAGES
    if (!from || !to || !amount || !side) {
      await createAuditEntry({
        userId,
        eventType: 'QUOTE_CREATED',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'Failed NGNZ Quote Validation',
        description: 'NGNZ quote request failed validation - missing required fields',
        errorDetails: {
          message: 'Missing required fields: from, to, amount, side',
          code: 'VALIDATION_ERROR'
        },
        requestData: { from, to, amount, side },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['quote', 'ngnz-swap', 'validation', 'failed']
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
        action: 'Failed NGNZ Quote Validation',
        description: 'NGNZ quote request failed validation - invalid amount',
        errorDetails: {
          message: 'Invalid amount. Must be a positive number.',
          code: 'INVALID_AMOUNT'
        },
        requestData: { from, to, amount, side },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['quote', 'ngnz-swap', 'validation', 'failed']
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
        action: 'Failed NGNZ Quote Validation',
        description: 'NGNZ quote request failed validation - invalid side',
        errorDetails: {
          message: 'Invalid side. Must be BUY or SELL.',
          code: 'INVALID_SIDE'
        },
        requestData: { from, to, amount, side },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['quote', 'ngnz-swap', 'validation', 'failed']
      });
      
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid side. Must be BUY or SELL.' 
      });
    }

    // Validate NGNZ swap
    const validation = await validateNGNZSwap(from, to);
    if (!validation.success) {
      await createAuditEntry({
        userId,
        eventType: 'QUOTE_CREATED',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'Failed NGNZ Swap Validation',
        description: 'NGNZ swap validation failed - invalid currency pair',
        errorDetails: {
          message: validation.message,
          code: 'INVALID_NGNZ_PAIR'
        },
        requestData: { from, to, amount, side },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['quote', 'ngnz-swap', 'validation', 'failed']
      });
      
      return res.status(400).json(validation);
    }

    const { isOnramp, sourceCurrency, targetCurrency } = validation;
    
    let receiveAmount, rate, provider, flow, swapType, cryptoPrice;

    if (isOnramp) {
      // NGNZ to Crypto (Onramp)
      const cryptoPrices = await getPricesWithCache([targetCurrency]);
      cryptoPrice = cryptoPrices[targetCurrency];
      
      if (!cryptoPrice) {
        logger.error(`Onramp failed: Price not available for ${targetCurrency}`);
        
        await createAuditEntry({
          userId,
          eventType: 'QUOTE_CREATED',
          status: 'FAILED',
          source: 'API_ENDPOINT',
          action: 'Failed NGNZ Onramp Price Fetch',
          description: `Price unavailable for NGNZ onramp target currency ${targetCurrency}`,
          errorDetails: {
            message: `Price not available for ${targetCurrency}`,
            code: 'PRICE_UNAVAILABLE'
          },
          swapDetails: {
            sourceCurrency,
            targetCurrency,
            sourceAmount: amount,
            flow: 'ONRAMP'
          },
          relatedEntities: {
            correlationId
          },
          systemContext,
          riskLevel: 'LOW',
          tags: ['quote', 'ngnz-swap', 'onramp', 'price-error']
        });
        
        return res.status(400).json({
          success: false,
          message: `Price not available for ${targetCurrency}`
        });
      }
      
      logger.info(`Onramp calculation: ${amount} NGNZ → ${targetCurrency} @ ${cryptoPrice}`);
      
      receiveAmount = await onrampService.calculateCryptoFromNaira(amount, targetCurrency, cryptoPrice);
      rate = (await onrampService.getOnrampRate()).finalPrice;
      provider = 'INTERNAL_ONRAMP';
      flow = 'ONRAMP';
      swapType = 'ONRAMP';
      
      logger.info(`Onramp result: ${receiveAmount} ${targetCurrency} at rate ₦${rate}/$1`);
    } else {
      // Crypto to NGNZ (Offramp)
      const cryptoPrices = await getPricesWithCache([sourceCurrency]);
      cryptoPrice = cryptoPrices[sourceCurrency];
      
      if (!cryptoPrice) {
        logger.error(`Offramp failed: Price not available for ${sourceCurrency}`);
        
        await createAuditEntry({
          userId,
          eventType: 'QUOTE_CREATED',
          status: 'FAILED',
          source: 'API_ENDPOINT',
          action: 'Failed NGNZ Offramp Price Fetch',
          description: `Price unavailable for NGNZ offramp source currency ${sourceCurrency}`,
          errorDetails: {
            message: `Price not available for ${sourceCurrency}`,
            code: 'PRICE_UNAVAILABLE'
          },
          swapDetails: {
            sourceCurrency,
            targetCurrency,
            sourceAmount: amount,
            flow: 'OFFRAMP'
          },
          relatedEntities: {
            correlationId
          },
          systemContext,
          riskLevel: 'LOW',
          tags: ['quote', 'ngnz-swap', 'offramp', 'price-error']
        });
        
        return res.status(400).json({
          success: false,
          message: `Price not available for ${sourceCurrency}`
        });
      }
      
      logger.info(`Offramp calculation: ${amount} ${sourceCurrency} @ ${cryptoPrice} → NGNZ`);
      
      receiveAmount = await offrampService.calculateNairaFromCrypto(amount, sourceCurrency, cryptoPrice);
      rate = (await offrampService.getCurrentRate()).finalPrice;
      provider = 'INTERNAL_OFFRAMP';
      flow = 'OFFRAMP';
      swapType = 'OFFRAMP';
      
      logger.info(`Offramp result: ₦${receiveAmount} at rate ₦${rate}/$1`);
    }

    const id = `ngnz_${flow.toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const expiresAt = new Date(Date.now() + 30000).toISOString(); // 30 seconds

    // Calculate USD values for display (optional)
    let sourceAmountUSD, targetAmountUSD;
    
    if (isOnramp) {
      sourceAmountUSD = amount / rate; // NGNZ amount ÷ rate = USD
      targetAmountUSD = receiveAmount * cryptoPrice; // crypto amount × price = USD
    } else {
      sourceAmountUSD = amount * cryptoPrice; // crypto amount × price = USD
      targetAmountUSD = receiveAmount / rate; // NGNZ amount ÷ rate = USD
    }

    const payload = {
      id,
      amount,
      amountReceived: receiveAmount,
      sourceAmountUSD: parseFloat(sourceAmountUSD.toFixed(6)),
      targetAmountUSD: parseFloat(targetAmountUSD.toFixed(6)),
      rate,
      cryptoPrice,
      side,
      sourceCurrency,
      targetCurrency,
      provider,
      type: swapType,
      flow,
      expiresAt,
      correlationId // Add correlation ID to payload
    };

    logger.info(`${flow} quote created`, {
      sourceAmount: amount,
      targetAmount: receiveAmount,
      sourceUSD: sourceAmountUSD.toFixed(6),
      targetUSD: targetAmountUSD.toFixed(6),
      rate,
      cryptoPrice,
      correlationId
    });

    // OPTIMIZED CACHING WITH AUTO-CLEANUP
    ngnzQuoteCache.set(id, payload);
    setTimeout(() => ngnzQuoteCache.delete(id), 30000);
    
    const endTime = new Date();

    // Create successful quote audit
    await createAuditEntry({
      userId,
      eventType: 'QUOTE_CREATED',
      status: 'SUCCESS',
      source: 'API_ENDPOINT',
      action: 'Create NGNZ Swap Quote',
      description: `Successfully created NGNZ ${flow} quote for ${amount} ${sourceCurrency} to ${targetCurrency}`,
      requestData: { from, to, amount, side },
      responseData: payload,
      swapDetails: {
        quoteId: id,
        sourceCurrency,
        targetCurrency,
        sourceAmount: amount,
        targetAmount: receiveAmount,
        provider,
        swapType,
        flow
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
      tags: ['quote', 'ngnz-swap', flow.toLowerCase(), 'created', 'success']
    });

    return res.json({
      success: true,
      message: `NGNZ ${flow.toLowerCase()} quote created successfully`,
      data: { data: payload, ...payload }
    });

  } catch (err) {
    const endTime = new Date();
    
    logger.error('POST /ngnz-swap/quote error', { error: err.stack, correlationId });
    
    // Create error audit entry
    await createAuditEntry({
      userId: req.user?.id,
      eventType: 'QUOTE_CREATED',
      status: 'FAILED',
      source: 'API_ENDPOINT',
      action: 'Failed NGNZ Quote Creation',
      description: `NGNZ quote creation failed with error: ${err.message}`,
      errorDetails: {
        message: err.message,
        code: 'NGNZ_QUOTE_CREATION_ERROR',
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
      flagReason: 'NGNZ quote creation system error',
      tags: ['quote', 'ngnz-swap', 'creation', 'system-error']
    });
    
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
});

// ENHANCED NGNZ SWAP EXECUTION ENDPOINT WITH OBIEX INTEGRATION AND COMPREHENSIVE AUDITING
router.post('/quote/:quoteId', async (req, res) => {
  const systemContext = getSystemContext(req);
  const startTime = new Date();
  
  try {
    const { quoteId } = req.params;
    const userId = req.user.id;
    const quote = ngnzQuoteCache.get(quoteId);
    
    // Use existing correlation ID from quote or generate new one
    const correlationId = quote?.correlationId || generateCorrelationId();

    // Create audit for quote acceptance attempt
    await createAuditEntry({
      userId,
      eventType: 'QUOTE_ACCEPTED',
      status: 'PENDING',
      source: 'API_ENDPOINT',
      action: 'Accept NGNZ Swap Quote',
      description: `Attempting to accept NGNZ quote ${quoteId}`,
      swapDetails: {
        quoteId,
        flow: quote?.flow
      },
      relatedEntities: {
        correlationId
      },
      systemContext,
      timing: {
        startTime
      },
      tags: ['quote', 'ngnz-swap', 'acceptance', 'pending']
    });

    // MAINTAINING ORIGINAL ERROR HANDLING
    if (!quote) {
      await createAuditEntry({
        userId,
        eventType: 'QUOTE_ACCEPTED',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'NGNZ Quote Not Found',
        description: `NGNZ quote ${quoteId} not found or expired`,
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
        tags: ['quote', 'ngnz-swap', 'not-found']
      });
      
      return res.status(404).json({ 
        success: false, 
        message: 'Quote not found or expired' 
      });
    }

    if (new Date() > new Date(quote.expiresAt)) {
      ngnzQuoteCache.delete(quoteId);
      
      await createAuditEntry({
        userId,
        eventType: 'QUOTE_EXPIRED',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'NGNZ Quote Expired',
        description: `NGNZ quote ${quoteId} has expired`,
        errorDetails: {
          message: 'Quote has expired',
          code: 'QUOTE_EXPIRED'
        },
        swapDetails: {
          quoteId,
          expiresAt: quote.expiresAt,
          flow: quote.flow
        },
        relatedEntities: {
          correlationId
        },
        systemContext,
        tags: ['quote', 'ngnz-swap', 'expired']
      });
      
      return res.status(410).json({ 
        success: false, 
        message: 'Quote has expired' 
      });
    }

    // Validate user balance
    const validation = await validateUserBalance(userId, quote.sourceCurrency, quote.amount);
    if (!validation.success) {
      await createAuditEntry({
        userId,
        eventType: 'BALANCE_SYNC',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'Insufficient Balance for NGNZ Swap',
        description: `Insufficient balance for NGNZ ${quote.flow}: ${validation.message}`,
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
          availableAmount: validation.availableBalance,
          flow: quote.flow
        },
        relatedEntities: {
          correlationId
        },
        systemContext,
        riskLevel: 'LOW',
        tags: ['balance', 'ngnz-swap', 'insufficient', 'validation']
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

    // Execute NGNZ swap directly
    const swapResult = await executeNGNZSwap(userId, quote, correlationId, systemContext);

    // *** NEW: Execute Obiex NGNZ swap in background ***
    // This runs asynchronously and won't block the response
    setImmediate(() => {
      executeObiexNGNZSwapBackground(userId, quote, swapResult.swapId, correlationId, systemContext);
    });

    logger.info('NGNZ swap completed, Obiex NGNZ swap initiated in background', { 
      userId, 
      quoteId, 
      correlationId,
      swapId: swapResult.swapId,
      flow: quote.flow
    });

    // Clean up quote from cache
    ngnzQuoteCache.delete(quoteId);
    
    const endTime = new Date();

    // Create successful quote acceptance audit
    await createAuditEntry({
      userId,
      eventType: 'QUOTE_ACCEPTED',
      status: 'SUCCESS',
      source: 'API_ENDPOINT',
      action: 'Accept NGNZ Swap Quote',
      description: `Successfully accepted and executed NGNZ ${quote.flow} quote ${quoteId}`,
      swapDetails: {
        quoteId,
        swapId: swapResult.swapId,
        sourceCurrency: quote.sourceCurrency,
        targetCurrency: quote.targetCurrency,
        sourceAmount: quote.amount,
        targetAmount: quote.amountReceived,
        provider: quote.provider,
        swapType: quote.type,
        flow: quote.flow
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
      tags: ['quote', 'ngnz-swap', quote.flow.toLowerCase(), 'accepted', 'success', 'obiex-initiated']
    });

    const responsePayload = {
      swapId: swapResult.swapId,
      quoteId,
      correlationId, // Include correlation ID in response
      status: 'SUCCESSFUL',
      flow: quote.flow,
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
      // NEW: Indicate that Obiex NGNZ swap is running in background
      obiexSwapInitiated: true,
      audit: {
        correlationId,
        trackingEnabled: true
      }
    };

    return res.json({
      success: true,
      message: `NGNZ ${quote.flow.toLowerCase()} completed successfully, Obiex swap initiated in background`,
      data: { data: responsePayload, ...responsePayload }
    });

  } catch (err) {
    const endTime = new Date();
    const correlationId = generateCorrelationId();
    
    logger.error('POST /ngnz-swap/quote/:quoteId error', { 
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
      action: 'Failed NGNZ Swap Execution',
      description: `NGNZ swap execution failed: ${err.message}`,
      errorDetails: {
        message: err.message,
        code: 'NGNZ_SWAP_EXECUTION_ERROR',
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
      flagReason: 'Critical NGNZ swap execution failure',
      tags: ['swap', 'ngnz-swap', 'execution', 'critical-error', 'api-endpoint']
    });
    
    return res.status(500).json({ 
      success: false, 
      message: err.message || 'Swap failed - please try again'
    });
  }
});

// MAINTAINING ORIGINAL SUPPORTED CURRENCIES ENDPOINT WITH AUDITING
router.get('/supported-currencies', (req, res) => {
  const systemContext = getSystemContext(req);
  
  try {
    const supportedCurrencies = [
      { code: 'BTC', name: 'Bitcoin', type: 'cryptocurrency' },
      { code: 'ETH', name: 'Ethereum', type: 'cryptocurrency' },
      { code: 'SOL', name: 'Solana', type: 'cryptocurrency' },
      { code: 'USDT', name: 'Tether', type: 'stablecoin' },
      { code: 'USDC', name: 'USD Coin', type: 'stablecoin' },
      { code: 'TRX', name: 'Tron', type: 'cryptocurrency' },
      { code: 'BNB', name: 'BNB', type: 'cryptocurrency' },
      { code: 'MATIC', name: 'Polygon', type: 'cryptocurrency' },
      { code: 'NGNZ', name: 'Nigerian Naira Digital', type: 'fiat' }
    ];

    // Simple audit for supported currencies request
    setImmediate(async () => {
      await createAuditEntry({
        userId: req.user?.id,
        eventType: 'USER_ACTION',
        status: 'SUCCESS',
        source: 'API_ENDPOINT',
        action: 'Fetch NGNZ Supported Currencies',
        description: 'Retrieved supported currencies for NGNZ swaps',
        responseData: { currencyCount: supportedCurrencies.length },
        systemContext,
        tags: ['currencies', 'ngnz-swap', 'fetch', 'info']
      });
    });

    res.json({
      success: true,
      message: 'Supported currencies for NGNZ swaps retrieved successfully',
      data: supportedCurrencies,
      total: supportedCurrencies.length
    });
  } catch (err) {
    logger.error('GET /ngnz-swap/supported-currencies error', { error: err.stack });
    
    // Error audit for supported currencies request
    setImmediate(async () => {
      await createAuditEntry({
        userId: req.user?.id,
        eventType: 'SYSTEM_ERROR',
        status: 'FAILED',
        source: 'API_ENDPOINT',
        action: 'Failed NGNZ Currencies Fetch',
        description: `Failed to fetch NGNZ supported currencies: ${err.message}`,
        errorDetails: {
          message: err.message,
          code: 'NGNZ_CURRENCIES_FETCH_ERROR',
          stack: err.stack
        },
        systemContext,
        tags: ['currencies', 'ngnz-swap', 'fetch', 'error']
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
  
  // Clean expired NGNZ quotes
  for (const [key, quote] of ngnzQuoteCache.entries()) {
    if (now > new Date(quote.expiresAt).getTime()) {
      ngnzQuoteCache.delete(key);
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