// jobs/updateCryptoPrices.js
const axios = require('axios');
const PriceChange = require('../models/pricechange'); // Changed from CryptoPrice to PriceChange
const logger = require('../utils/logger');

// Configuration
const CONFIG = {
  REQUEST_TIMEOUT: 15000,
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
  RATE_LIMIT_DELAY: 30000,
  JOB_LOCK_TTL: 10 * 60 * 1000, // 10 minutes lock
};

// Simple in-memory job lock (for single instance)
let jobLock = {
  isLocked: false,
  lockTime: null,
  lockId: null
};

// Check if job is already running
function isJobLocked() {
  if (!jobLock.isLocked) return false;
  
  // Check if lock has expired (safety mechanism)
  const now = Date.now();
  if (jobLock.lockTime && (now - jobLock.lockTime) > CONFIG.JOB_LOCK_TTL) {
    logger.warn('Job lock expired, releasing', { 
      lockAge: now - jobLock.lockTime,
      lockId: jobLock.lockId 
    });
    releaseLock();
    return false;
  }
  
  return true;
}

// Acquire job lock
function acquireLock() {
  if (isJobLocked()) {
    return false;
  }
  
  const lockId = `job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  jobLock = {
    isLocked: true,
    lockTime: Date.now(),
    lockId: lockId
  };
  
  logger.info('Job lock acquired', { lockId });
  return lockId;
}

// Release job lock
function releaseLock(lockId = null) {
  if (lockId && jobLock.lockId !== lockId) {
    logger.warn('Attempted to release lock with wrong ID', { 
      providedId: lockId, 
      currentId: jobLock.lockId 
    });
    return false;
  }
  
  const releasedId = jobLock.lockId;
  jobLock = {
    isLocked: false,
    lockTime: null,
    lockId: null
  };
  
  logger.info('Job lock released', { lockId: releasedId });
  return true;
}

// FCS API Configuration
const FCS_API_CONFIG = {
  hasValidApiKey: validateFCSApiKey(process.env.FCS_API_KEY),
  baseUrl: 'https://fcsapi.com/api-v3',
  apiKey: process.env.FCS_API_KEY
};

// Supported tokens (excluding NGNZ - handled by portfolio.js via offramp rate)
const SUPPORTED_TOKENS = {
  BTC: { fcsApiSymbol: 'BTC/USD', isStablecoin: false },
  ETH: { fcsApiSymbol: 'ETH/USD', isStablecoin: false },
  SOL: { fcsApiSymbol: 'SOL/USD', isStablecoin: false },
  USDT: { fcsApiSymbol: 'USDT/USD', isStablecoin: true },
  USDC: { fcsApiSymbol: 'USDC/USD', isStablecoin: true },
  BNB: { fcsApiSymbol: 'BNB/USD', isStablecoin: false },
  MATIC: { fcsApiSymbol: 'MATIC/USD', isStablecoin: false },
  AVAX: { fcsApiSymbol: 'AVAX/USD', isStablecoin: false }
  // NGNZ excluded - calculated from offramp rate in portfolio.js
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

// Fetch prices from FCS API
async function fetchFCSApiPrices() {
  try {
    logger.info('Starting FCS API price fetch for job');
    
    const prices = {};
    
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
      if (!item.s || !item.c) {
        logger.warn('Invalid FCS API response item - missing symbol or price', { item });
        continue;
      }
      
      const symbol = item.s; // e.g., "BTC/USD"
      const token = symbol.split('/')[0]; // e.g., "BTC"
      const priceStr = item.c; // Current price as string
      const price = parseFloat(priceStr); // Convert to number
      
      if (isNaN(price) || price <= 0) {
        logger.warn(`Invalid price from FCS API for ${token}`, { price: priceStr });
        continue;
      }
      
      prices[token] = price; // Changed from Map to object for PriceChange.storePrices compatibility
      logger.debug(`Set FCS API price: ${token} = $${price.toFixed(8)}`);
    }
    
    logger.info(`Successfully fetched ${Object.keys(prices).length} prices from FCS API`);
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

// Main job function with locking
async function updateCryptoPrices() {
  // Check if job is already running
  if (isJobLocked()) {
    logger.warn('Crypto price update job already running, skipping execution', {
      currentLockId: jobLock.lockId,
      lockAge: Date.now() - jobLock.lockTime
    });
    return { skipped: true, reason: 'Job already running' };
  }
  
  // Acquire lock
  const lockId = acquireLock();
  if (!lockId) {
    logger.error('Failed to acquire job lock');
    return { skipped: true, reason: 'Failed to acquire lock' };
  }
  
  const startTime = new Date();
  logger.info('Starting crypto price update job', { 
    timestamp: startTime.toISOString(),
    lockId: lockId
  });
  
  try {
    // Fetch current prices from FCS API
    let prices;
    try {
      prices = await withRetry(() => fetchFCSApiPrices());
    } catch (error) {
      logger.error('Failed to fetch prices from FCS API, job aborted', { 
        error: error.message,
        lockId: lockId
      });
      return { success: false, error: error.message };
    }
    
    if (Object.keys(prices).length === 0) {
      logger.warn('No prices fetched from FCS API, job aborted', { lockId: lockId });
      return { success: false, error: 'No prices fetched' };
    }
    
    logger.info(`Processing ${Object.keys(prices).length} tokens for price storage`, {
      tokens: Object.keys(prices),
      lockId: lockId
    });
    
    // Store prices using PriceChange model's built-in method
    let storedCount = 0;
    try {
      storedCount = await PriceChange.storePrices(prices, 'coingecko'); // Using 'coingecko' as source since FCS is similar
      
      if (storedCount > 0) {
        const endTime = new Date();
        const duration = endTime - startTime;
        
        logger.info('Crypto price update job completed successfully', {
          pricesStored: storedCount,
          duration: `${duration}ms`,
          timestamp: endTime.toISOString(),
          symbols: Object.keys(prices),
          priceData: Object.entries(prices).map(([symbol, price]) => ({
            symbol,
            price: `$${price.toFixed(8)}`
          })),
          lockId: lockId
        });
        
        return { 
          success: true, 
          pricesStored: storedCount,
          duration: duration,
          symbols: Object.keys(prices),
          priceData: Object.entries(prices).map(([symbol, price]) => ({
            symbol,
            price
          }))
        };
      } else {
        logger.warn('No prices were stored', { lockId: lockId });
        return { success: false, error: 'No prices were stored' };
      }
      
    } catch (storageError) {
      logger.error('Failed to store prices using PriceChange model', {
        error: storageError.message,
        pricesCount: Object.keys(prices).length,
        lockId: lockId
      });
      return { success: false, error: `Storage failed: ${storageError.message}` };
    }
    
  } catch (error) {
    logger.error('Crypto price update job failed', { 
      error: error.message,
      stack: error.stack,
      lockId: lockId
    });
    return { success: false, error: error.message };
  } finally {
    // Always release the lock
    releaseLock(lockId);
  }
}

// Cleanup old price data using PriceChange model method
async function cleanupOldPrices() {
  try {
    const deletedCount = await PriceChange.cleanupOldPrices(30); // Keep 30 days
    logger.info(`Cleaned up ${deletedCount} old price entries (older than 30 days)`);
    return deletedCount;
  } catch (error) {
    logger.error('Error cleaning up old prices', { error: error.message });
    throw error;
  }
}

// Get price statistics using PriceChange model
async function getPriceStatistics() {
  try {
    const stats = {};
    const tokens = Object.keys(SUPPORTED_TOKENS);
    
    for (const token of tokens) {
      const latestPrice = await PriceChange.findOne({
        symbol: token.toUpperCase()
      }).sort({ timestamp: -1 });
      
      const count = await PriceChange.countDocuments({
        symbol: token.toUpperCase()
      });
      
      stats[token] = {
        count: count,
        latestPrice: latestPrice ? latestPrice.price : null,
        latestTimestamp: latestPrice ? latestPrice.timestamp : null,
        source: latestPrice ? latestPrice.source : null
      };
    }
    
    return stats;
  } catch (error) {
    logger.error('Error getting price statistics', { error: error.message });
    throw error;
  }
}

// Test price changes calculation (for debugging)
async function testPriceChanges() {
  try {
    const prices = await fetchFCSApiPrices();
    if (Object.keys(prices).length === 0) {
      throw new Error('No prices fetched for testing');
    }
    
    // Test 1-hour price changes
    const changes1h = await PriceChange.getPriceChanges(prices, 1);
    
    logger.info('Price changes test results', {
      currentPrices: prices,
      changes1h: changes1h,
      tokensWithChanges: Object.keys(changes1h).filter(k => changes1h[k].dataAvailable).length
    });
    
    return {
      prices,
      changes1h,
      summary: {
        totalTokens: Object.keys(prices).length,
        tokensWithChanges: Object.keys(changes1h).filter(k => changes1h[k].dataAvailable).length
      }
    };
    
  } catch (error) {
    logger.error('Error testing price changes', { error: error.message });
    throw error;
  }
}

// Export for use with job schedulers
module.exports = {
  updateCryptoPrices,
  cleanupOldPrices,
  fetchFCSApiPrices,
  getPriceStatistics,
  testPriceChanges,
  // Export lock functions for testing/debugging
  isJobLocked,
  acquireLock,
  releaseLock,
  // Export configuration for debugging
  SUPPORTED_TOKENS,
  CONFIG
};

// Run immediately if called directly
if (require.main === module) {
  updateCryptoPrices()
    .then((result) => {
      if (result.success) {
        logger.info('Job completed successfully', result);
        process.exit(0);
      } else if (result.skipped) {
        logger.info('Job skipped', result);
        process.exit(0);
      } else {
        logger.error('Job failed', result);
        process.exit(1);
      }
    })
    .catch((error) => {
      logger.error('Job crashed', { error: error.message });
      process.exit(1);
    });
}