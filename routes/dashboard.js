const express = require('express');
const router = express.Router();
const User = require('../models/user');
const PriceChange = require('../models/pricechange');
const { getPricesWithCache } = require('../services/portfolio');
const { getCurrentRate } = require('../services/offramppriceservice');

// GET /dashboard - Get all dashboard data
router.get('/dashboard', async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Calculate KYC completion percentage
    const kycPercentageMap = {
      0: 0, 1: 33, 2: 67, 3: 100
    };
    const kycCompletionPercentage = kycPercentageMap[user.kycLevel] || 0;

    // Get all supported token symbols for pricing - DOGE REMOVED
    const tokenSymbols = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'];
    
    // Fetch current token prices and NGNB rate
    const [tokenPrices, ngnbRateInfo] = await Promise.allSettled([
      getPricesWithCache(tokenSymbols),
      getCurrentRate()
    ]);

    // Handle pricing data
    const prices = tokenPrices.status === 'fulfilled' ? tokenPrices.value : {};
    const ngnbRate = ngnbRateInfo.status === 'fulfilled' ? ngnbRateInfo.value : null;
    
    // Add NGNB pricing
    if (ngnbRate && ngnbRate.finalPrice) {
      prices.NGNB = ngnbRate.finalPrice;
    }

    // Store current prices in database
    if (prices && Object.keys(prices).length > 0) {
      try {
        await PriceChange.storePrices(prices);
      } catch (priceStoreError) {
        console.error('Failed to store current prices:', priceStoreError.message);
      }
    }

    // Calculate 12-hour price changes
    let changes12Hour = {};
    try {
      changes12Hour = await PriceChange.getPriceChanges(prices, 12);
    } catch (priceChangeError) {
      console.error('Failed to calculate price changes:', priceChangeError.message);
    }

    // Prepare dashboard data
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
        totalPortfolioBalance: user.totalPortfolioBalance,
        balances: {
          SOL: {
            balance: user.solBalance,
            balanceUSD: user.solBalanceUSD,
            pendingBalance: user.solPendingBalance,
            currentPrice: prices.SOL || 0,
            priceChange12h: changes12Hour.SOL ? changes12Hour.SOL.percentageChange : null,
            priceChangeData: changes12Hour.SOL || null
          },
          BTC: {
            balance: user.btcBalance,
            balanceUSD: user.btcBalanceUSD,
            pendingBalance: user.btcPendingBalance,
            currentPrice: prices.BTC || 0,
            priceChange12h: changes12Hour.BTC ? changes12Hour.BTC.percentageChange : null,
            priceChangeData: changes12Hour.BTC || null
          },
          USDT: {
            balance: user.usdtBalance,
            balanceUSD: user.usdtBalanceUSD,
            pendingBalance: user.usdtPendingBalance,
            currentPrice: prices.USDT || 1,
            priceChange12h: null,
            priceChangeData: null
          },
          USDC: {
            balance: user.usdcBalance,
            balanceUSD: user.usdcBalanceUSD,
            pendingBalance: user.usdcPendingBalance,
            currentPrice: prices.USDC || 1,
            priceChange12h: null,
            priceChangeData: null
          },
          ETH: {
            balance: user.ethBalance,
            balanceUSD: user.ethBalanceUSD,
            pendingBalance: user.ethPendingBalance,
            currentPrice: prices.ETH || 0,
            priceChange12h: changes12Hour.ETH ? changes12Hour.ETH.percentageChange : null,
            priceChangeData: changes12Hour.ETH || null
          },
          BNB: {
            balance: user.bnbBalance,
            balanceUSD: user.bnbBalanceUSD,
            pendingBalance: user.bnbPendingBalance,
            currentPrice: prices.BNB || 0,
            priceChange12h: changes12Hour.BNB ? changes12Hour.BNB.percentageChange : null,
            priceChangeData: changes12Hour.BNB || null
          },
          // DOGE: REMOVED COMPLETELY
          MATIC: {
            balance: user.maticBalance,
            balanceUSD: user.maticBalanceUSD,
            pendingBalance: user.maticPendingBalance,
            currentPrice: prices.MATIC || 0,
            priceChange12h: changes12Hour.MATIC ? changes12Hour.MATIC.percentageChange : null,
            priceChangeData: changes12Hour.MATIC || null
          },
          AVAX: {
            balance: user.avaxBalance,
            balanceUSD: user.avaxBalanceUSD,
            pendingBalance: user.avaxPendingBalance,
            currentPrice: prices.AVAX || 0,
            priceChange12h: changes12Hour.AVAX ? changes12Hour.AVAX.percentageChange : null,
            priceChangeData: changes12Hour.AVAX || null
          },
          NGNB: {
            balance: user.ngnbBalance,
            balanceUSD: user.ngnbBalanceUSD,
            pendingBalance: user.ngnbPendingBalance,
            currentPrice: prices.NGNB || 0,
            priceChange12h: null,
            priceChangeData: null
          }
        }
      },

      market: {
        prices: prices,
        priceChanges12h: changes12Hour,
        ngnbExchangeRate: ngnbRate ? {
          rate: ngnbRate.finalPrice,
          lastUpdated: ngnbRate.lastUpdated,
          source: ngnbRate.source
        } : null,
        pricesLastUpdated: tokenPrices.status === 'fulfilled' ? new Date().toISOString() : null
      },

      wallets: user.wallets,

      security: {
        is2FAEnabled: user.is2FAEnabled,
        failedLoginAttempts: user.failedLoginAttempts,
        lastFailedLogin: user.lastFailedLogin
      }
    };

    res.status(200).json({
      success: true,
      data: dashboardData
    });

  } catch (err) {
    console.error('Dashboard fetch error:', err);
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch dashboard data', 
      error: err.message 
    });
  }
});

// Additional endpoints
router.post('/store-prices', async (req, res) => {
  try {
    // Updated to exclude DOGE
    const tokenSymbols = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'];
    const [tokenPrices, ngnbRateInfo] = await Promise.allSettled([
      getPricesWithCache(tokenSymbols),
      getCurrentRate()
    ]);

    const prices = tokenPrices.status === 'fulfilled' ? tokenPrices.value : {};
    const ngnbRate = ngnbRateInfo.status === 'fulfilled' ? ngnbRateInfo.value : null;
    
    if (ngnbRate && ngnbRate.finalPrice) {
      prices.NGNB = ngnbRate.finalPrice;
    }

    const storedCount = await PriceChange.storePrices(prices);
    
    res.status(200).json({
      success: true,
      message: 'Prices stored successfully',
      storedCount,
      prices
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to store prices',
      error: error.message
    });
  }
});

module.exports = router;