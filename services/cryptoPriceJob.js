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
    
    const prices = new Map();
    
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
      
      prices.set(token, price);
      logger.debug(`Set FCS API price: ${token} = $${price.toFixed(8)}`);
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

// Calculate hourly percentage change
async function calculateHourlyPercentageChange(symbol, currentPrice) {
  try {
    logger.debug(`Calculating hourly percentage change for ${symbol}`, { currentPrice });
    
    // Get price from exactly 1 hour ago (or closest available)
    const oneHourAgo = new Date(Date.now() - (60 * 60 * 1000));
    
    const historicalPrice = await CryptoPrice.findOne({
      symbol: symbol,
      timestamp: { $lte: oneHourAgo }
    }).sort({ timestamp: -1 });
    
    if (!historicalPrice || !historicalPrice.price || historicalPrice.price <= 0) {
      logger.debug(`No valid historical price found for ${symbol}, returning 0% change`);
      return 0;
    }
    
    // Calculate percentage change: ((current - old) / old) * 100
    const oldPrice = historicalPrice.price;
    const percentageChange = ((currentPrice - oldPrice) / oldPrice) * 100;
    
    // Round to 4 decimal places for percentage precision
    const roundedChange = parseFloat(percentageChange.toFixed(4));
    
    logger.debug(`Calculated hourly change for ${symbol}`, {
      currentPrice: currentPrice.toFixed(8),
      oldPrice: oldPrice.toFixed(8),
      percentageChange: `${roundedChange}%`,
      timeDiff: `${Math.round((Date.now() - historicalPrice.timestamp.getTime()) / (1000 * 60))} minutes ago`
    });
    
    return roundedChange;
    
  } catch (error) {
    logger.error(`Error calculating hourly percentage change for ${symbol}`, { 
      error: error.message,
      currentPrice 
    });
    return 0;
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
  logger.info('Starting crypto price update job with percentage calculations', { 
    timestamp: startTime.toISOString(),
    lockId: lockId
  });
  
  try {
    // Fetch current prices from FCS API
    let priceMap;
    try {
      priceMap = await withRetry(() => fetchFCSApiPrices());
    } catch (error) {
      logger.error('Failed to fetch prices from FCS API, job aborted', { 
        error: error.message,
        lockId: lockId
      });
      return { success: false, error: error.message };
    }
    
    if (priceMap.size === 0) {
      logger.warn('No prices fetched from FCS API, job aborted', { lockId: lockId });
      return { success: false, error: 'No prices fetched' };
    }
    
    logger.info(`Processing ${priceMap.size} tokens for price and percentage calculations`, {
      tokens: Array.from(priceMap.keys()),
      lockId: lockId
    });
    
    // Process each price and calculate hourly percentage changes
    const priceUpdates = [];
    const timestamp = new Date();
    
    for (const [symbol, price] of priceMap.entries()) {
      try {
        // Calculate hourly percentage change
        const hourlyPercentageChange = await calculateHourlyPercentageChange(symbol, price);
        
        const priceUpdate = {
          symbol: symbol,
          price: price,
          hourly_change: hourlyPercentageChange, // This is stored as percentage (e.g., 2.5 for 2.5%)
          timestamp: timestamp
        };
        
        priceUpdates.push(priceUpdate);
        
        logger.debug(`Prepared price update for ${symbol}`, { 
          price: `$${price.toFixed(8)}`, 
          hourlyChange: `${hourlyPercentageChange}%`,
          lockId: lockId
        });
        
      } catch (error) {
        logger.error(`Error processing ${symbol}`, { 
          error: error.message,
          price: price,
          lockId: lockId
        });
        
        // Still add the price record even if percentage calculation failed
        priceUpdates.push({
          symbol: symbol,
          price: price,
          hourly_change: 0, // Default to 0% if calculation fails
          timestamp: timestamp
        });
      }
    }
    
    // Bulk insert to MongoDB (only if we have updates)
    if (priceUpdates.length > 0) {
      await CryptoPrice.insertMany(priceUpdates);
      
      const endTime = new Date();
      const duration = endTime - startTime;
      
      // Log summary of changes
      const changesWithMovement = priceUpdates.filter(p => Math.abs(p.hourly_change) > 0.01);
      const avgChange = priceUpdates.reduce((sum, p) => sum + Math.abs(p.hourly_change), 0) / priceUpdates.length;
      
      logger.info('Crypto price update job completed successfully', {
        pricesUpdated: priceUpdates.length,
        tokensWithMovement: changesWithMovement.length,
        avgAbsoluteChange: `${avgChange.toFixed(2)}%`,
        duration: `${duration}ms`,
        timestamp: endTime.toISOString(),
        symbols: priceUpdates.map(p => `${p.symbol}(${p.hourly_change > 0 ? '+' : ''}${p.hourly_change}%)`),
        lockId: lockId
      });
      
      return { 
        success: true, 
        pricesUpdated: priceUpdates.length,
        tokensWithMovement: changesWithMovement.length,
        avgAbsoluteChange: avgChange,
        duration: duration,
        symbols: priceUpdates.map(p => p.symbol),
        priceData: priceUpdates.map(p => ({
          symbol: p.symbol,
          price: p.price,
          change: `${p.hourly_change}%`
        }))
      };
    } else {
      logger.warn('No price updates to save', { lockId: lockId });
      return { success: false, error: 'No price updates to save' };
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

// Cleanup old price data (keep last 30 days for better historical data)
async function cleanupOldPrices() {
  try {
    const cutoffDate = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)); // 30 days
    
    const result = await CryptoPrice.deleteMany({
      timestamp: { $lt: cutoffDate }
    });
    
    logger.info(`Cleaned up ${result.deletedCount} old price entries (older than 30 days)`);
    return result.deletedCount;
    
  } catch (error) {
    logger.error('Error cleaning up old prices', { error: error.message });
    throw error;
  }
}

// Get price statistics for debugging
async function getPriceStatistics() {
  try {
    const stats = await CryptoPrice.aggregate([
      {
        $group: {
          _id: '$symbol',
          count: { $sum: 1 },
          latestPrice: { $max: '$price' },
          latestChange: { $last: '$hourly_change' },
          latestTimestamp: { $max: '$timestamp' },
          avgAbsChange: { $avg: { $abs: '$hourly_change' } }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    return stats;
  } catch (error) {
    logger.error('Error getting price statistics', { error: error.message });
    throw error;
  }
}

// Export for use with job schedulers
module.exports = {
  updateCryptoPrices,
  cleanupOldPrices,
  fetchFCSApiPrices,
  calculateHourlyPercentageChange,
  getPriceStatistics,
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