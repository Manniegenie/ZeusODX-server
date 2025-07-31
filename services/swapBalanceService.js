// services/swapBalanceService.js

const mongoose = require('mongoose');
const User = require('../models/user');
const Transaction = require('../models/transaction');
const { getPricesWithCache } = require('./portfolio');
const logger = require('../utils/logger');

/**
 * Get USD price for any currency (crypto or NGNZ)
 */
async function getCurrencyPrice(currency) {
  const uc = currency.toUpperCase();
  if (uc === 'NGNZ') {
    // NGNZ pegged logic
    const { getOnrampRate } = require('./onramppriceservice');
    const { getCurrentRate } = require('./offramppriceservice');
    let rate;
    try {
      rate = (await getOnrampRate()).finalPrice;
    } catch {
      rate = (await getCurrentRate()).finalPrice;
    }
    return 1 / rate; 
  }
  const prices = await getPricesWithCache([uc]);
  if (!prices[uc] || prices[uc] <= 0) {
    throw new Error(`No price for ${uc}`);
  }
  return prices[uc];
}

/**
 * Determine swap type based on currencies involved
 */
function getSwapType(fromCurrency, toCurrency) {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  
  if (from === 'NGNZ' && to !== 'NGNZ') {
    return 'onramp'; // NGNZ to crypto
  } else if (from !== 'NGNZ' && to === 'NGNZ') {
    return 'offramp'; // crypto to NGNZ
  } else {
    return 'crypto_to_crypto'; // crypto to crypto
  }
}

/**
 * Create swap transaction records
 */
async function createSwapTransactions({
  userId,
  fromCurrency,
  toCurrency,
  fromAmount,
  toAmount,
  swapType,
  session
}) {
  // Generate a unique reference for this swap pair
  const swapReference = `SWAP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Create the outgoing transaction (debit)
  const swapOutTransaction = new Transaction({
    userId,
    type: 'SWAP',
    currency: fromCurrency,
    amount: -fromAmount, // Negative for outgoing
    status: 'SUCCESSFUL',
    source: 'INTERNAL',
    fromCurrency,
    toCurrency,
    fromAmount,
    toAmount,
    swapType,
    reference: swapReference,
    narration: `Swap ${fromAmount} ${fromCurrency} to ${toAmount} ${toCurrency}`,
    completedAt: new Date(),
    metadata: {
      swapDirection: 'OUT',
      exchangeRate: toAmount / fromAmount,
      relatedTransactionRef: swapReference
    }
  });

  // Create the incoming transaction (credit)
  const swapInTransaction = new Transaction({
    userId,
    type: 'SWAP',
    currency: toCurrency,
    amount: toAmount, // Positive for incoming
    status: 'SUCCESSFUL',
    source: 'INTERNAL',
    fromCurrency,
    toCurrency,
    fromAmount,
    toAmount,
    swapType,
    reference: swapReference,
    narration: `Swap ${fromAmount} ${fromCurrency} to ${toAmount} ${toCurrency}`,
    completedAt: new Date(),
    metadata: {
      swapDirection: 'IN',
      exchangeRate: toAmount / fromAmount,
      relatedTransactionRef: swapReference
    }
  });

  // Save both transactions within the session
  await swapOutTransaction.save({ session });
  await swapInTransaction.save({ session });

  logger.info('Swap transactions created', {
    userId,
    swapReference,
    fromCurrency,
    toCurrency,
    fromAmount,
    toAmount,
    swapType,
    outTransactionId: swapOutTransaction._id,
    inTransactionId: swapInTransaction._id
  });

  return {
    swapOutTransaction,
    swapInTransaction,
    swapId: swapReference
  };
}

/**
 * updateBalancesOnSwap(userId, fromCurrency, toCurrency, fromAmount, toAmount)
 *
 * - Creates a SWAP transaction pair
 * - Adjusts balances atomically using MongoDB transactions
 * - Updates both regular balances and USD balances
 * - Throws on insufficient balance or DB errors
 */
async function updateBalancesOnSwap(userId, fromCurrency, toCurrency, fromAmount, toAmount) {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // 1. Validate user exists and has sufficient balance
    const user = await User.findById(userId).session(session);
    if (!user) {
      throw new Error('User not found');
    }

    const fromKey = fromCurrency.toLowerCase() + 'Balance';
    const toKey = toCurrency.toLowerCase() + 'Balance';
    const currentBalance = user[fromKey] || 0;

    if (currentBalance < fromAmount) {
      throw new Error(
        `Insufficient ${fromCurrency} balance. Available: ${currentBalance}, Required: ${fromAmount}`
      );
    }

    // 2. Get current prices for USD balance calculations
    const [fromPrice, toPrice] = await Promise.all([
      getCurrencyPrice(fromCurrency),
      getCurrencyPrice(toCurrency)
    ]);
    
    const fromUsdDelta = fromAmount * fromPrice;
    const toUsdDelta = toAmount * toPrice;

    // 3. Determine swap type
    const swapType = getSwapType(fromCurrency, toCurrency);

    // 4. Create swap transaction records
    const { swapOutTransaction, swapInTransaction, swapId } = await createSwapTransactions({
      userId,
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount,
      swapType,
      session
    });

    // 5. Update user balances atomically
    const updatedUser = await User.findOneAndUpdate(
      { 
        _id: userId, 
        [fromKey]: { $gte: fromAmount } // Double-check balance in update query
      },
      {
        $inc: {
          [fromKey]: -fromAmount,
          [toKey]: toAmount,
          [`${fromCurrency.toLowerCase()}BalanceUSD`]: -fromUsdDelta,
          [`${toCurrency.toLowerCase()}BalanceUSD`]: toUsdDelta
        },
        $set: { portfolioLastUpdated: new Date() }
      },
      { 
        new: true, 
        runValidators: true, 
        session 
      }
    );

    if (!updatedUser) {
      throw new Error('Balance update failed - insufficient balance or user not found during update');
    }

    // 6. Commit the transaction
    await session.commitTransaction();
    session.endSession();

    logger.info('Swap completed successfully', {
      userId, 
      swapId,
      fromCurrency, 
      toCurrency, 
      fromAmount, 
      toAmount,
      swapType,
      swapOutTransactionId: swapOutTransaction._id,
      swapInTransactionId: swapInTransaction._id,
      newFromBalance: updatedUser[fromKey],
      newToBalance: updatedUser[toKey]
    });

    return {
      user: updatedUser,
      swapOutTransaction,
      swapInTransaction,
      swapId
    };

  } catch (err) {
    // Rollback transaction on any error
    await session.abortTransaction();
    session.endSession();
    
    logger.error('Swap balance service failed', { 
      error: err.message,
      stack: err.stack,
      userId,
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount
    });
    
    throw err;
  }
}

module.exports = {
  updateBalancesOnSwap,
  getCurrencyPrice,
  getSwapType,
  createSwapTransactions
};