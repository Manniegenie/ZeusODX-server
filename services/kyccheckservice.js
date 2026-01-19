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
          
          if (['WITHDRAWAL', 'SWAP', 'CRYPTO'].includes(transactionType) && limits.crypto) {
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
    if (['WITHDRAWAL', 'SWAP', 'CRYPTO'].includes(transactionType)) return limitsForLevel.crypto;
    if (['NGNZ', 'NGNZ_TRANSFER'].includes(transactionType)) return limitsForLevel.ngnz;
    
    return limitsForLevel.utilities;
  }

  /**
   * Main validation method
   */
  async validateTransactionLimit(userId, amount, currency = 'NGNZ', transactionType = 'WITHDRAWAL') {
    try {
      logger.info(`[KYC] Validation for ${userId}: ${amount} ${currency} (type: ${transactionType})`);

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

      logger.info(`[KYC] Spending check for ${userId}: current=${currentSpending.daily}, requested=${amountInNaira}, limit=${kycLimits.daily}, type=${transactionType}`);

      // Validation
      if (newDailyTotal > kycLimits.daily) {
        const availableAmount = Math.max(0, kycLimits.daily - currentSpending.daily);
        logger.warn(`[KYC] Limit Exceeded for ${userId}. Available: ₦${availableAmount}`);

        return this.createErrorResponse('LIMIT_EXCEEDED', `Daily limit exceeded`, {
          kycLevel: userKycLevel,
          requestedAmount: amountInNaira,
          currentLimit: kycLimits.daily,
          availableAmount,
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
      logger.error('KYC validation error:', error);
      return this.createErrorResponse('VALIDATION_ERROR', error.message);
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

      if (['BTC', 'ETH', 'SOL'].includes(currency)) {
        const prices = await this.getCryptoPricesFromCurrencyAPI();
        const cryptoPrice = prices[currency];
        if (!cryptoPrice) throw new Error(`Price missing for ${currency}`);

        const usdValue = amount * cryptoPrice;
        return await offrampService.convertUsdToNaira(usdValue);
      }
      throw new Error(`Unsupported currency: ${currency}`);
    } catch (error) {
      logger.error(`Conversion failed: ${currency}`, error);
      throw error;
    }
  }

  async getCryptoPricesFromCurrencyAPI() {
    return await getPricesWithCache(['BTC', 'ETH', 'SOL', 'USDT', 'USDC']);
  }

  async getConversionRate(currency) {
    if (['NGNZ', 'NGN'].includes(currency)) return 1;
    const rate = await offrampService.getUsdToNgnRate();
    if (['USD', 'USDT', 'USDC'].includes(currency)) return rate.finalPrice;
    
    const prices = await this.getCryptoPricesFromCurrencyAPI();
    return prices[currency] * rate.finalPrice;
  }

  async getCurrentSpending(userId, transactionType = 'WITHDRAWAL') {
    // Determine the spending category based on transaction type
    const isUtilityTransaction = ['AIRTIME', 'BILL_PAYMENT', 'UTILITY'].includes(transactionType);
    const isCryptoTransaction = ['WITHDRAWAL', 'SWAP', 'CRYPTO'].includes(transactionType);
    const isNgnzTransaction = ['NGNZ', 'NGNZ_TRANSFER'].includes(transactionType);

    // Use category-specific cache key
    const category = isUtilityTransaction ? 'utility' : (isCryptoTransaction ? 'crypto' : 'ngnz');
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
      // For crypto transactions, only count withdrawal transactions
      const regularTransactions = await this.getSuccessfulTransactions(userId, startOfMonth);
      dailyTotal = await this.sumTransactionsByDate(regularTransactions, startOfDay);
      monthlyTotal = await this.sumTransactionsByDate(regularTransactions, startOfMonth);

      logger.info(`[KYC] Crypto spending for ${userId}: daily=${dailyTotal}, monthly=${monthlyTotal}, txCount=${regularTransactions.length}`);
    } else {
      // For NGNZ/other transactions, count both (original behavior as fallback)
      const [regularTransactions, billTransactions] = await Promise.all([
        this.getSuccessfulTransactions(userId, startOfMonth),
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

  async getSuccessfulTransactions(userId, sinceDate) {
    return await Transaction.find({
      userId,
      type: 'WITHDRAWAL',
      status: { $in: ['SUCCESSFUL', 'CONFIRMED', 'APPROVED'] },
      createdAt: { $gte: sinceDate }
    }).lean();
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
        try {
          sum += await this.convertToNaira(tx.amount, tx.currency);
        } catch (e) {
          sum += tx.amount; // Fallback to raw amount if conversion fails
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
  service: kycLimitService
};