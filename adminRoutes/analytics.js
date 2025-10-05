// routes/analytics.js
const express = require('express');
const router = express.Router();
const User = require('../models/user');
const Transaction = require('../models/transaction');

/**
 * GET /analytics/dashboard
 * Fetch essential dashboard statistics
 */
router.get('/dashboard', async (req, res) => {
  try {
    const [
      userStats,
      transactionStats,
      swapStats,
      withdrawalStats,
      recentActivity,
      tokenStats
    ] = await Promise.all([
      // Basic user statistics
      User.aggregate([
        {
          $group: {
            _id: null,
            totalUsers: { $sum: 1 },
            verifiedEmails: { $sum: { $cond: ['$emailVerified', 1, 0] } },
            verifiedBVNs: { $sum: { $cond: ['$bvnVerified', 1, 0] } },
            chatbotVerified: { $sum: { $cond: ['$chatbotTransactionVerified', 1, 0] } }
          }
        }
      ]),

      // Overall transaction statistics
      Transaction.aggregate([
        {
          $group: {
            _id: null,
            totalTransactions: { $sum: 1 },
            deposits: { $sum: { $cond: [{ $eq: ['$type', 'DEPOSIT'] }, 1, 0] } },
            withdrawals: { $sum: { $cond: [{ $eq: ['$type', 'WITHDRAWAL'] }, 1, 0] } },
            swaps: { $sum: { $cond: [{ $in: ['$type', ['SWAP', 'OBIEX_SWAP']] }, 1, 0] } },
            giftcards: { $sum: { $cond: [{ $eq: ['$type', 'GIFTCARD'] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $in: ['$status', ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED']] }, 1, 0] } },
            pending: { $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0] } }
          }
        }
      ]),

      // Enhanced swap statistics
      Transaction.aggregate([
        {
          $match: {
            type: { $in: ['SWAP', 'OBIEX_SWAP'] }
          }
        },
        {
          $group: {
            _id: null,
            totalSwaps: { $sum: 1 },
            onramps: { $sum: { $cond: [{ $in: ['$swapType', ['onramp', 'ONRAMP']] }, 1, 0] } },
            offramps: { $sum: { $cond: [{ $in: ['$swapType', ['offramp', 'OFFRAMP']] }, 1, 0] } },
            cryptoToCrypto: { $sum: { $cond: [{ $in: ['$swapType', ['crypto_to_crypto', 'CRYPTO_TO_CRYPTO']] }, 1, 0] } },
            ngnzSwaps: { $sum: { $cond: [{ $or: [
              { $in: ['$swapType', ['NGNX_TO_CRYPTO', 'CRYPTO_TO_NGNX']] },
              { $in: ['$swapCategory', ['NGNZ_EXCHANGE']] }
            ]}, 1, 0] } },
            successfulSwaps: { $sum: { $cond: [{ $eq: ['$status', 'SUCCESSFUL'] }, 1, 0] } },
            totalVolume: { $sum: { $abs: '$amount' } },
            totalFees: { $sum: '$fee' }
          }
        }
      ]),

      // NGNZ Withdrawal statistics
      Transaction.aggregate([
        {
          $match: {
            isNGNZWithdrawal: true
          }
        },
        {
          $group: {
            _id: null,
            totalWithdrawals: { $sum: 1 },
            completedWithdrawals: { $sum: { $cond: [{ $in: ['$status', ['SUCCESSFUL', 'COMPLETED']] }, 1, 0] } },
            pendingWithdrawals: { $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0] } },
            failedWithdrawals: { $sum: { $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0] } },
            totalAmount: { $sum: { $abs: '$amount' } },
            totalBankAmount: { $sum: '$bankAmount' },
            totalFees: { $sum: '$withdrawalFee' }
          }
        }
      ]),

      // Recent activity (last 24 hours)
      Transaction.aggregate([
        {
          $match: {
            createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
          }
        },
        {
          $group: {
            _id: null,
            transactions24h: { $sum: 1 },
            deposits24h: { $sum: { $cond: [{ $eq: ['$type', 'DEPOSIT'] }, 1, 0] } },
            withdrawals24h: { $sum: { $cond: [{ $eq: ['$type', 'WITHDRAWAL'] }, 1, 0] } },
            swaps24h: { $sum: { $cond: [{ $in: ['$type', ['SWAP', 'OBIEX_SWAP']] }, 1, 0] } },
            volume24h: { $sum: { $abs: '$amount' } }
          }
        }
      ]),

      // Token/Currency distribution
      Transaction.aggregate([
        {
          $match: {
            type: { $in: ['DEPOSIT', 'WITHDRAWAL', 'SWAP'] },
            status: { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] }
          }
        },
        {
          $group: {
            _id: '$currency',
            transactionCount: { $sum: 1 },
            deposits: { $sum: { $cond: [{ $eq: ['$type', 'DEPOSIT'] }, 1, 0] } },
            withdrawals: { $sum: { $cond: [{ $eq: ['$type', 'WITHDRAWAL'] }, 1, 0] } },
            swaps: { $sum: { $cond: [{ $in: ['$type', ['SWAP', 'OBIEX_SWAP']] }, 1, 0] } },
            totalVolume: { $sum: { $abs: '$amount' } }
          }
        },
        { $sort: { totalVolume: -1 } },
        { $limit: 10 }
      ])
    ]);

    const response = {
      success: true,
      timestamp: new Date().toISOString(),
      data: {
        // User Overview
        users: {
          total: userStats[0]?.totalUsers || 0,
          emailVerified: userStats[0]?.verifiedEmails || 0,
          bvnVerified: userStats[0]?.verifiedBVNs || 0,
          chatbotVerified: userStats[0]?.chatbotVerified || 0
        },

        // Overall Transaction Statistics
        transactions: {
          total: transactionStats[0]?.totalTransactions || 0,
          deposits: transactionStats[0]?.deposits || 0,
          withdrawals: transactionStats[0]?.withdrawals || 0,
          swaps: transactionStats[0]?.swaps || 0,
          giftcards: transactionStats[0]?.giftcards || 0,
          completed: transactionStats[0]?.completed || 0,
          pending: transactionStats[0]?.pending || 0,
          failed: transactionStats[0]?.failed || 0
        },

        // Enhanced Swap Statistics
        swapStats: {
          total: swapStats[0]?.totalSwaps || 0,
          onramps: swapStats[0]?.onramps || 0,
          offramps: swapStats[0]?.offramps || 0,
          cryptoToCrypto: swapStats[0]?.cryptoToCrypto || 0,
          ngnzSwaps: swapStats[0]?.ngnzSwaps || 0,
          successful: swapStats[0]?.successfulSwaps || 0,
          totalVolume: swapStats[0]?.totalVolume || 0,
          totalFees: swapStats[0]?.totalFees || 0
        },

        // NGNZ Withdrawal Statistics
        ngnzWithdrawals: {
          total: withdrawalStats[0]?.totalWithdrawals || 0,
          completed: withdrawalStats[0]?.completedWithdrawals || 0,
          pending: withdrawalStats[0]?.pendingWithdrawals || 0,
          failed: withdrawalStats[0]?.failedWithdrawals || 0,
          totalAmount: withdrawalStats[0]?.totalAmount || 0,
          totalBankAmount: withdrawalStats[0]?.totalBankAmount || 0,
          totalFees: withdrawalStats[0]?.totalFees || 0
        },

        // Chatbot Trades (for backward compatibility with frontend)
        // Map from general transaction stats to match expected format
        chatbotTrades: {
          overview: {
            total: transactionStats[0]?.swaps || 0,
            sell: swapStats[0]?.offramps || 0,
            buy: swapStats[0]?.onramps || 0,
            completed: swapStats[0]?.successfulSwaps || 0,
            pending: transactionStats[0]?.pending || 0,
            expired: 0,
            cancelled: 0
          },
          volume: {
            totalSellVolume: swapStats[0]?.totalVolume || 0,
            totalBuyVolumeNGN: swapStats[0]?.totalVolume || 0,
            totalReceiveAmount: swapStats[0]?.totalVolume || 0
          },
          success: {
            successfulPayouts: withdrawalStats[0]?.completedWithdrawals || 0,
            successfulCollections: transactionStats[0]?.completed || 0
          },
          recent24h: {
            trades: recentActivity[0]?.swaps24h || 0,
            sellTrades: recentActivity[0]?.swaps24h || 0,
            buyTrades: recentActivity[0]?.swaps24h || 0,
            volume: recentActivity[0]?.volume24h || 0
          }
        },

        // Recent Activity (24h)
        recentActivity: {
          transactions: recentActivity[0]?.transactions24h || 0,
          deposits: recentActivity[0]?.deposits24h || 0,
          withdrawals: recentActivity[0]?.withdrawals24h || 0,
          swaps: recentActivity[0]?.swaps24h || 0,
          volume: recentActivity[0]?.volume24h || 0
        },

        // Token Statistics
        tokenStats: tokenStats
      }
    };

    res.json(response);

  } catch (error) {
    console.error('Error fetching dashboard analytics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch analytics data',
      message: error.message
    });
  }
});

/**
 * GET /analytics/swap-pairs
 * Get analytics for specific swap pairs
 */
router.get('/swap-pairs', async (req, res) => {
  try {
    const { timeframe = '24h' } = req.query;
    
    const timeAgo = new Date();
    const hours = timeframe === '24h' ? 24 : 
                  timeframe === '7d' ? 24 * 7 : 
                  timeframe === '30d' ? 24 * 30 : 24;
    timeAgo.setHours(timeAgo.getHours() - hours);

    const swapPairStats = await Transaction.aggregate([
      {
        $match: {
          type: { $in: ['SWAP', 'OBIEX_SWAP'] },
          status: 'SUCCESSFUL',
          swapPair: { $exists: true },
          createdAt: { $gte: timeAgo }
        }
      },
      {
        $group: {
          _id: '$swapPair',
          totalSwaps: { $sum: 1 },
          totalVolume: { $sum: { $abs: '$amount' } },
          avgExchangeRate: { $avg: '$exchangeRate' },
          uniqueUsers: { $addToSet: '$userId' }
        }
      },
      {
        $project: {
          _id: 0,
          swapPair: '$_id',
          totalSwaps: 1,
          totalVolume: 1,
          avgExchangeRate: 1,
          uniqueUsers: { $size: '$uniqueUsers' }
        }
      },
      { $sort: { totalVolume: -1 } }
    ]);

    res.json({
      success: true,
      timeframe,
      data: swapPairStats
    });

  } catch (error) {
    console.error('Error fetching swap pair analytics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch swap pair analytics',
      message: error.message
    });
  }
});

module.exports = router;