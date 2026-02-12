const express = require('express');
const router = express.Router();
const User = require('../models/user');
const Transaction = require('../models/transaction');
const webhookAuth = require('../auth/webhookauth');
const logger = require('../utils/logger');
const { sendDepositEmail, sendWithdrawalEmail } = require('../services/EmailService');
const { 
  sendDepositNotification, 
  sendWithdrawalNotification 
} = require('../services/notificationService');

// Supported tokens - aligned with user schema balance fields
const SUPPORTED_TOKENS = {
  BTC: 'btc',
  ETH: 'eth', 
  SOL: 'sol',
  USDT: 'usdt',
  USDC: 'usdc',
  BNB: 'bnb',
  MATIC: 'matic',
  TRX: 'trx',      // Added TRX
  NGNZ: 'ngnz',
  NGNX: 'ngnz'     // Obiex uses NGNX, map to NGNZ for our app
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
      // Bank withdrawal fields (for NGNX/NGNZ withdrawals)
      accountNumber,
      accountName,
      bankCode,
      bankName,
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

    let normalizedCurrency = currency.trim().toUpperCase();
    
    // Map Obiex NGNX to our app's NGNZ
    if (normalizedCurrency === 'NGNX') {
      normalizedCurrency = 'NGNZ';
      logger.info(`Mapped Obiex currency NGNX to NGNZ for transaction ${transactionId}`);
    }

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
      // For NGNZ withdrawals, also try finding by reference or ngnzWithdrawal.obiex.id
      transaction = await Transaction.findOne({ 
        $or: [
          { obiexTransactionId: transactionId },
          { 'ngnzWithdrawal.obiex.id': transactionId },
          { reference: reference }
        ]
      });
      
      if (!transaction) {
        logger.warn(`No transaction found for obiexTransactionId: ${transactionId}`, {
          searchedTransactionId: transactionId,
          webhookReference: reference,
          currency: normalizedCurrency,
        });
        return res.status(404).json({ error: 'Transaction not found' });
      }
      
      logger.info(`Found withdrawal transaction: ${transaction._id} with obiexTransactionId: ${transaction.obiexTransactionId}, current status: ${transaction.status}`);
      
      // Capture original status for idempotency checks (before it gets updated)
      transaction._originalStatus = transaction.status;
      
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
    
    // Note: For NGNZ withdrawals, we manually update the transaction object below
    // This updatePayload building is kept for potential future use but not currently used for NGNZ withdrawals

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

        // Send deposit push notification (only on CONFIRMED status)
        try {
          const pushResult = await sendDepositNotification(
            user._id.toString(),
            parseFloat(amount),
            normalizedCurrency,
            'confirmed',
            {
              reference: reference,
              transactionId: transactionId,
              hash: hash,
              network: network
            }
          );
          
          if (pushResult.success) {
            logger.info(`Deposit confirmed push notification sent to user ${user._id} for ${amount} ${normalizedCurrency}`, {
              userId: user._id,
              amount: parseFloat(amount),
              currency: normalizedCurrency,
              network: network,
              transactionId: transactionId,
              via: pushResult.via
            });
          } else if (!pushResult.skipped) {
            logger.warn(`Failed to send deposit confirmed push notification to user ${user._id}: ${pushResult.message}`, {
              userId: user._id,
              amount: parseFloat(amount),
              currency: normalizedCurrency,
              error: pushResult.message
            });
          } else {
            logger.info(`Deposit notification skipped for user ${user._id} (no push token registered)`);
          }
        } catch (pushError) {
          // Log push notification error but don't fail the transaction
          logger.error(`Error sending deposit confirmed push notification to user ${user._id}:`, {
            userId: user._id,
            amount: parseFloat(amount),
            currency: normalizedCurrency,
            error: pushError.message,
            stack: pushError.stack
          });
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
      // For NGNZ withdrawals, use $set to properly update nested fields
      if (normalizedCurrency === 'NGNZ' && transaction.isNGNZWithdrawal) {
        // Update top-level fields
        transaction.status = status;
        transaction.updatedAt = new Date();
        transaction.obiexTransactionId = transactionId;
        if (hash) transaction.hash = hash;
        if (narration) transaction.narration = narration;
        
        // Update nested ngnzWithdrawal fields
        if (!transaction.ngnzWithdrawal) {
          transaction.ngnzWithdrawal = {};
        }
        if (!transaction.ngnzWithdrawal.obiex) {
          transaction.ngnzWithdrawal.obiex = {};
        }
        transaction.ngnzWithdrawal.obiex.id = transactionId;
        transaction.ngnzWithdrawal.obiex.reference = reference;
        transaction.ngnzWithdrawal.obiex.status = status;
        
        // Update bank details if provided
        if (accountNumber || accountName || bankCode || bankName) {
          if (!transaction.ngnzWithdrawal.destination) {
            transaction.ngnzWithdrawal.destination = {};
          }
          if (accountNumber) {
            const maskAccountNumber = (acct) => {
              if (!acct) return '';
              const s = String(acct).replace(/\s+/g, '');
              return s.length <= 4 ? s : `${s.slice(0, 2)}****${s.slice(-2)}`;
            };
            transaction.ngnzWithdrawal.destination.accountNumberMasked = maskAccountNumber(accountNumber);
            transaction.ngnzWithdrawal.destination.accountNumberLast4 = String(accountNumber).slice(-4);
          }
          if (accountName) transaction.ngnzWithdrawal.destination.accountName = accountName;
          if (bankCode) transaction.ngnzWithdrawal.destination.bankCode = bankCode;
          if (bankName) transaction.ngnzWithdrawal.destination.bankName = bankName;
        }
        
        // Update timestamps based on status
        if (status === 'SUCCESSFUL') {
          transaction.completedAt = new Date();
          transaction.ngnzWithdrawal.completedAt = new Date();
        } else if (['FAILED', 'REJECTED'].includes(status)) {
          transaction.failedAt = new Date();
          transaction.ngnzWithdrawal.failedAt = new Date();
          if (narration) transaction.ngnzWithdrawal.failureReason = narration;
        }
        
        await transaction.save();
        logger.info(`Updated NGNZ withdrawal transaction: ${transaction._id}, status: ${status}`);
      } else {
        // For other withdrawal types, use standard update
        Object.assign(transaction, updatePayload);
        await transaction.save();
        logger.info(`Updated existing withdrawal transaction: ${transaction._id}`);
      }
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
        // Check if already processed to prevent double refunds (idempotency)
        // Use original status captured before transaction was updated
        const originalStatus = transaction._originalStatus || transaction.status;
        const wasAlreadyFailed = ['FAILED', 'REJECTED'].includes(originalStatus);
        
        // Handle NGNZ withdrawals - refund directly to ngnzBalance
        if (normalizedCurrency === 'NGNZ' && transaction.isNGNZWithdrawal) {
          if (!wasAlreadyFailed) {
            try {
              // Get the amount that was originally deducted
              const refundAmount = transaction.ngnzWithdrawal?.requestedAmount || Math.abs(transaction.amount);
              
              // Refund to user's ngnzBalance
              updatedUser = await User.findByIdAndUpdate(
                user._id,
                { 
                  $inc: { ngnzBalance: refundAmount },
                  $set: { lastBalanceUpdate: new Date() }
                },
                { new: true, runValidators: true }
              );
              
              logger.info(`Refunded ${refundAmount} NGNZ to user ${user._id} for failed withdrawal (transaction: ${transaction._id})`);
            } catch (refundError) {
              logger.error(`Error refunding NGNZ balance for failed withdrawal (transaction: ${transaction._id}):`, refundError);
              // Don't throw - log error but continue with notification
            }
          } else {
            logger.info(`NGNZ withdrawal transaction ${transaction._id} already marked as FAILED/REJECTED, skipping refund to prevent double processing`);
          }
        } else {
          // Handle crypto withdrawals - refund directly to main balance (same as NGNZ)
          if (!wasAlreadyFailed) {
            try {
              // Get the amount that was originally deducted from main balance
              // For crypto withdrawals, reserveUserBalanceInternal deducts 'amount' from main balance
              const refundAmount = Math.abs(transaction.amount || parseFloat(amount));
              
              // Get currency balance field names
              const currencyLower = SUPPORTED_TOKENS[normalizedCurrency];
              const balanceField = `${currencyLower}Balance`;
              const pendingBalanceField = `${currencyLower}PendingBalance`;
              
              // Refund to main balance and reduce pending balance atomically
              // This moves the reserved amount back from pending to main balance
              updatedUser = await User.findByIdAndUpdate(
                user._id,
                { 
                  $inc: { 
                    [balanceField]: refundAmount,
                    [pendingBalanceField]: -refundAmount
                  },
                  $set: { lastBalanceUpdate: new Date() }
                },
                { new: true, runValidators: true }
              );
              
              logger.info(`Refunded ${refundAmount} ${normalizedCurrency} to user ${user._id} for failed withdrawal (transaction: ${transaction._id})`);
            } catch (refundError) {
              logger.error(`Error refunding crypto balance for failed withdrawal (transaction: ${transaction._id}):`, refundError);
              // Don't throw - log error but continue with notification
            }
          } else {
            logger.info(`Crypto withdrawal transaction ${transaction._id} already marked as FAILED/REJECTED, skipping refund to prevent double processing`);
          }
        }

        // Send withdrawal failed push notification (for all withdrawal types)
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
      } else if (status === 'SUCCESSFUL') {
        // For NGNZ withdrawals, just send email - balance already deducted, no pending balance
        if (normalizedCurrency === 'NGNZ' && transaction.isNGNZWithdrawal) {
          try {
            const withdrawalAmount = Math.abs(transaction.amount || parseFloat(amount));
            const userName = user.firstName || user.username || 'User';
            
            await sendWithdrawalEmail(
              user.email,
              userName,
              withdrawalAmount,
              'NGN',
              transaction.reference || reference
            );
            logger.info(`NGNZ withdrawal confirmation email sent to ${user.email} for ${withdrawalAmount} NGN`);
          } catch (emailError) {
            // Log email error but don't fail the transaction
            logger.error(`Failed to send NGNZ withdrawal confirmation email to user ${user._id}:`, emailError);
          }
        } else {
          // Reduce pending balance for successful crypto withdrawals (legacy behavior)
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
          } catch (err) {
            logger.error(`Error reducing pending balance for user ${user._id}:`, err);
          }
        }

        // Send withdrawal completed push notification (for all withdrawal types)
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