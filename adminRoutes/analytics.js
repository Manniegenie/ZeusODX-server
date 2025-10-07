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
 */
const BASE_UNIT_DIVISOR = {
  // Example: 'ETH': new Decimal('1e18'),
  // 'BTC': new Decimal('1e8'),
};

/**
 * Calculate total transaction volume in USD (robust & efficient)
 * FIXED: Only counts OUT side of swap pairs to avoid double-counting
 */
async function calculateTransactionVolume() {
  try {
    console.log('=== Starting Transaction Volume Calculation (optimized) ===');

    const nairaMarkdown = await NairaMarkdown.findOne();
    let offrampRate = nairaMarkdown?.offrampRate || 1554.42;

    if (!offrampRate || isNaN(offrampRate) || Number(offrampRate) === 0) {
      console.warn('Invalid or missing offrampRate from DB; falling back to default 1554.42');
      offrampRate = 1554.42;
    }

    let agg = await Transaction.aggregate([
      {
        $match: {
          type: { $in: ['SWAP', 'OBIEX_SWAP', 'GIFTCARD'] },
          status: { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] },
          currency: { $exists: true, $ne: null },
          // FIXED: Only count OUT side of swaps to avoid double-counting
          $or: [
            { type: 'GIFTCARD' }, // Include all giftcard transactions
            { type: { $in: ['SWAP', 'OBIEX_SWAP'] }, swapDirection: 'OUT' } // Only OUT swaps
          ]
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
      transactionVolumeResult,
      pendingTradesStats
    ] = await Promise.all([
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

      // FIXED: Only count OUT side of swaps for completed trades calculation
      Transaction.aggregate([
        {
          $match: {
            type: { $in: ['SWAP', 'OBIEX_SWAP'] },
            // FIXED: Only count OUT side of swaps
            swapDirection: 'OUT'
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
            // FIXED: Only count successful OUT swaps for completed trades
            successfulSwaps: { $sum: { $cond: [{ $eq: ['$status', 'SUCCESSFUL'] }, 1, 0] } },
            // FIXED: Only count pending OUT swaps for pending trades
            pendingSwaps: { $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0] } },
            totalVolume: { $sum: { $abs: '$amount' } },
            totalFees: { $sum: '$fee' }
          }
        }
      ]),

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

      calculateTransactionVolume(),

      // FIXED: Pending trades calculation - includes swaps (OUT only) and giftcards
      Transaction.aggregate([
        {
          $match: {
            status: 'PENDING',
            $or: [
              { type: 'GIFTCARD' },
              { type: { $in: ['SWAP', 'OBIEX_SWAP'] }, swapDirection: 'OUT' }
            ]
          }
        },
        {
          $group: {
            _id: null,
            totalPendingTrades: { $sum: 1 },
            pendingSwaps: { $sum: { $cond: [{ $in: ['$type', ['SWAP', 'OBIEX_SWAP']] }, 1, 0] } },
            pendingGiftcards: { $sum: { $cond: [{ $eq: ['$type', 'GIFTCARD'] }, 1, 0] } }
          }
        }
      ])
    ]);

    const response = {
      success: true,
      timestamp: new Date().toISOString(),
      data: {
        users: {
          total: userStats[0]?.totalUsers || 0,
          emailVerified: userStats[0]?.verifiedEmails || 0,
          bvnVerified: userStats[0]?.verifiedBVNs || 0,
          chatbotVerified: userStats[0]?.chatbotVerified || 0
        },
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
        swapStats: {
          total: swapStats[0]?.totalSwaps || 0,
          onramps: swapStats[0]?.onramps || 0,
          offramps: swapStats[0]?.offramps || 0,
          cryptoToCrypto: swapStats[0]?.cryptoToCrypto || 0,
          ngnzSwaps: swapStats[0]?.ngnzSwaps || 0,
          successful: swapStats[0]?.successfulSwaps || 0,
          pending: swapStats[0]?.pendingSwaps || 0, // FIXED: Now shows pending swaps correctly
          totalVolume: swapStats[0]?.totalVolume || 0,
          totalFees: swapStats[0]?.totalFees || 0
        },
        pendingTrades: {
          total: pendingTradesStats[0]?.totalPendingTrades || 0,
          swaps: pendingTradesStats[0]?.pendingSwaps || 0,
          giftcards: pendingTradesStats[0]?.pendingGiftcards || 0
        },
        ngnzWithdrawals: {
          total: withdrawalStats[0]?.totalWithdrawals || 0,
          completed: withdrawalStats[0]?.completedWithdrawals || 0,
          pending: withdrawalStats[0]?.pendingWithdrawals || 0,
          failed: withdrawalStats[0]?.failedWithdrawals || 0,
          totalAmount: withdrawalStats[0]?.totalAmount || 0,
          totalBankAmount: withdrawalStats[0]?.totalBankAmount || 0,
          totalFees: withdrawalStats[0]?.totalFees || 0
        },
        chatbotTrades: {
          overview: {
            total: swapStats[0]?.totalSwaps || 0, // FIXED: Now accurate
            sell: swapStats[0]?.offramps || 0,
            buy: swapStats[0]?.onramps || 0,
            completed: swapStats[0]?.successfulSwaps || 0, // FIXED: Now accurate
            pending: pendingTradesStats[0]?.totalPendingTrades || 0, // FIXED: Includes swaps + giftcards
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
        recentActivity: {
          transactions: recentActivity[0]?.transactions24h || 0,
          deposits: recentActivity[0]?.deposits24h || 0,
          withdrawals: recentActivity[0]?.withdrawals24h || 0,
          swaps: recentActivity[0]?.swaps24h || 0,
          volume: recentActivity[0]?.volume24h || 0
        },
        tokenStats: tokenStats,
        transactionVolume: transactionVolumeResult?.totalVolumeUSD ?? 0,
        transactionVolumeBreakdown: transactionVolumeResult?.breakdown ?? {},
        transactionVolumeCounts: transactionVolumeResult?.counts ?? { totalCurrencies: 0, processedCurrencies: 0, skippedCurrencies: 0 }
      }
    };

    console.log('=== Dashboard Analytics Request Complete ===');
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
 * GET /analytics/recent-transactions
 */
router.get('/recent-transactions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = (page - 1) * limit;

    const { username, transactionId, date, dateFrom, dateTo, type, status } = req.query;
    const filter = {};

    if (username) {
      const escapeForRegex = (s) => {
        if (!s) return s;
        const specials = ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\', '/'];
        let out = s;
        for (const ch of specials) out = out.split(ch).join('\\' + ch);
        return out;
      };

      const escaped = escapeForRegex(username);
      const regex = new RegExp(`^${escaped}$`, 'i');

      const user = await User.findOne({
        $or: [
          { username: regex },
          { firstname: regex },
          { lastname: regex }
        ]
      }).select('_id').lean();

      if (user && user._id) {
        filter.userId = user._id;
      } else {
        return res.json({
          success: true,
          timestamp: new Date().toISOString(),
          pagination: { currentPage: page, totalPages: 0, limit, totalCount: 0, hasNextPage: false, hasPreviousPage: false },
          data: []
        });
      }
    }

    if (transactionId) {
      const orClauses = [];
      if (mongoose.Types.ObjectId.isValid(transactionId)) {
        orClauses.push({ _id: mongoose.Types.ObjectId(transactionId) });
      }
      orClauses.push({ transactionId: transactionId });
      orClauses.push({ reference: transactionId });
      orClauses.push({ 'receiptDetails.transactionId': transactionId });
      filter.$or = orClauses;
    }

    if (date) {
      const d = new Date(date);
      if (!isNaN(d.getTime())) {
        const start = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0));
        const end = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999));
        filter.createdAt = { $gte: start, $lte: end };
      }
    } else if (dateFrom || dateTo) {
      const range = {};
      if (dateFrom) {
        const d1 = new Date(dateFrom);
        if (!isNaN(d1.getTime())) range.$gte = new Date(Date.UTC(d1.getFullYear(), d1.getMonth(), d1.getDate(), 0, 0, 0));
      }
      if (dateTo) {
        const d2 = new Date(dateTo);
        if (!isNaN(d2.getTime())) range.$lte = new Date(Date.UTC(d2.getFullYear(), d2.getMonth(), d2.getDate(), 23, 59, 59, 999));
      }
      if (Object.keys(range).length) filter.createdAt = range;
    }

    if (type) filter.type = type;
    if (status) filter.status = status;

    const [transactions, totalCount] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .populate('userId', 'username email firstname lastname')
        .populate('recipientUserId', 'username')
        .populate('senderUserId', 'username')
        .lean(),
      Transaction.countDocuments(filter)
    ]);

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
      ...(tx.type === 'SWAP' || tx.type === 'OBIEX_SWAP' ? {
        fromCurrency: tx.fromCurrency,
        toCurrency: tx.toCurrency,
        fromAmount: tx.fromAmount,
        toAmount: tx.toAmount,
        swapType: tx.swapType,
        exchangeRate: tx.exchangeRate
      } : {}),
      ...(tx.isNGNZWithdrawal ? {
        bankName: tx.ngnzWithdrawal?.destination?.bankName,
        accountName: tx.ngnzWithdrawal?.destination?.accountName,
        accountNumberMasked: tx.ngnzWithdrawal?.destination?.accountNumberMasked,
        withdrawalFee: tx.withdrawalFee
      } : {}),
      ...(tx.type === 'INTERNAL_TRANSFER_SENT' || tx.type === 'INTERNAL_TRANSFER_RECEIVED' ? {
        recipientUsername: tx.recipientUsername,
        senderUsername: tx.senderUsername
      } : {}),
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
 * GET /analytics/filter
 * Universal filter endpoint - FIXED search logic
 */
router.get('/filter', async (req, res) => {
  try {
    const {
      searchTerm,
      dateFrom,
      dateTo,
      transactionType,
      transactionStatus,
      userVerificationStatus,
      currency,
      minAmount,
      maxAmount,
      page = 1,
      limit = 50
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(parseInt(limit), 200);
    const skip = (pageNum - 1) * limitNum;

    // Build date range filter
    const dateFilter = {};
    if (dateFrom) {
      const d1 = new Date(dateFrom);
      if (!isNaN(d1.getTime())) {
        dateFilter.$gte = new Date(Date.UTC(d1.getFullYear(), d1.getMonth(), d1.getDate(), 0, 0, 0));
      }
    }
    if (dateTo) {
      const d2 = new Date(dateTo);
      if (!isNaN(d2.getTime())) {
        dateFilter.$lte = new Date(Date.UTC(d2.getFullYear(), d2.getMonth(), d2.getDate(), 23, 59, 59, 999));
      }
    }

    // Build transaction filter
    const transactionFilter = {};
    if (Object.keys(dateFilter).length) {
      transactionFilter.createdAt = dateFilter;
    }
    if (transactionType) {
      transactionFilter.type = transactionType;
    }
    if (transactionStatus) {
      transactionFilter.status = transactionStatus;
    }
    if (currency) {
      transactionFilter.currency = currency.toUpperCase();
    }
    if (minAmount || maxAmount) {
      transactionFilter.amount = {};
      if (minAmount) transactionFilter.amount.$gte = parseFloat(minAmount);
      if (maxAmount) transactionFilter.amount.$lte = parseFloat(maxAmount);
    }

    // Build user filter
    const userFilter = {};
    if (userVerificationStatus === 'emailVerified') {
      userFilter.emailVerified = true;
    } else if (userVerificationStatus === 'bvnVerified') {
      userFilter.bvnVerified = true;
    } else if (userVerificationStatus === 'chatbotVerified') {
      userFilter.chatbotTransactionVerified = true;
    } else if (userVerificationStatus === 'unverified') {
      userFilter.emailVerified = false;
      userFilter.bvnVerified = false;
    }

    // FIXED: Search logic - build $or array for EITHER user match OR transaction field match
    let userIds = [];
    if (searchTerm) {
      const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escapeRegex(searchTerm), 'i');

      // Search for matching users
      const matchingUsers = await User.find({
        $or: [
          { username: regex },
          { email: regex },
          { firstname: regex },
          { lastname: regex },
          { phoneNumber: regex }
        ],
        ...userFilter
      }).select('_id').lean();

      userIds = matchingUsers.map(u => u._id);

      // Build $or array for EITHER user match OR transaction field match
      const searchOrClauses = [];
      
      // Add user ID matches
      if (userIds.length > 0) {
        searchOrClauses.push({ userId: { $in: userIds } });
      }
      
      // Add transaction field matches
      if (mongoose.Types.ObjectId.isValid(searchTerm)) {
        searchOrClauses.push({ _id: mongoose.Types.ObjectId(searchTerm) });
      }
      searchOrClauses.push({ transactionId: regex });
      searchOrClauses.push({ reference: regex });
      searchOrClauses.push({ narration: regex });
      
      // Set as $or so ANY condition matches
      if (searchOrClauses.length > 0) {
        transactionFilter.$or = searchOrClauses;
      }
    }

    console.log('Filter query:', JSON.stringify(transactionFilter, null, 2));

    // Execute queries in parallel
    const [transactions, transactionCount, users, userCount] = await Promise.all([
      Transaction.find(transactionFilter)
        .sort({ createdAt: -1 })
        .limit(limitNum)
        .skip(skip)
        .populate('userId', 'username email firstname lastname')
        .lean(),
      Transaction.countDocuments(transactionFilter),
      searchTerm || Object.keys(userFilter).length > 0
        ? User.find({
            ...(searchTerm && userIds.length > 0 ? { _id: { $in: userIds } } : {}),
            ...userFilter
          })
          .sort({ createdAt: -1 })
          .limit(limitNum)
          .select('username email firstname lastname emailVerified bvnVerified chatbotTransactionVerified createdAt')
          .lean()
        : [],
      searchTerm || Object.keys(userFilter).length > 0
        ? User.countDocuments({
            ...(searchTerm && userIds.length > 0 ? { _id: { $in: userIds } } : {}),
            ...userFilter
          })
        : 0
    ]);

    console.log(`Found ${transactions.length} transactions, ${users.length} users`);

    // Format transactions
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
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
      ...(tx.type === 'SWAP' || tx.type === 'OBIEX_SWAP' ? {
        fromCurrency: tx.fromCurrency,
        toCurrency: tx.toCurrency,
        fromAmount: tx.fromAmount,
        toAmount: tx.toAmount,
        swapType: tx.swapType
      } : {}),
      ...(tx.isNGNZWithdrawal ? {
        bankName: tx.ngnzWithdrawal?.destination?.bankName,
        accountName: tx.ngnzWithdrawal?.destination?.accountName,
        withdrawalFee: tx.withdrawalFee
      } : {})
    }));

    // Format users
    const formattedUsers = users.map(user => ({
      id: user._id.toString(),
      username: user.username,
      email: user.email,
      firstname: user.firstname,
      lastname: user.lastname,
      emailVerified: user.emailVerified || false,
      bvnVerified: user.bvnVerified || false,
      chatbotVerified: user.chatbotTransactionVerified || false,
      createdAt: user.createdAt
    }));

    // Calculate aggregate statistics
    const aggregateStats = await Transaction.aggregate([
      { $match: transactionFilter },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: { $abs: '$amount' } },
          totalFees: { $sum: '$fee' },
          avgAmount: { $avg: { $abs: '$amount' } },
          successfulCount: {
            $sum: {
              $cond: [{ $in: ['$status', ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED']] }, 1, 0]
            }
          },
          pendingCount: {
            $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0] }
          },
          failedCount: {
            $sum: { $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0] }
          }
        }
      }
    ]);

    const totalPages = Math.ceil(Math.max(transactionCount, userCount) / limitNum);

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      filters: {
        searchTerm: searchTerm || null,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        transactionType: transactionType || null,
        transactionStatus: transactionStatus || null,
        userVerificationStatus: userVerificationStatus || null,
        currency: currency || null,
        minAmount: minAmount || null,
        maxAmount: maxAmount || null
      },
      pagination: {
        currentPage: pageNum,
        totalPages,
        limit: limitNum,
        totalCount: Math.max(transactionCount, userCount),
        transactionCount,
        userCount,
        hasNextPage: pageNum < totalPages,
        hasPreviousPage: pageNum > 1
      },
      aggregateStats: {
        totalAmount: aggregateStats[0]?.totalAmount || 0,
        totalFees: aggregateStats[0]?.totalFees || 0,
        avgAmount: aggregateStats[0]?.avgAmount || 0,
        successfulCount: aggregateStats[0]?.successfulCount || 0,
        pendingCount: aggregateStats[0]?.pendingCount || 0,
        failedCount: aggregateStats[0]?.failedCount || 0
      },
      data: {
        transactions: formattedTransactions,
        users: formattedUsers
      }
    });

  } catch (error) {
    console.error('Error in universal filter endpoint:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to filter data',
      message: error.message
    });
  }
});

/**
 * GET /analytics/swap-pairs
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