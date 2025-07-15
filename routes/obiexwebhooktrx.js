const express = require('express');
const router = express.Router();
const User = require('../models/user');
const Transaction = require('../models/transaction');
const { updateUserPortfolioBalance, releaseReservedBalance } = require('../services/portfolio');
const webhookAuth = require('../auth/webhookauth');
const logger = require('../utils/logger');

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
    } = body;

    // Validate required fields
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
      // 🔧 FIXED: Find user by correct wallet key structure
      const walletKey = `${normalizedCurrency}_${network.trim().toUpperCase()}`;
      logger.info(`Looking for user with address ${address} in wallets.${walletKey}.address`);
      user = await User.findOne({
        [`wallets.${walletKey}.address`]: address,
      });
    } else if (type === 'WITHDRAWAL') {
      // Find transaction by obiexTransactionId
      transaction = await Transaction.findOne({ obiexTransactionId: transactionId });
      
      if (!transaction) {
        logger.warn(`No transaction found for obiexTransactionId: ${transactionId}`, {
          searchedTransactionId: transactionId,
          webhookReference: reference,
        });
        return res.status(404).json({ error: 'Transaction not found' });
      }
      
      logger.info(`Found withdrawal transaction: ${transaction._id} with obiexTransactionId: ${transaction.obiexTransactionId}, current status: ${transaction.status}`);
      user = await User.findById(transaction.userId);
    }

    if (!user) {
      logger.warn(`No user found for ${type === 'DEPOSIT' ? `address ${address}` : `transactionId ${transactionId}`}`);
      return res.status(404).json({ error: 'No user found' });
    }

    // Prepare transaction data
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

    // Update the existing transaction (for withdrawals) or create new (for deposits)
    if (type === 'WITHDRAWAL' && transaction) {
      // Update existing withdrawal transaction
      Object.assign(transaction, updatePayload);
      await transaction.save();
      logger.info(`Updated existing withdrawal transaction: ${transaction._id}`);
    } else {
      // For deposits, use findOneAndUpdate with upsert
      transaction = await Transaction.findOneAndUpdate(
        { obiexTransactionId: transactionId },
        { $set: updatePayload },
        { upsert: true, new: true }
      );
      logger.info(transaction.isNew ? 'New transaction created' : 'Transaction updated');
    }

    // Handle pending balance for withdrawals with FAILED or REJECTED
    if (type === 'WITHDRAWAL' && ['FAILED', 'REJECTED'].includes(status)) {
      await releaseReservedBalance(user._id, normalizedCurrency, parseFloat(amount) + (transaction.fee || 0));
      logger.info(`Released reserved balance for failed/rejected withdrawal: ${parseFloat(amount) + (transaction.fee || 0)} ${normalizedCurrency}`);
    }

    // Reduce user's pending balance on SUCCESSFUL withdrawal
    if (type === 'WITHDRAWAL' && status === 'SUCCESSFUL') {
      try {
        const currencyKey = normalizedCurrency.toLowerCase();
        let pendingBalanceField;

        if (currencyKey.startsWith('usdt')) {
          pendingBalanceField = 'usdtPendingBalance';
        } else if (currencyKey.startsWith('usdc')) {
          pendingBalanceField = 'usdcPendingBalance';
        } else if (currencyKey.startsWith('btc')) {
          pendingBalanceField = 'btcPendingBalance';
        } else if (currencyKey.startsWith('sol')) {
          pendingBalanceField = 'solPendingBalance';
        } else if (currencyKey.startsWith('eth')) {
          pendingBalanceField = 'ethPendingBalance';
        } else if (currencyKey.startsWith('bnb')) {
          pendingBalanceField = 'bnbPendingBalance';
        } else if (currencyKey.startsWith('doge')) {
          pendingBalanceField = 'dogePendingBalance';
        } else if (currencyKey.startsWith('matic')) {
          pendingBalanceField = 'maticPendingBalance';
        } else if (currencyKey.startsWith('avax')) {
          pendingBalanceField = 'avaxPendingBalance';
        } else {
          logger.warn(`Unknown currency for pending balance adjustment: ${normalizedCurrency}`);
          pendingBalanceField = null;
        }

        if (pendingBalanceField) {
          const totalReservedAmount = parseFloat(amount) + (transaction.fee || 0);
          let newPendingBalance = Math.max(0, (user[pendingBalanceField] || 0) - totalReservedAmount);
          user[pendingBalanceField] = newPendingBalance;
          await user.save();

          logger.info(`Reduced user ${user._id} pending balance field ${pendingBalanceField} by ${totalReservedAmount} (amount: ${amount} + fee: ${transaction.fee || 0}). New value: ${newPendingBalance}`);
        }
      } catch (err) {
        logger.error(`Error reducing pending balance for user ${user._id}:`, err);
      }
    }

    const shouldUpdatePortfolio =
      (type === 'DEPOSIT' && status === 'CONFIRMED') ||
      (type === 'WITHDRAWAL' && status === 'SUCCESSFUL');

    if (shouldUpdatePortfolio) {
      try {
        const updatedUser = await updateUserPortfolioBalance(user._id);
        return res.status(200).json({ success: true, transaction, user: updatedUser });
      } catch (err) {
        logger.error('Portfolio update failed:', err);
        return res.status(200).json({
          success: true,
          transaction,
          warning: 'Transaction saved but portfolio update failed',
        });
      }
    }

    return res.status(200).json({ success: true, transaction });
  } catch (error) {
    logger.error('Webhook processing failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;