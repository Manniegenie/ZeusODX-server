const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { getPricesWithCache, SUPPORTED_TOKENS } = require('../services/portfolio');
const logger = require('../utils/logger');

/**
 * UPDATED: Calculate USD balances using portfolio service with automatic markdown
 * @param {Object} user - User document with token balances
 * @returns {Promise<Object>} Object with calculated USD balances and total
 */
async function calculateUSDBalances(user) {
  try {
    // Get all supported tokens from portfolio service
    const tokens = Object.keys(SUPPORTED_TOKENS);
    
    // Get current prices with automatic markdown application from portfolio service
    const prices = await getPricesWithCache(tokens);
    
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
      
      // Calculate USD value (prices already include markdown from portfolio service)
      const usdValue = tokenAmount * tokenPrice;
      
      // Store calculated USD balance
      calculatedBalances[usdBalanceField] = parseFloat(usdValue.toFixed(2));
      
      // Add to total portfolio
      totalPortfolioUSD += usdValue;
      
      // Get token info for logging
      const tokenInfo = SUPPORTED_TOKENS[token];
      const hasMarkdown = tokenInfo && !tokenInfo.isStablecoin && !tokenInfo.isNairaPegged;
      
      logger.debug(`Calculated USD balance for ${token}`, {
        tokenAmount,
        tokenPrice,
        usdValue: calculatedBalances[usdBalanceField],
        isStablecoin: tokenInfo?.isStablecoin || false,
        isNairaPegged: tokenInfo?.isNairaPegged || false,
        markdownApplied: hasMarkdown
      });
    }
    
    // Set total portfolio balance
    calculatedBalances.totalPortfolioBalance = parseFloat(totalPortfolioUSD.toFixed(2));
    
    logger.debug('Calculated total portfolio balance with markdown-adjusted prices', { 
      totalPortfolioUSD: calculatedBalances.totalPortfolioBalance,
      tokensProcessed: tokens.length,
      markdownAppliedByPortfolioService: true
    });
    
    return calculatedBalances;
  } catch (error) {
    logger.error('Error calculating USD balances with portfolio service', { error: error.message });
    
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

    // Build allowed fields dynamically from SUPPORTED_TOKENS (from portfolio service)
    const allowedFields = [];
    
    // Add balance fields for each supported token
    for (const token of Object.keys(SUPPORTED_TOKENS)) {
      const tokenLower = token.toLowerCase();
      allowedFields.push(
        `${tokenLower}Balance`,
        `${tokenLower}BalanceUSD`,
        `${tokenLower}PendingBalance`
      );
    }
    
    // Add total portfolio balance
    allowedFields.push('totalPortfolioBalance');

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

    // Categorize requested fields
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

    // Calculate USD balances on-demand if needed (with automatic markdown from portfolio service)
    let calculatedUSDBalances = {};
    if (usdFields.length > 0 || needsTotalPortfolio) {
      calculatedUSDBalances = await calculateUSDBalances(user);
    }

    // Build response with requested fields
    const response = {};
    
    for (const field of finalFields) {
      if (field.endsWith('BalanceUSD') || field === 'totalPortfolioBalance') {
        // Use calculated USD value (includes markdown from portfolio service)
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
      markdownAppliedByPortfolioService: usdFields.length > 0 || needsTotalPortfolio,
      lastBalanceUpdate: user.lastBalanceUpdate,
      portfolioLastUpdated: user.portfolioLastUpdated,
      supportedTokens: Object.keys(SUPPORTED_TOKENS).length
    };

    logger.info('Balances fetched with portfolio service markdown-adjusted USD calculations', { 
      userId, 
      requestedFields: finalFields,
      tokenFieldsFromDB: tokenFields.length,
      usdFieldsCalculated: usdFields.length,
      totalPortfolioCalculated: needsTotalPortfolio,
      markdownApplied: usdFields.length > 0 || needsTotalPortfolio
    });

    return res.status(200).json({
      ...response,
      _metadata: metadata
    });
  } catch (error) {
    logger.error('Error fetching balances with portfolio service USD calculations', {
      userId: req.user?.id || 'unknown',
      error: error.message,
      stack: error.stack
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/balance/supported-tokens - Get list of supported tokens
router.get('/supported-tokens', (req, res) => {
  try {
    const tokens = Object.entries(SUPPORTED_TOKENS).map(([code, info]) => ({
      code,
      isStablecoin: info.isStablecoin || false,
      isNairaPegged: info.isNairaPegged || false,
      supportedByJob: info.supportedByJob || false,
      balanceField: `${code.toLowerCase()}Balance`,
      usdBalanceField: `${code.toLowerCase()}BalanceUSD`,
      pendingBalanceField: `${code.toLowerCase()}PendingBalance`
    }));

    logger.info('Supported tokens retrieved from portfolio service', { 
      tokenCount: tokens.length,
      tokens: tokens.map(t => t.code)
    });

    return res.status(200).json({
      success: true,
      data: tokens,
      total: tokens.length,
      _metadata: {
        source: 'portfolio_service',
        markdownSupported: true,
        retrievedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Error fetching supported tokens', { error: error.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;