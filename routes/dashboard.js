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

    // Supported token symbols
    const tokenSymbols = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'];

    // Fetch prices + NGNZ rate
    const [tokenPrices, ngnzRateInfo] = await Promise.allSettled([
      getPricesWithCache(tokenSymbols),
      getCurrentRate()
    ]);

    const prices = tokenPrices.status === 'fulfilled' ? tokenPrices.value : {};
    const ngnzRate = ngnzRateInfo.status === 'fulfilled' ? ngnzRateInfo.value : null;

    // Add NGNZ price
    if (ngnzRate && ngnzRate.finalPrice) {
      prices.NGNZ = ngnzRate.finalPrice;
    }

    // Store current prices
    if (prices && Object.keys(prices).length > 0) {
      try {
        await PriceChange.storePrices(prices);
      } catch (priceStoreError) {
        console.error('Failed to store current prices:', priceStoreError.message);
      }
    }

    // 12h price changes
    let changes12Hour = {};
    try {
      changes12Hour = await PriceChange.getPriceChanges(prices, 12);
    } catch (priceChangeError) {
      console.error('Failed to calculate price changes:', priceChangeError.message);
    }

    // Calculate balances
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
        totalPortfolioBalance: calculatedUSDBalances.totalPortfolioBalance,
        balances: {
          SOL: {
            balance: user.solBalance,
            balanceUSD: calculatedUSDBalances.solBalanceUSD,
            pendingBalance: user.solPendingBalance,
            currentPrice: prices.SOL || 0,
            priceChange12h: changes12Hour.SOL ? changes12Hour.SOL.percentageChange : null,
            priceChangeData: changes12Hour.SOL || null
          },
          BTC: {
            balance: user.btcBalance,
            balanceUSD: calculatedUSDBalances.btcBalanceUSD,
            pendingBalance: user.btcPendingBalance,
            currentPrice: prices.BTC || 0,
            priceChange12h: changes12Hour.BTC ? changes12Hour.BTC.percentageChange : null,
            priceChangeData: changes12Hour.BTC || null
          },
          USDT: {
            balance: user.usdtBalance,
            balanceUSD: calculatedUSDBalances.usdtBalanceUSD,
            pendingBalance: user.usdtPendingBalance,
            currentPrice: prices.USDT || 1,
            priceChange12h: null,
            priceChangeData: null
          },
          USDC: {
            balance: user.usdcBalance,
            balanceUSD: calculatedUSDBalances.usdcBalanceUSD,
            pendingBalance: user.usdcPendingBalance,
            currentPrice: prices.USDC || 1,
            priceChange12h: null,
            priceChangeData: null
          },
          ETH: {
            balance: user.ethBalance,
            balanceUSD: calculatedUSDBalances.ethBalanceUSD,
            pendingBalance: user.ethPendingBalance,
            currentPrice: prices.ETH || 0,
            priceChange12h: changes12Hour.ETH ? changes12Hour.ETH.percentageChange : null,
            priceChangeData: changes12Hour.ETH || null
          },
          BNB: {
            balance: user.bnbBalance,
            balanceUSD: calculatedUSDBalances.bnbBalanceUSD,
            pendingBalance: user.bnbPendingBalance,
            currentPrice: prices.BNB || 0,
            priceChange12h: changes12Hour.BNB ? changes12Hour.BNB.percentageChange : null,
            priceChangeData: changes12Hour.BNB || null
          },
          MATIC: {
            balance: user.maticBalance,
            balanceUSD: calculatedUSDBalances.maticBalanceUSD,
            pendingBalance: user.maticPendingBalance,
            currentPrice: prices.MATIC || 0,
            priceChange12h: changes12Hour.MATIC ? changes12Hour.MATIC.percentageChange : null,
            priceChangeData: changes12Hour.MATIC || null
          },
          AVAX: {
            balance: user.avaxBalance,
            balanceUSD: calculatedUSDBalances.avaxBalanceUSD,
            pendingBalance: user.avaxPendingBalance,
            currentPrice: prices.AVAX || 0,
            priceChange12h: changes12Hour.AVAX ? changes12Hour.AVAX.percentageChange : null,
            priceChangeData: changes12Hour.AVAX || null
          },
          NGNZ: {
            balance: user.ngnzBalance,
            balanceUSD: calculatedUSDBalances.ngnzBalanceUSD,
            pendingBalance: user.ngnzPendingBalance,
            currentPrice: prices.NGNZ || 0,
            priceChange12h: null,
            priceChangeData: null
          }
        }
      },
      market: {
        prices: prices,
        priceChanges12h: changes12Hour,
        ngnzExchangeRate: ngnzRate ? {
          rate: ngnzRate.finalPrice,
          lastUpdated: ngnzRate.lastUpdated,
          source: ngnzRate.source
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

    res.status(200).json({ success: true, data: dashboardData });
  } catch (err) {
    console.error('Dashboard fetch error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch dashboard data', error: err.message });
  }
});

// Store prices endpoint
router.post('/store-prices', async (req, res) => {
  try {
    const tokenSymbols = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'];
    const [tokenPrices, ngnzRateInfo] = await Promise.allSettled([
      getPricesWithCache(tokenSymbols),
      getCurrentRate()
    ]);

    const prices = tokenPrices.status === 'fulfilled' ? tokenPrices.value : {};
    const ngnzRate = ngnzRateInfo.status === 'fulfilled' ? ngnzRateInfo.value : null;
    if (ngnzRate && ngnzRate.finalPrice) {
      prices.NGNZ = ngnzRate.finalPrice;
    }

    const storedCount = await PriceChange.storePrices(prices);
    res.status(200).json({ success: true, message: 'Prices stored successfully', storedCount, prices });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to store prices', error: error.message });
  }
});

module.exports = router;
