const axios = require('axios');
const { attachObiexAuth } = require('../utils/obiexAuth');

const BASE_URL = process.env.OBIEX_BASE_URL || 'https://api.obiex.finance';
const REQUEST_TIMEOUT = 10000;

const tradingPairsService = {
  // Cache variables
  pairsCache: null,
  cacheExpiry: 0,
  CACHE_DURATION: 10 * 60 * 1000, // 10 minutes

  /**
   * Create API client with authentication
   */
  createApiClient() {
    const client = axios.create({
      baseURL: BASE_URL,
      timeout: REQUEST_TIMEOUT,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    client.interceptors.request.use(attachObiexAuth);
    client.interceptors.response.use(
      response => response,
      error => {
        console.error('Trading Pairs API Error:', error.response?.data || error.message);
        return Promise.reject(error);
      }
    );

    return client;
  },

  /**
   * Get all trading pairs from Obiex API
   */
  async getAllPairs() {
    try {
      console.log('📊 Fetching all trading pairs from Obiex...');
      
      // Check cache first
      if (this.pairsCache && Date.now() < this.cacheExpiry) {
        console.log('📋 Using cached trading pairs');
        return { success: true, data: this.pairsCache };
      }

      const apiClient = this.createApiClient();
      const response = await apiClient.get('/v1/trades/pairs/grouped');

      if (response.data && response.data.data) {
        // Cache the data
        this.pairsCache = response.data.data;
        this.cacheExpiry = Date.now() + this.CACHE_DURATION;
        
        console.log('✅ Trading pairs fetched successfully:', this.pairsCache.length);
        return { success: true, data: this.pairsCache };
      } else {
        console.log('❌ Invalid response format from trading pairs API');
        return { success: false, error: 'Invalid response format' };
      }

    } catch (error) {
      console.log('❌ Error fetching trading pairs:', error.message);
      
      // Try to return cached data as fallback
      if (this.pairsCache) {
        console.log('📋 Using cached data as fallback');
        return { success: true, data: this.pairsCache };
      }
      
      return { 
        success: false, 
        error: error.response?.data?.message || error.message || 'Failed to fetch trading pairs' 
      };
    }
  },

  /**
   * Get only active trading pairs
   */
  async getActivePairs() {
    try {
      console.log('📊 Getting active trading pairs...');
      
      const allPairsResult = await this.getAllPairs();
      
      if (!allPairsResult.success) {
        return allPairsResult;
      }

      // Filter for active pairs
      const activePairs = allPairsResult.data.filter(pair => 
        pair.status === 'active' || 
        pair.isActive === true ||
        pair.isBuyable === true || 
        pair.isSellable === true
      );

      console.log('✅ Active trading pairs filtered:', activePairs.length);
      return { success: true, data: activePairs };

    } catch (error) {
      console.log('❌ Error getting active pairs:', error.message);
      return { success: false, error: error.message };
    }
  },

  /**
   * Check if a specific trading pair is available
   */
  async isPairAvailable(fromCurrency, toCurrency) {
    try {
      console.log(`🔍 Checking pair availability: ${fromCurrency} -> ${toCurrency}`);
      
      const fromUpper = fromCurrency.toUpperCase();
      const toUpper = toCurrency.toUpperCase();
      
      const allPairsResult = await this.getAllPairs();
      
      if (!allPairsResult.success) {
        return allPairsResult;
      }

      // Look for direct pair (FROM/TO)
      let pair = allPairsResult.data.find(p => 
        p.source?.code === fromUpper && p.target?.code === toUpper
      );

      // Look for reverse pair (TO/FROM) 
      let isReversePair = false;
      if (!pair) {
        pair = allPairsResult.data.find(p => 
          p.source?.code === toUpper && p.target?.code === fromUpper
        );
        isReversePair = true;
      }

      if (!pair) {
        console.log(`❌ Trading pair ${fromUpper}/${toUpper} not found`);
        return {
          success: true,
          data: {
            available: false,
            buyable: false,
            sellable: false,
            pair: null
          }
        };
      }

      // Determine buyable/sellable based on pair direction
      let buyable, sellable;
      
      if (isReversePair) {
        // For reverse pairs, swap the buy/sell logic
        buyable = pair.isSellable !== false;
        sellable = pair.isBuyable !== false;
      } else {
        // For direct pairs, use as-is
        buyable = pair.isBuyable !== false;
        sellable = pair.isSellable !== false;
      }

      const result = {
        available: true,
        buyable: buyable,
        sellable: sellable,
        pair: pair,
        isReversePair: isReversePair
      };

      console.log(`✅ Pair ${fromUpper}/${toUpper} available:`, result);
      return { success: true, data: result };

    } catch (error) {
      console.log('❌ Error checking pair availability:', error.message);
      return { success: false, error: error.message };
    }
  },

  /**
   * Get currency ID by code
   */
  async getCurrencyId(currencyCode) {
    try {
      const normalizedCode = currencyCode.toUpperCase();
      console.log(`🔍 Getting currency ID for: ${normalizedCode}`);
      
      const allPairsResult = await this.getAllPairs();
      
      if (!allPairsResult.success) {
        throw new Error('Failed to fetch trading pairs');
      }

      // Search through all pairs to find the currency
      for (const pair of allPairsResult.data) {
        if (pair.source?.code === normalizedCode) {
          console.log(`✅ Found currency ID for ${normalizedCode}:`, pair.source.id);
          return pair.source.id;
        }
        if (pair.target?.code === normalizedCode) {
          console.log(`✅ Found currency ID for ${normalizedCode}:`, pair.target.id);
          return pair.target.id;
        }
      }

      throw new Error(`Currency ID not found for ${normalizedCode}`);

    } catch (error) {
      console.log(`❌ Error getting currency ID for ${currencyCode}:`, error.message);
      throw error;
    }
  },

  /**
   * Get pair information by currencies
   */
  async getPairInfo(fromCurrency, toCurrency) {
    try {
      const fromUpper = fromCurrency.toUpperCase();
      const toUpper = toCurrency.toUpperCase();
      
      const allPairsResult = await this.getAllPairs();
      
      if (!allPairsResult.success) {
        return allPairsResult;
      }

      // Look for direct pair
      let pair = allPairsResult.data.find(p => 
        p.source?.code === fromUpper && p.target?.code === toUpper
      );

      // Look for reverse pair
      let isReverse = false;
      if (!pair) {
        pair = allPairsResult.data.find(p => 
          p.source?.code === toUpper && p.target?.code === fromUpper
        );
        isReverse = true;
      }

      if (!pair) {
        return {
          success: false,
          error: `Pair ${fromUpper}/${toUpper} not found`
        };
      }

      return {
        success: true,
        data: {
          ...pair,
          isReverse: isReverse,
          requestedFrom: fromUpper,
          requestedTo: toUpper
        }
      };

    } catch (error) {
      console.log('❌ Error getting pair info:', error.message);
      return { success: false, error: error.message };
    }
  },

  /**
   * Clear trading pairs cache
   */
  clearCache() {
    console.log('🧹 Clearing trading pairs cache...');
    this.pairsCache = null;
    this.cacheExpiry = 0;
    console.log('✅ Trading pairs cache cleared');
  },

  /**
   * Get cache status for debugging
   */
  getCacheStatus() {
    const now = Date.now();
    const remainingTime = this.cacheExpiry - now;
    
    return {
      hasCachedData: !!this.pairsCache,
      isFresh: remainingTime > 0,
      remainingMinutes: Math.max(0, Math.floor(remainingTime / (1000 * 60))),
      cacheExpiry: new Date(this.cacheExpiry).toISOString(),
      totalPairs: this.pairsCache?.length || 0
    };
  },

  /**
   * Refresh trading pairs data
   */
  async refreshPairs() {
    console.log('🔄 Force refreshing trading pairs...');
    this.clearCache();
    return await this.getAllPairs();
  }
};

module.exports = tradingPairsService;