const User = require('../models/user');
const Transaction = require('../models/transaction');
const BillTransaction = require('../models/billstransaction');
const { offrampService } = require('./offramppriceservice');
const { getPricesWithCache } = require('./portfolio'); 
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
   * Get KYC limits for a user with fallback logic
   */
  getUserKycLimits(user, transactionType = 'WITHDRAWAL') {
    try {
      if (user && typeof user.getKycLimits === 'function') {
        const limits = user.getKycLimits();
        
        if (limits && typeof limits === 'object') {
          if (['AIRTIME', 'BILL_PAYMENT', 'UTILITY'].includes(transactionType) && limits.utilities) {
            return limits.utilities;
          }
          
          if (['WITHDRAWAL', 'SWAP', 'CRYPTO', 'INTERNAL_TRANSFER'].includes(transactionType) && limits.crypto) {
            // Internally override the model's $2M value to 3B Naira for consistent math
            return { daily: 3000000000, monthly: 3000000000 };
          }
          
          if (['NGNZ', 'NGNZ_TRANSFER'].includes(transactionType) && limits.ngnz) {
            return limits.ngnz;
          }
        }
      }

      const kycLevel = user?.kycLevel || 0;
      return this.getDefaultLimitsForTransaction(kycLevel, transactionType);
      
    } catch (error) {
      logger.error('Error getting KYC limits, using defaults:', error);
      return this.getDefaultLimitsForTransaction(0, transactionType); 
    }
  }

  /**
   * Get default limits - Crypto normalized to Naira (3 Billion)
   */
  getDefaultLimitsForTransaction(kycLevel, transactionType) {
    const defaultLimitsByType = {
      0: {
        ngnz: { daily: 0, monthly: 0 },
        crypto: { daily: 0, monthly: 0 },
        utilities: { daily: 0, monthly: 0 }
      },
      1: {
        ngnz: { daily: 0, monthly: 0 },
        crypto: { daily: 0, monthly: 0 },
        utilities: { daily: 50000, monthly: 200000 }
      },
      2: {
        ngnz: { daily: 25000000, monthly: 200000000 },
        // $2,000,000 USD normalized to Naira
        crypto: { daily: 3000000000, monthly: 3000000000 }, 
        utilities: { daily: 500000, monthly: 2000000 }
      }
    };

    const limitsForLevel = defaultLimitsByType[kycLevel] || defaultLimitsByType[0];
    
    if (['AIRTIME', 'BILL_PAYMENT', 'UTILITY'].includes(transactionType)) return limitsForLevel.utilities;
    if (['WITHDRAWAL', 'SWAP', 'CRYPTO', 'INTERNAL_TRANSFER'].includes(transactionType)) return limitsForLevel.crypto;
    if (['NGNZ', 'NGNZ_TRANSFER'].includes(transactionType)) return limitsForLevel.ngnz;
    
    return limitsForLevel.utilities;
  }

  /**
   * Main validation method
   */
  async validateTransactionLimit(userId, amount, currency = 'NGNZ', transactionType = 'WITHDRAWAL') {
    try {
      logger.info(`[KYC] Validation for ${userId}: ${amount} ${currency} (type: ${transactionType})`);

      // Validate amount
      if (!amount || amount <= 0 || isNaN(amount)) {
        logger.warn(`[KYC] Invalid amount: ${amount}`, { userId, currency, transactionType });
        return this.createErrorResponse('INVALID_AMOUNT', 'Transaction exceeds your current KYC limit.');
      }

      const user = await this.getUser(userId);
      if (!user) return this.createErrorResponse('USER_NOT_FOUND', 'User not found');

      const kycLimits = this.getUserKycLimits(user, transactionType);
      const userKycLevel = user.kycLevel || 0;

      // Logic Mapping: NGNZ vs Crypto
      let amountInNaira;
      const upperCurrency = currency.toUpperCase();

      if (upperCurrency === 'NGNZ' || upperCurrency === 'NGN') {
        amountInNaira = amount; // NGNZ service bypasses conversion
      } else {
        amountInNaira = await this.convertToNaira(amount, upperCurrency);
      }

      if (userKycLevel === 0) {
        return this.createErrorResponse('KYC_REQUIRED', 'KYC Level 1 required');
      }

      // Get spending filtered by transaction type category
      const currentSpending = await this.getCurrentSpending(userId, transactionType);
      const newDailyTotal = currentSpending.daily + amountInNaira;
      const newMonthlyTotal = currentSpending.monthly + amountInNaira;

      logger.info(`[KYC] Spending check for ${userId}: daily=${currentSpending.daily}, monthly=${currentSpending.monthly}, requested=${amountInNaira}, dailyLimit=${kycLimits.daily}, monthlyLimit=${kycLimits.monthly}, type=${transactionType}`);

      // Daily limit validation
      if (newDailyTotal > kycLimits.daily) {
        const availableAmount = Math.max(0, kycLimits.daily - currentSpending.daily);
        logger.warn(`[KYC] Daily limit exceeded for ${userId}. Available: ₦${availableAmount}`);

        return this.createErrorResponse('LIMIT_EXCEEDED', `Daily limit exceeded`, {
          kycLevel: userKycLevel,
          requestedAmount: amountInNaira,
          currentLimit: kycLimits.daily,
          availableAmount,
          currency
        });
      }

      // Monthly limit validation
      if (kycLimits.monthly != null && newMonthlyTotal > kycLimits.monthly) {
        const availableMonthly = Math.max(0, kycLimits.monthly - currentSpending.monthly);
        logger.warn(`[KYC] Monthly limit exceeded for ${userId}. Available: ₦${availableMonthly}`);

        return this.createErrorResponse('LIMIT_EXCEEDED', `Monthly limit exceeded`, {
          kycLevel: userKycLevel,
          requestedAmount: amountInNaira,
          currentLimit: kycLimits.monthly,
          availableAmount: availableMonthly,
          currency
        });
      }

      return this.createSuccessResponse('TRANSACTION_ALLOWED', 'Success', {
        kycLevel: userKycLevel,
        newDailyTotal,
        dailyRemaining: kycLimits.daily - newDailyTotal,
        amountInNaira
      });

    } catch (error) {
      // Log specific error details for debugging, but return generic message to user
      const errorType = error.message.includes('UNSUPPORTED_CURRENCY') ? 'UNSUPPORTED_CURRENCY' : 
                       error.message.includes('Price missing') ? 'PRICE_UNAVAILABLE' : 
                       'VALIDATION_ERROR';
      
      logger.error('[KYC] Validation error:', { 
        userId, 
        currency, 
        amount, 
        transactionType,
        errorType,
        errorMessage: error.message,
        stack: error.stack 
      });
      
      // Return generic error response (user-facing message stays generic)
      return this.createErrorResponse('VALIDATION_ERROR', 'Transaction exceeds your current KYC limit.');
    }
  }

  async getUser(userId) {
    return await User.findById(userId).select('+kycLevel +kyc');
  }

  async convertToNaira(amount, currency) {
    if (['NGNZ', 'NGN', 'NAIRA'].includes(currency)) return amount;

    try {
      if (['USDT', 'USDC', 'USD'].includes(currency)) {
        return await offrampService.convertUsdToNaira(amount);
      }

      // Support all withdrawable crypto tokens: BTC, ETH, SOL, BNB, MATIC, TRX
      const cryptoCurrencies = ['BTC', 'ETH', 'SOL', 'BNB', 'MATIC', 'TRX'];
      if (cryptoCurrencies.includes(currency)) {
        const prices = await this.getCryptoPricesFromCurrencyAPI();
        const cryptoPrice = prices[currency];
        
        if (!cryptoPrice || cryptoPrice === 0) {
          const errorMsg = `Price missing or unavailable for ${currency}`;
          logger.error(`[KYC] ${errorMsg}`, { currency, availablePrices: Object.keys(prices) });
          throw new Error(`UNSUPPORTED_CURRENCY: ${errorMsg}`);
        }

        const usdValue = amount * cryptoPrice;
        return await offrampService.convertUsdToNaira(usdValue);
      }
      
      const errorMsg = `Unsupported currency for KYC conversion: ${currency}`;
      logger.error(`[KYC] ${errorMsg}`, { currency });
      throw new Error(`UNSUPPORTED_CURRENCY: ${errorMsg}`);
    } catch (error) {
      // Log specific error details for debugging
      if (error.message.includes('UNSUPPORTED_CURRENCY') || error.message.includes('Price missing')) {
        logger.error(`[KYC] Conversion failed: ${currency}`, { 
          currency, 
          error: error.message,
          errorType: error.message.includes('UNSUPPORTED_CURRENCY') ? 'UNSUPPORTED_CURRENCY' : 'PRICE_UNAVAILABLE'
        });
      } else {
        logger.error(`[KYC] Conversion failed: ${currency}`, { currency, error: error.message });
      }
      throw error;
    }
  }

  async getCryptoPricesFromCurrencyAPI() {
    // Fetch prices for all withdrawable crypto tokens
    return await getPricesWithCache(['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'TRX']);
  }

  async getConversionRate(currency) {
    if (['NGNZ', 'NGN'].includes(currency)) return 1;
    const rate = await offrampService.getUsdToNgnRate();
    if (['USD', 'USDT', 'USDC'].includes(currency)) return rate.finalPrice;
    
    const prices = await this.getCryptoPricesFromCurrencyAPI();
    const cryptoPrice = prices[currency];
    
    if (!cryptoPrice || cryptoPrice === 0) {
      const errorMsg = `Price missing or unavailable for ${currency} in getConversionRate`;
      logger.error(`[KYC] ${errorMsg}`, { currency, availablePrices: Object.keys(prices) });
      throw new Error(`PRICE_UNAVAILABLE: ${errorMsg}`);
    }
    
    return cryptoPrice * rate.finalPrice;
  }

  /**
   * Get spending category for a transaction type (for cache keys and invalidation).
   */
  getSpendingCategory(transactionType) {
    const isUtility = ['AIRTIME', 'BILL_PAYMENT', 'UTILITY'].includes(transactionType);
    const isCrypto = ['WITHDRAWAL', 'SWAP', 'CRYPTO', 'INTERNAL_TRANSFER'].includes(transactionType);
    return isUtility ? 'utility' : (isCrypto ? 'crypto' : 'ngnz');
  }

  /**
   * Invalidate cached spending for a user so the next limit check uses fresh data.
   * Call after a transaction completes (withdrawal, bill, internal transfer).
   * @param {string} userId - User ID
   * @param {string} transactionType - One of WITHDRAWAL, NGNZ, NGNZ_TRANSFER, INTERNAL_TRANSFER, BILL_PAYMENT, AIRTIME, UTILITY
   */
  invalidateSpending(userId, transactionType) {
    const category = this.getSpendingCategory(transactionType);
    const cacheKey = `spending_${userId}_${category}`;
    this.cache.userSpending.delete(cacheKey);
    this.cache.cacheExpiry.delete(cacheKey);
    logger.info(`[KYC] Invalidated spending cache for ${userId} (${category})`);
  }

  async getCurrentSpending(userId, transactionType = 'WITHDRAWAL') {
    // Determine the spending category based on transaction type
    const isUtilityTransaction = ['AIRTIME', 'BILL_PAYMENT', 'UTILITY'].includes(transactionType);
    const isCryptoTransaction = ['WITHDRAWAL', 'SWAP', 'CRYPTO', 'INTERNAL_TRANSFER'].includes(transactionType);
    const isNgnzTransaction = ['NGNZ', 'NGNZ_TRANSFER'].includes(transactionType);

    // Use category-specific cache key
    const category = this.getSpendingCategory(transactionType);
    const cacheKey = `spending_${userId}_${category}`;

    if (this.cache.userSpending.has(cacheKey) && Date.now() < this.cache.cacheExpiry.get(cacheKey)) {
      return this.cache.userSpending.get(cacheKey);
    }

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    let dailyTotal = 0;
    let monthlyTotal = 0;

    if (isUtilityTransaction) {
      // For utility transactions, only count bill transactions (airtime, data, electricity, etc.)
      const billTransactions = await this.getSuccessfulBillTransactions(userId, startOfMonth);
      dailyTotal = this.sumBillTransactionsByDate(billTransactions, startOfDay);
      monthlyTotal = this.sumBillTransactionsByDate(billTransactions, startOfMonth);

      logger.info(`[KYC] Utility spending for ${userId}: daily=${dailyTotal}, monthly=${monthlyTotal}, billCount=${billTransactions.length}`);
    } else if (isCryptoTransaction) {
      // For crypto transactions, count withdrawal or internal transfer transactions based on transactionType
      const regularTransactions = await this.getSuccessfulTransactions(userId, startOfMonth, transactionType);
      dailyTotal = await this.sumTransactionsByDate(regularTransactions, startOfDay);
      monthlyTotal = await this.sumTransactionsByDate(regularTransactions, startOfMonth);

      logger.info(`[KYC] Crypto spending for ${userId}: daily=${dailyTotal}, monthly=${monthlyTotal}, txCount=${regularTransactions.length}, type=${transactionType}`);
    } else {
      // For NGNZ/other transactions, count both (original behavior as fallback)
      const [regularTransactions, billTransactions] = await Promise.all([
        this.getSuccessfulTransactions(userId, startOfMonth, transactionType),
        this.getSuccessfulBillTransactions(userId, startOfMonth)
      ]);

      dailyTotal = (await this.sumTransactionsByDate(regularTransactions, startOfDay)) +
                   this.sumBillTransactionsByDate(billTransactions, startOfDay);
      monthlyTotal = (await this.sumTransactionsByDate(regularTransactions, startOfMonth)) +
                     this.sumBillTransactionsByDate(billTransactions, startOfMonth);
    }

    const spending = { daily: dailyTotal, monthly: monthlyTotal };
    this.cache.userSpending.set(cacheKey, spending);
    this.cache.cacheExpiry.set(cacheKey, Date.now() + this.cacheTimeout);
    return spending;
  }

  async getSuccessfulTransactions(userId, sinceDate, transactionType = 'WITHDRAWAL') {
    // For INTERNAL_TRANSFER limit checks, count INTERNAL_TRANSFER_SENT (crypto)
    // For WITHDRAWAL limit checks, count WITHDRAWAL (crypto)
    // For NGNZ/NGNZ_TRANSFER, count both WITHDRAWAL and INTERNAL_TRANSFER_SENT in NGNZ only
    let transactionTypes;
    const query = {
      userId,
      status: { $in: ['SUCCESSFUL', 'CONFIRMED', 'APPROVED', 'COMPLETED'] },
      createdAt: { $gte: sinceDate }
    };

    if (transactionType === 'INTERNAL_TRANSFER') {
      transactionTypes = ['INTERNAL_TRANSFER_SENT'];
    } else if (['NGNZ', 'NGNZ_TRANSFER'].includes(transactionType)) {
      transactionTypes = ['WITHDRAWAL', 'INTERNAL_TRANSFER_SENT'];
      query.currency = { $in: ['NGNZ', 'NGN'] };
    } else {
      transactionTypes = ['WITHDRAWAL'];
    }

    query.type = { $in: transactionTypes };
    return await Transaction.find(query).lean();
  }

  async getSuccessfulBillTransactions(userId, sinceDate) {
    return await BillTransaction.find({
      userId,
      status: 'completed',
      createdAt: { $gte: sinceDate }
    }).lean();
  }

  async sumTransactionsByDate(transactions, sinceDate) {
    let sum = 0;
    for (const tx of transactions) {
      if (tx.createdAt >= sinceDate) {
        if (!tx.currency) {
          logger.warn('[KYC] Transaction missing currency, skipping for spending sum', { txId: tx._id });
          continue;
        }
        try {
          // Use absolute value since withdrawals have negative amounts but should count as positive spending
          const amountToAdd = Math.abs(tx.amount);
          if (amountToAdd <= 0 || isNaN(amountToAdd)) {
            logger.warn('[KYC] Invalid transaction amount, skipping', { txId: tx._id, currency: tx.currency, amount: tx.amount });
            continue;
          }
          sum += await this.convertToNaira(amountToAdd, tx.currency);
        } catch (e) {
          logger.error('[KYC] Conversion failed for transaction, skipping', { 
            txId: tx._id, 
            currency: tx.currency, 
            amount: tx.amount,
            error: e.message,
            errorType: e.message.includes('UNSUPPORTED_CURRENCY') ? 'UNSUPPORTED_CURRENCY' : 'PRICE_UNAVAILABLE'
          });
          // Skip rather than use wrong fallback (amount could be in different currency)
          // This undercounts spending but prevents incorrect limit checks
        }
      }
    }
    return sum;
  }

  sumBillTransactionsByDate(transactions, sinceDate) {
    return transactions.reduce((sum, tx) => 
      tx.createdAt >= sinceDate ? sum + (tx.amountNaira || tx.amount || 0) : sum, 0);
  }

  createSuccessResponse(code, message, data = {}) {
    return { allowed: true, code, message, data };
  }

  createErrorResponse(code, message, data = {}) {
    return { allowed: false, code, message, data };
  }
}

const kycLimitService = new KYCLimitService();

module.exports = {
  validateTransactionLimit: (userId, amount, currency, transactionType) =>
    kycLimitService.validateTransactionLimit(userId, amount, currency, transactionType),
  invalidateSpending: (userId, transactionType) =>
    kycLimitService.invalidateSpending(userId, transactionType),
  service: kycLimitService
};