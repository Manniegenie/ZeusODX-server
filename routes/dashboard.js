const express = require('express');
const router = express.Router();
const User = require('../models/user');
const PriceChange = require('../models/pricechange');
const { getPricesWithCache, SUPPORTED_TOKENS } = require('../services/portfolio');
const { getCurrentRate } = require('../services/offramppriceservice');
const logger = require('../utils/logger');
const { registerCache, clearUserCaches } = require('../utils/cacheManager');

// Reduced cache with very short TTL for balance-sensitive data
const cache = new Map();
const CACHE_TTL = 5000; // 5 seconds - much shorter for balance data

function getFromCache(key) {
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.data;
  }
  cache.delete(key);
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// Register cache with global manager
registerCache('dashboard_cache', cache);

// Clear cache for specific user when balance changes
function clearUserCache(userId) {
  const keysToDelete = [];
  for (const [key] of cache.entries()) {
    if (key.includes(`user_${userId}`) || key.includes('price_changes') || key.includes('market_prices')) {
      keysToDelete.push(key);
    }
  }
  keysToDelete.forEach(key => cache.delete(key));
}

// Calculate USD balances for portfolio
async function calculatePortfolioBalances(user) {
  try {
    const tokens = Object.keys(SUPPORTED_TOKENS);
    const prices = await getPricesWithCache(tokens);
    
    const portfolioBalances = {};
    let totalPortfolioUSD = 0;

    for (const token of tokens) {
      const tokenLower = token.toLowerCase();
      const balance = user[`${tokenLower}Balance`] || 0;
      const pendingBalance = user[`${tokenLower}PendingBalance`] || 0;
      const price = prices[token] || 0;
      const balanceUSD = balance * price;

      portfolioBalances[token] = {
        balance,
        balanceUSD: parseFloat(balanceUSD.toFixed(2)),
        pendingBalance,
        currentPrice: price
      };

      totalPortfolioUSD += balanceUSD;
    }

    return {
      balances: portfolioBalances,
      totalPortfolioBalance: parseFloat(totalPortfolioUSD.toFixed(2))
    };
  } catch (error) {
    logger.error('Error calculating portfolio balances:', error.message);
    return {
      balances: {},
      totalPortfolioBalance: 0
    };
  }
}

// Get price changes
async function getPriceChanges() {
  const cacheKey = 'price_changes';
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  try {
    const tokens = Object.keys(SUPPORTED_TOKENS);
    const prices = await getPricesWithCache(tokens);
    const changes = await PriceChange.getPriceChanges(prices, 1);
    
    setCache(cacheKey, changes);
    return changes;
  } catch (error) {
    logger.error('Error getting price changes:', error.message);
    return {};
  }
}

// Main dashboard endpoint
router.get('/dashboard', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const userId = req.user.id;

    // Clear any cached data for this user to ensure fresh balance data
    clearUserCaches(userId);

    // Get user data
    const user = await User.findById(userId).select(
      'firstname lastname email username phonenumber avatarUrl is2FAEnabled ' +
      'kycLevel kycStatus failedLoginAttempts lastFailedLogin wallets ' +
      'btcBalance ethBalance solBalance usdtBalance usdcBalance bnbBalance maticBalance trxBalance ngnzBalance ' +
      'btcPendingBalance ethPendingBalance solPendingBalance usdtPendingBalance usdcPendingBalance bnbPendingBalance maticPendingBalance trxPendingBalance ngnzPendingBalance'
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Get token symbols (excluding NGNZ for separate fetch)
    const tokenSymbols = Object.keys(SUPPORTED_TOKENS).filter(token => token !== 'NGNZ');

    // Fetch prices and NGNZ rate separately
    const [portfolioData, priceChanges, tokenPricesResult, ngnzRateInfo] = await Promise.all([
      calculatePortfolioBalances(user),
      getPriceChanges(),
      getPricesWithCache(tokenSymbols),
      getCurrentRate()
    ]);

    // Handle pricing data for market display
    const marketPrices = tokenPricesResult || {};
    const ngnzRate = ngnzRateInfo || null;

    console.log('[DASHBOARD DEBUG] tokenPricesResult from getPricesWithCache:', JSON.stringify(marketPrices));

    // Add NGNZ price for market display
    if (ngnzRate && ngnzRate.finalPrice) {
      marketPrices.NGNZ = ngnzRate.finalPrice;
    }

    // Add price changes to portfolio balances
    for (const token in portfolioData.balances) {
      portfolioData.balances[token].priceChange12h = priceChanges[token]?.percentageChange || null;
    }

    // Get KYC completion percentage
    const kycPercentage = user.kycLevel === 0 ? 0 : user.kycLevel === 1 ? 50 : 100;

    // Build response
    const dashboardData = {
      profile: {
        id: user._id,
        firstname: user.firstname,
        lastname: user.lastname,
        email: user.email,
        username: user.username,
        phonenumber: user.phonenumber,
        avatarUrl: user.avatarUrl,
        is2FAEnabled: user.is2FAEnabled
      },
      kyc: {
        level: user.kycLevel,
        status: user.kycStatus,
        completionPercentage: kycPercentage
      },
      portfolio: {
        totalPortfolioBalance: portfolioData.totalPortfolioBalance,
        balances: portfolioData.balances
      },
      market: {
        prices: marketPrices,
        priceChanges12h: priceChanges,
        ngnzExchangeRate: ngnzRate ? {
          rate: ngnzRate.finalPrice,
          lastUpdated: ngnzRate.lastUpdated,
          source: ngnzRate.source
        } : null,
        pricesLastUpdated: new Date().toISOString()
      },
      security: {
        is2FAEnabled: user.is2FAEnabled,
        failedLoginAttempts: user.failedLoginAttempts || 0
      },
      wallets: user.wallets || {}
    };

    const processingTime = Date.now() - startTime;
    logger.info('Dashboard fetched successfully', { userId, processingTime });

    res.status(200).json({ success: true, data: dashboardData });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error('Dashboard fetch error', { 
      error: error.message, 
      userId: req.user?.id,
      processingTime
    });
    
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch dashboard data'
    });
  }
});

// Get current market prices
router.get('/market-prices', async (req, res) => {
  try {
    const cacheKey = 'market_prices';
    let prices = getFromCache(cacheKey);

    if (!prices) {
      const tokens = Object.keys(SUPPORTED_TOKENS);
      prices = await getPricesWithCache(tokens);
      setCache(cacheKey, prices);
    }

    res.status(200).json({ success: true, data: prices });
  } catch (error) {
    logger.error('Market prices fetch error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch market prices' 
    });
  }
});

// Get KYC limits and requirements for current user
router.get('/kyc-limits', async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('kycLevel kycStatus kyc emailVerified');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const limits = user.getKycLimits();
    const requirements = user.getKycRequirements();
    
    res.status(200).json({ 
      success: true, 
      data: {
        limits,
        requirements,
        currentLevel: user.kycLevel,
        status: user.kycStatus
      }
    });
  } catch (error) {
    logger.error('KYC limits fetch error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch KYC limits' 
    });
  }
});

// Store prices (background job trigger)
router.post('/store-prices', async (req, res) => {
  try {
    const tokens = Object.keys(SUPPORTED_TOKENS);
    const prices = await getPricesWithCache(tokens);
    
    // Store prices in background
    PriceChange.storePrices(prices, 'manual_store').catch(error => {
      logger.error('Background price storage failed:', error.message);
    });
    
    res.status(200).json({ 
      success: true, 
      message: 'Price storage initiated'
    });
  } catch (error) {
    logger.error('Store prices error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to initiate price storage'
    });
  }
});

// Get detailed KYC status and requirements
router.get('/kyc-status', async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('kycLevel kycStatus kyc emailVerified firstname lastname phonenumber');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const requirements = user.getKycRequirements();
    
    res.status(200).json({ 
      success: true, 
      data: {
        currentLevel: user.kycLevel,
        status: user.kycStatus,
        requirements: requirements,
        nextSteps: user.kycLevel === 0 ? ['Phone verification'] : 
                  user.kycLevel === 1 ? ['Email verification', 'Document verification'] : 
                  ['All KYC requirements completed'],
        isMaxLevel: user.kycLevel === 2
      }
    });
  } catch (error) {
    logger.error('KYC status fetch error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch KYC status' 
    });
  }
});

// Health check
router.get('/health', (req, res) => {
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    cacheSize: cache.size
  });
});

// Clean up cache periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now - entry.timestamp > CACHE_TTL) {
      cache.delete(key);
    }
  }
}, 300000);

module.exports = router;