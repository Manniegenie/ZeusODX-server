const axios = require('axios');
const Transaction = require('../models/transaction');
const User = require('../models/user');
const GlobalMarkdown = require('../models/pricemarkdown');
const NairaMarkdown = require('../models/offramp'); // Import offramp model
const logger = require('../utils/logger');

// Configuration for price sources
const CONFIG = {
  CACHE_TTL: 2 * 60 * 1000, // 2 minutes (reduced from 5 since FCS updates every 30s-1min)
  REQUEST_TIMEOUT: 15000, // 15 seconds
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000, // 2 seconds
  RATE_LIMIT_DELAY: 30000, // 30 seconds wait on rate limit
};

// ALIGNED WITH USER SCHEMA: All tokens that exist in user.js balance fields - DOGE REMOVED
const SUPPORTED_TOKENS = {
  BTC: { 
    currencyApiSymbol: 'BTC', 
    fcsApiSymbol: 'BTC/USD',
    isStablecoin: false, 
    supportedByCurrencyAPI: true,
    supportedByFCSAPI: true
  },
  ETH: { 
    currencyApiSymbol: 'ETH', 
    fcsApiSymbol: 'ETH/USD',
    isStablecoin: false, 
    supportedByCurrencyAPI: true,
    supportedByFCSAPI: true
  },
  SOL: { 
    currencyApiSymbol: 'SOL', 
    fcsApiSymbol: 'SOL/USD',
    isStablecoin: false, 
    supportedByCurrencyAPI: true,
    supportedByFCSAPI: true
  },
  USDT: { 
    currencyApiSymbol: 'USDT', 
    fcsApiSymbol: 'USDT/USD',
    isStablecoin: true, 
    supportedByCurrencyAPI: false,
    supportedByFCSAPI: true
  },
  USDC: { 
    currencyApiSymbol: 'USDC', 
    fcsApiSymbol: 'USDC/USD',
    isStablecoin: true, 
    supportedByCurrencyAPI: false,
    supportedByFCSAPI: true
  },
  BNB: { 
    currencyApiSymbol: 'BNB', 
    fcsApiSymbol: 'BNB/USD',
    isStablecoin: false, 
    supportedByCurrencyAPI: true,
    supportedByFCSAPI: true
  },
  MATIC: { 
    currencyApiSymbol: 'MATIC', 
    fcsApiSymbol: 'MATIC/USD',
    isStablecoin: false, 
    supportedByCurrencyAPI: true,
    supportedByFCSAPI: true
  },
  AVAX: { 
    currencyApiSymbol: 'AVAX', 
    fcsApiSymbol: 'AVAX/USD',
    isStablecoin: false, 
    supportedByCurrencyAPI: true,
    supportedByFCSAPI: true
  },
  NGNZ: { 
    currencyApiSymbol: 'NGNZ', 
    fcsApiSymbol: null, // Not supported by FCS API
    isStablecoin: true, 
    isNairaPegged: true, 
    supportedByCurrencyAPI: false,
    supportedByFCSAPI: false
  },
};

// Simplified price cache
const priceCache = {
  data: new Map(),
  lastUpdated: null,
  isUpdating: false,
  updatePromise: null,
};

// Validates API keys
function validateCurrencyApiKey(apiKey) {
  if (!apiKey) return false;
  return typeof apiKey === 'string' && apiKey.length >= 32;
}

function validateFCSApiKey(apiKey) {
  if (!apiKey) return false;
  return typeof apiKey === 'string' && apiKey.length >= 16;
}

// API configurations
const CURRENCY_API_CONFIG = {
  hasValidApiKey: validateCurrencyApiKey(process.env.CURRENCYAPI_KEY),
  baseUrl: 'https://api.currencyapi.com/v3',
  apiKey: process.env.CURRENCYAPI_KEY
};

const FCS_API_CONFIG = {
  hasValidApiKey: validateFCSApiKey(process.env.FCS_API_KEY),
  baseUrl: 'https://fcsapi.com/api-v3',
  apiKey: process.env.FCS_API_KEY
};

// NEW FUNCTION: Get global markdown percentage
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

// NEW FUNCTION: Apply markdown to prices
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

// NEW FUNCTION: Get USD/NGN offramp rate
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

// Checks if cache is valid and contains all required tokens
function isCacheValid(tokenSymbols) {
  if (!priceCache.lastUpdated) return false;
  
  const now = Date.now();
  const cacheExpired = now - priceCache.lastUpdated > CONFIG.CACHE_TTL;
  
  if (cacheExpired) return false;
  
  return tokenSymbols.every(symbol => 
    priceCache.data.has(symbol.toUpperCase())
  );
}

// Implements retry logic with exponential backoff
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

// NEW: Fetch prices from FCS API (Primary source)
async function fetchFCSApiPrices(tokens) {
  try {
    logger.info('Starting FCS API price fetch', { requestedTokens: tokens });
    
    // Filter to only tokens that FCS API supports
    const fcsApiTokens = tokens.filter(token => {
      const upperToken = token.toUpperCase();
      const tokenInfo = SUPPORTED_TOKENS[upperToken];
      return tokenInfo && tokenInfo.supportedByFCSAPI;
    });
    
    logger.info('Tokens supported by FCS API', { fcsApiTokens });
    
    const prices = new Map();
    
    // Handle NGNZ separately (not supported by FCS API)
    const ngnzPrices = await handleNGNZPricing(tokens);
    for (const [token, price] of Object.entries(ngnzPrices)) {
      prices.set(token, price);
      logger.debug(`Set NGNZ price: ${token} = $${price}`);
    }
    
    // Exit early if no tokens to request from FCS API
    if (fcsApiTokens.length === 0) {
      logger.info('No tokens to request from FCS API, returning early');
      return prices;
    }
    
    // Build symbol list for FCS API (e.g., "BTC/USD,ETH/USD")
    const fcsSymbols = fcsApiTokens
      .map(token => SUPPORTED_TOKENS[token.toUpperCase()].fcsApiSymbol)
      .filter(symbol => symbol !== null)
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
        'User-Agent': 'Portfolio-Service/1.0'
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
      responseStatus: response.status,
      creditCount: response.data.info?.credit_count
    });
    
    // Process FCS API response
    for (const item of response.data.response) {
      if (!item.s || typeof item.c !== 'number') {
        logger.warn('Invalid FCS API response item', { item });
        continue;
      }
      
      // Extract token from symbol (e.g., "BTC/USD" -> "BTC")
      const symbol = item.s; // e.g., "BTC/USD"
      const token = symbol.split('/')[0]; // e.g., "BTC"
      const price = item.c; // Current price
      
      if (price > 0) {
        prices.set(token, price);
        logger.debug(`Set FCS API price: ${token} = $${price.toFixed(8)}`);
      } else {
        logger.warn(`Invalid price from FCS API for ${token}`, { price });
      }
    }
    
    logger.info(`Successfully fetched ${prices.size} prices from FCS API`, {
      totalPrices: prices.size,
      fcsApiPrices: response.data.response.length
    });
    
    return prices;
  } catch (error) {
    logger.error('FCS API price fetch failed', { 
      error: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data
    });
    throw error;
  }
}

// UPDATED: Fetch prices from CurrencyAPI.com (Backup source)
async function fetchCurrencyApiPrices(tokens) {
  try {
    logger.info('Starting CurrencyAPI price fetch (BACKUP)', { requestedTokens: tokens });
    
    // Filter to only tokens that CurrencyAPI actually supports
    const currencyApiTokens = tokens.filter(token => {
      const upperToken = token.toUpperCase();
      const tokenInfo = SUPPORTED_TOKENS[upperToken];
      return tokenInfo && tokenInfo.supportedByCurrencyAPI;
    });
    
    logger.info('Tokens supported by CurrencyAPI', { currencyApiTokens });
    
    const prices = new Map();
    
    // Handle stablecoins (always $1.00) - only for tokens not already handled
    const stablecoins = ['USDT', 'USDC'];
    for (const token of tokens) {
      const upperToken = token.toUpperCase();
      if (stablecoins.includes(upperToken)) {
        prices.set(upperToken, 1.0);
        logger.debug(`Set stablecoin price: ${upperToken} = $1.00`);
      }
    }
    
    // Handle NGNZ separately (Naira-pegged)
    const ngnzPrices = await handleNGNZPricing(tokens);
    for (const [token, price] of Object.entries(ngnzPrices)) {
      prices.set(token, price);
      logger.debug(`Set NGNZ price: ${token} = $${price}`);
    }
    
    // Exit early if no tokens to request from CurrencyAPI
    if (currencyApiTokens.length === 0) {
      logger.info('No tokens to request from CurrencyAPI, returning early');
      return prices;
    }
    
    // Request only supported tokens from CurrencyAPI
    const cryptoTokens = currencyApiTokens.join(',');
    logger.info('Requesting from CurrencyAPI', { cryptoTokens });
    
    const config = {
      params: {
        base_currency: 'USD',
        currencies: cryptoTokens
      },
      timeout: CONFIG.REQUEST_TIMEOUT,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Portfolio-Service/1.0'
      }
    };
    
    if (CURRENCY_API_CONFIG.hasValidApiKey) {
      config.headers['apikey'] = CURRENCY_API_CONFIG.apiKey;
    } else {
      logger.warn('No valid CurrencyAPI key found, request may fail');
    }
    
    const response = await axios.get(`${CURRENCY_API_CONFIG.baseUrl}/latest`, config);
    
    if (!response.data || !response.data.data || typeof response.data.data !== 'object') {
      throw new Error('Invalid response format from CurrencyAPI');
    }
    
    logger.info('CurrencyAPI response received', { 
      responseDataKeys: Object.keys(response.data.data),
      responseStatus: response.status 
    });
    
    // Process response - CurrencyAPI returns rates like EUR: 0.85 (USD to EUR)
    // We need to invert to get crypto prices in USD
    for (const token of currencyApiTokens) {
      const upperToken = token.toUpperCase();
      const rateData = response.data.data[upperToken];
      
      if (rateData && typeof rateData.value === 'number' && rateData.value > 0) {
        const price = 1 / rateData.value; // Invert to get USD price per crypto unit
        prices.set(upperToken, price);
        logger.debug(`Set CurrencyAPI price: ${upperToken} = $${price.toFixed(2)}`);
      } else {
        logger.warn(`Invalid or missing price data for ${upperToken}`, { rateData });
      }
    }
    
    logger.info(`Successfully fetched ${prices.size} prices from CurrencyAPI`, {
      totalPrices: prices.size,
      currencyApiPrices: currencyApiTokens.length
    });
    
    return prices;
  } catch (error) {
    logger.error('CurrencyAPI price fetch failed', { 
      error: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data
    });
    throw error;
  }
}

// NEW: Main price fetching function with FCS API primary + CurrencyAPI backup
async function fetchCryptoPrices(tokens) {
  logger.info('Starting crypto price fetch with FCS + CurrencyAPI backup', { tokens });
  
  // Try FCS API first (primary source)
  if (FCS_API_CONFIG.hasValidApiKey) {
    try {
      logger.info('Attempting FCS API (primary source)');
      const fcsApiPrices = await fetchFCSApiPrices(tokens);
      
      // Check if we got prices for most requested tokens
      const requestedTokens = tokens.map(t => t.toUpperCase());
      const pricesReceived = Array.from(fcsApiPrices.keys());
      const coveragePercentage = (pricesReceived.length / requestedTokens.length) * 100;
      
      if (coveragePercentage >= 70) { // If we got at least 70% coverage
        logger.info(`FCS API successful with ${coveragePercentage.toFixed(1)}% coverage`, {
          requestedCount: requestedTokens.length,
          receivedCount: pricesReceived.length
        });
        return fcsApiPrices;
      } else {
        logger.warn(`FCS API coverage too low (${coveragePercentage.toFixed(1)}%), trying backup`);
      }
    } catch (fcsError) {
      logger.warn('FCS API failed, trying CurrencyAPI backup', { error: fcsError.message });
    }
  } else {
    logger.warn('No valid FCS API key, skipping to CurrencyAPI backup');
  }
  
  // Fallback to CurrencyAPI
  if (CURRENCY_API_CONFIG.hasValidApiKey) {
    try {
      logger.info('Attempting CurrencyAPI (backup source)');
      return await fetchCurrencyApiPrices(tokens);
    } catch (currencyApiError) {
      logger.error('Both FCS API and CurrencyAPI failed', { error: currencyApiError.message });
      throw currencyApiError;
    }
  } else {
    throw new Error('No valid API keys available for price fetching');
  }
}

// Fallback prices for supported tokens only - DOGE REMOVED
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

// Gets cryptocurrency prices with caching and automatic markdown application
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
      
      // Fetch original prices from API or fallback
      try {
        priceMap = await withRetry(() => fetchCryptoPrices(normalizedTokens));
      } catch (apiError) {
        logger.warn('All APIs failed, using fallback prices', { error: apiError.message });
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

// ====================================================
// UPDATED: Updates user balance directly for internal transfers - DOGE REMOVED
// ====================================================
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
    
    // Recalculate total portfolio balance - DOGE REMOVED
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

// ... (rest of the functions remain the same as in the original code)
// I'll include the essential ones for brevity

// NEW FUNCTION: Get prices without markdown (original prices)
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
      priceMap = await withRetry(() => fetchCryptoPrices(normalizedTokens));
    } catch (apiError) {
      logger.warn('APIs failed, using fallback prices for original prices', { error: apiError.message });
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

// Gets cache statistics
function getCacheStats() {
  return {
    cacheSize: priceCache.data.size,
    lastUpdated: priceCache.lastUpdated,
    isUpdating: priceCache.isUpdating,
    cacheAge: priceCache.lastUpdated ? Date.now() - priceCache.lastUpdated : null,
    ttl: CONFIG.CACHE_TTL,
    usingFCSAPI: FCS_API_CONFIG.hasValidApiKey,
    usingCurrencyAPI: CURRENCY_API_CONFIG.hasValidApiKey,
    supportedTokens: Object.keys(SUPPORTED_TOKENS)
  };
}

// Clears the price cache
function clearPriceCache() {
  priceCache.data.clear();
  priceCache.lastUpdated = null;
  priceCache.isUpdating = false;
  priceCache.updatePromise = null;
  logger.info('Price cache cleared');
}

// Force refresh prices for specific tokens
async function forceRefreshPrices(tokens = []) {
  logger.info('Force refreshing prices', { tokens });
  
  clearPriceCache();
  
  const tokensToRefresh = tokens.length > 0 ? tokens : Object.keys(SUPPORTED_TOKENS);
  
  return await getPricesWithCache(tokensToRefresh);
}

// Validates if a token is supported
function isTokenSupported(token) {
  return SUPPORTED_TOKENS.hasOwnProperty(token.toUpperCase());
}

module.exports = {
  // Core functions
  getPricesWithCache,
  getOriginalPricesWithCache,
  updateUserBalance,
  
  // NEW: Markdown functions
  getGlobalMarkdownPercentage,
  applyMarkdownToPrices,
  
  // Cache management
  clearPriceCache,
  getCacheStats,
  forceRefreshPrices,
  isCacheValid,
  
  // Utilities
  isTokenSupported,
  withRetry,
  SUPPORTED_TOKENS,
  handleNGNZPricing,
  
  // Configuration
  CONFIG,
  FCS_API_CONFIG,
  CURRENCY_API_CONFIG,
  
  // Cache object
  priceCache
};