// routes/ngnzSwap.js

const express = require('express');
const onrampService  = require('../services/onramppriceservice');
const offrampService = require('../services/offramppriceservice');
const { getPricesWithCache }         = require('../services/portfolio');
const { updateBalancesOnSwap }       = require('../services/swapBalanceService');
const Transaction                    = require('../models/transaction');
const User                           = require('../models/user');
const logger                         = require('../utils/logger');

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
    
    let receiveAmount, rate, provider, flow, swapType;

    if (isOnramp) {
      // NGNZ to Crypto (Onramp)
      // Need to get crypto price for the target currency
      const cryptoPrices = await getPricesWithCache([targetCurrency]);
      const cryptoPrice = cryptoPrices[targetCurrency];
      
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
      // Need to get crypto price for the source currency
      const cryptoPrices = await getPricesWithCache([sourceCurrency]);
      const cryptoPrice = cryptoPrices[sourceCurrency];
      
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

    // Calculate USD values for better UX
    let sourceAmountUSD, targetAmountUSD;
    
    if (isOnramp) {
      // NGNZ to Crypto
      sourceAmountUSD = amount / rate; // NGNZ amount ÷ rate = USD
      targetAmountUSD = receiveAmount * cryptoPrice; // crypto amount × price = USD
    } else {
      // Crypto to NGNZ  
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
      cryptoPrice, // Include crypto price for reference
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

    // Create swap transaction
    const swapTx = await Transaction.createSwapTransactions({
      userId,
      quoteId,
      sourceCurrency: quote.sourceCurrency,
      targetCurrency: quote.targetCurrency,
      sourceAmount: quote.amount,
      targetAmount: quote.amountReceived,
      exchangeRate: quote.amountReceived / quote.amount,
      swapType: quote.type,
      provider: quote.provider,
      markdownApplied: 0,
      swapFee: 0,
      quoteExpiresAt: new Date(quote.expiresAt),
      status: 'SUCCESSFUL',
      obiexTransactionId: `ngnz_${quote.flow.toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2)}`
    });

    logger.info('NGNZ swap transactions created', { 
      userId, 
      quoteId, 
      swapId: swapTx.swapId,
      flow: quote.flow 
    });

    // Update balances
    await updateBalancesOnSwap(
      userId,
      quote.sourceCurrency,
      quote.targetCurrency,
      quote.amount,
      quote.amountReceived
    );

    logger.info('NGNZ swap balances updated', { 
      userId, 
      flow: quote.flow 
    });

    // Clean up quote from cache
    ngnzQuoteCache.delete(quoteId);

    const responsePayload = {
      swapId: swapTx.swapId,
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
        swapId: swapTx.swapId,
        obiexTransactionId: swapTx.obiexTransactionId
      },
      balanceUpdated: true
    };

    return res.json({
      success: true,
      message: `NGNZ ${quote.flow.toLowerCase()} completed successfully`,
      data: { data: responsePayload, ...responsePayload }
    });

  } catch (err) {
    logger.error('POST /ngnz-swap/quote/:quoteId error', { error: err.stack });
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
});

// Get supported currencies for NGNZ swaps
router.get('/supported-currencies', (req, res) => {
  try {
    // Match the cryptocurrencies supported in your other services
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