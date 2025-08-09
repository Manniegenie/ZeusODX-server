const express = require('express');
const router = express.Router();
const User = require('../models/user');
const PriceChange = require('../models/pricechange');
const { getPricesWithCache, SUPPORTED_TOKENS } = require('../services/portfolio');
const { getCurrentRate } = require('../services/offramppriceservice');
const logger = require('../utils/logger');

/**
 * Calculate USD balances on-demand using cached prices
 */
async function calculateUSDBalances(user) {
  try {
    const tokens = Object.keys(SUPPORTED_TOKENS);
    const prices = await getPricesWithCache(tokens);

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

    // Fetch prices and NGNZ rate separately
    const [tokenPricesResult, ngnzRateInfo] = await Promise.allSettled([
      getPricesWithCache(tokenSymbols),
      getCurrentRate()
    ]);

    // Handle pricing data
    const prices = tokenPricesResult.status === 'fulfilled' ? tokenPricesResult.value : {};
    const ngnzRate = ngnzRateInfo.status === 'fulfilled' ? ngnzRateInfo.value : null;

    // Add NGNZ price like the old route
    if (ngnzRate && ngnzRate.finalPrice) {
      prices.NGNZ = ngnzRate.finalPrice;
    }

    logger.info('Pricing data fetched', {
      pricesCount: Object.keys(prices).length,
      hasNGNZ: !!prices.NGNZ,
      priceSymbols: Object.keys(prices)
    });

    // Store current prices using PriceChange model
    if (prices && Object.keys(prices).length > 0) {
      try {
        await PriceChange.storePrices(prices, 'portfolio_service');
        logger.debug('Current prices stored successfully');
      } catch (priceStoreError) {
        logger.error('Failed to store current prices:', priceStoreError.message);
      }
    }

    // Calculate 1-hour price changes using PriceChange model
    let changes1Hour = {};
    try {
      changes1Hour = await PriceChange.getPriceChanges(prices, 1); // 1 hour instead of 12
      logger.info('1-hour price changes calculated', {
        changesCount: Object.keys(changes1Hour).length,
        tokensWithData: Object.keys(changes1Hour).filter(k => changes1Hour[k].dataAvailable).length
      });
    } catch (priceChangeError) {
      logger.error('Failed to calculate 1-hour price changes:', priceChangeError.message);
    }

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
        priceChange1h: changes1Hour[token] ? changes1Hour[token].percentageChange : null, // Changed from priceChange12h to priceChange1h
        priceChangeData: changes1Hour[token] || null
      };
      
      // Special handling for NGNZ and stablecoins (no price changes)
      if (['NGNZ', 'USDT', 'USDC'].includes(token)) {
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
        priceChanges1h: changes1Hour, // Changed from priceChanges12h to priceChanges1h
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
      tokensWithChanges: Object.keys(changes1Hour).filter(k => changes1Hour[k].dataAvailable)
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

// Store prices endpoint (for manual price storage)
router.post('/store-prices', async (req, res) => {
  try {
    const tokenSymbols = Object.keys(SUPPORTED_TOKENS).filter(token => token !== 'NGNZ');
    
    const [tokenPrices, ngnzRateInfo] = await Promise.allSettled([
      getPricesWithCache(tokenSymbols),
      getCurrentRate()
    ]);

    const prices = tokenPrices.status === 'fulfilled' ? tokenPrices.value : {};
    const ngnzRate = ngnzRateInfo.status === 'fulfilled' ? ngnzRateInfo.value : null;
    
    if (ngnzRate && ngnzRate.finalPrice) {
      prices.NGNZ = ngnzRate.finalPrice;
    }

    const storedCount = await PriceChange.storePrices(prices, 'portfolio_service');
    
    res.status(200).json({ 
      success: true, 
      message: 'Prices stored successfully', 
      storedCount, 
      prices 
    });
  } catch (error) {
    logger.error('Store prices error', { error: error.message });
    res.status(500).json({ 
      success: false, 
      message: 'Failed to store prices', 
      error: error.message 
    });
  }
});

// Debug route to test price changes
router.get('/debug-price-changes', async (req, res) => {
  try {
    const tokenSymbols = Object.keys(SUPPORTED_TOKENS).filter(token => token !== 'NGNZ');
    
    // Get current prices
    const [tokenPrices, ngnzRateInfo] = await Promise.allSettled([
      getPricesWithCache(tokenSymbols),
      getCurrentRate()
    ]);

    const prices = tokenPrices.status === 'fulfilled' ? tokenPrices.value : {};
    const ngnzRate = ngnzRateInfo.status === 'fulfilled' ? ngnzRateInfo.value : null;
    
    if (ngnzRate && ngnzRate.finalPrice) {
      prices.NGNZ = ngnzRate.finalPrice;
    }

    // Test different timeframes
    const changes1h = await PriceChange.getPriceChanges(prices, 1);
    const changes12h = await PriceChange.getPriceChanges(prices, 12);
    const changes24h = await PriceChange.getPriceChanges(prices, 24);

    // Get price history count for each token
    const historyStats = {};
    for (const token of Object.keys(SUPPORTED_TOKENS)) {
      const count = await PriceChange.countDocuments({ symbol: token.toUpperCase() });
      const latest = await PriceChange.findOne({ symbol: token.toUpperCase() }).sort({ timestamp: -1 });
      historyStats[token] = {
        recordCount: count,
        latestTimestamp: latest ? latest.timestamp : null,
        latestPrice: latest ? latest.price : null
      };
    }

    res.json({
      success: true,
      data: {
        currentPrices: prices,
        priceChanges: {
          oneHour: changes1h,
          twelveHours: changes12h,
          twentyFourHours: changes24h
        },
        historyStats,
        analysis: {
          totalTokens: Object.keys(prices).length,
          changes1hAvailable: Object.keys(changes1h).filter(k => changes1h[k].dataAvailable).length,
          changes12hAvailable: Object.keys(changes12h).filter(k => changes12h[k].dataAvailable).length,
          changes24hAvailable: Object.keys(changes24h).filter(k => changes24h[k].dataAvailable).length
        }
      }
    });
    
  } catch (error) {
    logger.error('Debug price changes error', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

// Cleanup old prices endpoint (for maintenance)
router.post('/cleanup-prices', async (req, res) => {
  try {
    const daysToKeep = req.body.daysToKeep || 30;
    const deletedCount = await PriceChange.cleanupOldPrices(daysToKeep);
    
    res.json({
      success: true,
      message: `Cleaned up old price data`,
      deletedCount,
      daysKept: daysToKeep
    });
  } catch (error) {
    logger.error('Cleanup prices error', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;