const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');

// POST /api/balance with { "types": ["all"] } or a list of allowed balance fields
router.post('/balance', async (req, res) => {
  try {
    const userId = req.user.id;
    const { types } = req.body;

    if (!userId) {
      logger.warn('Unauthorized request - missing userId', { route: '/balance' });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!types || !Array.isArray(types) || types.length === 0) {
      logger.warn('Bad request - missing or invalid types array', { userId });
      return res.status(400).json({ error: 'Missing or invalid "types" array in request body' });
    }

    // Complete list of allowed balance fields from User schema
    const allowedFields = [
      // SOL balances
      'solBalance', 'solBalanceUSD', 'solPendingBalance',
      
      // BTC balances
      'btcBalance', 'btcBalanceUSD', 'btcPendingBalance',
      
      // USDT balances
      'usdtBalance', 'usdtBalanceUSD', 'usdtPendingBalance',
      
      // USDC balances
      'usdcBalance', 'usdcBalanceUSD', 'usdcPendingBalance',
      
      // ETH balances
      'ethBalance', 'ethBalanceUSD', 'ethPendingBalance',
      
      // BNB balances
      'bnbBalance', 'bnbBalanceUSD', 'bnbPendingBalance',
      
      // DOGE balances
      'dogeBalance', 'dogeBalanceUSD', 'dogePendingBalance',
      
      // MATIC balances
      'maticBalance', 'maticBalanceUSD', 'maticPendingBalance',
      
      // AVAX balances
      'avaxBalance', 'avaxBalanceUSD', 'avaxPendingBalance',
      
      // NGNB balances
      'ngnbBalance', 'ngnbBalanceUSD', 'ngnbPendingBalance',
      
      // Total portfolio
      'totalPortfolioBalance'
    ];

    let finalFields = [];

    if (types.includes('all')) {
      finalFields = allowedFields;
    } else {
      // Validate requested types
      const invalidFields = types.filter(field => !allowedFields.includes(field));
      if (invalidFields.length > 0) {
        logger.warn('Invalid balance type(s) requested', { userId, invalidFields });
        return res.status(400).json({ error: `Invalid balance type(s): ${invalidFields.join(', ')}` });
      }
      finalFields = types;
    }

    const projection = {};
    finalFields.forEach(field => projection[field] = 1);

    const user = await User.findById(userId, projection);

    if (!user) {
      logger.error('User not found while fetching balances', { userId });
      return res.status(404).json({ error: 'User not found' });
    }

    const response = {};
    finalFields.forEach(field => {
      response[field] = user[field];
    });

    logger.info('Balances fetched', { userId, requestedFields: finalFields });

    return res.status(200).json(response);
  } catch (error) {
    logger.error('Error fetching balances', {
      userId: req.user?.id || 'unknown',
      error: error.message,
      stack: error.stack
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;