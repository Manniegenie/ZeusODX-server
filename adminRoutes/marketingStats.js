// adminRoutes/marketingStats.js
const express = require('express');
const router = express.Router();

const User = require('../models/user');
const Transaction = require('../models/transaction');
const GiftCard = require('../models/giftcard');

/**
 * GET /analytics/marketing-stats
 * Marketing & user growth statistics — accessible to moderators and above
 */
router.get('/marketing-stats', async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;

    const dateFilter = {};
    if (dateFrom) dateFilter.$gte = new Date(dateFrom);
    if (dateTo) dateFilter.$lte = new Date(dateTo);
    const hasDateFilter = !!(dateFrom || dateTo);

    const [totalUsers, newUsersInPeriod, verifiedUsers, kycPendingUsers] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments(hasDateFilter ? { createdAt: dateFilter } : {}),
      User.countDocuments({ kycStatus: 'approved' }),
      User.countDocuments({ kycStatus: 'pending' }),
    ]);

    const transactionMatchQuery = {
      status: { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] },
      type: { $in: ['SWAP', 'OBIEX_SWAP', 'GIFTCARD', 'DEPOSIT', 'WITHDRAWAL'] },
    };
    if (hasDateFilter) transactionMatchQuery.createdAt = dateFilter;

    const activeTraderIds = await Transaction.distinct('userId', transactionMatchQuery);

    const regDateFilter = hasDateFilter
      ? dateFilter
      : { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) };

    const dailyRegistrations = await User.aggregate([
      { $match: { createdAt: regDateFilter } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const transactionTypeBreakdown = await Transaction.aggregate([
      { $match: transactionMatchQuery },
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    const giftcardMatchQuery = {};
    if (hasDateFilter) giftcardMatchQuery.createdAt = dateFilter;
    const giftcardCount = await GiftCard.countDocuments(giftcardMatchQuery);

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      filters: { dateFrom: dateFrom || null, dateTo: dateTo || null },
      data: {
        users: {
          total: totalUsers,
          newInPeriod: newUsersInPeriod,
          kycVerified: verifiedUsers,
          kycPending: kycPendingUsers,
          activeTraders: activeTraderIds.length,
          conversionRate: totalUsers > 0 ? parseFloat(((activeTraderIds.length / totalUsers) * 100).toFixed(1)) : 0,
        },
        dailyRegistrations,
        transactionTypeBreakdown,
        giftcardSubmissions: giftcardCount,
      },
    });
  } catch (error) {
    console.error('Error fetching marketing stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch marketing stats', message: error.message });
  }
});

module.exports = router;
