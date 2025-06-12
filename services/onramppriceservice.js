const axios = require('axios');
const logger = require('../utils/logger');
const NairaMark = require('../models/markup');

/**
 * Simple CurrencyAPI.com service with markup
 */
class CurrencyAPIService {
  constructor() {
    this.apiKey = process.env.CURRENCYAPI_KEY;
    this.baseURL = 'https://api.currencyapi.com/v3';
    this.cachedRate = null;
    this.cacheExpiry = null;
    this.cacheDuration = 2 * 60 * 1000; // 2 minutes cache
    this.fallbackRate = 1650; // Emergency fallback rate
    this.requestCount = 0;
    
    // Markup cache
    this.markupCache = null;
    this.markupCacheExpiry = null;
    this.markupCacheDuration = 5 * 60 * 1000; // 5 minutes cache for markup
  }

  /**
   * Get markup number from database
   * @returns {Promise<number>} Markup number
   */
  async getMarkup() {
    // Check cache
    if (this.markupCache !== null && this.markupCacheExpiry && new Date() < this.markupCacheExpiry) {
      return this.markupCache;
    }

    try {
      const markupRecord = await NairaMark.findOne({});
      const markup = markupRecord?.markup || 0;
      
      // Cache the markup
      this.markupCache = markup;
      this.markupCacheExpiry = new Date(Date.now() + this.markupCacheDuration);
      
      return markup;
    } catch (error) {
      logger.error('Failed to get markup from database:', error);
      return 0; // Return 0 if error
    }
  }

  /**
   * Get USD to NGN exchange rate with markup added
   * @returns {Promise<Object>} Rate information with markup applied
   */
  async getUsdToNgnRate() {
    // Check cache first
    if (this.isCacheValid()) {
      logger.debug('Using cached CurrencyAPI rate');
      return this.cachedRate;
    }

    if (!this.apiKey) {
      logger.error('CurrencyAPI key not configured');
      return this.getFallbackRate();
    }

    try {
      this.requestCount++;
      logger.debug(`Making CurrencyAPI request #${this.requestCount} this session`);

      const response = await axios.get(`${this.baseURL}/latest`, {
        headers: { 'apikey': this.apiKey },
        params: { base_currency: 'USD', currencies: 'NGN' },
        timeout: 8000
      });

      if (!response.data?.data?.NGN) {
        throw new Error('Invalid response format from CurrencyAPI');
      }

      const baseRate = response.data.data.NGN.value;
      
      // Get markup from database and add to rate
      const markup = await this.getMarkup();
      const finalRate = baseRate + markup;

      const rateInfo = {
        finalPrice: finalRate,
        lastUpdated: response.data.meta.last_updated_at,
        source: 'currencyapi.com',
        reliability: 'high',
        requestCount: this.requestCount
      };

      this.cacheRate(rateInfo);
      logger.info(`Rate with markup: ₦${baseRate} + ₦${markup} = ₦${finalRate} per $1`);

      return rateInfo;

    } catch (error) {
      logger.error('CurrencyAPI request failed:', error.message);
      return this.getFallbackRate();
    }
  }

  /**
   * Convert Naira to USD (markup already included in rate)
   * @param {number} nairaAmount - Amount in NGN
   * @returns {Promise<number>} Amount in USD
   */
  async convertNairaToUsd(nairaAmount) {
    try {
      const rateInfo = await this.getUsdToNgnRate();
      const usdAmount = nairaAmount / rateInfo.finalPrice;
      
      logger.debug(`Naira to USD: ₦${nairaAmount} ÷ ₦${rateInfo.finalPrice} = $${usdAmount.toFixed(4)}`);
      return usdAmount;

    } catch (error) {
      logger.error('Naira to USD conversion failed:', error);
      
      // Emergency fallback
      const fallbackAmount = nairaAmount / this.fallbackRate;
      logger.warn(`Using fallback conversion: ₦${nairaAmount} = $${fallbackAmount.toFixed(4)}`);
      return fallbackAmount;
    }
  }

  /**
   * Convert USD to Naira (markup already included in rate)
   * @param {number} usdAmount - Amount in USD
   * @returns {Promise<number>} Amount in NGN
   */
  async convertUsdToNaira(usdAmount) {
    try {
      const rateInfo = await this.getUsdToNgnRate();
      const nairaAmount = usdAmount * rateInfo.finalPrice;
      
      logger.debug(`USD to Naira: $${usdAmount} × ₦${rateInfo.finalPrice} = ₦${nairaAmount.toFixed(2)}`);
      return nairaAmount;

    } catch (error) {
      logger.error('USD to Naira conversion failed:', error);
      
      // Emergency fallback
      const fallbackAmount = usdAmount * this.fallbackRate;
      logger.warn(`Using fallback conversion: $${usdAmount} = ₦${fallbackAmount.toFixed(2)}`);
      return fallbackAmount;
    }
  }

  /**
   * Calculate crypto amount needed for Naira purchase
   * @param {number} nairaAmount - Amount in Naira
   * @param {string} cryptoCurrency - Target cryptocurrency
   * @param {number} cryptoPrice - Current crypto price in USD
   * @returns {Promise<number>} Crypto amount needed
   */
  async calculateCryptoRequired(nairaAmount, cryptoCurrency, cryptoPrice) {
    try {
      const usdAmount = await this.convertNairaToUsd(nairaAmount);
      const cryptoAmount = usdAmount / cryptoPrice;
      
      logger.debug(`Crypto calculation: ₦${nairaAmount} → $${usdAmount.toFixed(4)} → ${cryptoAmount.toFixed(8)} ${cryptoCurrency}`);
      
      return parseFloat(cryptoAmount.toFixed(8));

    } catch (error) {
      logger.error('Crypto calculation failed:', error);
      throw new Error(`Failed to calculate crypto requirement: ${error.message}`);
    }
  }

  /**
   * Get fallback rate with default markup
   * @returns {Object} Fallback rate
   */
  getFallbackRate() {
    logger.warn(`Using fallback rate: ₦${this.fallbackRate} per $1`);
    return {
      finalPrice: this.fallbackRate,
      lastUpdated: new Date().toISOString(),
      source: 'fallback-static',
      reliability: 'low'
    };
  }

  /**
   * Cache rate
   * @param {Object} rateData - Rate data to cache
   */
  cacheRate(rateData) {
    this.cachedRate = rateData;
    this.cacheExpiry = new Date(Date.now() + this.cacheDuration);
    logger.debug(`Rate cached until: ${this.cacheExpiry.toISOString()}`);
  }

  /**
   * Check if cached rate is valid
   * @returns {boolean} True if cache is valid
   */
  isCacheValid() {
    return this.cachedRate && 
           this.cacheExpiry && 
           new Date() < this.cacheExpiry;
  }

  /**
   * Clear caches
   */
  clearCache() {
    this.cachedRate = null;
    this.cacheExpiry = null;
    this.markupCache = null;
    this.markupCacheExpiry = null;
    logger.info('All caches cleared');
  }

  /**
   * Get API status
   * @returns {Promise<Object>} API status
   */
  async getApiStatus() {
    if (!this.apiKey) {
      return { configured: false, error: 'API key not configured' };
    }

    try {
      const response = await axios.get(`${this.baseURL}/status`, {
        headers: { 'apikey': this.apiKey },
        timeout: 5000
      });

      return {
        configured: true,
        sessionRequests: this.requestCount,
        quotaUsed: response.data.quotas?.month?.used || 'Unknown',
        quotaTotal: response.data.quotas?.month?.total || 'Unknown',
        quotaRemaining: response.data.quotas?.month?.remaining || 'Unknown'
      };

    } catch (error) {
      return {
        configured: true,
        sessionRequests: this.requestCount,
        error: error.message
      };
    }
  }

  /**
   * Health check
   * @returns {Promise<Object>} Health status
   */
  async healthCheck() {
    try {
      const [rate, markup] = await Promise.all([
        this.getUsdToNgnRate(),
        this.getMarkup()
      ]);

      return {
        status: 'healthy',
        rate: rate.finalPrice,
        markup: markup,
        cacheValid: this.isCacheValid()
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }
}

// Create singleton instance
const currencyService = new CurrencyAPIService();

// Export simple methods (markup included silently)
module.exports = {
  CurrencyAPIService,
  currencyService,
  
  // Main methods
  convertNairaToUsd: (amount) => currencyService.convertNairaToUsd(amount),
  convertUsdToNaira: (amount) => currencyService.convertUsdToNaira(amount),
  calculateCryptoRequired: (nairaAmount, cryptoCurrency, cryptoPrice) => 
    currencyService.calculateCryptoRequired(nairaAmount, cryptoCurrency, cryptoPrice),
  
  // Utility methods
  getCurrentRate: () => currencyService.getCurrentRate(),
  refreshRate: () => currencyService.refreshRate(),
  getApiStatus: () => currencyService.getApiStatus(),
  healthCheck: () => currencyService.healthCheck(),
  clearCache: () => currencyService.clearCache()
};