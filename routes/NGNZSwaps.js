// routes/ngnzSwap.js

const express = require('express');
const mongoose = require('mongoose');
const onrampService  = require('../services/onramppriceservice');
const offrampService = require('../services/offramppriceservice');
const { getPricesWithCache } = require('../services/portfolio');
const Transaction = require('../models/transaction');
const User = require('../models/user');
const logger = require('../utils/logger');

const router = express.Router();
const ngnzQuoteCache = new Map();

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
 * Execute NGNZ swap with atomic balance updates and transaction creation
 */
async function executeNGNZSwap(userId, quote) {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { sourceCurrency, targetCurrency, amount, amountReceived, flow, type } = quote;
    
    // Balance field names
    const fromKey = sourceCurrency.toLowerCase() + 'Balance';
    const toKey = targetCurrency.toLowerCase() + 'Balance';
    
    // Generate swap reference
    const swapReference = `NGNZ_SWAP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
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
        toAmount: amountReceived
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
        toAmount: amountReceived
      }
    });

    // 4. Save both transactions
    await swapOutTransaction.save({ session });
    await swapInTransaction.save({ session });

    // 5. Commit everything
    await session.commitTransaction();
    session.endSession();

    logger.info('NGNZ swap executed successfully', {
      userId,
      swapReference,
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

    return {
      user: updatedUser,
      swapOutTransaction,
      swapInTransaction,
      swapId: swapReference
    };

  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    
    logger.error('NGNZ swap execution failed', {
      error: err.message,
      stack: err.stack,
      userId,
      quote
    });
    
    throw err;
  }
}

router.post('/quote', async (req, res) => {
  try {
    const { from, to, amount, side } = req.body;
    
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

    // Validate NGNZ swap
    const validation = await validateNGNZSwap(from, to);
    if (!validation.success) {
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
      expiresAt
    };

    logger.info(`${flow} quote created`, {
      sourceAmount: amount,
      targetAmount: receiveAmount,
      sourceUSD: sourceAmountUSD.toFixed(6),
      targetUSD: targetAmountUSD.toFixed(6),
      rate,
      cryptoPrice
    });

    ngnzQuoteCache.set(id, payload);

    return res.json({
      success: true,
      message: `NGNZ ${flow.toLowerCase()} quote created successfully`,
      data: { data: payload, ...payload }
    });

  } catch (err) {
    logger.error('POST /ngnz-swap/quote error', { error: err.stack });
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
});

router.post('/quote/:quoteId', async (req, res) => {
  try {
    const { quoteId } = req.params;
    const userId = req.user.id;
    const quote = ngnzQuoteCache.get(quoteId);

    if (!quote) {
      return res.status(404).json({ 
        success: false, 
        message: 'Quote not found or expired' 
      });
    }

    if (new Date() > new Date(quote.expiresAt)) {
      ngnzQuoteCache.delete(quoteId);
      return res.status(410).json({ 
        success: false, 
        message: 'Quote has expired' 
      });
    }

    // Validate user balance
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

    // Execute swap directly (like your webhook does)
    const swapResult = await executeNGNZSwap(userId, quote);

    logger.info('NGNZ swap completed', { 
      userId, 
      quoteId, 
      swapId: swapResult.swapId,
      flow: quote.flow
    });

    // Clean up quote from cache
    ngnzQuoteCache.delete(quoteId);

    const responsePayload = {
      swapId: swapResult.swapId,
      quoteId,
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
      }
    };

    return res.json({
      success: true,
      message: `NGNZ ${quote.flow.toLowerCase()} completed successfully`,
      data: { data: responsePayload, ...responsePayload }
    });

  } catch (err) {
    logger.error('POST /ngnz-swap/quote/:quoteId error', { 
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

// Get supported currencies for NGNZ swaps
router.get('/supported-currencies', (req, res) => {
  try {
    const supportedCurrencies = [
      { code: 'BTC', name: 'Bitcoin', type: 'cryptocurrency' },
      { code: 'ETH', name: 'Ethereum', type: 'cryptocurrency' },
      { code: 'SOL', name: 'Solana', type: 'cryptocurrency' },
      { code: 'USDT', name: 'Tether', type: 'stablecoin' },
      { code: 'USDC', name: 'USD Coin', type: 'stablecoin' },
      { code: 'AVAX', name: 'Avalanche', type: 'cryptocurrency' },
      { code: 'BNB', name: 'BNB', type: 'cryptocurrency' },
      { code: 'MATIC', name: 'Polygon', type: 'cryptocurrency' },
      { code: 'NGNZ', name: 'Nigerian Naira Digital', type: 'fiat' }
    ];

    res.json({
      success: true,
      message: 'Supported currencies for NGNZ swaps retrieved successfully',
      data: supportedCurrencies,
      total: supportedCurrencies.length
    });
  } catch (err) {
    logger.error('GET /ngnz-swap/supported-currencies error', { error: err.stack });
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
});

module.exports = router;