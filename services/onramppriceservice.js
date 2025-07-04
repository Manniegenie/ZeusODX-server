const axios = require('axios');
const logger = require('../utils/logger');
const NairaMarkup = require('../models/onramp');

/**
 * Onramp service using direct rate from database
 */
class OnrampPriceService {
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
   * Get direct onramp rate from database
   * @returns {Promise<Object>} Onramp rate information
   */
  async getOnrampRate() {
    if (this.cache.rate && new Date() < this.cache.rateExpiry) {
      logger.debug('Using cached onramp rate');
      return this.cache.rate;
    }

    try {
      const record = await NairaMarkup.findOne({});
      
      if (!record || !record.onrampRate) {
        throw new Error('No onramp rate configured. Please set onramp rate first.');
      }
      
      const rateInfo = {
        finalPrice: record.onrampRate,
        lastUpdated: record.updatedAt,
        source: record.rateSource || 'manual',
        reliability: 'high',
        type: 'onramp',
        configured: true
      };

      this.cache.rate = rateInfo;
      this.cache.rateExpiry = new Date(Date.now() + this.cacheDuration.rate);
      
      logger.debug(`Using direct onramp rate: ₦${record.onrampRate} per $1`);
      return rateInfo;

    } catch (error) {
      logger.error('Failed to get onramp rate from database:', error.message);
      throw new Error(`Failed to fetch onramp rate: ${error.message}`);
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
    return await this.getOnrampRate();
  }

  /**
   * Convert Naira to USD using onramp rate
   * @param {number} nairaAmount - Amount in NGN
   * @returns {Promise<number>} Amount in USD
   */
  async convertNairaToUsd(nairaAmount) {
    const rate = await this.getOnrampRate();
    const usdAmount = nairaAmount / rate.finalPrice;
    
    logger.debug(`Onramp Naira to USD: ₦${nairaAmount} ÷ ₦${rate.finalPrice} = $${usdAmount.toFixed(4)}`);
    return usdAmount;
  }

  /**
   * Convert USD to Naira using onramp rate
   * @param {number} usdAmount - Amount in USD
   * @returns {Promise<number>} Amount in NGN
   */
  async convertUsdToNaira(usdAmount) {
    const rate = await this.getOnrampRate();
    const nairaAmount = usdAmount * rate.finalPrice;
    
    logger.debug(`Onramp USD to Naira: $${usdAmount} × ₦${rate.finalPrice} = ₦${nairaAmount.toFixed(2)}`);
    return nairaAmount;
  }

  /**
   * Calculate crypto amount user gets for their Naira (onramp scenario)
   * @param {number} nairaAmount - Amount of Naira user is paying
   * @param {string} cryptoCurrency - Cryptocurrency being bought
   * @param {number} cryptoPrice - Current crypto price in USD
   * @returns {Promise<number>} Crypto amount user receives
   */
  async calculateCryptoFromNaira(nairaAmount, cryptoCurrency, cryptoPrice) {
    try {
      const usdAmount = await this.convertNairaToUsd(nairaAmount);
      const cryptoAmount = usdAmount / cryptoPrice;
      
      logger.debug(`Onramp crypto calculation: ₦${nairaAmount} → $${usdAmount.toFixed(4)} → ${cryptoAmount.toFixed(8)} ${cryptoCurrency}`);
      
      return parseFloat(cryptoAmount.toFixed(8));
    } catch (error) {
      logger.error('Onramp crypto calculation failed:', error);
      throw new Error(`Failed to calculate onramp crypto amount: ${error.message}`);
    }
  }

  /**
   * Calculate Naira amount needed for target crypto amount (onramp scenario)
   * @param {number} cryptoAmount - Target crypto amount
   * @param {string} cryptoCurrency - Cryptocurrency being bought
   * @param {number} cryptoPrice - Current crypto price in USD
   * @returns {Promise<number>} Naira amount needed
   */
  async calculateNairaRequired(cryptoAmount, cryptoCurrency, cryptoPrice) {
    try {
      const usdAmount = cryptoAmount * cryptoPrice;
      const nairaAmount = await this.convertUsdToNaira(usdAmount);
      
      logger.debug(`Onramp Naira needed: ${cryptoAmount} ${cryptoCurrency} @ $${cryptoPrice} = $${usdAmount.toFixed(4)} → ₦${nairaAmount.toFixed(2)}`);
      
      return parseFloat(nairaAmount.toFixed(2));
    } catch (error) {
      logger.error('Onramp Naira calculation failed:', error);
      throw new Error(`Failed to calculate onramp Naira requirement: ${error.message}`);
    }
  }

  /**
   * Legacy method alias - calculate crypto amount required for Naira amount
   * @param {number} nairaAmount - Amount of Naira
   * @param {string} cryptoCurrency - Cryptocurrency
   * @param {number} cryptoPrice - Current crypto price in USD
   * @returns {Promise<number>} Crypto amount
   */
  async calculateCryptoRequired(nairaAmount, cryptoCurrency, cryptoPrice) {
    return await this.calculateCryptoFromNaira(nairaAmount, cryptoCurrency, cryptoPrice);
  }

  /**
   * Get comprehensive rate information including comparison
   * @returns {Promise<Object>} Rate information with comparison
   */
  async getRateWithComparison() {
    try {
      const [onrampRate, currencyAPIRate] = await Promise.allSettled([
        this.getOnrampRate(),
        this.getCurrencyAPIRate()
      ]);

      const hasOnrampRate = onrampRate.status === 'fulfilled';
      const hasCurrencyAPIRate = currencyAPIRate.status === 'fulfilled' && currencyAPIRate.value;

      const result = {
        onramp: hasOnrampRate ? onrampRate.value : null,
        currencyAPI: hasCurrencyAPIRate ? currencyAPIRate.value : null,
        comparison: null
      };

      if (hasOnrampRate && hasCurrencyAPIRate) {
        const difference = onrampRate.value.finalPrice - currencyAPIRate.value.rate;
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
    logger.info('Onramp caches cleared');
  }

  /**
   * Get API status
   * @returns {Promise<Object>} API status
   */
  async getApiStatus() {
    try {
      const onrampRate = await this.getOnrampRate();
      const currencyAPIRate = await this.getCurrencyAPIRate();

      return {
        configured: true,
        onrampRate: {
          rate: onrampRate.finalPrice,
          source: onrampRate.source,
          lastUpdated: onrampRate.lastUpdated,
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
        type: 'onramp'
      };
    } catch (error) {
      return {
        configured: false,
        error: error.message,
        type: 'onramp'
      };
    }
  }

  /**
   * Health check
   * @returns {Promise<Object>} Health status
   */
  async healthCheck() {
    try {
      const rate = await this.getOnrampRate();

      return {
        status: 'healthy',
        rate: rate.finalPrice,
        source: rate.source,
        lastUpdated: rate.lastUpdated,
        cacheValid: !!(this.cache.rate && new Date() < this.cache.rateExpiry),
        type: 'onramp'
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        type: 'onramp'
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
    return await this.getOnrampRate();
  }

  /**
   * Method that swap router expects - alias for getUsdToNgnRate
   * @returns {Promise<Object>} Current rate information
   */
  async getCurrentRate() {
    return await this.getOnrampRate();
  }

  /**
   * Update onramp rate in database
   * @param {number} newRate - New onramp rate
   * @returns {Promise<Object>} Update result
   */
  async updateOnrampRate(newRate) {
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

      let record = await NairaMarkup.findOne({});
      if (!record) {
        record = new NairaMarkup({ 
          onrampRate: newRate,
          rateSource: 'manual',
          lastCurrencyAPIRate: currencyAPIRate,
          markup: 0 // Keep for backward compatibility
        });
      } else {
        record.onrampRate = newRate;
        record.rateSource = 'manual';
        record.lastCurrencyAPIRate = currencyAPIRate;
      }

      await record.save();
      
      // Clear cache to force fresh data
      this.clearCache();
      
      logger.info('Onramp rate updated via service', {
        newRate,
        currencyAPIRate,
        difference: currencyAPIRate ? (newRate - currencyAPIRate).toFixed(2) : null
      });

      return {
        success: true,
        onrampRate: newRate,
        currencyAPIRate,
        difference: currencyAPIRate ? parseFloat((newRate - currencyAPIRate).toFixed(2)) : null,
        updatedAt: record.updatedAt
      };
    } catch (error) {
      logger.error('Failed to update onramp rate via service:', error.message);
      throw error;
    }
  }
}

// Create singleton instance
const onrampService = new OnrampPriceService();

// Export with correct method names (matching what swap router expects)
module.exports = {
  OnrampPriceService,
  onrampService,
  
  // Main methods (matching what swap router expects)
  convertNairaToUsd: (amount) => onrampService.convertNairaToUsd(amount),
  convertUsdToNaira: (amount) => onrampService.convertUsdToNaira(amount),
  calculateCryptoRequired: (nairaAmount, cryptoCurrency, cryptoPrice) => 
    onrampService.calculateCryptoRequired(nairaAmount, cryptoCurrency, cryptoPrice),
  calculateCryptoFromNaira: (nairaAmount, cryptoCurrency, cryptoPrice) =>
    onrampService.calculateCryptoFromNaira(nairaAmount, cryptoCurrency, cryptoPrice),
  calculateNairaRequired: (cryptoAmount, cryptoCurrency, cryptoPrice) =>
    onrampService.calculateNairaRequired(cryptoAmount, cryptoCurrency, cryptoPrice),
  
  // Methods expected by swap router
  getOnrampRate: () => onrampService.getOnrampRate(),
  
  // New methods for direct rate management
  updateOnrampRate: (rate) => onrampService.updateOnrampRate(rate),
  getRateWithComparison: () => onrampService.getRateWithComparison(),
  
  // Utility methods
  getCurrentRate: () => onrampService.getCurrentRate(),
  refreshRate: () => onrampService.refreshRate(),
  getApiStatus: () => onrampService.getApiStatus(),
  healthCheck: () => onrampService.healthCheck(),
  clearCache: () => onrampService.clearCache()
};