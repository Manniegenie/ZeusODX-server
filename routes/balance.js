const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger'); // adjust path as needed

// GET /api/balance?type=solBalanceUSD
router.get('/balance', async (req, res) => {
  try {
    const userId = req.user.id; // From your JWT middleware
    const { type } = req.query;

    if (!userId) {
      logger.warn('Unauthorized request - missing userId', { route: '/balance' });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!type) {
      logger.warn('Bad request - missing type parameter', { userId });
      return res.status(400).json({ error: 'Missing type parameter' });
    }

    // Allowed balance fields
    const allowedFields = [
      'solBalance', 'solBalanceUSD',
      'btcBalance', 'btcBalanceUSD',
      'usdtBalance', 'usdtBalanceUSD',
      'usdcBalance', 'usdcBalanceUSD',
      'ethBalance', 'ethBalanceUSD',
      'totalPortfolioBalance'
    ];

    if (!allowedFields.includes(type)) {
      logger.warn('Bad request - invalid balance type', { userId, requestedType: type });
      return res.status(400).json({ error: 'Invalid balance type requested' });
    }

    const projection = {};
    projection[type] = 1;

    const user = await User.findById(userId, projection);

    if (!user) {
      logger.error('User not found while fetching balance', { userId, requestedType: type });
      return res.status(404).json({ error: 'User not found' });
    }

    logger.info('Balance fetched successfully', {
      userId,
      balanceType: type,
      balanceValue: user[type]
    });

    return res.status(200).json({ [type]: user[type] });
  } catch (error) {
    logger.error('Error fetching balance', {
      userId: req.user?.id || 'unknown',
      error: error.message,
      stack: error.stack
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
