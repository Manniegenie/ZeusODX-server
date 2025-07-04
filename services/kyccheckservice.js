const User = require('../models/user');
const Transaction = require('../models/transaction');
const BillTransaction = require('../models/billstransaction');
const { offrampService } = require('./offramppriceservice');
const { getPricesWithCache } = require('./portfolio'); // Import your existing portfolio service
const logger = require('../utils/logger');

class KYCLimitService {
  constructor() {
    this.cache = {
      userSpending: new Map(),
      cacheExpiry: new Map()
    };
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes cache
  }

  /**
   * Main method to check if a user can process a transaction
   * @param {string} userId - User ID
   * @param {number} amount - Transaction amount
   * @param {string} currency - Currency code (NGNB, BTC, ETH, SOL, USDT, USDC, USD)
   * @param {string} transactionType - Type of transaction (WITHDRAWAL, BILL_PAYMENT, SWAP, etc.)
   * @returns {Object} Validation result with allowance status and details
   */
  async validateTransactionLimit(userId, amount, currency = 'NGNB', transactionType = 'WITHDRAWAL') {
    try {
      logger.info(`🔍 KYC validation started for user ${userId}: ${amount} ${currency} (${transactionType})`);

      // 1. Fetch user and validate
      const user = await this.getUser(userId);
      if (!user) {
        return this.createErrorResponse('USER_NOT_FOUND', 'User not found');
      }

      // 2. Get KYC limits for user
      const kycLimits = user.getKycLimits();
      logger.info(`📋 User KYC Level ${user.kycLevel}: Daily ₦${kycLimits.daily.toLocaleString()}, Monthly ₦${kycLimits.monthly.toLocaleString()}`);

      // 3. Convert amount to NGNB/Naira if needed
      const amountInNaira = await this.convertToNaira(amount, currency);
      logger.info(`💰 Amount conversion: ${amount} ${currency} = ₦${amountInNaira.toLocaleString()}`);

      // 4. Check if user has any transaction limits (KYC level 0 = no transactions)
      if (user.kycLevel === 0) {
        return this.createErrorResponse('KYC_REQUIRED', 'KYC verification required to process transactions', {
          kycLevel: 0,
          requiredAction: 'Complete KYC Level 1 verification',
          amountInNaira,
          currency
        });
      }

      // 5. Get current spending for the user
      const currentSpending = await this.getCurrentSpending(userId);
      
      // 6. Calculate new totals after this transaction
      const newDailyTotal = currentSpending.daily + amountInNaira;
      const newMonthlyTotal = currentSpending.monthly + amountInNaira;

      // 7. Check limits
      const dailyExceeded = newDailyTotal > kycLimits.daily;
      const monthlyExceeded = newMonthlyTotal > kycLimits.monthly;

      if (dailyExceeded || monthlyExceeded) {
        const limitType = dailyExceeded ? 'daily' : 'monthly';
        const currentLimit = dailyExceeded ? kycLimits.daily : kycLimits.monthly;
        const currentSpent = dailyExceeded ? currentSpending.daily : currentSpending.monthly;
        const availableAmount = Math.max(0, currentLimit - currentSpent);

        return this.createErrorResponse('LIMIT_EXCEEDED', `${limitType.charAt(0).toUpperCase() + limitType.slice(1)} transaction limit exceeded`, {
          kycLevel: user.kycLevel,
          limitType,
          requestedAmount: amountInNaira,
          currentLimit,
          currentSpent,
          availableAmount,
          newTotal: limitType === 'daily' ? newDailyTotal : newMonthlyTotal,
          amountInNaira,
          currency,
          upgradeRecommendation: this.getUpgradeRecommendation(user.kycLevel)
        });
      }

      // 8. Transaction is allowed
      return this.createSuccessResponse('TRANSACTION_ALLOWED', 'Transaction within limits', {
        kycLevel: user.kycLevel,
        kycLimits,
        currentSpending,
        requestedAmount: amountInNaira,
        newDailyTotal,
        newMonthlyTotal,
        dailyRemaining: kycLimits.daily - newDailyTotal,
        monthlyRemaining: kycLimits.monthly - newMonthlyTotal,
        amountInNaira,
        currency,
        conversionRate: currency === 'NGNB' || currency === 'NGN' ? 1 : await this.getConversionRate(currency)
      });

    } catch (error) {
      logger.error('❌ KYC validation error:', error);
      return this.createErrorResponse('VALIDATION_ERROR', 'Failed to validate transaction limits', {
        error: error.message
      });
    }
  }

  /**
   * Get user by ID
   */
  async getUser(userId) {
    try {
      const user = await User.findById(userId).select('+kycLevel +kyc');
      return user;
    } catch (error) {
      logger.error('Failed to fetch user:', error);
      throw new Error('User lookup failed');
    }
  }

  /**
   * Convert any currency amount to Naira/NGNB using CurrencyAPI
   */
  async convertToNaira(amount, currency) {
    // NGNB and NGN are 1:1 with Naira
    if (currency === 'NGNB' || currency === 'NGN' || currency === 'NAIRA') {
      return amount;
    }

    try {
      // For stablecoins, convert directly via USD rate
      if (currency === 'USDT' || currency === 'USDC') {
        return await offrampService.convertUsdToNaira(amount);
      }

      // For USD
      if (currency === 'USD') {
        return await offrampService.convertUsdToNaira(amount);
      }

      // For cryptocurrencies, use the same service as dashboard
      if (['BTC', 'ETH', 'SOL'].includes(currency)) {
        const prices = await this.getCryptoPricesFromCurrencyAPI();
        const cryptoPrice = prices[currency];
        
        if (!cryptoPrice) {
          throw new Error(`Price not available for ${currency}`);
        }

        const usdValue = amount * cryptoPrice;
        const nairaValue = await offrampService.convertUsdToNaira(usdValue);
        
        logger.info(`💱 Crypto conversion via CurrencyAPI: ${amount} ${currency} @ $${cryptoPrice} = $${usdValue} = ₦${nairaValue.toLocaleString()}`);
        return nairaValue;
      }

      // Unsupported currency
      throw new Error(`Unsupported currency: ${currency}. Supported: NGNB, NGN, USD, USDT, USDC, BTC, ETH, SOL`);

    } catch (error) {
      logger.error(`Currency conversion failed for ${amount} ${currency}:`, error);
      throw new Error(`Failed to convert ${currency} to Naira: ${error.message}`);
    }
  }

  /**
   * Get crypto prices using the same CurrencyAPI service as dashboard
   */
  async getCryptoPricesFromCurrencyAPI() {
    try {
      const tokenSymbols = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC'];
      const prices = await getPricesWithCache(tokenSymbols);
      
      if (!prices || Object.keys(prices).length === 0) {
        throw new Error('No prices returned from CurrencyAPI');
      }

      logger.info(`📈 CurrencyAPI prices: ${Object.entries(prices).map(([symbol, price]) => `${symbol}=$${price}`).join(', ')}`);
      return prices;

    } catch (error) {
      logger.error('Failed to get prices from CurrencyAPI:', error);
      throw new Error(`CurrencyAPI price fetch failed: ${error.message}`);
    }
  }

  /**
   * Get conversion rate for a currency to Naira
   */
  async getConversionRate(currency) {
    if (currency === 'NGNB' || currency === 'NGN') return 1;
    
    try {
      if (currency === 'USD' || currency === 'USDT' || currency === 'USDC') {
        const rate = await offrampService.getUsdToNgnRate();
        return rate.finalPrice;
      }

      // For cryptocurrencies, calculate conversion rate using CurrencyAPI
      if (['BTC', 'ETH', 'SOL'].includes(currency)) {
        const prices = await this.getCryptoPricesFromCurrencyAPI();
        const cryptoPriceUSD = prices[currency];
        
        if (!cryptoPriceUSD) {
          throw new Error(`Price not available for ${currency}`);
        }

        const usdToNairaRate = await offrampService.getUsdToNgnRate();
        return cryptoPriceUSD * usdToNairaRate.finalPrice;
      }

      return null;
    } catch (error) {
      logger.error(`Failed to get conversion rate for ${currency}:`, error);
      return null;
    }
  }

  /**
   * Calculate current daily and monthly spending for a user
   */
  async getCurrentSpending(userId) {
    const cacheKey = `spending_${userId}`;
    
    // Check cache first
    if (this.cache.userSpending.has(cacheKey) && 
        this.cache.cacheExpiry.has(cacheKey) && 
        Date.now() < this.cache.cacheExpiry.get(cacheKey)) {
      return this.cache.userSpending.get(cacheKey);
    }

    try {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      // Get successful transactions (withdrawals and bill payments)
      const [regularTransactions, billTransactions] = await Promise.all([
        this.getSuccessfulTransactions(userId, startOfMonth),
        this.getSuccessfulBillTransactions(userId, startOfMonth)
      ]);

      // Calculate daily spending
      const dailyRegular = await this.sumTransactionsByDate(regularTransactions, startOfDay);
      const dailyBills = this.sumBillTransactionsByDate(billTransactions, startOfDay);
      const dailyTotal = dailyRegular + dailyBills;

      // Calculate monthly spending
      const monthlyRegular = await this.sumTransactionsByDate(regularTransactions, startOfMonth);
      const monthlyBills = this.sumBillTransactionsByDate(billTransactions, startOfMonth);
      const monthlyTotal = monthlyRegular + monthlyBills;

      const spending = {
        daily: dailyTotal,
        monthly: monthlyTotal,
        breakdown: {
          daily: { regular: dailyRegular, bills: dailyBills },
          monthly: { regular: monthlyRegular, bills: monthlyBills }
        },
        calculatedAt: now
      };

      // Cache the result
      this.cache.userSpending.set(cacheKey, spending);
      this.cache.cacheExpiry.set(cacheKey, Date.now() + this.cacheTimeout);

      logger.info(`📊 Current spending for user ${userId}: Daily ₦${dailyTotal.toLocaleString()}, Monthly ₦${monthlyTotal.toLocaleString()}`);
      
      return spending;

    } catch (error) {
      logger.error('Failed to calculate current spending:', error);
      throw new Error('Failed to calculate current spending');
    }
  }

  /**
   * Get successful regular transactions for a user since a date
   */
  async getSuccessfulTransactions(userId, sinceDate) {
    return await Transaction.find({
      userId,
      type: 'WITHDRAWAL', // Only count withdrawals towards limits
      status: { $in: ['SUCCESSFUL', 'CONFIRMED', 'APPROVED'] },
      createdAt: { $gte: sinceDate }
    }).select('amount currency createdAt').lean();
  }

  /**
   * Get successful bill transactions for a user since a date
   */
  async getSuccessfulBillTransactions(userId, sinceDate) {
    return await BillTransaction.find({
      userId,
      status: 'completed-api',
      createdAt: { $gte: sinceDate }
    }).select('amountNaira amountNGNB createdAt').lean();
  }

  /**
   * Sum regular transactions by date, converting to Naira using CurrencyAPI
   */
  async sumTransactionsByDate(transactions, sinceDate) {
    let sum = 0;
    
    // Get crypto prices once for all transactions to avoid multiple API calls
    let cryptoPrices = null;
    
    for (const tx of transactions) {
      if (tx.createdAt >= sinceDate) {
        try {
          // For crypto currencies, get prices only once
          if (['BTC', 'ETH', 'SOL'].includes(tx.currency) && !cryptoPrices) {
            cryptoPrices = await this.getCryptoPricesFromCurrencyAPI();
          }
          
          // Convert each transaction to Naira based on its currency
          const amountInNaira = await this.convertToNaira(tx.amount, tx.currency);
          sum += amountInNaira;
        } catch (error) {
          logger.warn(`Failed to convert transaction ${tx._id} (${tx.amount} ${tx.currency}):`, error.message);
          // For failed conversions, assume NGNB if currency is not specified
          if (!tx.currency || tx.currency === 'NGNB' || tx.currency === 'NGN') {
            sum += tx.amount;
          }
          // Skip transactions with unconvertible currencies rather than failing
        }
      }
    }
    
    return sum;
  }

  /**
   * Sum bill transactions by date (already in Naira/NGNB)
   */
  sumBillTransactionsByDate(transactions, sinceDate) {
    return transactions.reduce((sum, tx) => {
      if (tx.createdAt >= sinceDate) {
        const amount = tx.amountNaira || tx.amountNGNB || 0;
        return sum + amount;
      }
      return sum;
    }, 0);
  }

  /**
   * Get upgrade recommendation based on current KYC level
   */
  getUpgradeRecommendation(currentLevel) {
    const recommendations = {
      0: 'Complete basic verification (Level 1) to start making transactions',
      1: 'Complete identity verification (Level 2) for higher limits up to ₦5M daily',
      2: 'Complete enhanced verification (Level 3) for maximum limits up to ₦20M daily'
    };
    return recommendations[currentLevel] || 'Your account has maximum verification';
  }

  /**
   * Create standardized success response
   */
  createSuccessResponse(code, message, data = {}) {
    return {
      allowed: true,
      code,
      message,
      data,
      timestamp: new Date()
    };
  }

  /**
   * Create standardized error response
   */
  createErrorResponse(code, message, data = {}) {
    return {
      allowed: false,
      code,
      message,
      data,
      timestamp: new Date()
    };
  }

  /**
   * Check specific limits without processing
   */
  async checkLimitsOnly(userId) {
    try {
      const user = await this.getUser(userId);
      if (!user) return null;

      const kycLimits = user.getKycLimits();
      const currentSpending = await this.getCurrentSpending(userId);

      return {
        kycLevel: user.kycLevel,
        limits: kycLimits,
        currentSpending,
        remaining: {
          daily: Math.max(0, kycLimits.daily - currentSpending.daily),
          monthly: Math.max(0, kycLimits.monthly - currentSpending.monthly)
        }
      };
    } catch (error) {
      logger.error('Failed to check limits:', error);
      throw error;
    }
  }

  /**
   * Clear cache for a specific user
   */
  clearUserCache(userId) {
    const cacheKey = `spending_${userId}`;
    this.cache.userSpending.delete(cacheKey);
    this.cache.cacheExpiry.delete(cacheKey);
  }

  /**
   * Clear all caches
   */
  clearAllCache() {
    this.cache.userSpending.clear();
    this.cache.cacheExpiry.clear();
  }

  /**
   * Get current crypto prices for debugging
   */
  async getCurrentPrices() {
    try {
      return await this.getCryptoPricesFromCurrencyAPI();
    } catch (error) {
      logger.error('Failed to get current prices:', error);
      return {};
    }
  }

  /**
   * Test price conversion for debugging
   */
  async testConversion(amount, fromCurrency, toCurrency = 'NGNB') {
    try {
      if (toCurrency !== 'NGNB') {
        throw new Error('Only conversion to NGNB is supported');
      }
      
      const result = await this.convertToNaira(amount, fromCurrency);
      return {
        success: true,
        originalAmount: amount,
        originalCurrency: fromCurrency,
        convertedAmount: result,
        convertedCurrency: 'NGNB',
        conversionRate: result / amount
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        originalAmount: amount,
        originalCurrency: fromCurrency
      };
    }
  }
}

// Create singleton instance
const kycLimitService = new KYCLimitService();

module.exports = {
  KYCLimitService,
  kycLimitService,
  
  // Main validation method
  validateTransactionLimit: (userId, amount, currency, transactionType) => 
    kycLimitService.validateTransactionLimit(userId, amount, currency, transactionType),
  
  // Utility methods
  checkLimitsOnly: (userId) => kycLimitService.checkLimitsOnly(userId),
  clearUserCache: (userId) => kycLimitService.clearUserCache(userId),
  clearAllCache: () => kycLimitService.clearAllCache(),
  
  // Price utilities (now using CurrencyAPI)
  getCurrentPrices: () => kycLimitService.getCurrentPrices(),
  testConversion: (amount, fromCurrency, toCurrency) => kycLimitService.testConversion(amount, fromCurrency, toCurrency),
  
  // Direct access to service
  service: kycLimitService
};