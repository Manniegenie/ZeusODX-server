// jobs/updateCryptoPrices.js
const axios = require('axios');
const CryptoPrice = require('../models/CryptoPrice');
const logger = require('../utils/logger');

// Configuration
const CONFIG = {
  REQUEST_TIMEOUT: 15000,
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
  RATE_LIMIT_DELAY: 30000,
};

// FCS API Configuration
const FCS_API_CONFIG = {
  hasValidApiKey: validateFCSApiKey(process.env.FCS_API_KEY),
  baseUrl: 'https://fcsapi.com/api-v3',
  apiKey: process.env.FCS_API_KEY
};

// Supported tokens from portfolio.js
const SUPPORTED_TOKENS = {
  BTC: { fcsApiSymbol: 'BTC/USD', isStablecoin: false },
  ETH: { fcsApiSymbol: 'ETH/USD', isStablecoin: false },
  SOL: { fcsApiSymbol: 'SOL/USD', isStablecoin: false },
  USDT: { fcsApiSymbol: 'USDT/USD', isStablecoin: true },
  USDC: { fcsApiSymbol: 'USDC/USD', isStablecoin: true },
  BNB: { fcsApiSymbol: 'BNB/USD', isStablecoin: false },
  MATIC: { fcsApiSymbol: 'MATIC/USD', isStablecoin: false },
  AVAX: { fcsApiSymbol: 'AVAX/USD', isStablecoin: false },
  NGNZ: { fcsApiSymbol: null, isStablecoin: true, isNairaPegged: true }
};

function validateFCSApiKey(apiKey) {
  if (!apiKey) return false;
  return typeof apiKey === 'string' && apiKey.length >= 16;
}

// Retry logic with exponential backoff
async function withRetry(fn, maxRetries = CONFIG.MAX_RETRIES, delay = CONFIG.RETRY_DELAY) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (error.response && error.response.status === 429) {
        if (attempt === maxRetries) break;
        
        const rateLimitWait = CONFIG.RATE_LIMIT_DELAY;
        logger.warn(`Rate limited, waiting ${rateLimitWait}ms before retry ${attempt + 1}`);
        await new Promise(resolve => setTimeout(resolve, rateLimitWait));
        continue;
      }
      
      if (attempt === maxRetries) break;
      
      const waitTime = delay * Math.pow(2, attempt);
      logger.warn(`Attempt ${attempt + 1} failed, retrying in ${waitTime}ms`, { error: error.message });
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  
  throw lastError;
}

// Get NGNZ price (Naira-pegged stablecoin)
async function getNGNZPrice() {
  try {
    // This would need your offramp rate logic from portfolio.js
    // For now, using a simple calculation
    const fallbackRate = 1554.42;
    return 1 / fallbackRate;
  } catch (error) {
    logger.error('Failed to get NGNZ price', { error: error.message });
    return 1 / 1554.42;
  }
}

// Fetch prices from FCS API
async function fetchFCSApiPrices() {
  try {
    logger.info('Starting FCS API price fetch for job');
    
    const prices = new Map();
    
    // Handle NGNZ separately (not supported by FCS API)
    const ngnzPrice = await getNGNZPrice();
    prices.set('NGNZ', ngnzPrice);
    
    // Get tokens supported by FCS API
    const fcsApiTokens = Object.keys(SUPPORTED_TOKENS).filter(token => {
      const tokenInfo = SUPPORTED_TOKENS[token];
      return tokenInfo && tokenInfo.fcsApiSymbol;
    });
    
    if (fcsApiTokens.length === 0) {
      logger.warn('No tokens to request from FCS API');
      return prices;
    }
    
    // Build symbol list for FCS API
    const fcsSymbols = fcsApiTokens
      .map(token => SUPPORTED_TOKENS[token].fcsApiSymbol)
      .join(',');
    
    logger.info('Requesting from FCS API', { fcsSymbols });
    
    const config = {
      params: {
        symbol: fcsSymbols,
        access_key: FCS_API_CONFIG.apiKey
      },
      timeout: CONFIG.REQUEST_TIMEOUT,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'CryptoPriceJob/1.0'
      }
    };
    
    if (!FCS_API_CONFIG.hasValidApiKey) {
      throw new Error('No valid FCS API key found');
    }
    
    const response = await axios.get(`${FCS_API_CONFIG.baseUrl}/crypto/latest`, config);
    
    if (!response.data || !response.data.response || !Array.isArray(response.data.response)) {
      throw new Error('Invalid response format from FCS API');
    }
    
    if (!response.data.status) {
      throw new Error(`FCS API returned error: ${response.data.msg || 'Unknown error'}`);
    }
    
    logger.info('FCS API response received', { 
      responseCount: response.data.response.length,
      creditCount: response.data.info?.credit_count
    });
    
    // Process FCS API response
    for (const item of response.data.response) {
      if (!item.s || typeof item.c !== 'number') {
        logger.warn('Invalid FCS API response item', { item });
        continue;
      }
      
      const symbol = item.s; // e.g., "BTC/USD"
      const token = symbol.split('/')[0]; // e.g., "BTC"
      const price = item.c; // Current price
      
      if (price > 0) {
        prices.set(token, price);
        logger.debug(`Set FCS API price: ${token} = $${price.toFixed(8)}`);
      }
    }
    
    logger.info(`Successfully fetched ${prices.size} prices from FCS API`);
    return prices;
    
  } catch (error) {
    logger.error('FCS API price fetch failed', { 
      error: error.message,
      status: error.response?.status,
      responseData: error.response?.data
    });
    throw error;
  }
}

// Calculate hourly change percentage
async function calculateHourlyChange(symbol, currentPrice) {
  try {
    const oneHourAgo = new Date(Date.now() - (60 * 60 * 1000));
    
    const historicalPrice = await CryptoPrice.findOne({
      symbol: symbol,
      timestamp: { $lte: oneHourAgo }
    }).sort({ timestamp: -1 });
    
    if (!historicalPrice || !historicalPrice.price) {
      logger.debug(`No historical price found for ${symbol}, returning 0% change`);
      return 0;
    }
    
    const change = ((currentPrice - historicalPrice.price) / historicalPrice.price) * 100;
    return parseFloat(change.toFixed(4));
    
  } catch (error) {
    logger.error(`Error calculating hourly change for ${symbol}`, { error: error.message });
    return 0;
  }
}

// Main job function
async function updateCryptoPrices() {
  const startTime = new Date();
  logger.info('Starting crypto price update job', { timestamp: startTime.toISOString() });
  
  try {
    // Fetch current prices
    let priceMap;
    try {
      priceMap = await withRetry(() => fetchFCSApiPrices());
    } catch (error) {
      logger.error('Failed to fetch prices, job aborted', { error: error.message });
      return;
    }
    
    if (priceMap.size === 0) {
      logger.warn('No prices fetched, job aborted');
      return;
    }
    
    // Process each price and calculate hourly changes
    const priceUpdates = [];
    const timestamp = new Date();
    
    for (const [symbol, price] of priceMap.entries()) {
      try {
        const hourlyChange = await calculateHourlyChange(symbol, price);
        
        priceUpdates.push({
          symbol: symbol,
          price: price,
          hourly_change: hourlyChange,
          timestamp: timestamp
        });
        
        logger.debug(`Prepared update for ${symbol}`, { 
          price: price.toFixed(8), 
          hourlyChange: `${hourlyChange}%` 
        });
        
      } catch (error) {
        logger.error(`Error processing ${symbol}`, { error: error.message });
      }
    }
    
    // Bulk insert to MongoDB
    if (priceUpdates.length > 0) {
      await CryptoPrice.insertMany(priceUpdates);
      
      const endTime = new Date();
      const duration = endTime - startTime;
      
      logger.info('Crypto price update job completed successfully', {
        pricesUpdated: priceUpdates.length,
        duration: `${duration}ms`,
        timestamp: endTime.toISOString(),
        symbols: priceUpdates.map(p => p.symbol)
      });
    } else {
      logger.warn('No price updates to save');
    }
    
  } catch (error) {
    logger.error('Crypto price update job failed', { 
      error: error.message,
      stack: error.stack 
    });
    throw error;
  }
}

// Cleanup old price data (keep last 7 days)
async function cleanupOldPrices() {
  try {
    const cutoffDate = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000));
    
    const result = await CryptoPrice.deleteMany({
      timestamp: { $lt: cutoffDate }
    });
    
    logger.info(`Cleaned up ${result.deletedCount} old price entries`);
    return result.deletedCount;
    
  } catch (error) {
    logger.error('Error cleaning up old prices', { error: error.message });
    throw error;
  }
}

// Export for use with job schedulers
module.exports = {
  updateCryptoPrices,
  cleanupOldPrices,
  fetchFCSApiPrices,
  calculateHourlyChange
};

// Run immediately if called directly
if (require.main === module) {
  updateCryptoPrices()
    .then(() => {
      logger.info('Job completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Job failed', { error: error.message });
      process.exit(1);
    });
}