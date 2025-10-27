// Debug route to check transaction status
const express = require('express');
const BillTransaction = require('../models/billstransaction');

const router = express.Router();

// Debug endpoint to check transaction status
router.get('/transaction/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    
    const transaction = await BillTransaction.findOne({ orderId });
    
    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found',
        orderId
      });
    }
    
    res.json({
      success: true,
      data: {
        orderId: transaction.orderId,
        status: transaction.status,
        billType: transaction.billType,
        productName: transaction.productName,
        balanceCompleted: transaction.balanceCompleted,
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
        metaData: transaction.metaData,
        processingErrors: transaction.processingErrors
      }
    });
  } catch (error) {
    console.error('Debug transaction error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching transaction',
      error: error.message
    });
  }
});

// Debug endpoint to check all BetWay transactions
router.get('/betway-transactions', async (req, res) => {
  try {
    const transactions = await BillTransaction.find({
      billType: 'betting',
      'metaData.betting_provider': 'betway'
    }).sort({ createdAt: -1 }).limit(10);
    
    res.json({
      success: true,
      data: transactions.map(tx => ({
        orderId: tx.orderId,
        status: tx.status,
        createdAt: tx.createdAt,
        balanceCompleted: tx.balanceCompleted,
        hasApiOrderId: tx.orderId.startsWith('API-')
      }))
    });
  } catch (error) {
    console.error('Debug BetWay transactions error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching BetWay transactions',
      error: error.message
    });
  }
});

module.exports = router;
