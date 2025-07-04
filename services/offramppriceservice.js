const axios = require('axios');
const logger = require('../utils/logger');
const NairaMarkdown = require('../models/offramp');

/**
 * Offramp service using direct rate from database
 */
class OfframpPriceService {
  constructor() {
    this.apiKey = process.env.CURRENCYAPI_KEY;
    this.baseURL = 'https://api.currencyapi.com/v3';
    this.requestCount = 0;
    
    // Cache objects
    this.cache = {
      rate: null,
      rateExpiry: null,
      currencyAPIRate: null,
      currencyAPIExpiry: null
    };
    
    this.cacheDuration = {
      rate: 2 * 60 * 1000, // 2 minutes
      currencyAPIRate: 5 * 60 * 1000 // 5 minutes
    };
  }

  /**
   * Get direct offramp rate from database
   * @returns {Promise<Object>} Offramp rate information
   */
  async getOfframpRate() {
    if (this.cache.rate && new Date() < this.cache.rateExpiry) {
      logger.debug('Using cached offramp rate');
      return this.cache.rate;
    }

    try {
      const record = await NairaMarkdown.findOne({});
      
      if (!record || !record.offrampRate) {
        throw new Error('No offramp rate configured. Please set offramp rate first.');
      }
      
      const rateInfo = {
        finalPrice: record.offrampRate,
        lastUpdated: record.updatedAt,
        source: record.rateSource || 'manual',
        reliability: 'high',
        type: 'offramp',
        configured: true
      };

      this.cache.rate = rateInfo;
      this.cache.rateExpiry = new Date(Date.now() + this.cacheDuration.rate);
      
      logger.debug(`Using direct offramp rate: ₦${record.offrampRate} per $1`);
      return rateInfo;

    } catch (error) {
      logger.error('Failed to get offramp rate from database:', error.message);
      throw new Error(`Failed to fetch offramp rate: ${error.message}`);
    }
  }

  /**
   * Get CurrencyAPI rate for comparison purposes (optional)
   * @returns {Promise<Object>} CurrencyAPI rate information
   */
  async getCurrencyAPIRate() {
    if (this.cache.currencyAPIRate && new Date() < this.cache.currencyAPIExpiry) {
      logger.debug('Using cached CurrencyAPI rate');
      return this.cache.currencyAPIRate;
    }

    if (!this.apiKey) {
      logger.warn('Currency API key not configured - cannot fetch comparison rate');
      return null;
    }

    try {
      this.requestCount++;
      logger.debug(`Making CurrencyAPI request #${this.requestCount} for comparison`);
      
      const response = await axios.get(`${this.baseURL}/latest`, {
        headers: { 'apikey': this.apiKey },
        params: { base_currency: 'USD', currencies: 'NGN' },
        timeout: 8000
      });

      const rate = response.data?.data?.NGN?.value;
      if (!rate) {
        throw new Error('Invalid response format from CurrencyAPI');
      }

      const rateInfo = {
        rate: rate,
        lastUpdated: response.data.meta.last_updated_at,
        source: 'currencyapi.com',
        type: 'market_comparison'
      };

      this.cache.currencyAPIRate = rateInfo;
      this.cache.currencyAPIExpiry = new Date(Date.now() + this.cacheDuration.currencyAPIRate);
      
      logger.debug(`CurrencyAPI comparison rate: ₦${rate} per $1`);
      return rateInfo;

    } catch (error) {
      logger.warn('CurrencyAPI comparison request failed:', error.message);
      return null; // Don't throw error for comparison rate
    }
  }

  /**
   * Get USD to NGN exchange rate (direct from database)
   * @returns {Promise<Object>} Rate information
   */
  async getUsdToNgnRate() {
    return await this.getOfframpRate();
  }

  /**
   * Convert Naira to USD using offramp rate
   * @param {number} nairaAmount - Amount in NGN
   * @returns {Promise<number>} Amount in USD
   */
  async convertNairaToUsd(nairaAmount) {
    const rate = await this.getOfframpRate();
    const usdAmount = nairaAmount / rate.finalPrice;
    
    logger.debug(`Offramp Naira to USD: ₦${nairaAmount} ÷ ₦${rate.finalPrice} = $${usdAmount.toFixed(4)}`);
    return usdAmount;
  }

  /**
   * Convert USD to Naira using offramp rate
   * @param {number} usdAmount - Amount in USD
   * @returns {Promise<number>} Amount in NGN
   */
  async convertUsdToNaira(usdAmount) {
    const rate = await this.getOfframpRate();
    const nairaAmount = usdAmount * rate.finalPrice;
    
    logger.debug(`Offramp USD to Naira: $${usdAmount} × ₦${rate.finalPrice} = ₦${nairaAmount.toFixed(2)}`);
    return nairaAmount;
  }

  /**
   * Calculate Naira amount received for crypto sale (offramp scenario)
   * @param {number} cryptoAmount - Amount of crypto to sell
   * @param {string} cryptoCurrency - Cryptocurrency being sold
   * @param {number} cryptoPrice - Current crypto price in USD
   * @returns {Promise<number>} Naira amount received
   */
  async calculateNairaFromCrypto(cryptoAmount, cryptoCurrency, cryptoPrice) {
    try {
      const usdAmount = cryptoAmount * cryptoPrice;
      const nairaAmount = await this.convertUsdToNaira(usdAmount);
      
      logger.debug(`Offramp calculation: ${cryptoAmount} ${cryptoCurrency} @ $${cryptoPrice} = $${usdAmount.toFixed(4)} → ₦${nairaAmount.toFixed(2)}`);
      
      return parseFloat(nairaAmount.toFixed(2));
    } catch (error) {
      logger.error('Offramp Naira calculation failed:', error);
      throw new Error(`Failed to calculate offramp Naira amount: ${error.message}`);
    }
  }

  /**
   * Calculate crypto amount needed for Naira target (offramp scenario)
   * @param {number} nairaAmount - Target Naira amount
   * @param {string} cryptoCurrency - Cryptocurrency to sell
   * @param {number} cryptoPrice - Current crypto price in USD
   * @returns {Promise<number>} Crypto amount needed
   */
  async calculateCryptoForNaira(nairaAmount, cryptoCurrency, cryptoPrice) {
    try {
      const usdAmount = await this.convertNairaToUsd(nairaAmount);
      const cryptoAmount = usdAmount / cryptoPrice;
      
      logger.debug(`Offramp crypto needed: ₦${nairaAmount} → $${usdAmount.toFixed(4)} → ${cryptoAmount.toFixed(8)} ${cryptoCurrency}`);
      
      return parseFloat(cryptoAmount.toFixed(8));
    } catch (error) {
      logger.error('Offramp crypto calculation failed:', error);
      throw new Error(`Failed to calculate offramp crypto requirement: ${error.message}`);
    }
  }

  /**
   * Method that swap router expects - alias for getUsdToNgnRate
   * @returns {Promise<Object>} Current rate information
   */
  async getCurrentRate() {
    return await this.getOfframpRate();
  }

  /**
   * Get comprehensive rate information including comparison
   * @returns {Promise<Object>} Rate information with comparison
   */
  async getRateWithComparison() {
    try {
      const [offrampRate, currencyAPIRate] = await Promise.allSettled([
        this.getOfframpRate(),
        this.getCurrencyAPIRate()
      ]);

      const hasOfframpRate = offrampRate.status === 'fulfilled';
      const hasCurrencyAPIRate = currencyAPIRate.status === 'fulfilled' && currencyAPIRate.value;

      const result = {
        offramp: hasOfframpRate ? offrampRate.value : null,
        currencyAPI: hasCurrencyAPIRate ? currencyAPIRate.value : null,
        comparison: null
      };

      if (hasOfframpRate && hasCurrencyAPIRate) {
        const difference = currencyAPIRate.value.rate - offrampRate.value.finalPrice;
        result.comparison = {
          difference: parseFloat(difference.toFixed(2)),
          percentageDifference: parseFloat((difference / currencyAPIRate.value.rate * 100).toFixed(2))
        };
      }

      return result;
    } catch (error) {
      logger.error('Failed to get rate with comparison:', error.message);
      throw error;
    }
  }

  /**
   * Clear caches
   */
  clearCache() {
    this.cache = {
      rate: null,
      rateExpiry: null,
      currencyAPIRate: null,
      currencyAPIExpiry: null
    };
    logger.info('Offramp caches cleared');
  }

  /**
   * Get API status
   * @returns {Promise<Object>} API status
   */
  async getApiStatus() {
    try {
      const offrampRate = await this.getOfframpRate();
      const currencyAPIRate = await this.getCurrencyAPIRate();

      return {
        configured: true,
        offrampRate: {
          rate: offrampRate.finalPrice,
          source: offrampRate.source,
          lastUpdated: offrampRate.lastUpdated,
          configured: true
        },
        currencyAPI: currencyAPIRate ? {
          rate: currencyAPIRate.rate,
          sessionRequests: this.requestCount,
          available: true
        } : {
          available: false,
          reason: 'API key not configured or request failed'
        },
        type: 'offramp'
      };
    } catch (error) {
      return {
        configured: false,
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
      const rate = await this.getOfframpRate();

      return {
        status: 'healthy',
        rate: rate.finalPrice,
        source: rate.source,
        lastUpdated: rate.lastUpdated,
        cacheValid: !!(this.cache.rate && new Date() < this.cache.rateExpiry),
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
   * Force refresh rate (clear cache and fetch new)
   * @returns {Promise<Object>} Fresh rate information
   */
  async refreshRate() {
    this.cache.rate = null;
    this.cache.rateExpiry = null;
    return await this.getOfframpRate();
  }

  /**
   * Update offramp rate in database
   * @param {number} newRate - New offramp rate
   * @returns {Promise<Object>} Update result
   */
  async updateOfframpRate(newRate) {
    if (typeof newRate !== 'number' || newRate <= 0) {
      throw new Error('Invalid rate. Must be a positive number.');
    }

    try {
      // Get current CurrencyAPI rate for reference
      let currencyAPIRate = null;
      try {
        const apiRate = await this.getCurrencyAPIRate();
        currencyAPIRate = apiRate?.rate || null;
      } catch (apiError) {
        logger.warn('Could not fetch CurrencyAPI rate for reference:', apiError.message);
      }

      let record = await NairaMarkdown.findOne({});
      if (!record) {
        record = new NairaMarkdown({ 
          offrampRate: newRate,
          rateSource: 'manual',
          lastCurrencyAPIRate: currencyAPIRate,
          markup: 0 // Keep for backward compatibility
        });
      } else {
        record.offrampRate = newRate;
        record.rateSource = 'manual';
        record.lastCurrencyAPIRate = currencyAPIRate;
      }

      await record.save();
      
      // Clear cache to force fresh data
      this.clearCache();
      
      logger.info('Offramp rate updated via service', {
        newRate,
        currencyAPIRate,
        difference: currencyAPIRate ? (currencyAPIRate - newRate).toFixed(2) : null
      });

      return {
        success: true,
        offrampRate: newRate,
        currencyAPIRate,
        difference: currencyAPIRate ? parseFloat((currencyAPIRate - newRate).toFixed(2)) : null,
        updatedAt: record.updatedAt
      };
    } catch (error) {
      logger.error('Failed to update offramp rate via service:', error.message);
      throw error;
    }
  }
}

// Create singleton instance
const offrampService = new OfframpPriceService();

// Export with correct method names (matching what swap router expects)
module.exports = {
  OfframpPriceService,
  offrampService,
  
  // Main methods (matching what swap router expects)
  convertNairaToUsd: (amount) => offrampService.convertNairaToUsd(amount),
  convertUsdToNaira: (amount) => offrampService.convertUsdToNaira(amount),
  calculateNairaFromCrypto: (cryptoAmount, cryptoCurrency, cryptoPrice) => 
    offrampService.calculateNairaFromCrypto(cryptoAmount, cryptoCurrency, cryptoPrice),
  calculateCryptoForNaira: (nairaAmount, cryptoCurrency, cryptoPrice) =>
    offrampService.calculateCryptoForNaira(nairaAmount, cryptoCurrency, cryptoPrice),
  
  // Methods expected by swap router
  getCurrentRate: () => offrampService.getCurrentRate(),
  
  // New methods for direct rate management
  updateOfframpRate: (rate) => offrampService.updateOfframpRate(rate),
  getRateWithComparison: () => offrampService.getRateWithComparison(),
  
  // Utility methods
  refreshRate: () => offrampService.refreshRate(),
  getApiStatus: () => offrampService.getApiStatus(),
  healthCheck: () => offrampService.healthCheck(),
  clearCache: () => offrampService.clearCache()
};