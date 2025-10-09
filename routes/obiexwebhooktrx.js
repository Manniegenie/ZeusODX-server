const express = require('express');
const router = express.Router();
const User = require('../models/user');
const Transaction = require('../models/transaction');
const webhookAuth = require('../auth/webhookauth');
const logger = require('../utils/logger');
const { sendDepositEmail } = require('../services/EmailService');
const { 
  sendDepositNotification, 
  sendWithdrawalNotification 
} = require('../services/notificationService');

// Supported tokens - aligned with user schema (DOGE REMOVED)
const SUPPORTED_TOKENS = {
  BTC: 'btc',
  ETH: 'eth', 
  SOL: 'sol',
  USDT: 'usdt',
  USDC: 'usdc',
  BNB: 'bnb',
  MATIC: 'matic',
  AVAX: 'avax',
  NGNB: 'ngnb'
};

/**
 * Update user balance directly for deposits
 * @param {String} userId - User ID
 * @param {String} currency - Currency code
 * @param {Number} amount - Amount to add
 * @returns {Promise<Object>} Updated user
 */
async function updateUserBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number') {
    throw new Error('Invalid parameters for balance update');
  }
  
  try {
    const currencyUpper = currency.toUpperCase();
    
    // Validate currency is supported
    if (!SUPPORTED_TOKENS[currencyUpper]) {
      throw new Error(`Unsupported currency: ${currencyUpper}`);
    }
    
    // Map currency to correct balance field
    const currencyLower = SUPPORTED_TOKENS[currencyUpper];
    const balanceField = `${currencyLower}Balance`;
    
    // Build update object
    const updateFields = {
      $inc: {
        [balanceField]: amount
      },
      $set: {
        lastBalanceUpdate: new Date()
      }
    };
    
    const user = await User.findByIdAndUpdate(
      userId, 
      updateFields, 
      { new: true, runValidators: true }
    );
    
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    
    logger.info(`Updated balance for user ${userId}: ${amount > 0 ? '+' : ''}${amount} ${currencyUpper}`);
    
    return user;
  } catch (error) {
    logger.error(`Failed to update balance for user ${userId}`, { 
      currency, 
      amount, 
      error: error.message 
    });
    throw error;
  }
}

/**
 * Reserve user balance for pending transactions
 * @param {String} userId - User ID
 * @param {String} currency - Currency code  
 * @param {Number} amount - Amount to reserve
 * @returns {Promise<Object>} Updated user
 */
async function reserveUserBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number' || amount <= 0) {
    throw new Error('Invalid parameters for balance reservation');
  }
  
  try {
    const currencyUpper = currency.toUpperCase();
    
    // Validate currency is supported
    if (!SUPPORTED_TOKENS[currencyUpper]) {
      throw new Error(`Unsupported currency: ${currencyUpper}`);
    }
    
    // Map currency to correct pending balance field
    const currencyLower = SUPPORTED_TOKENS[currencyUpper];
    const pendingBalanceKey = `${currencyLower}PendingBalance`;
    
    const update = { 
      $inc: { [pendingBalanceKey]: amount },
      $set: { lastBalanceUpdate: new Date() }
    };
    
    const user = await User.findByIdAndUpdate(
      userId, 
      update, 
      { new: true, runValidators: true }
    );
    
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    
    logger.info(`Reserved ${amount} ${currencyUpper} for user ${userId}`);
    return user;
  } catch (error) {
    logger.error(`Failed to reserve balance for user ${userId}`, { 
      currency, 
      amount, 
      error: error.message 
    });
    throw error;
  }
}

/**
 * Release reserved user balance
 * @param {String} userId - User ID
 * @param {String} currency - Currency code
 * @param {Number} amount - Amount to release
 * @returns {Promise<Object>} Updated user
 */
async function releaseReservedBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number' || amount <= 0) {
    throw new Error('Invalid parameters for balance release');
  }
  
  try {
    const currencyUpper = currency.toUpperCase();
    
    // Validate currency is supported
    if (!SUPPORTED_TOKENS[currencyUpper]) {
      throw new Error(`Unsupported currency: ${currencyUpper}`);
    }
    
    // Map currency to correct pending balance field
    const currencyLower = SUPPORTED_TOKENS[currencyUpper];
    const pendingBalanceKey = `${currencyLower}PendingBalance`;
    
    const update = { 
      $inc: { [pendingBalanceKey]: -amount },
      $set: { lastBalanceUpdate: new Date() }
    };
    
    const user = await User.findByIdAndUpdate(
      userId, 
      update, 
      { new: true, runValidators: true }
    );
    
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    
    logger.info(`Released ${amount} ${currencyUpper} for user ${userId}`);
    return user;
  } catch (error) {
    logger.error(`Failed to release reserved balance for user ${userId}`, { 
      currency, 
      amount, 
      error: error.message 
    });
    throw error;
  }
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
    } = body;

    // Validate required fields
    const requiredFields = { type, currency, amount, transactionId, status, reference };
    const missingFields = Object.keys(requiredFields).filter(key => !requiredFields[key]);
    
    // Add network to required fields for deposits
    if (type === 'DEPOSIT' && (!address || !network)) {
      missingFields.push('address', 'network');
    }

    if (missingFields.length > 0) {
      logger.warn('Webhook Transaction - Missing Fields:', {
        type: !!type,
        currency: !!currency,
        amount: !!amount,
        transactionId: !!transactionId,
        status: !!status,
        reference: !!reference,
        address: !!address,
        network: !!network,
      });
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate positive amounts
    if (parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }

    const normalizedCurrency = currency.trim().toUpperCase();

    // Validate currency is supported
    if (!SUPPORTED_TOKENS[normalizedCurrency]) {
      logger.warn(`Unsupported currency: ${normalizedCurrency}`);
      return res.status(400).json({ error: `Unsupported currency: ${normalizedCurrency}` });
    }

    let user;
    let transaction;
    
    if (type === 'DEPOSIT') {
      // Find user by correct wallet key structure
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

    let updatedUser = user;

    // For confirmed deposits, update balance BEFORE saving transaction
    if (type === 'DEPOSIT' && status === 'CONFIRMED') {
      try {
        updatedUser = await updateUserBalance(user._id, normalizedCurrency, parseFloat(amount));
        logger.info(`Credited ${amount} ${normalizedCurrency} to user ${user._id} for confirmed deposit`);
        
        // Send deposit notification email
        try {
          if (user.email) {
            await sendDepositEmail(
              user.email,
              user.firstName || user.username || 'User',
              parseFloat(amount),
              normalizedCurrency,
              reference
            );
            logger.info(`Deposit notification email sent to ${user.email} for ${amount} ${normalizedCurrency}`);
          } else {
            logger.warn(`No email address found for user ${user._id}, skipping deposit notification email`);
          }
        } catch (emailError) {
          // Log email error but don't fail the transaction
          logger.error(`Failed to send deposit notification email to user ${user._id}:`, emailError);
        }

        // Send deposit push notification
        try {
          const pushResult = await sendDepositNotification(
            user._id.toString(),
            parseFloat(amount),
            normalizedCurrency,
            'confirmed',
            {
              reference: reference,
              transactionId: transactionId,
              hash: hash
            }
          );
          
          if (pushResult.success) {
            logger.info(`Deposit push notification sent to user ${user._id} for ${amount} ${normalizedCurrency}`);
          } else if (!pushResult.skipped) {
            logger.warn(`Failed to send deposit push notification to user ${user._id}: ${pushResult.message}`);
          }
        } catch (pushError) {
          // Log push notification error but don't fail the transaction
          logger.error(`Error sending deposit push notification to user ${user._id}:`, pushError);
        }
      } catch (err) {
        logger.error(`Error crediting balance for confirmed deposit:`, err);
        return res.status(500).json({ 
          error: 'Failed to credit user balance',
          details: err.message 
        });
      }
    }

    // Only save transaction if balance update succeeded (or wasn't needed)
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

    // Handle withdrawal balance updates (after transaction is saved)
    if (type === 'WITHDRAWAL') {
      if (['FAILED', 'REJECTED'].includes(status)) {
        // Release reserved balance for failed/rejected withdrawals
        try {
          const totalReservedAmount = parseFloat(amount) + (transaction.fee || 0);
          await releaseReservedBalance(user._id, normalizedCurrency, totalReservedAmount);
          logger.info(`Released reserved balance for failed/rejected withdrawal: ${totalReservedAmount} ${normalizedCurrency}`);

          // Send withdrawal failed push notification
          try {
            const pushResult = await sendWithdrawalNotification(
              user._id.toString(),
              parseFloat(amount),
              normalizedCurrency,
              'failed',
              {
                reference: reference,
                transactionId: transactionId,
                reason: narration || 'Withdrawal failed'
              }
            );
            
            if (pushResult.success) {
              logger.info(`Withdrawal failed push notification sent to user ${user._id}`);
            } else if (!pushResult.skipped) {
              logger.warn(`Failed to send withdrawal failed push notification to user ${user._id}: ${pushResult.message}`);
            }
          } catch (pushError) {
            logger.error(`Error sending withdrawal failed push notification to user ${user._id}:`, pushError);
          }
        } catch (err) {
          logger.error(`Error releasing reserved balance for failed withdrawal:`, err);
        }
      } else if (status === 'SUCCESSFUL') {
        // Reduce pending balance for successful withdrawals
        try {
          const currencyLower = SUPPORTED_TOKENS[normalizedCurrency];
          const pendingBalanceField = `${currencyLower}PendingBalance`;
          
          const totalReservedAmount = parseFloat(amount) + (transaction.fee || 0);
          let newPendingBalance = Math.max(0, (user[pendingBalanceField] || 0) - totalReservedAmount);
          
          updatedUser = await User.findByIdAndUpdate(
            user._id,
            { 
              [pendingBalanceField]: newPendingBalance,
              lastBalanceUpdate: new Date()
            },
            { new: true, runValidators: true }
          );

          logger.info(`Reduced user ${user._id} pending balance field ${pendingBalanceField} by ${totalReservedAmount} (amount: ${amount} + fee: ${transaction.fee || 0}). New value: ${newPendingBalance}`);

          // Send withdrawal completed push notification
          try {
            const pushResult = await sendWithdrawalNotification(
              user._id.toString(),
              parseFloat(amount),
              normalizedCurrency,
              'completed',
              {
                reference: reference,
                transactionId: transactionId,
                hash: hash,
                fee: transaction.fee || 0
              }
            );
            
            if (pushResult.success) {
              logger.info(`Withdrawal completed push notification sent to user ${user._id} for ${amount} ${normalizedCurrency}`);
            } else if (!pushResult.skipped) {
              logger.warn(`Failed to send withdrawal completed push notification to user ${user._id}: ${pushResult.message}`);
            }
          } catch (pushError) {
            logger.error(`Error sending withdrawal completed push notification to user ${user._id}:`, pushError);
          }
        } catch (err) {
          logger.error(`Error reducing pending balance for user ${user._id}:`, err);
        }
      }
    }

    return res.status(200).json({ 
      success: true, 
      transaction,
      user: updatedUser
    });

  } catch (error) {
    logger.error('Webhook processing failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;