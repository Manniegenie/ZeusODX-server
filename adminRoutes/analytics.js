// routes/analytics.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Decimal = require('decimal.js');

const User = require('../models/user');
const Transaction = require('../models/transaction');
const BillTransaction = require('../models/billstransaction');
const NairaMarkdown = require('../models/offramp');
const { getPricesWithCache, SUPPORTED_TOKENS } = require('../services/portfolio');
const GiftCard = require('../models/giftcard'); // Add this if not already present

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
          // Include: GIFTCARD (all), SWAP/OBIEX_SWAP where swapDirection is OUT, missing, or null
          // Exclude: SWAP/OBIEX_SWAP where swapDirection is IN
          $or: [
            { type: 'GIFTCARD' },
            { type: { $in: ['SWAP', 'OBIEX_SWAP'] }, swapDirection: 'OUT' },
            { type: { $in: ['SWAP', 'OBIEX_SWAP'] }, swapDirection: { $exists: false } },
            { type: { $in: ['SWAP', 'OBIEX_SWAP'] }, swapDirection: null }
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

    // NOTE:
    // - Keep NGNZ (priced via offramp rate)
    // - Keep USD (giftcards often use USD as currency; USD/USD = 1)
    // - Keep supported crypto tokens (priced via getPricesWithCache)
    const currencies = agg
      .map(r => (r?._id ? String(r._id).toUpperCase() : null))
      .filter((c) => {
        if (!c) return false;
        if (c === 'NGNZ') return true;
        if (c === 'USD') return true;
        return !!SUPPORTED_TOKENS[c];
      });

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

      // Giftcards are often stored as USD face value; USD/USD = 1
      if (currency === 'USD') {
        const usdValue = totalAmountDecimal;
        totalVolumeUSD = totalVolumeUSD.plus(usdValue);
        breakdown[currency] = {
          totalAmount: totalAmountDecimal.toString(),
          usdValue: usdValue.toString(),
          price: 1
        };
        processedCurrencies++;
        continue;
      }

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
      pendingTradesStats,
      approvedGiftCardsCount,
      rejectedGiftCardsCount,
      paidGiftCardsCount
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
      // Include legacy swaps without swapDirection, exclude IN swaps
      Transaction.aggregate([
        {
          $match: {
            type: { $in: ['SWAP', 'OBIEX_SWAP'] },
            // Include OUT, missing, or null swapDirection (exclude IN)
            $or: [
              { swapDirection: 'OUT' },
              { swapDirection: { $exists: false } },
              { swapDirection: null }
            ]
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
      // Include legacy swaps without swapDirection, exclude IN swaps
      Transaction.aggregate([
        {
          $match: {
            status: 'PENDING',
            $or: [
              { type: 'GIFTCARD' },
              { type: { $in: ['SWAP', 'OBIEX_SWAP'] }, swapDirection: 'OUT' },
              { type: { $in: ['SWAP', 'OBIEX_SWAP'] }, swapDirection: { $exists: false } },
              { type: { $in: ['SWAP', 'OBIEX_SWAP'] }, swapDirection: null }
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
      ]),

      GiftCard.countDocuments({ status: 'APPROVED' }),
      GiftCard.countDocuments({ status: 'REJECTED' }),
      GiftCard.countDocuments({ status: 'PAID' })
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
        transactionVolumeCounts: transactionVolumeResult?.counts ?? { totalCurrencies: 0, processedCurrencies: 0, skippedCurrencies: 0 },
        giftCardStats: {
          approved: (Number(approvedGiftCardsCount) || 0) + (Number(paidGiftCardsCount) || 0),
          rejected: Number(rejectedGiftCardsCount) || 0,
          paid: Number(paidGiftCardsCount) || 0
        }
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

    const BILL_TYPES = ['airtime', 'data', 'electricity', 'cable_tv', 'internet', 'betting', 'education'];
    const isBillType = type && BILL_TYPES.includes(type.toLowerCase());
    const isRegularType = type && !isBillType;

    // Build bill filter from same params
    const billFilter = {};
    if (filter.userId) billFilter.userId = filter.userId;
    if (filter.createdAt) billFilter.createdAt = filter.createdAt;
    if (isBillType) billFilter.billType = type.toLowerCase();
    // Map status: frontend uses SUCCESSFUL/PENDING/FAILED
    if (status) {
      const statusMap = { SUCCESSFUL: 'completed', COMPLETED: 'completed', CONFIRMED: 'completed', PENDING: ['initiated-api', 'processing-api'], FAILED: 'failed' };
      const mapped = statusMap[status.toUpperCase()];
      if (Array.isArray(mapped)) billFilter.status = { $in: mapped };
      else if (mapped) billFilter.status = mapped;
    }

    if (isRegularType) filter.type = type;
    if (!isBillType && status) filter.status = status;

    let formattedTransactions = [];
    let totalCount = 0;

    if (isBillType) {
      // Only query BillTransaction
      const [bills, count] = await Promise.all([
        BillTransaction.find(billFilter)
          .sort({ createdAt: -1 })
          .limit(limit)
          .skip(skip)
          .populate('userId', 'username email firstname lastname')
          .lean(),
        BillTransaction.countDocuments(billFilter)
      ]);
      totalCount = count;
      formattedTransactions = bills.map(bill => normalizeBillTx(bill));
    } else if (isRegularType) {
      // Only query Transaction
      const [transactions, count] = await Promise.all([
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
      totalCount = count;
      formattedTransactions = transactions.map(tx => formatRegularTx(tx));
    } else {
      // No type filter — merge both collections
      const fetchLimit = skip + limit;
      const [transactions, txCount, bills, billCount] = await Promise.all([
        Transaction.find(filter)
          .sort({ createdAt: -1 })
          .limit(fetchLimit)
          .populate('userId', 'username email firstname lastname')
          .populate('recipientUserId', 'username')
          .populate('senderUserId', 'username')
          .lean(),
        Transaction.countDocuments(filter),
        BillTransaction.find(billFilter)
          .sort({ createdAt: -1 })
          .limit(fetchLimit)
          .populate('userId', 'username email firstname lastname')
          .lean(),
        BillTransaction.countDocuments(billFilter)
      ]);
      totalCount = txCount + billCount;
      const merged = [
        ...transactions.map(tx => formatRegularTx(tx)),
        ...bills.map(bill => normalizeBillTx(bill))
      ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      formattedTransactions = merged.slice(skip, skip + limit);
    }

    function normalizeBillTx(bill) {
      const statusMap = { 'completed': 'SUCCESSFUL', 'failed': 'FAILED', 'refunded': 'FAILED', 'initiated-api': 'PENDING', 'processing-api': 'PENDING' };
      return {
        id: bill._id.toString(),
        userId: bill.userId?._id?.toString(),
        username: bill.userId?.username || bill.userId?.firstname || 'Unknown',
        userEmail: bill.userId?.email,
        type: bill.billType.toUpperCase(),
        status: statusMap[bill.status] || bill.status,
        currency: bill.paymentCurrency || 'NGNZ',
        amount: -(Math.abs(bill.amountNGNZ || bill.amountNaira || bill.amount || 0)),
        fee: 0,
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
      };
    }

    function formatRegularTx(tx) {
      let displayAmount = tx.amount;
      if (tx.type === 'DEPOSIT' || tx.type === 'INTERNAL_TRANSFER_RECEIVED') {
        displayAmount = Math.abs(tx.amount);
      } else if (tx.type === 'WITHDRAWAL' || tx.type === 'INTERNAL_TRANSFER_SENT') {
        displayAmount = -Math.abs(tx.amount);
      }
      return {
        id: tx._id.toString(),
        userId: tx.userId?._id?.toString(),
        username: tx.userId?.username || tx.userId?.firstname || 'Unknown',
        userEmail: tx.userId?.email,
        type: tx.type,
        status: tx.status,
        currency: tx.currency,
        amount: displayAmount,
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
          accountNumber: tx.ngnzWithdrawal?.destination?.accountNumber,
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
      };
    }

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
    const formattedTransactions = transactions.map(tx => {
      // Ensure correct sign convention for display:
      // - DEPOSIT, INTERNAL_TRANSFER_RECEIVED: positive
      // - WITHDRAWAL, INTERNAL_TRANSFER_SENT: negative
      let displayAmount = tx.amount;
      
      // Validate and correct sign based on transaction type
      if (tx.type === 'DEPOSIT' || tx.type === 'INTERNAL_TRANSFER_RECEIVED') {
        // Should be positive
        displayAmount = Math.abs(tx.amount);
      } else if (tx.type === 'WITHDRAWAL' || tx.type === 'INTERNAL_TRANSFER_SENT') {
        // Should be negative
        displayAmount = -Math.abs(tx.amount);
      }
      
      return {
        id: tx._id.toString(),
        userId: tx.userId?._id?.toString(),
        username: tx.userId?.username || tx.userId?.firstname || 'Unknown',
        userEmail: tx.userId?.email,
        type: tx.type,
        status: tx.status,
        currency: tx.currency,
        amount: displayAmount,
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
        accountNumber: tx.ngnzWithdrawal?.destination?.accountNumber, // Show full account number for admin
        withdrawalFee: tx.withdrawalFee
      } : {})
      };
    });

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

/**
 * GET /analytics/platform-stats
 * Comprehensive platform statistics:
 * 1. Total user wallet balances (USD and Naira)
 * 2. Total utility spending
 * 3. Profit from markdowns (withdrawals and swaps)
 */
router.get('/platform-stats', async (req, res) => {
  try {
    console.log('=== Platform Stats Request Started ===');

    const { dateFrom, dateTo } = req.query;
    const dateFilter = {};
    if (dateFrom) dateFilter.$gte = new Date(dateFrom);
    if (dateTo) dateFilter.$lte = new Date(dateTo);
    const hasDateFilter = !!(dateFrom || dateTo);

    // Get offramp rate for Naira conversion
    const nairaMarkdown = await NairaMarkdown.findOne();
    const offrampRate = nairaMarkdown?.offrampRate || 1554.42;

    // Get current crypto prices
    const cryptoTokens = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'TRX'];
    let prices = {};
    try {
      prices = await getPricesWithCache(cryptoTokens) || {};
    } catch (e) {
      console.warn('getPricesWithCache failed, using fallback prices:', e.message);
      prices = { BTC: 65000, ETH: 3200, SOL: 200, USDT: 1, USDC: 1, BNB: 580, MATIC: 0.85, TRX: 0.14 };
    }

    // Calculate NGNZ price in USD
    const ngnzPriceUsd = 1 / offrampRate;

    // 1. AGGREGATE TOTAL USER WALLET BALANCES
    const walletBalances = await User.aggregate([
      {
        $group: {
          _id: null,
          totalBtc: { $sum: { $ifNull: ['$btcBalance', 0] } },
          totalEth: { $sum: { $ifNull: ['$ethBalance', 0] } },
          totalSol: { $sum: { $ifNull: ['$solBalance', 0] } },
          totalUsdt: { $sum: { $ifNull: ['$usdtBalance', 0] } },
          totalUsdc: { $sum: { $ifNull: ['$usdcBalance', 0] } },
          totalBnb: { $sum: { $ifNull: ['$bnbBalance', 0] } },
          totalMatic: { $sum: { $ifNull: ['$maticBalance', 0] } },
          totalTrx: { $sum: { $ifNull: ['$trxBalance', 0] } },
          totalNgnz: { $sum: { $ifNull: ['$ngnzBalance', 0] } },
          // Pending balances
          totalBtcPending: { $sum: { $ifNull: ['$btcPendingBalance', 0] } },
          totalEthPending: { $sum: { $ifNull: ['$ethPendingBalance', 0] } },
          totalSolPending: { $sum: { $ifNull: ['$solPendingBalance', 0] } },
          totalUsdtPending: { $sum: { $ifNull: ['$usdtPendingBalance', 0] } },
          totalUsdcPending: { $sum: { $ifNull: ['$usdcPendingBalance', 0] } },
          totalBnbPending: { $sum: { $ifNull: ['$bnbPendingBalance', 0] } },
          totalMaticPending: { $sum: { $ifNull: ['$maticPendingBalance', 0] } },
          totalTrxPending: { $sum: { $ifNull: ['$trxPendingBalance', 0] } },
          totalNgnzPending: { $sum: { $ifNull: ['$ngnzPendingBalance', 0] } },
          userCount: { $sum: 1 }
        }
      }
    ]);

    const balances = walletBalances[0] || {};

    // Calculate USD values for each token
    const balanceBreakdown = {
      BTC: {
        amount: balances.totalBtc || 0,
        pendingAmount: balances.totalBtcPending || 0,
        price: prices.BTC || 0,
        usdValue: (balances.totalBtc || 0) * (prices.BTC || 0),
        pendingUsdValue: (balances.totalBtcPending || 0) * (prices.BTC || 0)
      },
      ETH: {
        amount: balances.totalEth || 0,
        pendingAmount: balances.totalEthPending || 0,
        price: prices.ETH || 0,
        usdValue: (balances.totalEth || 0) * (prices.ETH || 0),
        pendingUsdValue: (balances.totalEthPending || 0) * (prices.ETH || 0)
      },
      SOL: {
        amount: balances.totalSol || 0,
        pendingAmount: balances.totalSolPending || 0,
        price: prices.SOL || 0,
        usdValue: (balances.totalSol || 0) * (prices.SOL || 0),
        pendingUsdValue: (balances.totalSolPending || 0) * (prices.SOL || 0)
      },
      USDT: {
        amount: balances.totalUsdt || 0,
        pendingAmount: balances.totalUsdtPending || 0,
        price: prices.USDT || 1,
        usdValue: (balances.totalUsdt || 0) * (prices.USDT || 1),
        pendingUsdValue: (balances.totalUsdtPending || 0) * (prices.USDT || 1)
      },
      USDC: {
        amount: balances.totalUsdc || 0,
        pendingAmount: balances.totalUsdcPending || 0,
        price: prices.USDC || 1,
        usdValue: (balances.totalUsdc || 0) * (prices.USDC || 1),
        pendingUsdValue: (balances.totalUsdcPending || 0) * (prices.USDC || 1)
      },
      BNB: {
        amount: balances.totalBnb || 0,
        pendingAmount: balances.totalBnbPending || 0,
        price: prices.BNB || 0,
        usdValue: (balances.totalBnb || 0) * (prices.BNB || 0),
        pendingUsdValue: (balances.totalBnbPending || 0) * (prices.BNB || 0)
      },
      MATIC: {
        amount: balances.totalMatic || 0,
        pendingAmount: balances.totalMaticPending || 0,
        price: prices.MATIC || 0,
        usdValue: (balances.totalMatic || 0) * (prices.MATIC || 0),
        pendingUsdValue: (balances.totalMaticPending || 0) * (prices.MATIC || 0)
      },
      TRX: {
        amount: balances.totalTrx || 0,
        pendingAmount: balances.totalTrxPending || 0,
        price: prices.TRX || 0,
        usdValue: (balances.totalTrx || 0) * (prices.TRX || 0),
        pendingUsdValue: (balances.totalTrxPending || 0) * (prices.TRX || 0)
      },
      NGNZ: {
        amount: balances.totalNgnz || 0,
        pendingAmount: balances.totalNgnzPending || 0,
        price: ngnzPriceUsd,
        usdValue: (balances.totalNgnz || 0) * ngnzPriceUsd,
        pendingUsdValue: (balances.totalNgnzPending || 0) * ngnzPriceUsd,
        nairaValue: balances.totalNgnz || 0, // NGNZ is 1:1 with Naira
        pendingNairaValue: balances.totalNgnzPending || 0
      }
    };

    // Calculate totals
    const totalUsdValue = Object.values(balanceBreakdown).reduce((sum, token) => sum + token.usdValue, 0);
    const totalPendingUsdValue = Object.values(balanceBreakdown).reduce((sum, token) => sum + token.pendingUsdValue, 0);
    const totalNairaValue = totalUsdValue * offrampRate;
    const totalPendingNairaValue = totalPendingUsdValue * offrampRate;

    // 2. AGGREGATE TOTAL UTILITY SPENDING (from BillTransaction)
    const BillTransaction = require('../models/billstransaction');
    const utilityMatchQuery = { status: 'completed' };
    if (hasDateFilter) utilityMatchQuery.createdAt = dateFilter;
    const utilityStats = await BillTransaction.aggregate([
      {
        $match: utilityMatchQuery
      },
      {
        $group: {
          _id: '$billType',
          totalAmount: { $sum: { $ifNull: ['$amountNaira', 0] } },
          totalAmountNGNZ: { $sum: { $ifNull: ['$amountNGNZ', 0] } },
          count: { $sum: 1 }
        }
      }
    ]);

    const utilityBreakdown = {};
    let totalUtilitySpent = 0;
    let totalUtilityCount = 0;

    for (const stat of utilityStats) {
      utilityBreakdown[stat._id] = {
        totalNaira: stat.totalAmount,
        totalNGNZ: stat.totalAmountNGNZ,
        count: stat.count,
        usdValue: stat.totalAmount / offrampRate
      };
      totalUtilitySpent += stat.totalAmount;
      totalUtilityCount += stat.count;
    }

    // 3. CALCULATE PROFIT FROM MARKDOWNS
    // Get global markdown settings
    const GlobalMarkdown = require('../models/pricemarkdown');
    const SwapMarkdown = require('../models/swapmarkdown');

    let globalMarkdown = null;
    let swapMarkdown = null;

    try {
      globalMarkdown = await GlobalMarkdown.getCurrentMarkdown();
    } catch (e) {
      console.warn('Could not fetch global markdown:', e.message);
    }

    try {
      swapMarkdown = await SwapMarkdown.findOne();
    } catch (e) {
      console.warn('Could not fetch swap markdown:', e.message);
    }

    // Calculate profit from NGNZ withdrawals (fee retained)
    const withdrawalMatchQuery = { isNGNZWithdrawal: true, status: { $in: ['SUCCESSFUL', 'COMPLETED'] } };
    if (hasDateFilter) withdrawalMatchQuery.createdAt = dateFilter;
    const withdrawalProfitStats = await Transaction.aggregate([
      {
        $match: withdrawalMatchQuery
      },
      {
        $group: {
          _id: null,
          totalWithdrawalFees: { $sum: { $ifNull: ['$withdrawalFee', 0] } },
          totalWithdrawals: { $sum: 1 },
          totalAmountWithdrawn: { $sum: { $abs: '$amount' } },
          totalBankAmount: { $sum: { $ifNull: ['$bankAmount', 0] } }
        }
      }
    ]);

    const withdrawalProfit = withdrawalProfitStats[0] || {
      totalWithdrawalFees: 0,
      totalWithdrawals: 0,
      totalAmountWithdrawn: 0,
      totalBankAmount: 0
    };

    // Calculate profit from swaps (markdown difference)
    // For swaps, profit = fromAmount * fromPrice - toAmount * toPrice (when markdown is applied)
    // Include legacy swaps without swapDirection, exclude IN swaps
    const swapMatchQuery = {
      type: { $in: ['SWAP', 'OBIEX_SWAP'] },
      status: 'SUCCESSFUL',
      $or: [
        { swapDirection: 'OUT' },
        { swapDirection: { $exists: false } },
        { swapDirection: null }
      ]
    };
    if (hasDateFilter) swapMatchQuery.createdAt = dateFilter;
    const swapProfitStats = await Transaction.aggregate([
      {
        $match: swapMatchQuery
      },
      {
        $group: {
          _id: null,
          totalSwaps: { $sum: 1 },
          totalFromAmount: { $sum: { $ifNull: ['$fromAmount', 0] } },
          totalToAmount: { $sum: { $ifNull: ['$toAmount', 0] } },
          totalFees: { $sum: { $ifNull: ['$fee', 0] } },
          totalObiexFees: { $sum: { $ifNull: ['$obiexFee', 0] } }
        }
      }
    ]);

    const swapProfit = swapProfitStats[0] || {
      totalSwaps: 0,
      totalFromAmount: 0,
      totalToAmount: 0,
      totalFees: 0,
      totalObiexFees: 0
    };

    // Calculate estimated markdown profit from swaps
    // This is an approximation based on markdown percentage
    const swapMarkdownPercentage = swapMarkdown?.markdownPercentage || 0;
    const estimatedSwapMarkdownProfit = swapMarkdownPercentage > 0
      ? (swapProfit.totalFromAmount * (swapMarkdownPercentage / 100))
      : 0;

    // Calculate estimated markdown profit from crypto prices (price markdown)
    const globalMarkdownPercentage = globalMarkdown?.markdownPercentage || 0;

    // Build response
    const response = {
      success: true,
      timestamp: new Date().toISOString(),
      data: {
        // 1. Total Wallet Balances
        walletBalances: {
          totalUsd: parseFloat(totalUsdValue.toFixed(2)),
          totalNaira: parseFloat(totalNairaValue.toFixed(2)),
          totalPendingUsd: parseFloat(totalPendingUsdValue.toFixed(2)),
          totalPendingNaira: parseFloat(totalPendingNairaValue.toFixed(2)),
          grandTotalUsd: parseFloat((totalUsdValue + totalPendingUsdValue).toFixed(2)),
          grandTotalNaira: parseFloat((totalNairaValue + totalPendingNairaValue).toFixed(2)),
          userCount: balances.userCount || 0,
          breakdown: balanceBreakdown,
          conversionRate: {
            usdToNaira: offrampRate,
            nairaToUsd: ngnzPriceUsd
          }
        },

        // 2. Utility Spending
        utilitySpending: {
          totalNaira: totalUtilitySpent,
          totalUsd: parseFloat((totalUtilitySpent / offrampRate).toFixed(2)),
          totalTransactions: totalUtilityCount,
          breakdown: utilityBreakdown
        },

        // 3. Profit & Revenue
        profits: {
          // Withdrawal fees (direct profit)
          withdrawals: {
            totalFeesCollected: withdrawalProfit.totalWithdrawalFees,
            totalFeesUsd: parseFloat((withdrawalProfit.totalWithdrawalFees / offrampRate).toFixed(2)),
            totalTransactions: withdrawalProfit.totalWithdrawals,
            totalAmountProcessed: withdrawalProfit.totalAmountWithdrawn,
            totalSentToBank: withdrawalProfit.totalBankAmount
          },

          // Swap markdown profit (estimated)
          swaps: {
            totalSwaps: swapProfit.totalSwaps,
            markdownPercentage: swapMarkdownPercentage,
            estimatedMarkdownProfit: parseFloat(estimatedSwapMarkdownProfit.toFixed(2)),
            estimatedMarkdownProfitUsd: parseFloat((estimatedSwapMarkdownProfit / offrampRate).toFixed(2)),
            totalFeesCollected: swapProfit.totalFees,
            totalObiexFees: swapProfit.totalObiexFees
          },

          // Price markdown (affects displayed prices)
          priceMarkdown: {
            percentage: globalMarkdownPercentage,
            isActive: globalMarkdown?.isActive || false,
            description: 'Applied to crypto prices (reduces displayed price to user)'
          },

          // Combined totals
          summary: {
            totalDirectFeesNaira: withdrawalProfit.totalWithdrawalFees + swapProfit.totalFees,
            totalDirectFeesUsd: parseFloat(((withdrawalProfit.totalWithdrawalFees + swapProfit.totalFees) / offrampRate).toFixed(2)),
            totalEstimatedMarkdownProfit: parseFloat(estimatedSwapMarkdownProfit.toFixed(2)),
            totalEstimatedMarkdownProfitUsd: parseFloat((estimatedSwapMarkdownProfit / offrampRate).toFixed(2))
          }
        },

        // Current settings
        currentSettings: {
          offrampRate: offrampRate,
          globalMarkdownPercentage: globalMarkdownPercentage,
          swapMarkdownPercentage: swapMarkdownPercentage
        }
      }
    };

    response.filters = { dateFrom: dateFrom || null, dateTo: dateTo || null };
    console.log('=== Platform Stats Request Complete ===');
    res.json(response);

  } catch (error) {
    console.error('Error fetching platform stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch platform statistics',
      message: error.message
    });
  }
});

/**
 * GET /analytics/volumes
 * Returns total deposit and withdrawal volumes (USD, using trade volume logic)
 */
router.get('/volumes', async (req, res) => {
  try {
    // Get offramp rate for NGNZ
    const nairaMarkdown = await NairaMarkdown.findOne();
    let offrampRate = nairaMarkdown?.offrampRate || 1554.42;
    if (!offrampRate || isNaN(offrampRate) || Number(offrampRate) === 0) {
      offrampRate = 1554.42;
    }

    // Aggregate deposits (some historical rows may have negative amounts; use abs for robustness)
    const depositAgg = await Transaction.aggregate([
      {
        $match: {
          type: 'DEPOSIT',
          status: 'CONFIRMED',
          amount: { $ne: 0 },
          currency: { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: { $toUpper: '$currency' },
          totalAmount: { $sum: { $abs: '$amount' } }
        }
      }
    ]);

    // Aggregate withdrawals
    // IMPORTANT:
    // - NGNZ withdrawals use negative `amount` (by convention)
    // - Crypto withdrawals in `routes/withdraw.js` currently save POSITIVE `amount`
    // So we must use abs(amount) and not rely on sign.
    const withdrawalAgg = await Transaction.aggregate([
      {
        $match: {
          type: 'WITHDRAWAL',
          status: { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] },
          amount: { $ne: 0 },
          currency: { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: { $toUpper: '$currency' },
          totalAmount: { $sum: { $abs: '$amount' } }
        }
      }
    ]);

    // Get all unique currencies
    const allCurrencies = Array.from(new Set([
      ...depositAgg.map(d => d._id),
      ...withdrawalAgg.map(w => w._id)
    ])).filter(Boolean);

    // Get prices for all currencies that require market pricing
    // - NGNZ is derived from offramp rate
    // - USD is 1
    const priceCurrencies = allCurrencies.filter((c) => c && c !== 'NGNZ' && c !== 'USD' && SUPPORTED_TOKENS[c]);
    let prices = {};
    try {
      prices = await getPricesWithCache(priceCurrencies) || {};
    } catch (e) {
      prices = {};
    }

    // Helper to convert to USD
    function toUSD(currency, amount) {
      const cur = String(currency || '').toUpperCase();
      const amt = Number(amount) || 0;
      if (!amt) return 0;
      if (cur === 'USD') return amt;
      if (cur === 'NGNZ') {
        return Number(offrampRate) ? amt / Number(offrampRate) : 0;
      }
      const price = prices[cur];
      return price ? amt * Number(price) : 0;
    }

    // Sum all deposits and withdrawals in USD
    let totalDepositUSD = 0;
    let totalWithdrawalUSD = 0;
    for (const d of depositAgg) {
      totalDepositUSD += toUSD(d._id, d.totalAmount);
    }
    for (const w of withdrawalAgg) {
      totalWithdrawalUSD += toUSD(w._id, w.totalAmount);
    }

    res.json({
      success: true,
      data: {
        totalDepositUSD: Number(totalDepositUSD.toFixed(2)),
        totalWithdrawalUSD: Number(totalWithdrawalUSD.toFixed(2))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /analytics/top-traders
 * Top users ranked by TOTAL volume (USD):
 *   - ngnzVolume:            NGNZ currency transactions (swaps, bill payments)
 *   - cryptoWithdrawalUsd:   WITHDRAWAL type transactions in any crypto currency
 *   - internalTransferUsd:   SWAP / OBIEX_SWAP / GIFTCARD (crypto-to-crypto / internal)
 * Supports dateFrom, dateTo, limit (default 20)
 */
router.get('/top-traders', async (req, res) => {
  try {
    const { dateFrom, dateTo, limit = 20 } = req.query;

    // Two cases captured in one query:
    // 1. OUT swaps — counts the FROM currency spent (drives totalVolumeUsd + top tokens)
    // 2. IN swaps where currency = NGNZ — counts the NGNZ the user received (drives ngnzVolume display)
    const matchQuery = {
      status: { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] },
      currency: { $exists: true, $ne: null },
      type: { $in: ['SWAP', 'OBIEX_SWAP'] },
      $or: [
        { swapDirection: 'OUT' },
        { swapDirection: 'IN', currency: { $regex: /^ngnz$/i } },
      ],
    };

    if (dateFrom || dateTo) {
      matchQuery.createdAt = {};
      if (dateFrom) matchQuery.createdAt.$gte = new Date(dateFrom);
      if (dateTo) matchQuery.createdAt.$lte = new Date(dateTo);
    }

    const nairaMarkdown = await NairaMarkdown.findOne();
    const offrampRate = nairaMarkdown?.offrampRate || 1554.42;

    // Step 1: Aggregate raw volumes grouped by userId + currency + volume category
    const rawData = await Transaction.aggregate([
      { $match: matchQuery },
      {
        $addFields: {
          normalizedCurrency: { $toUpper: '$currency' },
          volumeCategory: {
            $cond: {
              // IN + NGNZ = naira received; everything else (OUT) = swap volume spent
              if: { $and: [
                { $eq: ['$swapDirection', 'IN'] },
                { $eq: [{ $toUpper: '$currency' }, 'NGNZ'] },
              ]},
              then: 'ngnz',
              else: 'swap',
            },
          },
        },
      },
      {
        $group: {
          _id: {
            userId: '$userId',
            currency: '$normalizedCurrency',
            category: '$volumeCategory',
          },
          totalVolume: { $sum: { $abs: '$amount' } },
          tradeCount: { $sum: 1 },
          lastTradeAt: { $max: '$createdAt' },
        },
      },
    ]);

    // Step 2: Fetch crypto prices for non-NGNZ/non-USD currencies
    const allCurrencies = [...new Set(
      rawData
        .map((r) => r._id.currency)
        .filter((c) => c && c !== 'NGNZ' && c !== 'USD' && SUPPORTED_TOKENS[c])
    )];

    let prices = {};
    try {
      prices = (await getPricesWithCache(allCurrencies)) || {};
    } catch (e) {
      console.warn('Price fetch failed for top-traders:', e.message);
    }

    function toUSD(currency, amount) {
      if (!amount) return 0;
      if (currency === 'NGNZ') return amount / offrampRate;
      if (currency === 'USD') return amount;
      const price = prices[currency];
      return price ? amount * Number(price) : 0;
    }

    // Step 3: Merge into per-user totals
    const userMap = {};
    for (const row of rawData) {
      const uid = row._id.userId?.toString();
      if (!uid) continue;

      if (!userMap[uid]) {
        userMap[uid] = {
          userId: uid,
          ngnzVolume: 0,   // raw NGNZ received (IN side)
          totalVolumeUsd: 0, // USD value of OUT swaps only
          currencyVolumes: {}, // { [currency]: usdVolume } — used to derive top tokens
        };
      }

      const u = userMap[uid];

      if (row._id.category === 'ngnz') {
        // IN side, NGNZ received — display only, does not affect USD ranking or top tokens
        u.ngnzVolume += row.totalVolume;
      } else {
        // OUT side — drives totalVolumeUsd and top tokens
        const usdVal = toUSD(row._id.currency, row.totalVolume);
        u.currencyVolumes[row._id.currency] = (u.currencyVolumes[row._id.currency] || 0) + usdVal;
        u.totalVolumeUsd += usdVal;
      }
    }

    // Step 4: Sort by total USD volume descending, take top N
    const sorted = Object.values(userMap)
      .map((t) => ({
        ...t,
        // Top 3 tokens ranked by their USD volume contribution
        topTokens: Object.entries(t.currencyVolumes)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([currency]) => currency),
      }))
      .sort((a, b) => b.totalVolumeUsd - a.totalVolumeUsd)
      .slice(0, parseInt(limit));

    // Step 5: Batch user lookup — cast strings to ObjectId to ensure Mongoose matches correctly
    const mongoose = require('mongoose');
    const objectIds = sorted
      .map((t) => { try { return new mongoose.Types.ObjectId(t.userId); } catch { return null; } })
      .filter(Boolean);

    const users = await User.find(
      { _id: { $in: objectIds } },
      { _id: 1, email: 1, firstname: 1, lastname: 1 }
    ).lean();
    const userLookup = Object.fromEntries(users.map((u) => [u._id.toString(), u]));

    const result = sorted
      .map((t) => {
        const user = userLookup[t.userId];
        // Skip traders whose user record no longer exists (deleted accounts)
        if (!user) return null;
        return {
          userId: t.userId,
          email: user.email || '',
          firstname: user.firstname || '',
          lastname: user.lastname || '',
          ngnzVolume: parseFloat(t.ngnzVolume.toFixed(2)),
          totalVolumeUsd: parseFloat(t.totalVolumeUsd.toFixed(2)),
          topTokens: t.topTokens,
          currencies: t.topTokens, // backward-compat alias for old frontend builds
        };
      })
      .filter(Boolean);

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      filters: { dateFrom: dateFrom || null, dateTo: dateTo || null, limit: parseInt(limit) },
      data: { topTraders: result },
    });
  } catch (error) {
    console.error('Error fetching top traders:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch top traders', message: error.message });
  }
});

/**
 * GET /analytics/token-volume
 * Most traded tokens by volume and count with optional date filtering
 */
router.get('/token-volume', async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;

    const matchQuery = {
      status: { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] },
      type: { $in: ['SWAP', 'OBIEX_SWAP', 'DEPOSIT', 'WITHDRAWAL', 'GIFTCARD'] },
      currency: { $exists: true, $ne: null },
    };

    if (dateFrom || dateTo) {
      matchQuery.createdAt = {};
      if (dateFrom) matchQuery.createdAt.$gte = new Date(dateFrom);
      if (dateTo) matchQuery.createdAt.$lte = new Date(dateTo);
    }

    const tokenVolume = await Transaction.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: { $toUpper: '$currency' },
          totalVolume: { $sum: { $abs: '$amount' } },
          tradeCount: { $sum: 1 },
          uniqueUsers: { $addToSet: '$userId' },
        },
      },
      {
        $project: {
          token: '$_id',
          totalVolume: 1,
          tradeCount: 1,
          uniqueUserCount: { $size: '$uniqueUsers' },
        },
      },
      { $sort: { tradeCount: -1 } },
    ]);

    const tokens = tokenVolume.map((t) => t.token).filter((t) => t && t !== 'NGNZ' && t !== 'USD');
    let prices = {};
    try {
      prices = await getPricesWithCache(tokens) || {};
    } catch (e) {
      console.warn('Price fetch failed for token-volume:', e.message);
    }

    const nairaMarkdown = await NairaMarkdown.findOne();
    const offrampRate = nairaMarkdown?.offrampRate || 1554.42;

    const enrichedTokens = tokenVolume
      .map((t) => {
        let usdValue = 0;
        if (t.token === 'NGNZ') {
          usdValue = t.totalVolume / offrampRate;
        } else if (t.token === 'USD') {
          usdValue = t.totalVolume;
        } else if (prices[t.token]) {
          usdValue = t.totalVolume * prices[t.token];
        }
        return { ...t, usdValue: parseFloat(usdValue.toFixed(2)) };
      })
      .sort((a, b) => b.usdValue - a.usdValue);

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      filters: { dateFrom: dateFrom || null, dateTo: dateTo || null },
      data: { tokens: enrichedTokens },
    });
  } catch (error) {
    console.error('Error fetching token volume:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch token volume', message: error.message });
  }
});

// ============================================================
// BALANCE HISTORY & FUNDING HISTORY
// ============================================================

const PlatformSnapshot = require('../models/platformSnapshot');
const FundingEvent     = require('../models/fundingEvent');

/**
 * Shared helper — computes current platform wallet totals.
 * Returns the snapshot payload ready to save or return directly.
 */
async function computePlatformSnapshot() {
  const NairaMarkdown = require('../models/offramp');
  const nairaMarkdown = await NairaMarkdown.findOne();
  const offrampRate   = nairaMarkdown?.offrampRate || 1554.42;
  const ngnzPriceUsd  = 1 / offrampRate;

  const cryptoTokens = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'TRX'];
  let prices = {};
  try {
    prices = await getPricesWithCache(cryptoTokens) || {};
  } catch {
    prices = { BTC: 65000, ETH: 3200, SOL: 200, USDT: 1, USDC: 1, BNB: 580, MATIC: 0.85, TRX: 0.14 };
  }

  const walletBalances = await User.aggregate([
    {
      $group: {
        _id: null,
        totalBtc:       { $sum: { $ifNull: ['$btcBalance', 0] } },
        totalEth:       { $sum: { $ifNull: ['$ethBalance', 0] } },
        totalSol:       { $sum: { $ifNull: ['$solBalance', 0] } },
        totalUsdt:      { $sum: { $ifNull: ['$usdtBalance', 0] } },
        totalUsdc:      { $sum: { $ifNull: ['$usdcBalance', 0] } },
        totalBnb:       { $sum: { $ifNull: ['$bnbBalance', 0] } },
        totalMatic:     { $sum: { $ifNull: ['$maticBalance', 0] } },
        totalTrx:       { $sum: { $ifNull: ['$trxBalance', 0] } },
        totalNgnz:      { $sum: { $ifNull: ['$ngnzBalance', 0] } },
        totalBtcPending:   { $sum: { $ifNull: ['$btcPendingBalance', 0] } },
        totalEthPending:   { $sum: { $ifNull: ['$ethPendingBalance', 0] } },
        totalSolPending:   { $sum: { $ifNull: ['$solPendingBalance', 0] } },
        totalUsdtPending:  { $sum: { $ifNull: ['$usdtPendingBalance', 0] } },
        totalUsdcPending:  { $sum: { $ifNull: ['$usdcPendingBalance', 0] } },
        totalBnbPending:   { $sum: { $ifNull: ['$bnbPendingBalance', 0] } },
        totalMaticPending: { $sum: { $ifNull: ['$maticPendingBalance', 0] } },
        totalTrxPending:   { $sum: { $ifNull: ['$trxPendingBalance', 0] } },
        totalNgnzPending:  { $sum: { $ifNull: ['$ngnzPendingBalance', 0] } },
        userCount: { $sum: 1 },
      },
    },
  ]);

  const b = walletBalances[0] || {};

  const breakdown = {
    BTC:  { amount: b.totalBtc  || 0, pendingAmount: b.totalBtcPending  || 0, priceUsd: prices.BTC  || 0, usdValue: (b.totalBtc  || 0) * (prices.BTC  || 0), pendingUsdValue: (b.totalBtcPending  || 0) * (prices.BTC  || 0) },
    ETH:  { amount: b.totalEth  || 0, pendingAmount: b.totalEthPending  || 0, priceUsd: prices.ETH  || 0, usdValue: (b.totalEth  || 0) * (prices.ETH  || 0), pendingUsdValue: (b.totalEthPending  || 0) * (prices.ETH  || 0) },
    SOL:  { amount: b.totalSol  || 0, pendingAmount: b.totalSolPending  || 0, priceUsd: prices.SOL  || 0, usdValue: (b.totalSol  || 0) * (prices.SOL  || 0), pendingUsdValue: (b.totalSolPending  || 0) * (prices.SOL  || 0) },
    USDT: { amount: b.totalUsdt || 0, pendingAmount: b.totalUsdtPending || 0, priceUsd: prices.USDT || 1, usdValue: (b.totalUsdt || 0) * (prices.USDT || 1), pendingUsdValue: (b.totalUsdtPending || 0) * (prices.USDT || 1) },
    USDC: { amount: b.totalUsdc || 0, pendingAmount: b.totalUsdcPending || 0, priceUsd: prices.USDC || 1, usdValue: (b.totalUsdc || 0) * (prices.USDC || 1), pendingUsdValue: (b.totalUsdcPending || 0) * (prices.USDC || 1) },
    BNB:  { amount: b.totalBnb  || 0, pendingAmount: b.totalBnbPending  || 0, priceUsd: prices.BNB  || 0, usdValue: (b.totalBnb  || 0) * (prices.BNB  || 0), pendingUsdValue: (b.totalBnbPending  || 0) * (prices.BNB  || 0) },
    MATIC:{ amount: b.totalMatic|| 0, pendingAmount: b.totalMaticPending|| 0, priceUsd: prices.MATIC|| 0, usdValue: (b.totalMatic|| 0) * (prices.MATIC|| 0), pendingUsdValue: (b.totalMaticPending|| 0) * (prices.MATIC|| 0) },
    TRX:  { amount: b.totalTrx  || 0, pendingAmount: b.totalTrxPending  || 0, priceUsd: prices.TRX  || 0, usdValue: (b.totalTrx  || 0) * (prices.TRX  || 0), pendingUsdValue: (b.totalTrxPending  || 0) * (prices.TRX  || 0) },
    NGNZ: { amount: b.totalNgnz || 0, pendingAmount: b.totalNgnzPending || 0, priceUsd: ngnzPriceUsd,     usdValue: (b.totalNgnz || 0) * ngnzPriceUsd,        pendingUsdValue: (b.totalNgnzPending || 0) * ngnzPriceUsd },
  };

  const totalUsd          = Object.values(breakdown).reduce((s, t) => s + t.usdValue, 0);
  const totalPendingUsd   = Object.values(breakdown).reduce((s, t) => s + t.pendingUsdValue, 0);
  const totalNaira        = totalUsd * offrampRate;
  const totalPendingNaira = totalPendingUsd * offrampRate;

  return {
    usdToNairaRate: offrampRate,
    totalUsd:       parseFloat(totalUsd.toFixed(2)),
    totalNaira:     parseFloat(totalNaira.toFixed(2)),
    totalPendingUsd:    parseFloat(totalPendingUsd.toFixed(2)),
    totalPendingNaira:  parseFloat(totalPendingNaira.toFixed(2)),
    userCount:      b.userCount || 0,
    breakdown,
  };
}

// POST /analytics/snapshot — manually take a balance snapshot
router.post('/snapshot', async (req, res) => {
  try {
    const adminId = req.admin?._id || req.user?._id;
    const { notes } = req.body;

    const data = await computePlatformSnapshot();
    const snapshot = await PlatformSnapshot.create({
      ...data,
      snapshotType: 'manual',
      takenBy: adminId,
      notes: notes || '',
    });

    res.json({ success: true, message: 'Snapshot saved', data: snapshot });
  } catch (error) {
    console.error('Error creating snapshot:', error);
    res.status(500).json({ success: false, error: 'Failed to create snapshot', message: error.message });
  }
});

// GET /analytics/balance-history — paginated list of snapshots
router.get('/balance-history', async (req, res) => {
  try {
    const { dateFrom, dateTo, page = 1, limit = 30, type } = req.query;
    const query = {};

    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
      if (dateTo)   query.createdAt.$lte = new Date(new Date(dateTo).setHours(23, 59, 59, 999));
    }
    if (type && ['auto', 'manual'].includes(type)) query.snapshotType = type;

    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip     = (pageNum - 1) * limitNum;

    const [snapshots, total] = await Promise.all([
      PlatformSnapshot.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate('takenBy', 'adminName email')
        .lean(),
      PlatformSnapshot.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: {
        snapshots,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      },
    });
  } catch (error) {
    console.error('Error fetching balance history:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch balance history', message: error.message });
  }
});

// POST /analytics/funding-events — log a funding event
router.post('/funding-events', async (req, res) => {
  try {
    const adminId = req.admin?._id || req.user?._id;
    const { type, amountNaira, amountUsd, description, reference } = req.body;

    const validTypes = ['obiex_topup', 'bank_deposit', 'manual_funding', 'platform_withdrawal', 'other'];
    if (!type || !validTypes.includes(type)) {
      return res.status(400).json({ success: false, error: `type must be one of: ${validTypes.join(', ')}` });
    }
    if (!amountNaira && !amountUsd) {
      return res.status(400).json({ success: false, error: 'Provide at least amountNaira or amountUsd' });
    }

    const event = await FundingEvent.create({
      type,
      amountNaira: amountNaira || 0,
      amountUsd:   amountUsd   || 0,
      description: description || '',
      reference:   reference   || '',
      recordedBy:  adminId,
    });

    res.status(201).json({ success: true, message: 'Funding event recorded', data: event });
  } catch (error) {
    console.error('Error recording funding event:', error);
    res.status(500).json({ success: false, error: 'Failed to record funding event', message: error.message });
  }
});

// GET /analytics/funding-history — paginated list of funding events
router.get('/funding-history', async (req, res) => {
  try {
    const { dateFrom, dateTo, page = 1, limit = 30, type } = req.query;
    const query = {};

    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
      if (dateTo)   query.createdAt.$lte = new Date(new Date(dateTo).setHours(23, 59, 59, 999));
    }
    if (type) query.type = type;

    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip     = (pageNum - 1) * limitNum;

    const [events, total] = await Promise.all([
      FundingEvent.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate('recordedBy', 'adminName email')
        .lean(),
      FundingEvent.countDocuments(query),
    ]);

    // Summary totals for the filtered range
    const summary = await FundingEvent.aggregate([
      { $match: query },
      {
        $group: {
          _id: '$type',
          totalNaira: { $sum: '$amountNaira' },
          totalUsd:   { $sum: '$amountUsd' },
          count:      { $sum: 1 },
        },
      },
    ]);

    res.json({
      success: true,
      data: {
        events,
        summary,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      },
    });
  } catch (error) {
    console.error('Error fetching funding history:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch funding history', message: error.message });
  }
});

module.exports = router;
module.exports.computePlatformSnapshot = computePlatformSnapshot;