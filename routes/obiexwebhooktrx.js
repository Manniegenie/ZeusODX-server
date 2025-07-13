const express = require('express');
const router = express.Router();
const User = require('../models/user');
const Transaction = require('../models/transaction');
const { updateUserPortfolioBalance, releaseReservedBalance } = require('../services/portfolio');
const webhookAuth = require('../auth/webhookauth');
const logger = require('../utils/logger');

const CURRENCY_BALANCE_MAP = {
  'BTC': 'btcBalance',
  'ETH': 'ethBalance',
  'SOL': 'solBalance',
  'USDT': 'usdtBalance',
  'USDC': 'usdcBalance',
  'BNB': 'bnbBalance',
  'MATIC': 'maticBalance',
  'AVAX': 'avaxBalance',
  'NGNZ': 'ngnzBalance'
};

const PENDING_BALANCE_MAP = {
  'BTC': 'btcPendingBalance',
  'ETH': 'ethPendingBalance', 
  'SOL': 'solPendingBalance',
  'USDT': 'usdtPendingBalance',
  'USDC': 'usdcPendingBalance',
  'BNB': 'bnbPendingBalance',
  'MATIC': 'maticPendingBalance',
  'AVAX': 'avaxPendingBalance',
  'NGNZ': 'ngnzPendingBalance'
};

async function updateUserBalance(user, currency, amount) {
  const normalizedCurrency = currency.toUpperCase();
  const balanceField = CURRENCY_BALANCE_MAP[normalizedCurrency];
  
  if (!balanceField) {
    logger.warn(`No balance field mapping found for currency: ${normalizedCurrency}`);
    return;
  }
  
  const currentBalance = user[balanceField] || 0;
  const newBalance = Math.max(0, currentBalance + amount);
  
  user[balanceField] = newBalance;
  await user.save();
  
  logger.info(`Updated ${user._id} ${balanceField}: ${currentBalance} -> ${newBalance} (${amount >= 0 ? '+' : ''}${amount})`);
}

async function updatePendingBalance(user, currency, amount) {
  const normalizedCurrency = currency.toUpperCase();
  const pendingBalanceField = PENDING_BALANCE_MAP[normalizedCurrency];
  
  if (!pendingBalanceField) {
    logger.warn(`No pending balance field mapping found for currency: ${normalizedCurrency}`);
    return;
  }
  
  const currentPending = user[pendingBalanceField] || 0;
  const newPending = Math.max(0, currentPending - Math.abs(amount));
  
  user[pendingBalanceField] = newPending;
  await user.save();
  
  logger.info(`Updated ${user._id} ${pendingBalanceField}: ${currentPending} -> ${newPending} (-${Math.abs(amount)})`);
}

router.post('/transaction', webhookAuth, async (req, res) => {
  const body = req.body;

  logger.info('Webhook Transaction - Received Body:', body);

  try {
    const {
      hash,
      type,
      currency,
      address,
      amount,
      status,
      reference,
      transactionId,
      createdAt,
      lastUpdated,
      network,
      narration,
      source,
      swapDetails,
      relatedTransactionId,
      metadata
    } = body;

    const requiredFields = { type, currency, amount, transactionId, status, reference };
    const missingFields = Object.keys(requiredFields).filter(key => !requiredFields[key]);
    
    if (type === 'DEPOSIT' && !address) missingFields.push('address');

    if (missingFields.length > 0) {
      logger.warn('Webhook Transaction - Missing Fields:', {
        type: !!type,
        currency: !!currency,
        amount: !!amount,
        transactionId: !!transactionId,
        status: !!status,
        reference: !!reference,
        address: !!address,
      });
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const normalizedCurrency = currency.trim().toUpperCase();

    let user;
    let transaction;
    
    if (type === 'DEPOSIT') {
      user = await User.findOne({
        $or: [
          { [`wallets.${normalizedCurrency}.address`]: address },
          { [`wallets.${normalizedCurrency}_BEP20.address`]: address },
          { [`wallets.${normalizedCurrency}_TRX.address`]: address },
          { [`wallets.${normalizedCurrency}_ETH.address`]: address },
          { [`wallets.${normalizedCurrency}_BSC.address`]: address },
        ],
      });
    } else if (['WITHDRAWAL', 'SWAP_IN', 'SWAP_OUT', 'ONRAMP', 'OFFRAMP'].includes(type)) {
      transaction = await Transaction.findOne({ obiexTransactionId: transactionId });
      
      if (!transaction) {
        logger.warn(`No transaction found for obiexTransactionId: ${transactionId}`, {
          type,
          searchedTransactionId: transactionId,
          webhookReference: reference,
        });
        return res.status(404).json({ error: 'Transaction not found' });
      }
      
      logger.info(`Found ${type} transaction: ${transaction._id} with obiexTransactionId: ${transaction.obiexTransactionId}, current status: ${transaction.status}`);
      user = await User.findById(transaction.userId);
    }

    if (!user) {
      logger.warn(`No user found for ${type === 'DEPOSIT' ? `address ${address}` : `transactionId ${transactionId}`}`);
      return res.status(404).json({ error: 'No user found' });
    }

    const updatePayload = {
      userId: user._id,
      type,
      currency: normalizedCurrency,
      address,
      amount: parseFloat(amount),
      status,
      reference,
      obiexTransactionId: transactionId,
      updatedAt: new Date()
    };

    if (hash) updatePayload.hash = hash;
    if (network) updatePayload.network = network;
    if (narration) updatePayload.narration = narration;
    if (source) updatePayload.source = source;
    if (createdAt) updatePayload.createdAt = new Date(createdAt);
    if (metadata) updatePayload.metadata = metadata;
    if (relatedTransactionId) updatePayload.relatedTransactionId = relatedTransactionId;

    if (swapDetails && ['SWAP_IN', 'SWAP_OUT', 'ONRAMP', 'OFFRAMP'].includes(type)) {
      updatePayload.swapDetails = {
        ...swapDetails,
        quoteAcceptedAt: swapDetails.quoteAcceptedAt ? new Date(swapDetails.quoteAcceptedAt) : undefined,
        quoteExpiresAt: swapDetails.quoteExpiresAt ? new Date(swapDetails.quoteExpiresAt) : undefined
      };
      
      logger.info('Processing swap transaction with details:', {
        type,
        swapId: swapDetails.swapId,
        quoteId: swapDetails.quoteId,
        sourceCurrency: swapDetails.sourceCurrency,
        targetCurrency: swapDetails.targetCurrency,
        swapType: swapDetails.swapType
      });
    }

    if (['WITHDRAWAL', 'SWAP_IN', 'SWAP_OUT', 'ONRAMP', 'OFFRAMP'].includes(type) && transaction) {
      Object.assign(transaction, updatePayload);
      await transaction.save();
      logger.info(`Updated existing ${type} transaction: ${transaction._id}`);
    } else {
      transaction = await Transaction.findOneAndUpdate(
        { obiexTransactionId: transactionId },
        { $set: updatePayload },
        { upsert: true, new: true }
      );
      logger.info(transaction.isNew ? `New ${type} transaction created` : `${type} transaction updated`);
    }

    // Handle pending balance for withdrawals with FAILED or REJECTED
    if (type === 'WITHDRAWAL' && ['FAILED', 'REJECTED'].includes(status)) {
      await releaseReservedBalance(user._id, normalizedCurrency, parseFloat(amount) + (transaction.fee || 0));
      logger.info(`Released reserved balance for failed/rejected withdrawal: ${parseFloat(amount) + (transaction.fee || 0)} ${normalizedCurrency}`);
    }

    // Handle failed ONRAMP/OFFRAMP swaps
    if (['ONRAMP', 'OFFRAMP'].includes(type) && ['FAILED', 'REJECTED'].includes(status)) {
      if (swapDetails && swapDetails.swapId) {
        await Transaction.updateSwapStatus(swapDetails.swapId, status);
        logger.info(`Updated all swap transactions with swapId ${swapDetails.swapId} to ${status}`);
        
        if (type === 'ONRAMP') {
          const releaseAmount = Math.abs(parseFloat(amount)) + (swapDetails.swapFee || 0);
          await releaseReservedBalance(user._id, normalizedCurrency, releaseAmount);
          logger.info(`Released reserved balance for failed ${type}: ${releaseAmount} ${normalizedCurrency}`);
        }
      }
    }

    // Handle successful deposit
    if (type === 'DEPOSIT' && status === 'CONFIRMED') {
      try {
        await updateUserBalance(user, normalizedCurrency, parseFloat(amount));
        logger.info(`Added deposit to user balance: ${amount} ${normalizedCurrency}`);
      } catch (err) {
        logger.error(`Error updating balance for deposit:`, err);
      }
    }

    // Handle successful withdrawal
    if (type === 'WITHDRAWAL' && status === 'SUCCESSFUL') {
      try {
        const totalReservedAmount = parseFloat(amount) + (transaction.fee || 0);
        await updatePendingBalance(user, normalizedCurrency, totalReservedAmount);
        logger.info(`Reduced pending balance for successful withdrawal: ${totalReservedAmount} ${normalizedCurrency}`);
      } catch (err) {
        logger.error(`Error reducing pending balance for withdrawal:`, err);
      }
    }

    // Handle successful ONRAMP/OFFRAMP
    if (['ONRAMP', 'OFFRAMP'].includes(type) && status === 'SUCCESSFUL') {
      try {
        await Transaction.updateSwapStatus(swapDetails.swapId, 'SUCCESSFUL');
        logger.info(`Updated all swap transactions with swapId ${swapDetails.swapId} to SUCCESSFUL`);
        
        if (type === 'ONRAMP') {
          const deductAmount = Math.abs(parseFloat(amount));
          const totalReservedAmount = deductAmount + (swapDetails.swapFee || 0);
          await updateUserBalance(user, normalizedCurrency, -deductAmount);
          await updatePendingBalance(user, normalizedCurrency, totalReservedAmount);
          logger.info(`ONRAMP: Deducted ${deductAmount} ${normalizedCurrency} from balance and reduced pending by ${totalReservedAmount}`);
        } else if (type === 'OFFRAMP') {
          const addAmount = Math.abs(parseFloat(amount));
          await updateUserBalance(user, normalizedCurrency, addAmount);
          logger.info(`OFFRAMP: Added ${addAmount} ${normalizedCurrency} to user balance`);
        }
      } catch (err) {
        logger.error(`Error handling successful ONRAMP/OFFRAMP balance update for user ${user._id}:`, err);
      }
    }

    // Update portfolio for final states
    const shouldUpdatePortfolio =
      (type === 'DEPOSIT' && status === 'CONFIRMED') ||
      (type === 'WITHDRAWAL' && status === 'SUCCESSFUL') ||
      (['ONRAMP', 'OFFRAMP'].includes(type) && status === 'SUCCESSFUL');

    if (shouldUpdatePortfolio) {
      try {
        const updatedUser = await updateUserPortfolioBalance(user._id);
        return res.status(200).json({ 
          success: true, 
          transaction, 
          user: updatedUser,
          ...(swapDetails && { swapDetails: swapDetails })
        });
      } catch (err) {
        logger.error('Portfolio update failed:', err);
        return res.status(200).json({
          success: true,
          transaction,
          warning: 'Transaction saved but portfolio update failed',
        });
      }
    }

    return res.status(200).json({ 
      success: true, 
      transaction,
      ...(swapDetails && { swapDetails: swapDetails })
    });
  } catch (error) {
    logger.error('Webhook processing failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/swap-status', webhookAuth, async (req, res) => {
  try {
    const { swapId, status, metadata } = req.body;

    if (!swapId || !status) {
      return res.status(400).json({ error: 'Missing required fields: swapId, status' });
    }

    logger.info('Swap Status Update Webhook:', { swapId, status, metadata });

    // Update all transactions related to this swap
    const updateResult = await Transaction.updateSwapStatus(swapId, status);
    
    if (updateResult.modifiedCount === 0) {
      logger.warn(`No transactions found for swapId: ${swapId}`);
      return res.status(404).json({ error: 'Swap not found' });
    }

    // Handle failed CRYPTO_TO_CRYPTO swaps
    if (['FAILED', 'REJECTED'].includes(status)) {
      const { swapOutTransaction } = await Transaction.getSwapTransactions(swapId);
      if (swapOutTransaction && swapOutTransaction.swapDetails.swapType === 'CRYPTO_TO_CRYPTO') {
        const userId = swapOutTransaction.userId;
        const sourceCurrency = swapOutTransaction.currency;
        const sourceAmount = Math.abs(swapOutTransaction.amount);
        const swapFee = swapOutTransaction.swapDetails?.swapFee || 0;
        
        await releaseReservedBalance(userId, sourceCurrency, sourceAmount + swapFee);
        logger.info(`Released reserved balance for failed CRYPTO_TO_CRYPTO swap: ${sourceAmount + swapFee} ${sourceCurrency}`, { swapId });
      }
    }

    // Update portfolio for final states
    if (['SUCCESSFUL', 'FAILED', 'REJECTED'].includes(status)) {
      const { swapOutTransaction } = await Transaction.getSwapTransactions(swapId);
      if (swapOutTransaction) {
        await updateUserPortfolioBalance(swapOutTransaction.userId);
      }
    }

    logger.info(`Updated ${updateResult.modifiedCount} transactions for swapId ${swapId} to status ${status}`);

    return res.status(200).json({ 
      success: true, 
      swapId, 
      status, 
      updatedTransactions: updateResult.modifiedCount 
    });

  } catch (error) {
    logger.error('Swap status webhook processing failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;