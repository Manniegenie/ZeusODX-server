// routes/analytics.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Decimal = require('decimal.js');

const User = require('../models/user');
const Transaction = require('../models/transaction');
const NairaMarkdown = require('../models/offramp');
const { getPricesWithCache, SUPPORTED_TOKENS } = require('../services/portfolio');

/**
 * Optional base unit map for tokens stored in smallest units.
 * If your transaction.amount is stored in base units (e.g. wei for ETH = 1e18),
 * fill this map with the appropriate divisor. By default every token is assumed
 * to be in "human" units (divisor = 1).
 */
const BASE_UNIT_DIVISOR = {
  // Example: 'ETH': new Decimal('1e18'),
  // 'BTC': new Decimal('1e8'),
  // add tokens here if your amounts are stored in base units
};

/**
 * Calculate total transaction volume in USD (robust & efficient)
 */
async function calculateTransactionVolume() {
  try {
    console.log('=== Starting Transaction Volume Calculation (optimized) ===');

    // Get offramp rate for NGNZ conversion
    const nairaMarkdown = await NairaMarkdown.findOne();
    let offrampRate = nairaMarkdown?.offrampRate || 1554.42;

    if (!offrampRate || isNaN(offrampRate) || Number(offrampRate) === 0) {
      console.warn('Invalid or missing offrampRate from DB; falling back to default 1554.42');
      offrampRate = 1554.42;
    }

    // Aggregate absolute amounts per currency (one row per currency)
    let agg = await Transaction.aggregate([
      {
        $match: {
          type: { $in: ['SWAP', 'OBIEX_SWAP', 'GIFTCARD'] },
          status: { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] },
          currency: { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: { $toUpper: '$currency' },
          totalAmount: { $sum: { $abs: '$amount' } },
          count: { $sum: 1 }
        }
      }
    ]).exec();

    // Ensure agg is an array
    if (!Array.isArray(agg) && agg && typeof agg.toArray === 'function') {
      try {
        agg = await agg.toArray();
      } catch (e) {
        console.warn('Unable to convert aggregation cursor to array:', e.message);
      }
    }

    if (!agg || agg.length === 0) {
      console.log('No matching transactions found. Returning 0.');
      return {
        totalVolumeUSD: 0,
        breakdown: {},
        counts: { totalCurrencies: 0, processedCurrencies: 0, skippedCurrencies: 0 },
        totalSkippedUSD: '0'
      };
    }

    // Prepare currencies to fetch prices for (exclude NGNZ)
    const currencies = agg
      .map(r => r._id)
      .filter(c => c && c !== 'NGNZ' && SUPPORTED_TOKENS[c]);

    console.log('Currencies to fetch prices for:', currencies);

    let prices = {};
    try {
      prices = await getPricesWithCache(currencies) || {};
    } catch (e) {
      console.warn('getPricesWithCache threw an error, proceeding with empty prices:', e.message);
      prices = {};
    }

    console.log('Prices received for currencies:', Object.keys(prices));

    // Compute USD values per currency using Decimal for precision
    let totalVolumeUSD = new Decimal(0);
    let totalSkippedUSD = new Decimal(0);
    const breakdown = {};
    let processedCurrencies = 0;
    let skippedCurrencies = 0;

    for (const row of agg) {
      const currency = row._id;
      const divisor = BASE_UNIT_DIVISOR[currency] || new Decimal(1);
      const totalAmountDecimal = new Decimal(row.totalAmount || 0).div(divisor);

      if (currency === 'NGNZ') {
        if (!offrampRate || isNaN(offrampRate) || Number(offrampRate) === 0) {
          console.warn('Invalid offrampRate, skipping NGNZ conversion');
          breakdown[currency] = {
            totalAmount: totalAmountDecimal.toString(),
            usdValue: '0',
            note: 'invalid offrampRate'
          };
          skippedCurrencies++;
          continue;
        }

        const usdValue = totalAmountDecimal.div(new Decimal(offrampRate));
        totalVolumeUSD = totalVolumeUSD.plus(usdValue);
        breakdown[currency] = {
          totalAmount: totalAmountDecimal.toString(),
          usdValue: usdValue.toString(),
          price: (1 / Number(offrampRate))
        };
        processedCurrencies++;

      } else {
        const price = prices?.[currency];

        if (typeof price === 'number' || typeof price === 'string') {
          const usdValue = totalAmountDecimal.times(new Decimal(price));
          totalVolumeUSD = totalVolumeUSD.plus(usdValue);
          breakdown[currency] = {
            totalAmount: totalAmountDecimal.toString(),
            usdValue: usdValue.toString(),
            price: Number(price)
          };
          processedCurrencies++;
        } else {
          console.warn(`Missing price for ${currency}. Skipping conversion for ${totalAmountDecimal.toString()} ${currency}`);
          breakdown[currency] = {
            totalAmount: totalAmountDecimal.toString(),
            usdValue: '0',
            note: 'price missing'
          };
          skippedCurrencies++;
        }
      }
    }

    const result = {
      totalVolumeUSD: Number(totalVolumeUSD.toFixed(2)),
      breakdown,
      counts: {
        totalCurrencies: agg.length,
        processedCurrencies,
        skippedCurrencies
      },
      totalSkippedUSD: totalSkippedUSD.toString()
    };

    console.log('Transaction Volume Calculation Complete. Summary:');
    console.log('Total USD:', result.totalVolumeUSD);
    console.log('Counts:', result.counts);
    console.log('Skipped USD total (approx):', result.totalSkippedUSD);

    return result;
  } catch (error) {
    console.error('Error calculating transaction volume:', error);
    console.error('Stack trace:', error.stack);
    return {
      totalVolumeUSD: 0,
      breakdown: {},
      counts: { totalCurrencies: 0, processedCurrencies: 0, skippedCurrencies: 0 },
      totalSkippedUSD: '0'
    };
  }
}

/**
 * GET /analytics/dashboard
 * Fetch essential dashboard statistics
 */
router.get('/dashboard', async (req, res) => {
  try {
    console.log('=== Dashboard Analytics Request Started ===');

    const [
      userStats,
      transactionStats,
      swapStats,
      withdrawalStats,
      recentActivity,
      tokenStats,
      transactionVolumeResult
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
      ]),

      // Calculate total transaction volume in USD (optimized function)
      calculateTransactionVolume()
    ]);

    console.log('Transaction Volume Result:', transactionVolumeResult);

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
        tokenStats: tokenStats,

        // Transaction Volume in USD (NEW) — expose the numeric total and breakdown for debugging
        transactionVolume: transactionVolumeResult?.totalVolumeUSD ?? 0,
        transactionVolumeBreakdown: transactionVolumeResult?.breakdown ?? {},
        transactionVolumeCounts: transactionVolumeResult?.counts ?? { totalCurrencies: 0, processedCurrencies: 0, skippedCurrencies: 0 }
      }
    };

    console.log('=== Sending Response to Client ===');
    console.log('Response data.transactionVolume:', response.data.transactionVolume);
    console.log('Response data.users.total:', response.data.users.total);
    console.log('Response data.chatbotTrades.overview.total:', response.data.chatbotTrades.overview.total);
    console.log('=== Dashboard Analytics Request Complete ===');

    res.json(response);

  } catch (error) {
    console.error('Error fetching dashboard analytics:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch analytics data',
      message: error.message
    });
  }
});

router.get('/recent-transactions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = (page - 1) * limit;

    // Fetch transactions and total count
    const [transactions, totalCount] = await Promise.all([
      Transaction.find({})
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .populate('userId', 'username email firstname lastname')
        .populate('recipientUserId', 'username')
        .populate('senderUserId', 'username')
        .lean(),
      Transaction.countDocuments({})
    ]);

    // Format transactions for response
    const formattedTransactions = transactions.map(tx => ({
      id: tx._id.toString(),
      userId: tx.userId?._id?.toString(),
      username: tx.userId?.username || tx.userId?.firstname || 'Unknown',
      userEmail: tx.userId?.email,
      type: tx.type,
      status: tx.status,
      currency: tx.currency,
      amount: tx.amount,
      fee: tx.fee || 0,
      narration: tx.narration,
      reference: tx.reference,
      source: tx.source,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
      completedAt: tx.completedAt,

      // Swap details
      ...(tx.type === 'SWAP' || tx.type === 'OBIEX_SWAP' ? {
        fromCurrency: tx.fromCurrency,
        toCurrency: tx.toCurrency,
        fromAmount: tx.fromAmount,
        toAmount: tx.toAmount,
        swapType: tx.swapType,
        exchangeRate: tx.exchangeRate
      } : {}),

      // NGNZ withdrawal details
      ...(tx.isNGNZWithdrawal ? {
        bankName: tx.ngnzWithdrawal?.destination?.bankName,
        accountName: tx.ngnzWithdrawal?.destination?.accountName,
        accountNumberMasked: tx.ngnzWithdrawal?.destination?.accountNumberMasked,
        withdrawalFee: tx.withdrawalFee
      } : {}),

      // Internal transfer details
      ...(tx.type === 'INTERNAL_TRANSFER_SENT' || tx.type === 'INTERNAL_TRANSFER_RECEIVED' ? {
        recipientUsername: tx.recipientUsername,
        senderUsername: tx.senderUsername
      } : {}),

      // Giftcard details
      ...(tx.type === 'GIFTCARD' ? {
        cardType: tx.cardType,
        country: tx.country,
        expectedRate: tx.expectedRate
      } : {})
    }));

    const totalPages = Math.ceil(totalCount / limit);

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      pagination: {
        currentPage: page,
        totalPages,
        limit,
        totalCount,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      },
      data: formattedTransactions
    });

  } catch (error) {
    console.error('Error fetching recent transactions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch recent transactions',
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
