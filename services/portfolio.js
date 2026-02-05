// services/portfolio.js - Simplified without caching
const Transaction = require('../models/transaction');
const User = require('../models/user');
const PriceChange = require('../models/pricechange'); // FIXED: Use PriceChange instead of CryptoPrice
const GlobalMarkdown = require('../models/pricemarkdown');
const NairaMarkdown = require('../models/offramp');
const logger = require('../utils/logger');

// Configuration
const CONFIG = {
  DB_QUERY_TIMEOUT: 5000, // 5 seconds for DB queries
  MAX_RETRIES: 2,
  RETRY_DELAY: 1000,
};

// ALIGNED WITH USER SCHEMA: All tokens that exist in user.js balance fields
const SUPPORTED_TOKENS = {
  BTC: { 
    isStablecoin: false, 
    supportedByJob: true // Populated by updateCryptoPrices job
  },
  ETH: { 
    isStablecoin: false, 
    supportedByJob: true
  },
  SOL: { 
    isStablecoin: false, 
    supportedByJob: true
  },
  USDT: { 
    isStablecoin: true, 
    supportedByJob: true
  },
  USDC: { 
    isStablecoin: true, 
    supportedByJob: true
  },
  BNB: { 
    isStablecoin: false, 
    supportedByJob: true
  },
  MATIC: { 
    isStablecoin: false, 
    supportedByJob: true
  },
  TRX: { 
    isStablecoin: false, 
    supportedByJob: true
  },
  NGNZ: { 
    isStablecoin: true, 
    isNairaPegged: true, 
    supportedByJob: false // Calculated from offramp rate
  },
};

// Get global markdown percentage
async function getGlobalMarkdownPercentage() {
  try {
    const markdownDoc = await GlobalMarkdown.getCurrentMarkdown();
    
    if (!markdownDoc || !markdownDoc.isActive) {
      return { hasMarkdown: false, percentage: 0 };
    }
    
    return {
      hasMarkdown: true,
      percentage: markdownDoc.markdownPercentage,
      formattedPercentage: markdownDoc.formattedPercentage
    };
  } catch (error) {
    logger.warn('Error fetching global markdown percentage', { error: error.message });
    return { hasMarkdown: false, percentage: 0 };
  }
}

// Apply markdown to prices (exempt stablecoins and NGNZ)
function applyMarkdownToPrices(priceMap, markdownPercentage) {
  if (!markdownPercentage || markdownPercentage <= 0) {
    return priceMap;
  }

  const markedDownPrices = new Map();
  const discountMultiplier = (100 - markdownPercentage) / 100;

  for (const [token, price] of priceMap.entries()) {
    const tokenInfo = SUPPORTED_TOKENS[token];
    if (tokenInfo && (tokenInfo.isStablecoin || tokenInfo.isNairaPegged)) {
      markedDownPrices.set(token, price);
    } else {
      markedDownPrices.set(token, price * discountMultiplier);
    }
  }

  return markedDownPrices;
}

// Get USD/NGN offramp rate
async function getNairaOfframpRate() {
  try {
    const rateDoc = await NairaMarkdown.findOne();
    if (!rateDoc || !rateDoc.offrampRate) {
      logger.warn('No offramp rate configured, using fallback rate');
      return 1554.42; // Fallback rate
    }
    return rateDoc.offrampRate;
  } catch (error) {
    logger.error('Failed to fetch offramp rate', { error: error.message });
    return 1554.42; // Fallback rate
  }
}

// Special handling for NGNZ (Naira-pegged stablecoin)
async function handleNGNZPricing(tokens) {
  const ngnzPrices = {};
  if (tokens.some(token => token.toUpperCase() === 'NGNZ')) {
    const ngnToUsdRate = 1 / await getNairaOfframpRate();
    ngnzPrices['NGNZ'] = ngnToUsdRate;
    
    logger.debug(`Set NGNZ price from offramp rate: $${ngnToUsdRate}`);
  }
  return ngnzPrices;
}

// Retry logic for database operations
async function withRetry(fn, maxRetries = CONFIG.MAX_RETRIES, delay = CONFIG.RETRY_DELAY) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt === maxRetries) break;
      
      const waitTime = delay * Math.pow(2, attempt);
      logger.warn(`DB attempt ${attempt + 1} failed, retrying in ${waitTime}ms`, { error: error.message });
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  
  throw lastError;
}

// FIXED: Fetch prices from database using PriceChange model (populated by job)
async function fetchDatabasePrices(tokens) {
  try {
    logger.info('Fetching prices from job-populated database', { requestedTokens: tokens });
    
    const prices = new Map();
    
    // Handle NGNZ separately (calculated from offramp rate)
    const ngnzPrices = await handleNGNZPricing(tokens);
    for (const [token, price] of Object.entries(ngnzPrices)) {
      prices.set(token, price);
      logger.debug(`Set NGNZ price: ${token} = $${price}`);
    }
    
    // Filter to tokens that should be in the database (populated by job)
    const dbTokens = tokens.filter(token => {
      const upperToken = token.toUpperCase();
      const tokenInfo = SUPPORTED_TOKENS[upperToken];
      return tokenInfo && tokenInfo.supportedByJob && upperToken !== 'NGNZ'; // NGNZ handled separately
    });
    
    if (dbTokens.length === 0) {
      logger.info('No job-supported tokens to request from database');
      return prices;
    }
    
    logger.info('Requesting job-populated prices from database', { dbTokens });
    
    // FIXED: Get latest prices for requested tokens using PriceChange model
    const latestPrices = {};
    for (const token of dbTokens) {
      const upperToken = token.toUpperCase();
      const latestPrice = await PriceChange.findOne({
        symbol: upperToken
      }).sort({ timestamp: -1 });
      
      if (latestPrice && latestPrice.price > 0) {
        latestPrices[upperToken] = latestPrice.price;
        prices.set(upperToken, latestPrice.price);
        logger.debug(`Set job-populated price: ${upperToken} = $${latestPrice.price.toFixed(8)}`);
      }
    }
    
    if (Object.keys(latestPrices).length === 0) {
      throw new Error('No prices found in database - job may not be running');
    }
    
    logger.info('Job-populated prices retrieved from database', { 
      pricesFound: Object.keys(latestPrices).length,
      tokens: Object.keys(latestPrices)
    });
    
    // Check if we got all requested tokens
    const missingTokens = dbTokens.filter(token => 
      !prices.has(token.toUpperCase())
    );
    
    if (missingTokens.length > 0) {
      logger.warn('Some tokens missing from job-populated database', { missingTokens });
    }
    
    logger.info(`Successfully fetched ${prices.size} prices from job-populated database`);
    return prices;
    
  } catch (error) {
    logger.error('Job-populated database price fetch failed', { 
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

// Fallback prices (used when job-populated database is unavailable)
async function getFallbackPrices(tokens) {
  const fallbackPrices = new Map();
  const fallbacks = {
    'BTC': 65000,
    'ETH': 3200,
    'SOL': 200,
    'USDT': 1,
    'USDC': 1,
    'BNB': 580,
    'MATIC': 0.85,
    'TRX': 0.14,
    'NGNZ': 1 / await getNairaOfframpRate(),
  };
  
  for (const token of tokens) {
    const upperToken = token.toUpperCase();
    if (SUPPORTED_TOKENS[upperToken]) {
      fallbackPrices.set(upperToken, fallbacks[upperToken] || 0);
      logger.debug(`Set fallback price: ${upperToken} = $${fallbacks[upperToken]}`);
    }
  }
  
  return fallbackPrices;
}

// Main price fetching function (reads from job-populated database)
async function fetchCryptoPrices(tokens) {
  logger.info('Starting crypto price fetch from job-populated database', { tokens });
  
  try {
    // Try job-populated database first
    return await withRetry(() => fetchDatabasePrices(tokens));
  } catch (dbError) {
    logger.error('Job-populated database price fetch failed, using fallback prices', { error: dbError.message });
    // Fallback to hardcoded prices if job-populated DB fails
    return await getFallbackPrices(tokens);
  }
}

// Get cryptocurrency prices with automatic markdown application (no caching)
async function getPricesWithCache(tokenSymbols) {
  if (!Array.isArray(tokenSymbols) || tokenSymbols.length === 0) {
    logger.warn('Invalid token symbols provided to getPricesWithCache');
    return {};
  }
  
  // Filter to only supported tokens and normalize
  const normalizedTokens = [...new Set(
    tokenSymbols
      .map(t => t.toUpperCase())
      .filter(token => SUPPORTED_TOKENS[token])
  )];
  
  if (normalizedTokens.length === 0) {
    logger.warn('No supported tokens found in request');
    return {};
  }
  
  try {
    // Fetch fresh prices from job-populated database or fallback
    let priceMap;
    try {
      priceMap = await fetchCryptoPrices(normalizedTokens);
    } catch (error) {
      logger.warn('Price fetch failed, using fallback prices', { error: error.message });
      priceMap = await getFallbackPrices(normalizedTokens);
    }
    
    // Apply hardcoded 0.75% markdown to displayed prices (stablecoins/NGNZ exempt)
    const HARDCODED_MARKDOWN_PERCENT = 0.68;
    priceMap = applyMarkdownToPrices(priceMap, HARDCODED_MARKDOWN_PERCENT);

    // Return prices as object
    return Object.fromEntries(
      normalizedTokens.map(token => [token, priceMap.get(token) || 0])
    );
    
  } catch (error) {
    logger.error('Failed to fetch and process prices', { error: error.message });
    
    // Final fallback - return zero prices
    return Object.fromEntries(
      normalizedTokens.map(token => [token, 0])
    );
  }
}

// FIXED: Get hourly price changes using PriceChange model
async function getHourlyPriceChanges(tokens) {
  try {
    const changes = {};
    
    // Get current prices first
    const currentPrices = {};
    for (const token of tokens) {
      const upperToken = token.toUpperCase();
      
      if (!SUPPORTED_TOKENS[upperToken]) {
        continue;
      }
      
      // Skip NGNZ as it doesn't have price changes (stable/pegged)
      if (upperToken === 'NGNZ') {
        continue;
      }
      
      // Get latest price from PriceChange model
      const latestPrice = await PriceChange.findOne({
        symbol: upperToken
      }).sort({ timestamp: -1 });
      
      if (latestPrice) {
        currentPrices[upperToken] = latestPrice.price;
      }
    }
    
    // Use PriceChange model's getPriceChanges method for 1-hour changes
    const priceChanges = await PriceChange.getPriceChanges(currentPrices, 1); // 1 hour
    
    // Format the response
    for (const [token, changeData] of Object.entries(priceChanges)) {
      if (changeData.dataAvailable) {
        changes[token] = {
          currentPrice: changeData.newPrice,
          hourlyChange: changeData.percentageChange,
          timestamp: new Date()
        };
        
        logger.debug(`Got hourly change for ${token}`, {
          price: changeData.newPrice,
          change: `${changeData.percentageChange}%`
        });
      }
    }
    
    logger.info(`Retrieved hourly changes for ${Object.keys(changes).length} tokens`, {
      tokens: Object.keys(changes),
      changes: Object.fromEntries(
        Object.entries(changes).map(([token, data]) => [token, `${data.hourlyChange}%`])
      )
    });
    
    return changes;
  } catch (error) {
    logger.error('Failed to get hourly price changes from job-populated database', { error: error.message });
    return {};
  }
}

// Update user balance directly for internal transfers
async function updateUserBalance(userId, currency, amount, session = null) {
  if (!userId || !currency || typeof amount !== 'number') {
    throw new Error('Invalid parameters for balance update');
  }
  
  try {
    const currencyUpper = currency.toUpperCase();
    
    // Validate currency is supported
    if (!SUPPORTED_TOKENS[currencyUpper]) {
      throw new Error(`Unsupported currency: ${currencyUpper}`);
    }
    
    // Get current price for USD value calculation
    const prices = await getPricesWithCache([currencyUpper]);
    const currentPrice = prices[currencyUpper] || 0;
    const usdAmount = amount * currentPrice;
    
    // Map currency to correct balance fields
    const currencyLower = currencyUpper.toLowerCase();
    const balanceField = `${currencyLower}Balance`;
    const usdBalanceField = `${currencyLower}BalanceUSD`;
    
    // Build update object
    const updateFields = {
      $inc: {
        [balanceField]: amount,
        [usdBalanceField]: usdAmount
      },
      $set: {
        lastBalanceUpdate: new Date()
      }
    };
    
    // Execute update with or without session
    const updateOptions = { 
      new: true, 
      runValidators: true,
      ...(session && { session })
    };
    
    const user = await User.findByIdAndUpdate(userId, updateFields, updateOptions);
    
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    
    // Recalculate total portfolio balance
    const totalPortfolioBalance = 
      (user.btcBalanceUSD || 0) +
      (user.ethBalanceUSD || 0) +
      (user.solBalanceUSD || 0) +
      (user.usdtBalanceUSD || 0) +
      (user.usdcBalanceUSD || 0) +
      (user.bnbBalanceUSD || 0) +
      (user.maticBalanceUSD || 0) +
      (user.trxBalanceUSD || 0) +
      (user.ngnzBalanceUSD || 0);
    
    // Update total portfolio balance
    await User.findByIdAndUpdate(
      userId,
      { 
        $set: { 
          totalPortfolioBalance: parseFloat(totalPortfolioBalance.toFixed(2)),
          portfolioLastUpdated: new Date()
        }
      },
      { session, runValidators: true }
    );
    
    logger.info(`Updated balance for user ${userId}: ${amount > 0 ? '+' : ''}${amount} ${currencyUpper} (${amount > 0 ? '+' : ''}$${usdAmount.toFixed(2)} USD)`);
    
    return user;
  } catch (error) {
    logger.error(`Failed to update balance for user ${userId}`, { 
      currency, 
      amount, 
      error: error.message 
    });
    throw error;
  }
}

// Get prices without markdown (original prices from job-populated database)
async function getOriginalPricesWithCache(tokenSymbols) {
  if (!Array.isArray(tokenSymbols) || tokenSymbols.length === 0) {
    logger.warn('Invalid token symbols provided to getOriginalPricesWithCache');
    return {};
  }
  
  const normalizedTokens = [...new Set(
    tokenSymbols
      .map(t => t.toUpperCase())
      .filter(token => SUPPORTED_TOKENS[token])
  )];
  
  if (normalizedTokens.length === 0) {
    return {};
  }
  
  try {
    let priceMap;
    
    try {
      priceMap = await fetchCryptoPrices(normalizedTokens);
    } catch (error) {
      logger.warn('Job-populated database failed, using fallback prices for original prices', { error: error.message });
      priceMap = await getFallbackPrices(normalizedTokens);
    }
    
    // Return original prices without markdown
    return Object.fromEntries(
      normalizedTokens.map(token => [token, priceMap.get(token) || 0])
    );
  } catch (error) {
    logger.error('Failed to fetch original prices', { error: error.message });
    return {};
  }
}

// Validate if a token is supported
function isTokenSupported(token) {
  return SUPPORTED_TOKENS.hasOwnProperty(token.toUpperCase());
}

// Legacy cache functions (kept for compatibility, but do nothing)
function clearPriceCache() {
  logger.info('clearPriceCache called (no-op without caching)');
}

function getCacheStats() {
  return {
    cacheSize: 0,
    lastUpdated: null,
    isUpdating: false,
    cacheAge: null,
    ttl: 0,
    usingJobPopulatedDatabase: true,
    supportedTokens: Object.keys(SUPPORTED_TOKENS),
    cachingDisabled: true
  };
}

function forceRefreshPrices(tokens = []) {
  logger.info('forceRefreshPrices called (no-op without caching)', { tokens });
  const tokensToRefresh = tokens.length > 0 ? tokens : Object.keys(SUPPORTED_TOKENS);
  return getPricesWithCache(tokensToRefresh);
}

function isCacheValid(tokenSymbols) {
  // Always return false since we don't cache
  return false;
}

module.exports = {
  // Core functions
  getPricesWithCache,
  getOriginalPricesWithCache,
  updateUserBalance,
  
  // Markdown functions
  getGlobalMarkdownPercentage,
  applyMarkdownToPrices,
  
  // Cache management (legacy - kept for compatibility)
  clearPriceCache,
  getCacheStats,
  forceRefreshPrices,
  isCacheValid,
  
  // Job-populated database functions
  fetchDatabasePrices,
  getHourlyPriceChanges,
  
  // Utilities
  isTokenSupported,
  withRetry,
  SUPPORTED_TOKENS,
  handleNGNZPricing,
  
  // Configuration
  CONFIG
};