const express = require('express');
const router = express.Router();
const Transaction = require('../models/transaction');
const User = require('../models/user');
const logger = require('../utils/logger');

/**
 * GET /admin/transaction/:transactionId
 * Get full transaction details by transaction ID
 */
router.get('/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;

    if (!transactionId) {
      return res.status(400).json({
        success: false,
        error: 'Transaction ID is required'
      });
    }

    // Find transaction by _id or reference or transactionId
    const transaction = await Transaction.findOne({
      $or: [
        { _id: transactionId },
        { reference: transactionId },
        { transactionId: transactionId },
        { obiexTransactionId: transactionId }
      ]
    })
      .populate('userId', 'firstname lastname email username phonenumber kycLevel kycStatus')
      .populate('recipientUserId', 'firstname lastname email username')
      .populate('senderUserId', 'firstname lastname email username')
      .populate('giftCardId')
      .lean();

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transaction not found'
      });
    }

    // Format transaction data for frontend
    const formattedTransaction = {
      ...transaction,
      id: transaction._id.toString(),
      user: transaction.userId ? {
        id: transaction.userId._id.toString(),
        name: `${transaction.userId.firstname || ''} ${transaction.userId.lastname || ''}`.trim(),
        email: transaction.userId.email,
        username: transaction.userId.username,
        phone: transaction.userId.phonenumber,
        kycLevel: transaction.userId.kycLevel,
        kycStatus: transaction.userId.kycStatus
      } : null,
      recipient: transaction.recipientUserId ? {
        id: transaction.recipientUserId._id.toString(),
        name: `${transaction.recipientUserId.firstname || ''} ${transaction.recipientUserId.lastname || ''}`.trim(),
        email: transaction.recipientUserId.email,
        username: transaction.recipientUserId.username
      } : transaction.recipientUsername ? {
        username: transaction.recipientUsername,
        fullName: transaction.recipientFullName
      } : null,
      sender: transaction.senderUserId ? {
        id: transaction.senderUserId._id.toString(),
        name: `${transaction.senderUserId.firstname || ''} ${transaction.senderUserId.lastname || ''}`.trim(),
        email: transaction.senderUserId.email,
        username: transaction.senderUserId.username
      } : transaction.senderUsername ? {
        username: transaction.senderUsername,
        fullName: transaction.senderFullName
      } : null,
      // Swap details
      swapDetails: transaction.fromCurrency ? {
        fromCurrency: transaction.fromCurrency,
        toCurrency: transaction.toCurrency,
        fromAmount: transaction.fromAmount,
        toAmount: transaction.toAmount,
        swapType: transaction.swapType,
        swapCategory: transaction.swapCategory,
        swapPair: transaction.swapPair,
        exchangeRate: transaction.exchangeRate,
        swapDirection: transaction.swapDirection
      } : null,
      // Withdrawal details
      withdrawalDetails: transaction.ngnzWithdrawal ? {
        bankName: transaction.ngnzWithdrawal.destination?.bankName,
        accountName: transaction.ngnzWithdrawal.destination?.accountName,
        accountNumberMasked: transaction.ngnzWithdrawal.destination?.accountNumberMasked,
        accountNumberLast4: transaction.ngnzWithdrawal.destination?.accountNumberLast4,
        requestedAmount: transaction.ngnzWithdrawal.requestedAmount,
        withdrawalFee: transaction.ngnzWithdrawal.withdrawalFee,
        amountSentToBank: transaction.ngnzWithdrawal.amountSentToBank,
        provider: transaction.ngnzWithdrawal.provider,
        obiexStatus: transaction.ngnzWithdrawal.obiex?.status,
        obiexReference: transaction.ngnzWithdrawal.obiex?.reference
      } : transaction.bankName ? {
        bankName: transaction.bankName,
        accountName: transaction.accountName,
        accountNumberMasked: transaction.accountNumberMasked
      } : null,
      // Gift card details
      giftCardDetails: transaction.giftCardId ? {
        cardType: transaction.cardType || transaction.giftCardId.cardType,
        cardFormat: transaction.cardFormat || transaction.giftCardId.cardFormat,
        cardRange: transaction.cardRange || transaction.giftCardId.cardRange,
        country: transaction.country || transaction.giftCardId.country,
        eCode: transaction.eCode || transaction.giftCardId.eCode,
        expectedRate: transaction.expectedRate || transaction.giftCardId.expectedRate,
        expectedAmountToReceive: transaction.expectedAmountToReceive || transaction.giftCardId.expectedAmountToReceive
      } : transaction.cardType ? {
        cardType: transaction.cardType,
        cardFormat: transaction.cardFormat,
        cardRange: transaction.cardRange,
        country: transaction.country
      } : null
    };

    logger.info('Transaction details retrieved', {
      transactionId,
      type: transaction.type,
      status: transaction.status
    });

    return res.status(200).json({
      success: true,
      data: {
        transaction: formattedTransaction
      }
    });

  } catch (error) {
    logger.error('Error retrieving transaction details', {
      error: error.message,
      stack: error.stack,
      transactionId: req.params.transactionId
    });
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

module.exports = router;
