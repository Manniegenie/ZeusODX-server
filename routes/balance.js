const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { getPricesWithCache, SUPPORTED_TOKENS, getOfframpRate } = require('../services/portfolio');
const logger = require('../utils/logger');

/**
 * OPTIMIZED: Calculate USD balances on-demand using cached prices
 * @param {Object} user - User document with token balances
 * @returns {Promise<Object>} Object with calculated USD balances and total
 */
async function calculateUSDBalances(user) {
  try {
    // Get all supported tokens
    const tokens = Object.keys(SUPPORTED_TOKENS);
    
    // Get current prices with offramp rate for NGNZ
    const prices = await getPricesWithCache(tokens, 'portfolio');
    
    const calculatedBalances = {};
    let totalPortfolioUSD = 0;
    
    // Calculate USD values for each token
    for (const token of tokens) {
      const tokenLower = token.toLowerCase();
      const balanceField = `${tokenLower}Balance`;
      const usdBalanceField = `${tokenLower}BalanceUSD`;
      
      // Get token amount from user
      const tokenAmount = user[balanceField] || 0;
      const tokenPrice = prices[token] || 0;
      
      // Calculate USD value
      const usdValue = tokenAmount * tokenPrice;
      
      // Store calculated USD balance
      calculatedBalances[usdBalanceField] = parseFloat(usdValue.toFixed(2));
      
      // Add to total portfolio
      totalPortfolioUSD += usdValue;
      
      logger.debug(`Calculated USD balance for ${token}`, {
        tokenAmount,
        tokenPrice,
        usdValue: calculatedBalances[usdBalanceField],
        usingDynamicRate: token === 'NGNZ'
      });
    }
    
    // Set total portfolio balance
    calculatedBalances.totalPortfolioBalance = parseFloat(totalPortfolioUSD.toFixed(2));
    
    logger.debug('Calculated total portfolio balance', { 
      totalPortfolioUSD: calculatedBalances.totalPortfolioBalance,
      tokensProcessed: tokens.length
    });
    
    return calculatedBalances;
  } catch (error) {
    logger.error('Error calculating USD balances', { error: error.message });
    
    // Return zeros if calculation fails
    const fallbackBalances = {};
    const tokens = Object.keys(SUPPORTED_TOKENS);
    
    for (const token of tokens) {
      const tokenLower = token.toLowerCase();
      const usdBalanceField = `${tokenLower}BalanceUSD`;
      fallbackBalances[usdBalanceField] = 0;
    }
    fallbackBalances.totalPortfolioBalance = 0;
    
    return fallbackBalances;
  }
}

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

    // FIXED: Complete list of allowed balance fields (using NGNZ not NGNB)
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
      
      // MATIC balances
      'maticBalance', 'maticBalanceUSD', 'maticPendingBalance',
      
      // AVAX balances
      'avaxBalance', 'avaxBalanceUSD', 'avaxPendingBalance',
      
      // NGNZ balances (FIXED: was ngnbBalance)
      'ngnzBalance', 'ngnzBalanceUSD', 'ngnzPendingBalance',
      
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

    // OPTIMIZED: Only fetch token balances and pending balances from database
    const tokenFields = [];
    const usdFields = [];
    const pendingFields = [];
    let needsTotalPortfolio = false;
    
    for (const field of finalFields) {
      if (field === 'totalPortfolioBalance') {
        needsTotalPortfolio = true;
      } else if (field.endsWith('BalanceUSD')) {
        usdFields.push(field);
      } else if (field.endsWith('PendingBalance')) {
        pendingFields.push(field);
      } else if (field.endsWith('Balance')) {
        tokenFields.push(field);
      }
    }

    // Build projection for database query (only token + pending balances exist in DB)
    const projection = {};
    tokenFields.forEach(field => projection[field] = 1);
    pendingFields.forEach(field => projection[field] = 1);

    // Always include metadata fields
    projection.lastBalanceUpdate = 1;
    projection.portfolioLastUpdated = 1;

    const user = await User.findById(userId, projection);

    if (!user) {
      logger.error('User not found while fetching balances', { userId });
      return res.status(404).json({ error: 'User not found' });
    }

    // OPTIMIZED: Calculate USD balances on-demand if needed
    let calculatedUSDBalances = {};
    if (usdFields.length > 0 || needsTotalPortfolio) {
      calculatedUSDBalances = await calculateUSDBalances(user);
    }

    // Build response with requested fields
    const response = {};
    
    for (const field of finalFields) {
      if (field.endsWith('BalanceUSD') || field === 'totalPortfolioBalance') {
        // Use calculated USD value
        response[field] = calculatedUSDBalances[field] || 0;
      } else {
        // Use value from database (token balances, pending balances)
        response[field] = user[field] || 0;
      }
    }

    // Add metadata about the calculation
    const metadata = {
      calculatedAt: new Date().toISOString(),
      usdValuesCalculated: usdFields.length > 0 || needsTotalPortfolio,
      portfolioCalculated: needsTotalPortfolio,
      lastBalanceUpdate: user.lastBalanceUpdate,
      portfolioLastUpdated: user.portfolioLastUpdated
    };

    logger.info('Balances fetched with dynamic USD calculations', { 
      userId, 
      requestedFields: finalFields,
      tokenFieldsFromDB: tokenFields.length,
      usdFieldsCalculated: usdFields.length,
      totalPortfolioCalculated: needsTotalPortfolio
    });

    return res.status(200).json({
      ...response,
      _metadata: metadata
    });
  } catch (error) {
    logger.error('Error fetching balances with USD calculations', {
      userId: req.user?.id || 'unknown',
      error: error.message,
      stack: error.stack
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;