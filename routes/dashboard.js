const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { getPricesWithCache, getHourlyPriceChanges, SUPPORTED_TOKENS, getCacheStats } = require('../services/portfolio');
const { getCurrentRate } = require('../services/offramppriceservice');
const logger = require('../utils/logger');

/**
 * Calculate USD balances on-demand using cached prices from portfolio service
 */
async function calculateUSDBalances(user) {
  try {
    const tokens = Object.keys(SUPPORTED_TOKENS);
    
    // Get current prices from portfolio service (includes NGNZ from offramp rate)
    const prices = await getPricesWithCache(tokens); // ✅ Fixed: removed second parameter

    const calculatedBalances = {};
    let totalPortfolioUSD = 0;

    for (const token of tokens) {
      const tokenLower = token.toLowerCase();
      const balanceField = `${tokenLower}Balance`;
      const usdBalanceField = `${tokenLower}BalanceUSD`;

      const tokenAmount = user[balanceField] || 0;
      const tokenPrice = prices[token] || 0;
      const usdValue = tokenAmount * tokenPrice;

      calculatedBalances[usdBalanceField] = parseFloat(usdValue.toFixed(2));
      totalPortfolioUSD += usdValue;

      if (logger && logger.debug) {
        logger.debug(`Calculated USD balance for ${token}`, {
          tokenAmount,
          tokenPrice,
          usdValue: calculatedBalances[usdBalanceField],
          isNGNZ: token === 'NGNZ'
        });
      }
    }

    calculatedBalances.totalPortfolioBalance = parseFloat(totalPortfolioUSD.toFixed(2));

    if (logger && logger.debug) {
      logger.debug('Calculated total portfolio balance', { 
        totalPortfolioUSD: calculatedBalances.totalPortfolioBalance,
        tokensProcessed: tokens.length,
        includesNGNZ: !!prices.NGNZ
      });
    }

    return calculatedBalances;
  } catch (error) {
    if (logger && logger.error) {
      logger.error('Error calculating USD balances', { error: error.message });
    } else {
      console.error('Error calculating USD balances:', error.message);
    }

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

// GET /dashboard - Get all dashboard data
router.get('/dashboard', async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Calculate KYC completion percentage
    const kycPercentageMap = { 0: 0, 1: 33, 2: 67, 3: 100 };
    const kycCompletionPercentage = kycPercentageMap[user.kycLevel] || 0;

    // Get supported token symbols (excluding NGNZ - we'll fetch it separately)
    const tokenSymbols = Object.keys(SUPPORTED_TOKENS).filter(token => token !== 'NGNZ');

    logger.info('Fetching dashboard data', { 
      userId, 
      requestedTokens: tokenSymbols 
    });

    // Fetch prices, changes, and NGNZ rate separately like the old route
    const [tokenPricesResult, hourlyChangesResult, ngnzRateInfo] = await Promise.allSettled([
      getPricesWithCache(tokenSymbols),
      getHourlyPriceChanges(tokenSymbols),
      getCurrentRate()
    ]);

    // Handle pricing data
    const prices = tokenPricesResult.status === 'fulfilled' ? tokenPricesResult.value : {};
    const changes1Hour = hourlyChangesResult.status === 'fulfilled' ? hourlyChangesResult.value : {};
    const ngnzRate = ngnzRateInfo.status === 'fulfilled' ? ngnzRateInfo.value : null;

    // Add NGNZ price like the old route
    if (ngnzRate && ngnzRate.finalPrice) {
      prices.NGNZ = ngnzRate.finalPrice;
    }

    logger.info('Pricing data fetched', {
      pricesCount: Object.keys(prices).length,
      changesCount: Object.keys(changes1Hour).length,
      hasNGNZ: !!prices.NGNZ,
      priceSymbols: Object.keys(prices),
      changeSymbols: Object.keys(changes1Hour)
    });

    // Calculate USD balances using portfolio service prices
    const calculatedUSDBalances = await calculateUSDBalances(user);

    // Build portfolio balances data for all supported tokens
    const portfolioBalances = {};
    const allTokenSymbols = Object.keys(SUPPORTED_TOKENS);
    
    for (const token of allTokenSymbols) {
      const tokenLower = token.toLowerCase();
      const balanceField = `${tokenLower}Balance`;
      const pendingBalanceField = `${tokenLower}PendingBalance`;
      const usdBalanceField = `${tokenLower}BalanceUSD`;
      
      portfolioBalances[token] = {
        balance: user[balanceField] || 0,
        balanceUSD: calculatedUSDBalances[usdBalanceField] || 0,
        pendingBalance: user[pendingBalanceField] || 0,
        currentPrice: prices[token] || 0,
        priceChange1h: changes1Hour[token] ? changes1Hour[token].hourlyChange : null,
        priceChangeData: changes1Hour[token] || null
      };
      
      // Special handling for NGNZ (no price changes)
      if (token === 'NGNZ') {
        portfolioBalances[token].priceChange1h = null;
        portfolioBalances[token].priceChangeData = null;
      }
    }

    // Prepare dashboard response
    const dashboardData = {
      profile: {
        id: user.id,
        firstname: user.firstname,
        lastname: user.lastname,
        email: user.email,
        username: user.username,
        phonenumber: user.phonenumber,
        avatarUrl: user.avatarUrl,
        avatarLastUpdated: user.avatarLastUpdated,
        is2FAEnabled: user.is2FAEnabled
      },
      kyc: {
        level: user.kycLevel,
        status: user.kycStatus,
        completionPercentage: kycCompletionPercentage,
        limits: user.getKycLimits()
      },
      portfolio: {
        totalPortfolioBalance: calculatedUSDBalances.totalPortfolioBalance,
        balances: portfolioBalances
      },
      market: {
        prices: prices,
        priceChanges1h: changes1Hour,
        ngnzExchangeRate: ngnzRate ? {
          rate: ngnzRate.finalPrice,
          lastUpdated: ngnzRate.lastUpdated,
          source: ngnzRate.source
        } : null,
        pricesLastUpdated: tokenPricesResult.status === 'fulfilled' ? new Date().toISOString() : null
      },
      wallets: user.wallets,
      security: {
        is2FAEnabled: user.is2FAEnabled,
        failedLoginAttempts: user.failedLoginAttempts,
        lastFailedLogin: user.lastFailedLogin
      }
    };

    // Log dashboard performance
    logger.info('Dashboard data prepared successfully', {
      userId,
      totalTokens: allTokenSymbols.length,
      pricesRetrieved: Object.keys(prices).length,
      changesRetrieved: Object.keys(changes1Hour).length,
      ngnzPrice: prices.NGNZ,
      totalPortfolioUSD: calculatedUSDBalances.totalPortfolioBalance,
      tokensWithChanges: Object.keys(changes1Hour)
    });

    res.status(200).json({ success: true, data: dashboardData });
    
  } catch (err) {
    logger.error('Dashboard fetch error', { 
      error: err.message, 
      stack: err.stack,
      userId: req.user?.id 
    });
    
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch dashboard data', 
      error: err.message 
    });
  }
});

// Get current price and cache status from portfolio service
router.get('/price-status', async (req, res) => {
  try {
    const tokenSymbols = Object.keys(SUPPORTED_TOKENS);
    
    // Get all prices through portfolio service
    const prices = await getPricesWithCache(tokenSymbols);
    const changes = await getHourlyPriceChanges(tokenSymbols);
    const cacheStats = getCacheStats();
    
    // Count job-supported vs calculated tokens
    const jobTokens = Object.keys(SUPPORTED_TOKENS).filter(token => {
      const tokenInfo = SUPPORTED_TOKENS[token];
      return tokenInfo && tokenInfo.supportedByJob;
    });
    
    const calculatedTokens = Object.keys(SUPPORTED_TOKENS).filter(token => {
      const tokenInfo = SUPPORTED_TOKENS[token];
      return tokenInfo && (tokenInfo.isNairaPegged || !tokenInfo.supportedByJob);
    });
    
    const status = {
      totalSupportedTokens: tokenSymbols.length,
      jobPopulatedTokens: jobTokens.length,
      calculatedTokens: calculatedTokens.length,
      pricesRetrieved: Object.keys(prices).length,
      changesRetrieved: Object.keys(changes).length,
      cache: {
        size: cacheStats.cacheSize,
        lastUpdated: cacheStats.lastUpdated,
        age: cacheStats.cacheAge,
        ttl: cacheStats.ttl
      },
      tokenBreakdown: {
        jobPopulated: jobTokens,
        calculated: calculatedTokens
      },
      currentPrices: Object.entries(prices).map(([symbol, price]) => ({
        symbol,
        price,
        hourlyChange: changes[symbol] ? changes[symbol].hourlyChange : null,
        source: calculatedTokens.includes(symbol) ? 'calculated' : 'job'
      }))
    };

    res.status(200).json({
      success: true,
      data: status
    });
  } catch (error) {
    logger.error('Price status error', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Failed to get price status',
      error: error.message
    });
  }
});

// Debug route to test portfolio service
router.get('/debug-portfolio', async (req, res) => {
  try {
    const tokenSymbols = Object.keys(SUPPORTED_TOKENS);
    
    logger.info('Testing portfolio service', { tokenSymbols });
    
    // Test price fetching
    const prices = await getPricesWithCache(tokenSymbols);
    logger.info('Portfolio service prices', { prices });
    
    // Test hourly changes
    const changes = await getHourlyPriceChanges(tokenSymbols);
    logger.info('Portfolio service changes', { changes });
    
    res.json({
      success: true,
      data: {
        supportedTokens: SUPPORTED_TOKENS,
        prices: prices,
        hourlyChanges: changes,
        analysis: {
          totalTokens: tokenSymbols.length,
          pricesRetrieved: Object.keys(prices).length,
          changesRetrieved: Object.keys(changes).length,
          hasNGNZ: !!prices.NGNZ,
          ngnzPrice: prices.NGNZ,
          tokensWithChanges: Object.keys(changes)
        }
      }
    });
    
  } catch (error) {
    logger.error('Portfolio debug error', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

module.exports = router;