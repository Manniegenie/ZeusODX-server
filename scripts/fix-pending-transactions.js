// Script to fix old pending transactions
const mongoose = require('mongoose');
const BillTransaction = require('../models/billstransaction');

async function fixPendingTransactions() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/zeusodx');
    console.log('Connected to MongoDB');

    // Find all pending transactions older than 1 hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    const pendingTransactions = await BillTransaction.find({
      status: 'initiated-api',
      createdAt: { $lt: oneHourAgo },
      orderId: { $regex: /^pending_/ }
    });

    console.log(`Found ${pendingTransactions.length} old pending transactions`);

    // Update them to failed status
    const updateResult = await BillTransaction.updateMany(
      {
        status: 'initiated-api',
        createdAt: { $lt: oneHourAgo },
        orderId: { $regex: /^pending_/ }
      },
      {
        $set: {
          status: 'failed',
          balanceCompleted: false,
          processingErrors: [{
            error: 'Transaction timeout - automatically marked as failed',
            timestamp: new Date(),
            phase: 'cleanup_script'
          }]
        }
      }
    );

    console.log(`Updated ${updateResult.modifiedCount} transactions to failed status`);
    
    // Also update any transactions that are stuck in 'initiated-api' status
    const stuckTransactions = await BillTransaction.updateMany(
      {
        status: 'initiated-api',
        createdAt: { $lt: oneHourAgo }
      },
      {
        $set: {
          status: 'failed',
          balanceCompleted: false,
          processingErrors: [{
            error: 'Transaction timeout - automatically marked as failed',
            timestamp: new Date(),
            phase: 'cleanup_script'
          }]
        }
      }
    );

    console.log(`Updated ${stuckTransactions.modifiedCount} stuck transactions to failed status`);

    console.log('Cleanup completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error fixing pending transactions:', error);
    process.exit(1);
  }
}

// Run the script
fixPendingTransactions();
