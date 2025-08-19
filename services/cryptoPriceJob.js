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

// Enhanced API key validation function
function validateFCSApiKey(apiKey) {
  if (!apiKey) {
    logger.error('FCS API key is missing');
    return false;
  }
  
  if (typeof apiKey !== 'string') {
    logger.error('FCS API key must be a string');
    return false;
  }
  
  if (apiKey.length < 16) {
    logger.error('FCS API key appears to be too short');
    return false;
  }
  
  // Check for demo key pattern
  if (apiKey.toLowerCase().includes('demo')) {
    logger.warn('Using demo API key - limited functionality');
  }
  
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

// Enhanced retry logic with backoff for specific errors
async function withRetry(fn, maxRetries = CONFIG.MAX_RETRIES, delay = CONFIG.RETRY_DELAY) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Don't retry on authentication/authorization errors
      const nonRetryableErrors = [101, 102, 103, 104, 111, 212, 213];
      if (error.message.includes('API Key') || 
          error.message.includes('Account') ||
          nonRetryableErrors.some(code => error.message.includes(code.toString()))) {
        logger.error('Non-retryable error encountered', { error: error.message });
        throw error;
      }
      
      // Handle rate limiting with longer delay
      if (error.response && (error.response.status === 429 || error.message.includes('213'))) {
        if (attempt === maxRetries) break;
        
        const rateLimitWait = CONFIG.RATE_LIMIT_DELAY;
        logger.warn(`Rate limited, waiting ${rateLimitWait}ms before retry ${attempt + 1}`);
        await new Promise(resolve => setTimeout(resolve, rateLimitWait));
        continue;
      }
      
      if (attempt === maxRetries) break;
      
      const waitTime = delay * Math.pow(2, attempt);
      logger.warn(`Attempt ${attempt + 1} failed, retrying in ${waitTime}ms`, { 
        error: error.message,
        attempt: attempt + 1,
        maxRetries: maxRetries + 1
      });
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  
  throw lastError;
}

// Fixed FCS API fetch function based on official FCS documentation
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
    
    logger.info('Requesting from FCS API', { fcsSymbols, apiKey: FCS_API_CONFIG.apiKey });
    
    if (!FCS_API_CONFIG.hasValidApiKey) {
      throw new Error('No valid FCS API key found');
    }
    
    // Fixed axios configuration to match FCS documentation pattern
    const requestUrl = `${FCS_API_CONFIG.baseUrl}/crypto/latest`;
    
    // Create form data matching FCS documentation format
    const data = {
      symbol: fcsSymbols,
      api_key: FCS_API_CONFIG.apiKey  // Note: using 'api_key' not 'access_key'
    };
    
    const config = {
      method: 'POST',  // POST request as per FCS docs
      url: requestUrl,
      data: data,      // Send data in request body
      timeout: CONFIG.REQUEST_TIMEOUT,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Node.js/CryptoPriceJob',
        'Content-Type': 'application/json'
      },
      // SSL and network configuration
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: true,
        keepAlive: true,
        timeout: CONFIG.REQUEST_TIMEOUT
      }),
      // Ensure proper response handling
      responseType: 'json',
      maxRedirects: 5,
      validateStatus: function (status) {
        return status >= 200 && status < 300; // Only accept 2xx responses as success
      }
    };
    
    logger.info('Making POST request to FCS API', {
      url: requestUrl,
      data: data,
      headers: config.headers
    });
    
    const response = await axios(config);
    
    logger.info('FCS API raw response received', {
      status: response.status,
      statusText: response.statusText,
      hasData: !!response.data,
      dataType: typeof response.data,
      contentType: response.headers['content-type']
    });
    
    // Validate response structure
    if (!response.data || typeof response.data !== 'object') {
      throw new Error('Invalid response format from FCS API - no data object');
    }
    
    // Check FCS API status
    if (response.data.status !== true) {
      const errorMsg = response.data.msg || 'Unknown FCS API error';
      const errorCode = response.data.code || 'unknown';
      logger.error('FCS API returned error status', {
        status: response.data.status,
        code: errorCode,
        msg: errorMsg,
        fullResponse: response.data
      });
      throw new Error(`FCS API error (${errorCode}): ${errorMsg}`);
    }
    
    // Validate response array
    if (!Array.isArray(response.data.response)) {
      logger.error('Invalid response format - response field is not an array', {
        responseType: typeof response.data.response,
        responseValue: response.data.response
      });
      throw new Error('Invalid response format from FCS API - response not array');
    }
    
    logger.info('FCS API response validated successfully', { 
      responseCount: response.data.response.length,
      creditCount: response.data.info?.credit_count,
      serverTime: response.data.info?.server_time,
      processTime: response.data.info?.process_time
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
        logger.warn(`Invalid price from FCS API for ${token}`, { 
          token,
          symbol,
          priceString: priceStr,
          parsedPrice: price 
        });
        continue;
      }
      
      prices[token] = price;
      logger.debug(`Set FCS API price: ${token} = $${price.toFixed(8)}`, {
        symbol,
        price,
        rawData: item
      });
    }
    
    const successMessage = `Successfully fetched ${Object.keys(prices).length} prices from FCS API`;
    logger.info(successMessage, {
      pricesCount: Object.keys(prices).length,
      tokens: Object.keys(prices),
      creditUsed: response.data.info?.credit_count
    });
    
    return prices;
    
  } catch (error) {
    // Enhanced error logging with more details
    const errorDetails = {
      message: error.message,
      code: error.code,
      errno: error.errno,
      syscall: error.syscall,
      hostname: error.hostname,
      ...(error.response && {
        response: {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
          headers: error.response.headers
        }
      }),
      ...(error.request && !error.response && {
        request: {
          method: error.request.method,
          path: error.request.path,
          host: error.request.host
        }
      }),
      ...(error.config && {
        config: {
          url: error.config.url,
          method: error.config.method,
          data: error.config.data,
          timeout: error.config.timeout
        }
      })
    };
    
    logger.error('FCS API price fetch failed', errorDetails);
    throw error;
  }
}

// Test function to validate API key and connection
async function testFCSConnection() {
  try {
    logger.info('Testing FCS API connection...');
    
    const data = {
      symbol: 'BTC/USD', // Single symbol for testing
      api_key: FCS_API_CONFIG.apiKey
    };
    
    const config = {
      method: 'POST',
      url: `${FCS_API_CONFIG.baseUrl}/crypto/latest`,
      data: data,
      timeout: 10000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Node.js/CryptoPriceJob',
        'Content-Type': 'application/json'
      },
      validateStatus: function (status) {
        return true; // Accept any status for testing
      }
    };
    
    const response = await axios(config);
    
    logger.info('FCS API test response', {
      status: response.status,
      statusText: response.statusText,
      data: response.data,
      headers: {
        'content-type': response.headers['content-type']
      }
    });
    
    if (response.status === 200 && response.data.status === true) {
      logger.info('FCS API connection test successful');
      return { success: true, data: response.data };
    } else {
      logger.error('FCS API connection test failed', {
        status: response.status,
        data: response.data
      });
      return { success: false, error: response.data };
    }
    
  } catch (error) {
    logger.error('FCS API connection test failed', {
      error: error.message,
      response: error.response?.data
    });
    return { success: false, error: error.message };
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
      storedCount = await PriceChange.storePrices(prices, 'fcsapi'); // Using 'fcsapi' as source
      
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
  testFCSConnection,
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
  // Test connection first, then run the job if successful
  testFCSConnection()
    .then((result) => {
      if (result.success) {
        logger.info('✅ FCS API connection test successful, running price update job');
        return updateCryptoPrices();
      } else {
        logger.error('❌ FCS API connection test failed, aborting job', result.error);
        process.exit(1);
      }
    })
    .then((jobResult) => {
      if (jobResult.success) {
        logger.info('✅ Crypto price update job completed successfully', jobResult);
        process.exit(0);
      } else if (jobResult.skipped) {
        logger.info('ℹ️ Crypto price update job skipped', jobResult);
        process.exit(0);
      } else {
        logger.error('❌ Crypto price update job failed', jobResult);
        process.exit(1);
      }
    })
    .catch((error) => {
      logger.error('💥 Job crashed', { error: error.message, stack: error.stack });
      process.exit(1);
    });
}