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
      // NEW: Swap-specific fields
      swapDetails,
      relatedTransactionId,
      metadata
    } = body;

    // Validate required fields based on transaction type
    const requiredFields = { type, currency, amount, transactionId, status, reference };
    const missingFields = Object.keys(requiredFields).filter(key => !requiredFields[key]);
    
    // Address is required for deposits but not for swaps
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
    
    // Find user based on transaction type
    if (type === 'DEPOSIT') {
      // Find user by wallet address for deposits
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
      // Find transaction by obiexTransactionId for all internal operations
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

    // Add optional fields
    if (hash) updatePayload.hash = hash;
    if (network) updatePayload.network = network;
    if (narration) updatePayload.narration = narration;
    if (source) updatePayload.source = source;
    if (createdAt) updatePayload.createdAt = new Date(createdAt);
    if (metadata) updatePayload.metadata = metadata;
    if (relatedTransactionId) updatePayload.relatedTransactionId = relatedTransactionId;

    // Handle swap-specific data
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

    // Update the existing transaction or create new one
    if (['WITHDRAWAL', 'SWAP_IN', 'SWAP_OUT', 'ONRAMP', 'OFFRAMP'].includes(type) && transaction) {
      // Update existing transaction
      Object.assign(transaction, updatePayload);
      await transaction.save();
      logger.info(`Updated existing ${type} transaction: ${transaction._id}`);
    } else {
      // For deposits, use findOneAndUpdate with upsert
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

    // Handle swap transaction failures
    if (['SWAP_IN', 'SWAP_OUT', 'ONRAMP', 'OFFRAMP'].includes(type) && ['FAILED', 'REJECTED'].includes(status)) {
      // For failed swaps, we need to handle both sides of the transaction
      if (swapDetails && swapDetails.swapId) {
        // Update all related swap transactions to failed status
        await Transaction.updateSwapStatus(swapDetails.swapId, status);
        logger.info(`Updated all swap transactions with swapId ${swapDetails.swapId} to ${status}`);
        
        // Release reserved balance for SWAP_OUT/ONRAMP (the source currency being spent)
        if (type === 'SWAP_OUT' || type === 'ONRAMP') {
          const releaseAmount = Math.abs(parseFloat(amount)) + (swapDetails.swapFee || 0);
          await releaseReservedBalance(user._id, normalizedCurrency, releaseAmount);
          logger.info(`Released reserved balance for failed ${type}: ${releaseAmount} ${normalizedCurrency}`);
        }
      }
    }

    // Reduce user's pending balance on SUCCESSFUL withdrawal
    if (type === 'WITHDRAWAL' && status === 'SUCCESSFUL') {
      try {
        // Determine the field name for pending balance based on currency
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
        } else if (currencyKey.startsWith('matic')) {
          pendingBalanceField = 'maticPendingBalance';
        } else if (currencyKey.startsWith('avax')) {
          pendingBalanceField = 'avaxPendingBalance';
        } else if (currencyKey.startsWith('ngnz')) {
          pendingBalanceField = 'ngnzPendingBalance';
        } else {
          logger.warn(`Unknown currency for pending balance adjustment: ${normalizedCurrency}`);
          pendingBalanceField = null;
        }

        if (pendingBalanceField) {
          // Get the total amount that was reserved (withdrawal amount + fee)
          const totalReservedAmount = parseFloat(amount) + (transaction.fee || 0);
          
          // Calculate new pending balance safely, ensure no negatives
          let newPendingBalance = Math.max(0, (user[pendingBalanceField] || 0) - totalReservedAmount);

          // Update user document
          user[pendingBalanceField] = newPendingBalance;
          await user.save();

          logger.info(`Reduced user ${user._id} pending balance field ${pendingBalanceField} by ${totalReservedAmount} (amount: ${amount} + fee: ${transaction.fee || 0}). New value: ${newPendingBalance}`);
        }
      } catch (err) {
        logger.error(`Error reducing pending balance for user ${user._id}:`, err);
        // Do NOT block the webhook response; just log the error
      }
    }

    // Handle successful swap completion
    if (['SWAP_IN', 'SWAP_OUT', 'ONRAMP', 'OFFRAMP'].includes(type) && status === 'SUCCESSFUL') {
      try {
        if (swapDetails && swapDetails.swapId) {
          // Update all related swap transactions to successful
          await Transaction.updateSwapStatus(swapDetails.swapId, 'SUCCESSFUL');
          logger.info(`Updated all swap transactions with swapId ${swapDetails.swapId} to SUCCESSFUL`);
          
          // For SWAP_OUT/ONRAMP (source currency), reduce pending balance
          if (type === 'SWAP_OUT' || type === 'ONRAMP') {
            const currencyKey = normalizedCurrency.toLowerCase();
            const pendingBalanceField = `${currencyKey}PendingBalance`;
            
            if (user[pendingBalanceField] !== undefined) {
              const totalReservedAmount = Math.abs(parseFloat(amount)) + (swapDetails.swapFee || 0);
              const newPendingBalance = Math.max(0, (user[pendingBalanceField] || 0) - totalReservedAmount);
              
              user[pendingBalanceField] = newPendingBalance;
              await user.save();
              
              logger.info(`Reduced user ${user._id} pending balance for successful ${type}: ${pendingBalanceField} by ${totalReservedAmount}. New value: ${newPendingBalance}`);
            }
          }
        }
      } catch (err) {
        logger.error(`Error handling successful swap for user ${user._id}:`, err);
        // Do NOT block the webhook response; just log the error
      }
    }

    // Update portfolio for final states
    const shouldUpdatePortfolio =
      (type === 'DEPOSIT' && status === 'CONFIRMED') ||
      (type === 'WITHDRAWAL' && status === 'SUCCESSFUL') ||
      (['SWAP_IN', 'SWAP_OUT', 'ONRAMP', 'OFFRAMP'].includes(type) && status === 'SUCCESSFUL');

    if (shouldUpdatePortfolio) {
      try {
        const updatedUser = await updateUserPortfolioBalance(user._id);
        
        // For successful swaps, also log the swap completion
        if (['SWAP_IN', 'SWAP_OUT', 'ONRAMP', 'OFFRAMP'].includes(type) && status === 'SUCCESSFUL' && swapDetails) {
          logger.info('Swap completed successfully', {
            userId: user._id,
            swapId: swapDetails.swapId,
            type: swapDetails.swapType,
            sourceCurrency: swapDetails.sourceCurrency,
            targetCurrency: swapDetails.targetCurrency,
            sourceAmount: swapDetails.sourceAmount,
            targetAmount: swapDetails.targetAmount,
            exchangeRate: swapDetails.exchangeRate
          });
        }
        
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

// NEW: Webhook endpoint specifically for swap status updates
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

    // Get the updated transactions
    const { swapOutTransaction, swapInTransaction } = await Transaction.getSwapTransactions(swapId);
    
    if (swapOutTransaction && swapInTransaction) {
      const user = await User.findById(swapOutTransaction.userId);
      
      if (user) {
        // Handle failed swaps
        if (['FAILED', 'REJECTED'].includes(status)) {
          const sourceCurrency = swapOutTransaction.currency;
          const sourceAmount = Math.abs(swapOutTransaction.amount);
          const swapFee = swapOutTransaction.swapDetails?.swapFee || 0;
          
          await releaseReservedBalance(user._id, sourceCurrency, sourceAmount + swapFee);
          logger.info(`Released reserved balance for failed swap: ${sourceAmount + swapFee} ${sourceCurrency}`);
        }
        
        // Update portfolio for final states
        if (['SUCCESSFUL', 'FAILED', 'REJECTED'].includes(status)) {
          await updateUserPortfolioBalance(user._id);
        }
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