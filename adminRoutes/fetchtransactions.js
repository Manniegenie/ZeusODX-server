const express = require('express');
const router = express.Router();
const User = require('../models/user');
const Transaction = require('../models/transaction');
const BillTransaction = require('../models/billstransaction');

router.post('/transactions-by-email', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const [transactions, bills] = await Promise.all([
      Transaction.find({ userId: user._id }).lean(),
      BillTransaction.find({ userId: user._id }).lean()
    ]);

    const statusMap = { 'completed': 'SUCCESSFUL', 'failed': 'FAILED', 'refunded': 'FAILED', 'initiated-api': 'PENDING', 'processing-api': 'PENDING' };

    const formattedTransactions = transactions.map(tx => {
      let displayAmount = tx.amount;
      if (tx.type === 'DEPOSIT' || tx.type === 'INTERNAL_TRANSFER_RECEIVED') {
        displayAmount = Math.abs(tx.amount);
      } else if (tx.type === 'WITHDRAWAL' || tx.type === 'INTERNAL_TRANSFER_SENT') {
        displayAmount = -Math.abs(tx.amount);
      }
      return { ...tx, amount: displayAmount };
    });

    const formattedBills = bills.map(bill => ({
      _id: bill._id,
      type: bill.billType.toUpperCase(),
      status: statusMap[bill.status] || bill.status,
      currency: bill.paymentCurrency || 'NGNZ',
      amount: -(Math.abs(bill.amountNGNZ || bill.amountNaira || bill.amount || 0)),
      narration: bill.productName,
      reference: bill.orderId,
      source: 'bills',
      createdAt: bill.createdAt,
      updatedAt: bill.updatedAt,
      billDetails: {
        billType: bill.billType,
        network: bill.network,
        productName: bill.productName,
        customerPhone: bill.customerPhone,
        customerInfo: bill.customerInfo
      }
    }));

    const allTransactions = [...formattedTransactions, ...formattedBills]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({ success: true, transactions: allTransactions });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
