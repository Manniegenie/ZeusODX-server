const express = require('express');
const router = express.Router();
const User = require('../models/user');
const CryptoPrice = require('../models/CryptoPrice'); // NEW: Use CryptoPrice instead of PriceChange
const { getPricesWithCache, getHourlyPriceChanges, SUPPORTED_TOKENS } = require('../services/portfolio');
const logger = require('../utils/logger');

/**
 * Calculate USD balances on-demand using cached prices (from database)
 */
async function calculateUSDBalances(user) {
  try {
    const tokens = Object.keys(SUPPORTED_TOKENS);
    
    // Get current prices with dynamic NGNZ rate for portfolio calculation
    const prices = await getPricesWithCache(tokens, 'portfolio');

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
          usingDynamicRate: token === 'NGNZ'
        });
      }
    }

    calculatedBalances.totalPortfolioBalance = parseFloat(totalPortfolioUSD.toFixed(2));

    if (logger && logger.debug) {
      logger.debug('Calculated total portfolio balance', { 
        totalPortfolioUSD: calculatedBalances.totalPortfolioBalance,
        tokensProcessed: tokens.length
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

    // Get all supported token symbols for pricing - NGNZ handled by portfolio service
    const tokenSymbols = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX', 'NGNZ'];

    // Fetch current token prices from database (with dynamic NGNZ)
    const [tokenPrices, hourlyChanges] = await Promise.allSettled([
      getPricesWithCache(tokenSymbols, 'portfolio'),
      getHourlyPriceChanges(tokenSymbols)
    ]);

    // Handle pricing data
    const prices = tokenPrices.status === 'fulfilled' ? tokenPrices.value : {};
    const changes1Hour = hourlyChanges.status === 'fulfilled' ? hourlyChanges.value : {};

    // CALCULATE USD BALANCES ON-DEMAND using database prices
    const calculatedUSDBalances = await calculateUSDBalances(user);

    // Prepare dashboard
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
        totalPortfolioBalance: calculatedUSDBalances.totalPortfolioBalance, // CALCULATED FROM DB PRICES
        balances: {
          SOL: {
            balance: user.solBalance,
            balanceUSD: calculatedUSDBalances.solBalanceUSD, // CALCULATED
            pendingBalance: user.solPendingBalance,
            currentPrice: prices.SOL || 0,
            priceChange1h: changes1Hour.SOL ? changes1Hour.SOL.hourlyChange : null,
            priceChangeData: changes1Hour.SOL || null
          },
          BTC: {
            balance: user.btcBalance,
            balanceUSD: calculatedUSDBalances.btcBalanceUSD, // CALCULATED
            pendingBalance: user.btcPendingBalance,
            currentPrice: prices.BTC || 0,
            priceChange1h: changes1Hour.BTC ? changes1Hour.BTC.hourlyChange : null,
            priceChangeData: changes1Hour.BTC || null
          },
          USDT: {
            balance: user.usdtBalance,
            balanceUSD: calculatedUSDBalances.usdtBalanceUSD, // CALCULATED
            pendingBalance: user.usdtPendingBalance,
            currentPrice: prices.USDT || 1,
            priceChange1h: changes1Hour.USDT ? changes1Hour.USDT.hourlyChange : null,
            priceChangeData: changes1Hour.USDT || null
          },
          USDC: {
            balance: user.usdcBalance,
            balanceUSD: calculatedUSDBalances.usdcBalanceUSD, // CALCULATED
            pendingBalance: user.usdcPendingBalance,
            currentPrice: prices.USDC || 1,
            priceChange1h: changes1Hour.USDC ? changes1Hour.USDC.hourlyChange : null,
            priceChangeData: changes1Hour.USDC || null
          },
          ETH: {
            balance: user.ethBalance,
            balanceUSD: calculatedUSDBalances.ethBalanceUSD, // CALCULATED
            pendingBalance: user.ethPendingBalance,
            currentPrice: prices.ETH || 0,
            priceChange1h: changes1Hour.ETH ? changes1Hour.ETH.hourlyChange : null,
            priceChangeData: changes1Hour.ETH || null
          },
          BNB: {
            balance: user.bnbBalance,
            balanceUSD: calculatedUSDBalances.bnbBalanceUSD, // CALCULATED
            pendingBalance: user.bnbPendingBalance,
            currentPrice: prices.BNB || 0,
            priceChange1h: changes1Hour.BNB ? changes1Hour.BNB.hourlyChange : null,
            priceChangeData: changes1Hour.BNB || null
          },
          MATIC: {
            balance: user.maticBalance,
            balanceUSD: calculatedUSDBalances.maticBalanceUSD, // CALCULATED
            pendingBalance: user.maticPendingBalance,
            currentPrice: prices.MATIC || 0,
            priceChange1h: changes1Hour.MATIC ? changes1Hour.MATIC.hourlyChange : null,
            priceChangeData: changes1Hour.MATIC || null
          },
          AVAX: {
            balance: user.avaxBalance,
            balanceUSD: calculatedUSDBalances.avaxBalanceUSD, // CALCULATED
            pendingBalance: user.avaxPendingBalance,
            currentPrice: prices.AVAX || 0,
            priceChange1h: changes1Hour.AVAX ? changes1Hour.AVAX.hourlyChange : null,
            priceChangeData: changes1Hour.AVAX || null
          },
          NGNZ: {
            balance: user.ngnzBalance,
            balanceUSD: calculatedUSDBalances.ngnzBalanceUSD, // CALCULATED
            pendingBalance: user.ngnzPendingBalance,
            currentPrice: prices.NGNZ || 0,
            priceChange1h: null, // NGNZ doesn't have hourly changes (stable/pegged)
            priceChangeData: null
          }
        }
      },
      market: {
        prices: prices,
        priceChanges1h: changes1Hour, // Now from database (1-hour changes)
        ngnzExchangeRate: {
          rate: prices.NGNZ || 0,
          lastUpdated: new Date().toISOString(),
          source: 'dynamic_offramp_rate',
          isDynamic: true
        },
        pricesLastUpdated: tokenPrices.status === 'fulfilled' ? new Date().toISOString() : null,
        priceSource: 'database' // Indicates prices come from database
      },
      wallets: user.wallets,
      security: {
        is2FAEnabled: user.is2FAEnabled,
        failedLoginAttempts: user.failedLoginAttempts,
        lastFailedLogin: user.lastFailedLogin
      }
    };

    // Log dashboard performance
    logger.info('Dashboard data fetched successfully', {
      userId,
      pricesFromDatabase: Object.keys(prices).length,
      usingDynamicNGNZ: !!prices.NGNZ,
      totalPortfolioUSD: calculatedUSDBalances.totalPortfolioBalance
    });

    res.status(200).json({ success: true, data: dashboardData });
  } catch (err) {
    logger.error('Dashboard fetch error', { 
      error: err.message, 
      stack: err.stack,
      userId: req.user?.id 
    });
    
    res.status(500).json({ success: false, message: 'Failed to fetch dashboard data', error: err.message });
  }
});

// NEW: Get current price status from database
router.get('/price-status', async (req, res) => {
  try {
    const tokens = Object.keys(SUPPORTED_TOKENS).filter(t => t !== 'NGNZ'); // Exclude NGNZ
    
    const latestPrices = await CryptoPrice.getLatestPrices();
    
    const status = {
      totalTokens: tokens.length,
      pricesInDatabase: latestPrices.length,
      lastUpdated: latestPrices.length > 0 ? latestPrices[0].timestamp : null,
      tokens: latestPrices.map(p => ({
        symbol: p.symbol,
        price: p.price,
        hourlyChange: p.hourly_change,
        timestamp: p.timestamp
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

// REMOVED: store-prices endpoint (now handled by scheduled job)

module.exports = router;