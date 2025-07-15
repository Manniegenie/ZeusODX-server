// routes/webhookTransaction.js

const express = require('express');
const router = express.Router();
const User = require('../models/user');
const Transaction = require('../models/transaction');
const { updateUserPortfolioBalance, releaseReservedBalance } = require('../services/portfolio');
const webhookAuth = require('../auth/webhookauth');
const logger = require('../utils/logger');


// Map currency code → the corresponding PendingBalance field on User
const PENDING_BALANCE_FIELDS = {
  BTC:  'btcPendingBalance',
  ETH:  'ethPendingBalance',
  SOL:  'solPendingBalance',
  USDT: 'usdtPendingBalance',
  USDC: 'usdcPendingBalance',
  BNB:  'bnbPendingBalance',
  DOGE: 'dogePendingBalance',
  MATIC:'maticPendingBalance',
  AVAX: 'avaxPendingBalance',
  NGNZ: 'ngnzPendingBalance',
};

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
      network,
      narration,
      source,
      fee
    } = body;

    // required‐field check
    const reqFields = { type, currency, amount, transactionId, status, reference };
    const missing = Object.entries(reqFields)
      .filter(([, v]) => v == null || v === '')
      .map(([k]) => k);
    if (type === 'DEPOSIT' && !address) missing.push('address');
    if (missing.length) {
      logger.warn('Missing required fields:', missing);
      return res.status(400).json({ error: 'Missing required fields: ' + missing.join(', ') });
    }

    const curr = currency.trim().toUpperCase();
    let user, transaction;

    if (type === 'DEPOSIT') {
      // find user by wallet address
      const walletKey = `${curr}_${(network||'').trim().toUpperCase()}`;
      user = await User.findOne({ [`wallets.${walletKey}.address`]: address });
    }
    else if (type === 'WITHDRAWAL') {
      transaction = await Transaction.findOne({ obiexTransactionId: transactionId });
      if (!transaction) {
        logger.warn(`Withdrawal tx not found: ${transactionId}`);
        return res.status(404).json({ error: 'Transaction not found' });
      }
      user = await User.findById(transaction.userId);
    }

    if (!user) {
      logger.warn(`No user for ${type}: ${type==='DEPOSIT'?address:transactionId}`);
      return res.status(404).json({ error: 'User not found' });
    }

    // build payload
    const payload = {
      userId: user._id,
      type,
      currency: curr,
      amount: parseFloat(amount),
      status,
      reference,
      obiexTransactionId: transactionId,
      updatedAt: new Date()
    };
    if (hash)      payload.hash = hash;
    if (network)   payload.network = network;
    if (narration) payload.narration = narration;
    if (source)    payload.source = source;
    if (createdAt) payload.createdAt = new Date(createdAt);

    // upsert / update transaction
    if (type === 'WITHDRAWAL' && transaction) {
      Object.assign(transaction, payload);
      await transaction.save();
      logger.info(`Updated withdrawal tx ${transaction._id}`);
    } else {
      transaction = await Transaction.findOneAndUpdate(
        { obiexTransactionId: transactionId },
        { $set: payload },
        { upsert: true, new: true }
      );
      logger.info(`Deposit tx ${transaction.isNew ? 'created' : 'updated'}: ${transaction._id}`);
    }

    // handle reserved balance on failure/rejection
    if (type === 'WITHDRAWAL' && ['FAILED', 'REJECTED'].includes(status)) {
      const total = parseFloat(amount) + (fee || 0);
      await releaseReservedBalance(user._id, curr, total);
      logger.info(`Released reserved ${curr}: ${total}`);
    }

    // on successful withdrawal, decrement the pending balance field
    if (type === 'WITHDRAWAL' && status === 'SUCCESSFUL') {
      const field = PENDING_BALANCE_FIELDS[curr];
      if (field) {
        const total = parseFloat(amount) + (fee || 0);
        user[field] = Math.max(0, (user[field] || 0) - total);
        await user.save();
        logger.info(`Reduced ${field} by ${total}, new ${user[field]}`);
      } else {
        logger.warn(`No pendingBalance field mapped for currency ${curr}`);
      }
    }

    // decide whether to recalc portfolio
    const shouldRecalc =
      (type === 'DEPOSIT'    && status === 'CONFIRMED') ||
      (type === 'WITHDRAWAL' && status === 'SUCCESSFUL');

    if (shouldRecalc) {
      try {
        const updatedUser = await updateUserPortfolioBalance(user._id);
        return res.status(200).json({ success: true, transaction, user: updatedUser });
      } catch (err) {
        logger.error('Portfolio recalc failed:', err);
        return res.status(200).json({
          success: true,
          transaction,
          warning: 'Saved but portfolio update failed'
        });
      }
    }

    return res.status(200).json({ success: true, transaction });

  } catch (err) {
    logger.error('Webhook processing failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
