const Transaction = require('../models/transaction');
const User = require('../models/user');
const CryptoPrice = require('../models/CryptoPrice'); // NEW: Import CryptoPrice model
const GlobalMarkdown = require('../models/pricemarkdown');
const NairaMarkdown = require('../models/offramp');
const logger = require('../utils/logger');

// Configuration
const CONFIG = {
  CACHE_TTL: 5 * 60 * 1000, // 5 minutes (increased since we're reading from DB)
  DB_QUERY_TIMEOUT: 5000, // 5 seconds for DB queries
  MAX_RETRIES: 2, // Reduced retries since DB is more reliable
  RETRY_DELAY: 1000, // 1 second
};

// ALIGNED WITH USER SCHEMA: All tokens that exist in user.js balance fields
const SUPPORTED_TOKENS = {
  BTC: { 
    isStablecoin: false, 
    supportedByDB: true
  },
  ETH: { 
    isStablecoin: false, 
    supportedByDB: true
  },
  SOL: { 
    isStablecoin: false, 
    supportedByDB: true
  },
  USDT: { 
    isStablecoin: true, 
    supportedByDB: true
  },
  USDC: { 
    isStablecoin: true, 
    supportedByDB: true
  },
  BNB: { 
    isStablecoin: false, 
    supportedByDB: true
  },
  MATIC: { 
    isStablecoin: false, 
    supportedByDB: true
  },
  AVAX: { 
    isStablecoin: false, 
    supportedByDB: true
  },
  NGNZ: { 
    isStablecoin: true, 
    isNairaPegged: true, 
    supportedByDB: true
  },
};

// Simplified price cache for DB queries
const priceCache = {
  data: new Map(),
  lastUpdated: null,
  isUpdating: false,
  updatePromise: null,
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

// Apply markdown to prices
function applyMarkdownToPrices(priceMap, markdownPercentage) {
  if (!markdownPercentage || markdownPercentage <= 0) {
    return priceMap;
  }
  
  const markedDownPrices = new Map();
  const discountMultiplier = (100 - markdownPercentage) / 100;
  
  for (const [token, price] of priceMap.entries()) {
    // Don't apply markdown to stablecoins or NGNZ
    const tokenInfo = SUPPORTED_TOKENS[token];
    if (tokenInfo && (tokenInfo.isStablecoin || tokenInfo.isNairaPegged)) {
      markedDownPrices.set(token, price);
    } else {
      const markedDownPrice = price * discountMultiplier;
      markedDownPrices.set(token, markedDownPrice);
    }
  }
  
  logger.info(`Applied ${markdownPercentage}% markdown to ${priceMap.size} token prices`, {
    discountMultiplier,
    affectedTokens: Array.from(priceMap.keys()).filter(token => {
      const tokenInfo = SUPPORTED_TOKENS[token];
      return !tokenInfo?.isStablecoin && !tokenInfo?.isNairaPegged;
    })
  });
  
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
  }
  return ngnzPrices;
}

// Check if cache is valid and contains all required tokens
function isCacheValid(tokenSymbols) {
  if (!priceCache.lastUpdated) return false;
  
  const now = Date.now();
  const cacheExpired = now - priceCache.lastUpdated > CONFIG.CACHE_TTL;
  
  if (cacheExpired) return false;
  
  return tokenSymbols.every(symbol => 
    priceCache.data.has(symbol.toUpperCase())
  );
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

// NEW: Fetch prices from database
async function fetchDatabasePrices(tokens) {
  try {
    logger.info('Starting database price fetch', { requestedTokens: tokens });
    
    const prices = new Map();
    
    // Handle NGNZ separately (calculated from offramp rate)
    const ngnzPrices = await handleNGNZPricing(tokens);
    for (const [token, price] of Object.entries(ngnzPrices)) {
      prices.set(token, price);
      logger.debug(`Set NGNZ price: ${token} = $${price}`);
    }
    
    // Filter to tokens that should be in the database
    const dbTokens = tokens.filter(token => {
      const upperToken = token.toUpperCase();
      const tokenInfo = SUPPORTED_TOKENS[upperToken];
      return tokenInfo && tokenInfo.supportedByDB && upperToken !== 'NGNZ'; // NGNZ handled separately
    });
    
    if (dbTokens.length === 0) {
      logger.info('No tokens to request from database, returning early');
      return prices;
    }
    
    logger.info('Requesting from database', { dbTokens });
    
    // Get latest prices for requested tokens
    const dbPrices = await CryptoPrice.getLatestPrices();
    
    if (!dbPrices || dbPrices.length === 0) {
      throw new Error('No prices found in database');
    }
    
    logger.info('Database prices retrieved', { 
      pricesFound: dbPrices.length,
      tokens: dbPrices.map(p => p.symbol)
    });
    
    // Process database results
    for (const priceDoc of dbPrices) {
      const token = priceDoc.symbol;
      const price = priceDoc.price;
      
      // Only include tokens that were requested
      if (dbTokens.some(t => t.toUpperCase() === token) && price > 0) {
        prices.set(token, price);
        logger.debug(`Set DB price: ${token} = $${price.toFixed(8)}`);
      }
    }
    
    // Check if we got all requested tokens
    const missingTokens = dbTokens.filter(token => 
      !prices.has(token.toUpperCase())
    );
    
    if (missingTokens.length > 0) {
      logger.warn('Some tokens missing from database', { missingTokens });
    }
    
    logger.info(`Successfully fetched ${prices.size} prices from database`);
    return prices;
    
  } catch (error) {
    logger.error('Database price fetch failed', { 
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

// Fallback prices for supported tokens (used when DB is unavailable)
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
    'AVAX': 35,
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

// Main price fetching function (now database-first)
async function fetchCryptoPrices(tokens) {
  logger.info('Starting crypto price fetch from database', { tokens });
  
  try {
    // Try database first
    return await withRetry(() => fetchDatabasePrices(tokens));
  } catch (dbError) {
    logger.error('Database price fetch failed, using fallback prices', { error: dbError.message });
    // Fallback to hardcoded prices if DB fails
    return await getFallbackPrices(tokens);
  }
}

// Get cryptocurrency prices with caching and automatic markdown application
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
  
  // Check cache validity
  if (isCacheValid(normalizedTokens)) {
    logger.debug('Using cached prices with markdown applied', { tokens: normalizedTokens });
    return Object.fromEntries(
      normalizedTokens.map(token => [token, priceCache.data.get(token)])
    );
  }
  
  // Handle concurrent requests
  if (priceCache.isUpdating && priceCache.updatePromise) {
    logger.info('Price update in progress, waiting for completion');
    await priceCache.updatePromise;
    return Object.fromEntries(
      normalizedTokens.map(token => [token, priceCache.data.get(token) || 0])
    );
  }
  
  // Start price update with markdown integration
  priceCache.isUpdating = true;
  priceCache.updatePromise = (async () => {
    try {
      let priceMap;
      
      // Fetch prices from database or fallback
      try {
        priceMap = await fetchCryptoPrices(normalizedTokens);
      } catch (error) {
        logger.warn('Price fetch failed, using fallback prices', { error: error.message });
        priceMap = await getFallbackPrices(normalizedTokens);
      }
      
      // Apply global markdown percentage automatically
      const markdownInfo = await getGlobalMarkdownPercentage();
      
      if (markdownInfo.hasMarkdown) {
        logger.info('Applying global markdown to all crypto prices', {
          markdownPercentage: markdownInfo.percentage,
          affectedTokens: Array.from(priceMap.keys()).filter(token => {
            const tokenInfo = SUPPORTED_TOKENS[token];
            return !tokenInfo?.isStablecoin && !tokenInfo?.isNairaPegged;
          })
        });
        priceMap = applyMarkdownToPrices(priceMap, markdownInfo.percentage);
      }
      
      // Update cache with marked-down prices
      priceCache.data = priceMap;
      priceCache.lastUpdated = Date.now();
      
      logger.info('Price cache updated successfully', { 
        tokenCount: priceMap.size,
        tokens: Array.from(priceMap.keys()),
        markdownApplied: markdownInfo.hasMarkdown,
        markdownPercentage: markdownInfo.hasMarkdown ? `${markdownInfo.percentage}%` : 'None'
      });
      
      return priceMap;
    } catch (error) {
      logger.error('Failed to fetch and process prices', { error: error.message });
      
      // Return stale cache if available
      if (priceCache.data.size > 0) {
        logger.warn('Returning stale cache data due to fetch failure');
        return priceCache.data;
      }
      
      // Final fallback without markdown
      const fallbackPrices = await getFallbackPrices(normalizedTokens);
      priceCache.data = fallbackPrices;
      priceCache.lastUpdated = Date.now();
      return fallbackPrices;
    } finally {
      priceCache.isUpdating = false;
      priceCache.updatePromise = null;
    }
  })();
  
  const priceMap = await priceCache.updatePromise;
  
  return Object.fromEntries(
    normalizedTokens.map(token => [token, priceMap.get(token) || 0])
  );
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
      (user.avaxBalanceUSD || 0) +
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

// Get prices without markdown (original prices from database)
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
      logger.warn('Database failed, using fallback prices for original prices', { error: error.message });
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

// Get cache statistics
function getCacheStats() {
  return {
    cacheSize: priceCache.data.size,
    lastUpdated: priceCache.lastUpdated,
    isUpdating: priceCache.isUpdating,
    cacheAge: priceCache.lastUpdated ? Date.now() - priceCache.lastUpdated : null,
    ttl: CONFIG.CACHE_TTL,
    usingDatabase: true,
    supportedTokens: Object.keys(SUPPORTED_TOKENS)
  };
}

// Clear the price cache
function clearPriceCache() {
  priceCache.data.clear();
  priceCache.lastUpdated = null;
  priceCache.isUpdating = false;
  priceCache.updatePromise = null;
  logger.info('Price cache cleared');
}

// Force refresh prices for specific tokens
async function forceRefreshPrices(tokens = []) {
  logger.info('Force refreshing prices from database', { tokens });
  
  clearPriceCache();
  
  const tokensToRefresh = tokens.length > 0 ? tokens : Object.keys(SUPPORTED_TOKENS);
  
  return await getPricesWithCache(tokensToRefresh);
}

// Validate if a token is supported
function isTokenSupported(token) {
  return SUPPORTED_TOKENS.hasOwnProperty(token.toUpperCase());
}

// Get hourly price changes from database
async function getHourlyPriceChanges(tokens) {
  try {
    const changes = {};
    
    for (const token of tokens) {
      const upperToken = token.toUpperCase();
      
      if (!SUPPORTED_TOKENS[upperToken]) {
        continue;
      }
      
      // Get latest price
      const latestPrice = await CryptoPrice.getLatestPrice(upperToken);
      
      if (latestPrice && latestPrice.hourly_change !== undefined) {
        changes[upperToken] = {
          currentPrice: latestPrice.price,
          hourlyChange: latestPrice.hourly_change,
          timestamp: latestPrice.timestamp
        };
      }
    }
    
    return changes;
  } catch (error) {
    logger.error('Failed to get hourly price changes', { error: error.message });
    return {};
  }
}

module.exports = {
  // Core functions
  getPricesWithCache,
  getOriginalPricesWithCache,
  updateUserBalance,
  
  // Markdown functions
  getGlobalMarkdownPercentage,
  applyMarkdownToPrices,
  
  // Cache management
  clearPriceCache,
  getCacheStats,
  forceRefreshPrices,
  isCacheValid,
  
  // NEW: Database-specific functions
  fetchDatabasePrices,
  getHourlyPriceChanges,
  
  // Utilities
  isTokenSupported,
  withRetry,
  SUPPORTED_TOKENS,
  handleNGNZPricing,
  
  // Configuration
  CONFIG,
  
  // Cache object
  priceCache
};