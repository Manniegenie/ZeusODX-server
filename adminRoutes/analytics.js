// routes/analytics.js
const express = require('express');
const router = express.Router();
const User = require('../models/user');
const ChatbotTransaction = require('../models/ChatbotTransaction');

/**
 * GET /analytics/dashboard
 * Fetch essential dashboard statistics
 */
router.get('/dashboard', async (req, res) => {
  try {
    const [
      userStats,
      chatbotTradeStats,
      recentTrades,
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

      // Chatbot transaction statistics
      ChatbotTransaction.aggregate([
        {
          $group: {
            _id: null,
            totalTrades: { $sum: 1 },
            totalSellTrades: { $sum: { $cond: [{ $eq: ['$kind', 'SELL'] }, 1, 0] } },
            totalBuyTrades: { $sum: { $cond: [{ $eq: ['$kind', 'BUY'] }, 1, 0] } },
            completedTrades: { $sum: { $cond: [{ $in: ['$status', ['CONFIRMED', 'PAID']] }, 1, 0] } },
            pendingTrades: { $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0] } },
            expiredTrades: { $sum: { $cond: [{ $eq: ['$status', 'EXPIRED'] }, 1, 0] } },
            cancelledTrades: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] } },
            // Volume calculations
            totalSellVolume: { $sum: { $cond: [{ $eq: ['$kind', 'SELL'] }, '$sellAmount', 0] } },
            totalBuyVolumeNGN: { $sum: { $cond: [{ $eq: ['$kind', 'BUY'] }, '$buyAmount', 0] } },
            totalReceiveAmount: { $sum: '$receiveAmount' },
            // Successful payouts and collections
            successfulPayouts: { $sum: { $cond: ['$payoutSuccess', 1, 0] } },
            successfulCollections: { $sum: { $cond: ['$collectionSuccess', 1, 0] } }
          }
        }
      ]),

      // Recent chatbot trades (last 24 hours)
      ChatbotTransaction.aggregate([
        {
          $match: {
            createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
          }
        },
        {
          $group: {
            _id: null,
            trades24h: { $sum: 1 },
            sellTrades24h: { $sum: { $cond: [{ $eq: ['$kind', 'SELL'] }, 1, 0] } },
            buyTrades24h: { $sum: { $cond: [{ $eq: ['$kind', 'BUY'] }, 1, 0] } },
            volume24h: { $sum: '$receiveAmount' }
          }
        }
      ]),

      // Token distribution in chatbot trades
      ChatbotTransaction.aggregate([
        {
          $group: {
            _id: '$token',
            tradeCount: { $sum: 1 },
            sellCount: { $sum: { $cond: [{ $eq: ['$kind', 'SELL'] }, 1, 0] } },
            buyCount: { $sum: { $cond: [{ $eq: ['$kind', 'BUY'] }, 1, 0] } },
            totalVolume: { $sum: '$receiveAmount' }
          }
        },
        { $sort: { tradeCount: -1 } }
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

        // Chatbot Trading Statistics
        chatbotTrades: {
          overview: {
            total: chatbotTradeStats[0]?.totalTrades || 0,
            sell: chatbotTradeStats[0]?.totalSellTrades || 0,
            buy: chatbotTradeStats[0]?.totalBuyTrades || 0,
            completed: chatbotTradeStats[0]?.completedTrades || 0,
            pending: chatbotTradeStats[0]?.pendingTrades || 0,
            expired: chatbotTradeStats[0]?.expiredTrades || 0,
            cancelled: chatbotTradeStats[0]?.cancelledTrades || 0
          },
          volume: {
            totalSellVolume: chatbotTradeStats[0]?.totalSellVolume || 0,
            totalBuyVolumeNGN: chatbotTradeStats[0]?.totalBuyVolumeNGN || 0,
            totalReceiveAmount: chatbotTradeStats[0]?.totalReceiveAmount || 0
          },
          success: {
            successfulPayouts: chatbotTradeStats[0]?.successfulPayouts || 0,
            successfulCollections: chatbotTradeStats[0]?.successfulCollections || 0
          },
          recent24h: {
            trades: recentTrades[0]?.trades24h || 0,
            sellTrades: recentTrades[0]?.sellTrades24h || 0,
            buyTrades: recentTrades[0]?.buyTrades24h || 0,
            volume: recentTrades[0]?.volume24h || 0
          }
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

module.exports = router;