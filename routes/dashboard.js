const express = require('express');
const router = express.Router();
const User = require('../models/user');
const PriceChange = require('../models/pricechange');
const { getPricesWithCache, SUPPORTED_TOKENS } = require('../services/portfolio');
const { getCurrentRate } = require('../services/offramppriceservice');
const logger = require('../utils/logger');

// Aggressive caching for dashboard data
const dashboardCache = new Map();
const priceChangeCache = new Map();
const DASHBOARD_CACHE_TTL = 30000; // 30 seconds
const PRICE_CHANGE_CACHE_TTL = 300000; // 5 minutes

/**
 * Get cached user data with only required fields
 */
async function getCachedUser(userId) {
  const cacheKey = `dashboard_user_${userId}`;
  const cached = dashboardCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp) < DASHBOARD_CACHE_TTL) {
    return cached.user;
  }
  
  // Only select fields we actually need for dashboard
  const user = await User.findById(userId).select(
    'firstname lastname email username phonenumber avatarUrl avatarLastUpdated is2FAEnabled ' +
    'kycLevel kycStatus failedLoginAttempts lastFailedLogin wallets ' +
    'btcBalance ethBalance solBalance usdtBalance usdcBalance bnbBalance maticBalance avaxBalance ngnzBalance ' +
    'btcPendingBalance ethPendingBalance solPendingBalance usdtPendingBalance usdcPendingBalance bnbPendingBalance maticPendingBalance avaxPendingBalance ngnzPendingBalance'
  ).lean();
  
  if (user) {
    dashboardCache.set(cacheKey, { user, timestamp: Date.now() });
    setTimeout(() => dashboardCache.delete(cacheKey), DASHBOARD_CACHE_TTL);
  }
  
  return user;
}

/**
 * Get cached price changes
 */
async function getCachedPriceChanges(prices) {
  const cacheKey = 'price_changes_1h';
  const cached = priceChangeCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp) < PRICE_CHANGE_CACHE_TTL) {
    return cached.changes;
  }
  
  try {
    const changes = await PriceChange.getPriceChanges(prices, 1);
    priceChangeCache.set(cacheKey, { changes, timestamp: Date.now() });
    setTimeout(() => priceChangeCache.delete(cacheKey), PRICE_CHANGE_CACHE_TTL);
    return changes;
  } catch (error) {
    logger.error('Failed to get price changes:', error.message);
    return {};
  }
}

/**
 * FIXED: USD balance calculation - keeping original logic but optimized
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

// GET /dashboard - Optimized dashboard endpoint
router.get('/dashboard', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const userId = req.user.id;
    
    // Check if we have a cached complete dashboard response
    const dashboardCacheKey = `dashboard_complete_${userId}`;
    const cachedDashboard = dashboardCache.get(dashboardCacheKey);
    
    if (cachedDashboard && (Date.now() - cachedDashboard.timestamp) < DASHBOARD_CACHE_TTL) {
      logger.info('Dashboard cache hit', { userId, cacheAge: Date.now() - cachedDashboard.timestamp });
      return res.status(200).json({ success: true, data: cachedDashboard.data });
    }

    // Get user data first
    const user = await getCachedUser(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Get token symbols (excluding NGNZ for separate fetch - for market display)
    const tokenSymbols = Object.keys(SUPPORTED_TOKENS).filter(token => token !== 'NGNZ');

    logger.info('Fetching dashboard data', { 
      userId, 
      requestedTokens: tokenSymbols 
    });

    // Fetch prices and NGNZ rate separately (for market display)
    const [tokenPricesResult, ngnzRateInfo] = await Promise.allSettled([
      getPricesWithCache(tokenSymbols),
      getCurrentRate()
    ]);

    // Handle pricing data for market display
    const marketPrices = tokenPricesResult.status === 'fulfilled' ? tokenPricesResult.value : {};
    const ngnzRate = ngnzRateInfo.status === 'fulfilled' ? ngnzRateInfo.value : null;

    // Add NGNZ price for market display
    if (ngnzRate && ngnzRate.finalPrice) {
      marketPrices.NGNZ = ngnzRate.finalPrice;
    }

    logger.info('Pricing data fetched', {
      pricesCount: Object.keys(marketPrices).length,
      hasNGNZ: !!marketPrices.NGNZ,
      priceSymbols: Object.keys(marketPrices)
    });

    // Calculate USD balances using original method (this fetches prices internally)
    const calculatedUSDBalances = await calculateUSDBalances(user);

    // Get price changes using market prices
    const priceChanges = await getCachedPriceChanges(marketPrices);

    // Build portfolio balances using market prices for display
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
        currentPrice: marketPrices[token] || 0,
        priceChange12h: ['NGNZ', 'USDT', 'USDC'].includes(token) ? null : (priceChanges[token]?.percentageChange || null),
        priceChangeData: ['NGNZ', 'USDT', 'USDC'].includes(token) ? null : (priceChanges[token] || null)
      };
    }

    // Calculate KYC completion percentage
    const kycPercentageMap = { 0: 0, 1: 33, 2: 67, 3: 100 };
    const kycCompletionPercentage = kycPercentageMap[user.kycLevel] || 0;

    // Build optimized dashboard response
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
        limits: user.getKycLimits ? user.getKycLimits() : null
      },
      portfolio: {
        totalPortfolioBalance: calculatedUSDBalances.totalPortfolioBalance,
        balances: portfolioBalances
      },
      market: {
        prices: marketPrices,
        priceChanges12h: priceChanges,
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

    // Cache the complete dashboard response
    dashboardCache.set(dashboardCacheKey, { 
      data: dashboardData, 
      timestamp: Date.now() 
    });
    setTimeout(() => dashboardCache.delete(dashboardCacheKey), DASHBOARD_CACHE_TTL);

    // Log performance metrics
    const processingTime = Date.now() - startTime;
    logger.info('Dashboard optimized fetch completed', {
      userId,
      processingTime,
      totalTokens: Object.keys(SUPPORTED_TOKENS).length,
      pricesRetrieved: Object.keys(marketPrices).length,
      totalPortfolioUSD: calculatedUSDBalances.totalPortfolioBalance,
      cacheUsed: false
    });

    res.status(200).json({ success: true, data: dashboardData });
    
  } catch (err) {
    logger.error('Dashboard fetch error', { 
      error: err.message, 
      stack: err.stack,
      userId: req.user?.id,
      processingTime: Date.now() - startTime
    });
    
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch dashboard data', 
      error: err.message 
    });
  }
});

// REMOVED: Automatic price storage from dashboard fetch (moved to separate background job)

// Store prices endpoint - NOW ASYNC (don't block dashboard)
router.post('/store-prices', async (req, res) => {
  try {
    const tokenSymbols = Object.keys(SUPPORTED_TOKENS).filter(token => token !== 'NGNZ');
    
    const [tokenPrices, ngnzRateInfo] = await Promise.allSettled([
      getPricesWithCache(tokenSymbols),
      getCurrentRate()
    ]);

    const prices = tokenPrices.status === 'fulfilled' ? tokenPrices.value : {};
    const ngnzRate = ngnzRateInfo.status === 'fulfilled' ? ngnzRateInfo.value : null;
    
    if (ngnzRate?.finalPrice) {
      prices.NGNZ = ngnzRate.finalPrice;
    }

    // Store prices asynchronously
    PriceChange.storePrices(prices, 'manual_store').catch(error => {
      logger.error('Background price storage failed:', error.message);
    });
    
    res.status(200).json({ 
      success: true, 
      message: 'Price storage initiated', 
      pricesCount: Object.keys(prices).length
    });
  } catch (error) {
    logger.error('Store prices error', { error: error.message });
    res.status(500).json({ 
      success: false, 
      message: 'Failed to initiate price storage', 
      error: error.message 
    });
  }
});

// Lightweight health check endpoint
router.get('/health', (req, res) => {
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    cacheStats: {
      dashboardEntries: dashboardCache.size,
      priceChangeEntries: priceChangeCache.size
    }
  });
});

// Debug route - only for development
if (process.env.NODE_ENV === 'development') {
  router.get('/debug-price-changes', async (req, res) => {
    try {
      const tokenSymbols = Object.keys(SUPPORTED_TOKENS).filter(token => token !== 'NGNZ');
      
      const [tokenPrices, ngnzRateInfo] = await Promise.allSettled([
        getPricesWithCache(tokenSymbols),
        getCurrentRate()
      ]);

      const prices = tokenPrices.status === 'fulfilled' ? tokenPrices.value : {};
      const ngnzRate = ngnzRateInfo.status === 'fulfilled' ? ngnzRateInfo.value : null;
      
      if (ngnzRate?.finalPrice) {
        prices.NGNZ = ngnzRate.finalPrice;
      }

      const [changes1h, changes12h, changes24h] = await Promise.allSettled([
        PriceChange.getPriceChanges(prices, 1),
        PriceChange.getPriceChanges(prices, 12),
        PriceChange.getPriceChanges(prices, 24)
      ]);

      res.json({
        success: true,
        data: {
          currentPrices: prices,
          priceChanges: {
            oneHour: changes1h.status === 'fulfilled' ? changes1h.value : {},
            twelveHours: changes12h.status === 'fulfilled' ? changes12h.value : {},
            twentyFourHours: changes24h.status === 'fulfilled' ? changes24h.value : {}
          },
          cacheStats: {
            dashboardEntries: dashboardCache.size,
            priceChangeEntries: priceChangeCache.size
          }
        }
      });
      
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
}

// Cleanup old prices endpoint
router.post('/cleanup-prices', async (req, res) => {
  try {
    const daysToKeep = req.body.daysToKeep || 30;
    
    // Run cleanup in background
    PriceChange.cleanupOldPrices(daysToKeep)
      .then(deletedCount => {
        logger.info('Price cleanup completed', { deletedCount, daysKept: daysToKeep });
      })
      .catch(error => {
        logger.error('Price cleanup failed:', error.message);
      });
    
    res.json({
      success: true,
      message: 'Price cleanup initiated',
      daysToKeep: daysToKeep
    });
  } catch (error) {
    logger.error('Cleanup prices error', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Clean up caches periodically
setInterval(() => {
  const now = Date.now();
  
  // Clean dashboard cache
  for (const [key, entry] of dashboardCache.entries()) {
    if (now - entry.timestamp > DASHBOARD_CACHE_TTL) {
      dashboardCache.delete(key);
    }
  }
  
  // Clean price change cache
  for (const [key, entry] of priceChangeCache.entries()) {
    if (now - entry.timestamp > PRICE_CHANGE_CACHE_TTL) {
      priceChangeCache.delete(key);
    }
  }
}, 60000); // Clean every minute

module.exports = router;