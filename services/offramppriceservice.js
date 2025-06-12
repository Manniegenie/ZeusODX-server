const axios = require('axios');
const logger = require('../utils/logger');
const NairaMarkdown = require('../models/markdown'); // Different schema for offramp

/**
 * Simple CurrencyAPI.com service with markdown (reduction for offramp)
 */
class OfframpPriceService {
  constructor() {
    this.apiKey = process.env.CURRENCYAPI_KEY;
    this.baseURL = 'https://api.currencyapi.com/v3';
    this.cachedRate = null;
    this.cacheExpiry = null;
    this.cacheDuration = 2 * 60 * 1000; // 2 minutes cache
    this.fallbackRate = 1650; // Emergency fallback rate
    this.requestCount = 0;
    
    // Markdown cache (reduction for offramp)
    this.markdownCache = null;
    this.markdownCacheExpiry = null;
    this.markdownCacheDuration = 5 * 60 * 1000; // 5 minutes cache for markdown
  }

  /**
   * Get markdown number from database (reduction for offramp)
   * @returns {Promise<number>} Markdown number
   */
  async getMarkdown() {
    // Check cache
    if (this.markdownCache !== null && this.markdownCacheExpiry && new Date() < this.markdownCacheExpiry) {
      return this.markdownCache;
    }

    try {
      const markdownRecord = await NairaMarkdown.findOne({});
      const markdown = markdownRecord?.markdown || 0;
      
      // Cache the markdown
      this.markdownCache = markdown;
      this.markdownCacheExpiry = new Date(Date.now() + this.markdownCacheDuration);
      
      return markdown;
    } catch (error) {
      logger.error('Failed to get markdown from database:', error);
      return 0; // Return 0 if error
    }
  }

  /**
   * Get USD to NGN exchange rate with markdown reduction applied (for offramp)
   * @returns {Promise<Object>} Rate information with markdown applied
   */
  async getUsdToNgnRate() {
    // Check cache first
    if (this.isCacheValid()) {
      logger.debug('Using cached CurrencyAPI offramp rate');
      return this.cachedRate;
    }

    if (!this.apiKey) {
      logger.error('CurrencyAPI key not configured');
      return this.getFallbackRate();
    }

    try {
      this.requestCount++;
      logger.debug(`Making CurrencyAPI offramp request #${this.requestCount} this session`);

      const response = await axios.get(`${this.baseURL}/latest`, {
        headers: { 'apikey': this.apiKey },
        params: { base_currency: 'USD', currencies: 'NGN' },
        timeout: 8000
      });

      if (!response.data?.data?.NGN) {
        throw new Error('Invalid response format from CurrencyAPI');
      }

      const baseRate = response.data.data.NGN.value;
      
      // Get markdown from database and subtract from rate (reduction for offramp)
      const markdown = await this.getMarkdown();
      const finalRate = baseRate - markdown;

      const rateInfo = {
        finalPrice: finalRate,
        lastUpdated: response.data.meta.last_updated_at,
        source: 'currencyapi.com',
        reliability: 'high',
        requestCount: this.requestCount,
        type: 'offramp'
      };

      this.cacheRate(rateInfo);
      logger.info(`Offramp rate with markdown: ₦${baseRate} - ₦${markdown} = ₦${finalRate} per $1`);

      return rateInfo;

    } catch (error) {
      logger.error('CurrencyAPI offramp request failed:', error.message);
      return this.getFallbackRate();
    }
  }

  /**
   * Convert Naira to USD (markdown already applied to rate)
   * @param {number} nairaAmount - Amount in NGN
   * @returns {Promise<number>} Amount in USD
   */
  async convertNairaToUsd(nairaAmount) {
    try {
      const rateInfo = await this.getUsdToNgnRate();
      const usdAmount = nairaAmount / rateInfo.finalPrice;
      
      logger.debug(`Offramp Naira to USD: ₦${nairaAmount} ÷ ₦${rateInfo.finalPrice} = $${usdAmount.toFixed(4)}`);
      return usdAmount;

    } catch (error) {
      logger.error('Offramp Naira to USD conversion failed:', error);
      
      // Emergency fallback
      const fallbackAmount = nairaAmount / this.fallbackRate;
      logger.warn(`Using fallback offramp conversion: ₦${nairaAmount} = $${fallbackAmount.toFixed(4)}`);
      return fallbackAmount;
    }
  }

  /**
   * Convert USD to Naira (markdown already applied to rate)
   * @param {number} usdAmount - Amount in USD
   * @returns {Promise<number>} Amount in NGN
   */
  async convertUsdToNaira(usdAmount) {
    try {
      const rateInfo = await this.getUsdToNgnRate();
      const nairaAmount = usdAmount * rateInfo.finalPrice;
      
      logger.debug(`Offramp USD to Naira: $${usdAmount} × ₦${rateInfo.finalPrice} = ₦${nairaAmount.toFixed(2)}`);
      return nairaAmount;

    } catch (error) {
      logger.error('Offramp USD to Naira conversion failed:', error);
      
      // Emergency fallback
      const fallbackAmount = usdAmount * this.fallbackRate;
      logger.warn(`Using fallback offramp conversion: $${usdAmount} = ₦${fallbackAmount.toFixed(2)}`);
      return fallbackAmount;
    }
  }

  /**
   * Calculate crypto amount needed for Naira purchase (offramp scenario)
   * @param {number} nairaAmount - Amount in Naira
   * @param {string} cryptoCurrency - Target cryptocurrency
   * @param {number} cryptoPrice - Current crypto price in USD
   * @returns {Promise<number>} Crypto amount needed
   */
  async calculateCryptoRequired(nairaAmount, cryptoCurrency, cryptoPrice) {
    try {
      const usdAmount = await this.convertNairaToUsd(nairaAmount);
      const cryptoAmount = usdAmount / cryptoPrice;
      
      logger.debug(`Offramp crypto calculation: ₦${nairaAmount} → $${usdAmount.toFixed(4)} → ${cryptoAmount.toFixed(8)} ${cryptoCurrency}`);
      
      return parseFloat(cryptoAmount.toFixed(8));

    } catch (error) {
      logger.error('Offramp crypto calculation failed:', error);
      throw new Error(`Failed to calculate offramp crypto requirement: ${error.message}`);
    }
  }

  /**
   * Calculate Naira amount user receives for crypto (typical offramp scenario)
   * @param {number} cryptoAmount - Amount of crypto to sell
   * @param {string} cryptoCurrency - Cryptocurrency being sold
   * @param {number} cryptoPrice - Current crypto price in USD
   * @returns {Promise<number>} Naira amount user receives
   */
  async calculateNairaFromCrypto(cryptoAmount, cryptoCurrency, cryptoPrice) {
    try {
      const usdAmount = cryptoAmount * cryptoPrice;
      const nairaAmount = await this.convertUsdToNaira(usdAmount);
      
      logger.debug(`Offramp calculation: ${cryptoAmount} ${cryptoCurrency} → $${usdAmount.toFixed(4)} → ₦${nairaAmount.toFixed(2)}`);
      
      return parseFloat(nairaAmount.toFixed(2));

    } catch (error) {
      logger.error('Offramp Naira calculation failed:', error);
      throw new Error(`Failed to calculate offramp Naira amount: ${error.message}`);
    }
  }

  /**
   * Get fallback rate with default markdown reduction
   * @returns {Object} Fallback rate
   */
  getFallbackRate() {
    const fallbackMarkdown = 50; // Default markdown reduction
    const adjustedRate = this.fallbackRate - fallbackMarkdown;
    
    logger.warn(`Using offramp fallback rate: ₦${this.fallbackRate} - ₦${fallbackMarkdown} = ₦${adjustedRate} per $1`);
    return {
      finalPrice: adjustedRate,
      lastUpdated: new Date().toISOString(),
      source: 'fallback-static',
      reliability: 'low',
      type: 'offramp'
    };
  }

  /**
   * Cache rate
   * @param {Object} rateData - Rate data to cache
   */
  cacheRate(rateData) {
    this.cachedRate = rateData;
    this.cacheExpiry = new Date(Date.now() + this.cacheDuration);
    logger.debug(`Offramp rate cached until: ${this.cacheExpiry.toISOString()}`);
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
    this.markdownCache = null;
    this.markdownCacheExpiry = null;
    logger.info('Offramp caches cleared');
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
        quotaRemaining: response.data.quotas?.month?.remaining || 'Unknown',
        type: 'offramp'
      };

    } catch (error) {
      return {
        configured: true,
        sessionRequests: this.requestCount,
        error: error.message,
        type: 'offramp'
      };
    }
  }

  /**
   * Health check
   * @returns {Promise<Object>} Health status
   */
  async healthCheck() {
    try {
      const [rate, markdown] = await Promise.all([
        this.getUsdToNgnRate(),
        this.getMarkdown()
      ]);

      return {
        status: 'healthy',
        rate: rate.finalPrice,
        markdown: markdown,
        cacheValid: this.isCacheValid(),
        type: 'offramp'
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        type: 'offramp'
      };
    }
  }

  /**
   * Get current exchange rate info (for display purposes)
   * @returns {Promise<Object>} Current rate information
   */
  async getCurrentRate() {
    return await this.getUsdToNgnRate();
  }

  /**
   * Force refresh rate (clear cache and fetch new)
   * @returns {Promise<Object>} Fresh rate information
   */
  async refreshRate() {
    this.cachedRate = null;
    this.cacheExpiry = null;
    return await this.getUsdToNgnRate();
  }
}

// Create singleton instance
const offrampService = new OfframpPriceService();

// Export simple methods (markdown reduction included silently)
module.exports = {
  OfframpPriceService,
  offrampService,
  
  // Main methods for offramp
  convertNairaToUsd: (amount) => offrampService.convertNairaToUsd(amount),
  convertUsdToNaira: (amount) => offrampService.convertUsdToNaira(amount),
  calculateCryptoRequired: (nairaAmount, cryptoCurrency, cryptoPrice) => 
    offrampService.calculateCryptoRequired(nairaAmount, cryptoCurrency, cryptoPrice),
  calculateNairaFromCrypto: (cryptoAmount, cryptoCurrency, cryptoPrice) =>
    offrampService.calculateNairaFromCrypto(cryptoAmount, cryptoCurrency, cryptoPrice),
  
  // Utility methods
  getCurrentRate: () => offrampService.getCurrentRate(),
  refreshRate: () => offrampService.refreshRate(),
  getApiStatus: () => offrampService.getApiStatus(),
  healthCheck: () => offrampService.healthCheck(),
  clearCache: () => offrampService.clearCache()
};