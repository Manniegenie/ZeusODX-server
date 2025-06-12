const axios = require('axios');
const Transaction = require('../models/transaction');
const User = require('../models/user');
const logger = require('../utils/logger');

// Configuration for price sources
const CONFIG = {
  CACHE_TTL: 5 * 60 * 1000, // 5 minutes
  REQUEST_TIMEOUT: 15000, // 15 seconds
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000, // 2 seconds
  RATE_LIMIT_DELAY: 30000, // 30 seconds wait on rate limit
};

// ALIGNED WITH USER SCHEMA: Only tokens that exist in user.js
const SUPPORTED_TOKENS = {
  BTC: { currencyApiSymbol: 'BTC', isStablecoin: false },
  ETH: { currencyApiSymbol: 'ETH', isStablecoin: false },
  SOL: { currencyApiSymbol: 'SOL', isStablecoin: false },
  USDT: { currencyApiSymbol: 'USDT', isStablecoin: true },
  USDC: { currencyApiSymbol: 'USDC', isStablecoin: true },
  NGNB: { currencyApiSymbol: 'NGNB', isStablecoin: true, isNairaPegged: true },
};

// Simplified price cache
const priceCache = {
  data: new Map(),
  lastUpdated: null,
  isUpdating: false,
  updatePromise: null,
};

// Validates CurrencyAPI.com API key format
function validateCurrencyApiKey(apiKey) {
  if (!apiKey) return false;
  return typeof apiKey === 'string' && apiKey.length >= 32;
}

// CurrencyAPI configuration - SINGLE DECLARATION
const API_CONFIG = {
  hasValidApiKey: validateCurrencyApiKey(process.env.CURRENCYAPI_KEY),
  baseUrl: 'https://api.currencyapi.com/v3',
  apiKey: process.env.CURRENCYAPI_KEY
};

// Special handling for NGNB (Naira-pegged stablecoin)
function handleNGNBPricing(tokens) {
  const ngnbPrices = {};
  if (tokens.some(token => token.toUpperCase() === 'NGNB')) {
    const ngnToUsdRate = 1 / 1554.42; // Approximate NGN to USD rate
    ngnbPrices['NGNB'] = ngnToUsdRate;
  }
  return ngnbPrices;
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

// Fetch prices from CurrencyAPI.com
async function fetchCurrencyApiPrices(tokens) {
  try {
    const supportedTokens = tokens.filter(token => {
      const upperToken = token.toUpperCase();
      return SUPPORTED_TOKENS[upperToken] && upperToken !== 'NGNB';
    });
    
    const stablecoins = ['USDT', 'USDC'];
    const cryptoTokens = supportedTokens
      .filter(token => !stablecoins.includes(token.toUpperCase()))
      .join(',');
    
    const prices = new Map();
    
    // Handle stablecoins (always $1.00)
    for (const token of tokens) {
      const upperToken = token.toUpperCase();
      if (stablecoins.includes(upperToken)) {
        prices.set(upperToken, 1.0);
      }
    }
    
    // Handle NGNB separately (Naira-pegged)
    const ngnbPrices = handleNGNBPricing(tokens);
    for (const [token, price] of Object.entries(ngnbPrices)) {
      prices.set(token, price);
    }
    
    if (!cryptoTokens) {
      return prices;
    }
    
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
    
    if (API_CONFIG.hasValidApiKey) {
      config.headers['apikey'] = API_CONFIG.apiKey;
    }
    
    const response = await axios.get(`${API_CONFIG.baseUrl}/latest`, config);
    
    if (!response.data || !response.data.data || typeof response.data.data !== 'object') {
      throw new Error('Invalid response format from CurrencyAPI');
    }
    
    // Process response - invert rates to get USD price per crypto unit
    for (const token of supportedTokens) {
      const upperToken = token.toUpperCase();
      
      if (stablecoins.includes(upperToken) || upperToken === 'NGNB') {
        continue; // Already handled
      }
      
      const rate = response.data.data[upperToken] && response.data.data[upperToken].value;
      
      if (typeof rate === 'number' && rate > 0) {
        const price = 1 / rate;
        prices.set(upperToken, price);
      }
    }
    
    logger.info(`Fetched ${prices.size} prices from CurrencyAPI.com`);
    return prices;
  } catch (error) {
    logger.error('CurrencyAPI price fetch failed', { error: error.message });
    throw error;
  }
}

// Fallback prices for supported tokens only
async function getFallbackPrices(tokens) {
  const fallbackPrices = new Map();
  const fallbacks = {
    'BTC': 65000,
    'ETH': 3200,
    'SOL': 200,
    'USDT': 1,
    'USDC': 1,
    'NGNB': 1 / 1554.42,
  };
  
  for (const token of tokens) {
    const upperToken = token.toUpperCase();
    if (SUPPORTED_TOKENS[upperToken]) {
      fallbackPrices.set(upperToken, fallbacks[upperToken] || 0);
    }
  }
  
  return fallbackPrices;
}

// Gets cryptocurrency prices with caching
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
    logger.info('Using cached prices', { tokens: normalizedTokens });
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
  
  // Start price update
  priceCache.isUpdating = true;
  priceCache.updatePromise = (async () => {
    try {
      let priceMap;
      
      try {
        priceMap = await withRetry(() => fetchCurrencyApiPrices(normalizedTokens));
      } catch (apiError) {
        logger.warn('CurrencyAPI failed, using fallback prices', { error: apiError.message });
        priceMap = await getFallbackPrices(normalizedTokens);
      }
      
      // Update cache
      priceCache.data = priceMap;
      priceCache.lastUpdated = Date.now();
      
      logger.info('Successfully updated price cache', { 
        tokenCount: priceMap.size,
        tokens: Array.from(priceMap.keys())
      });
      
      return priceMap;
    } catch (error) {
      logger.error('Failed to fetch prices', { error: error.message });
      
      // Return stale cache if available
      if (priceCache.data.size > 0) {
        logger.info('Returning stale cache data due to failure');
        return priceCache.data;
      }
      
      // Final fallback
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

// Calculates user portfolio balance
async function getUserPortfolioBalance(userId, asOfDate = null) {
  if (!userId) {
    throw new Error('User ID is required');
  }
  
  try {
    const query = { 
      userId, 
      status: { $in: ['CONFIRMED', 'SUCCESSFUL'] } 
    };
    
    if (asOfDate) {
      const date = new Date(asOfDate);
      if (isNaN(date.getTime())) {
        throw new Error('Invalid asOfDate provided');
      }
      query.createdAt = { $lte: date };
    }
    
    const transactions = await Transaction.find(query).lean();
    logger.info(`Found ${transactions.length} transactions for user ${userId}`);
    
    // Calculate token balances - filter to supported tokens only
    const tokenBalances = new Map();
    
    for (const tx of transactions) {
      if (!tx.currency || !tx.amount || !tx.type) {
        logger.warn('Skipping invalid transaction', { txId: tx._id });
        continue;
      }
      
      const token = tx.currency.toUpperCase();
      
      // Skip unsupported tokens
      if (!SUPPORTED_TOKENS[token]) {
        logger.warn('Skipping unsupported token in transaction', { txId: tx._id, token });
        continue;
      }
      
      const amount = parseFloat(tx.amount);
      
      if (isNaN(amount)) {
        logger.warn('Invalid amount in transaction', { txId: tx._id, amount: tx.amount });
        continue;
      }
      
      const currentBalance = tokenBalances.get(token) || 0;
      
      if (tx.type === 'DEPOSIT') {
        tokenBalances.set(token, currentBalance + amount);
      } else if (tx.type === 'WITHDRAWAL') {
        tokenBalances.set(token, currentBalance - amount);
      }
    }
    
    // Filter out zero balances
    const nonZeroBalances = new Map();
    for (const [token, balance] of tokenBalances) {
      if (Math.abs(balance) > 0.00000001) {
        nonZeroBalances.set(token, balance);
      }
    }
    
    const tokens = Array.from(nonZeroBalances.keys());
    
    if (tokens.length === 0) {
      return {
        totalPortfolioUSD: 0,
        tokens: [],
        lastUpdated: priceCache.lastUpdated ? new Date(priceCache.lastUpdated).toISOString() : null,
        asOfDate: asOfDate ? new Date(asOfDate).toISOString() : null,
      };
    }
    
    // Get current prices
    const prices = await getPricesWithCache(tokens);
    let totalUSD = 0;
    const portfolio = [];
    
    for (const token of tokens) {
      const balance = nonZeroBalances.get(token);
      const price = prices[token] || 0;
      const valueInUSD = balance * price;
      totalUSD += valueInUSD;
      
      portfolio.push({
        token,
        balance: parseFloat(balance.toFixed(8)),
        priceInUSD: parseFloat(price.toFixed(8)),
        valueInUSD: parseFloat(valueInUSD.toFixed(2)),
        isNairaPegged: token === 'NGNB'
      });
    }
    
    // Sort by value descending
    portfolio.sort((a, b) => b.valueInUSD - a.valueInUSD);
    
    return {
      totalPortfolioUSD: parseFloat(totalUSD.toFixed(2)),
      tokens: portfolio,
      lastUpdated: priceCache.lastUpdated ? new Date(priceCache.lastUpdated).toISOString() : null,
      asOfDate: asOfDate ? new Date(asOfDate).toISOString() : null,
    };
  } catch (error) {
    logger.error('Error calculating portfolio balance', { userId, error: error.message });
    throw error;
  }
}

// Updates user's portfolio balance in the database - ALIGNED with user schema
async function updateUserPortfolioBalance(userId, asOfDate = null) {
  if (!userId) {
    throw new Error('User ID is required');
  }
  
  try {
    const portfolio = await getUserPortfolioBalance(userId, asOfDate);
    const user = await User.findById(userId);
    
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    
    // Update fields EXACTLY matching user schema
    const updateFields = {
      totalPortfolioBalance: portfolio.totalPortfolioUSD,
      portfolioLastUpdated: new Date(),
      // Reset all balances to 0 first
      solBalance: 0,
      solBalanceUSD: 0,
      btcBalance: 0,
      btcBalanceUSD: 0,
      usdtBalance: 0,
      usdtBalanceUSD: 0,
      usdcBalance: 0,
      usdcBalanceUSD: 0,
      ethBalance: 0,
      ethBalanceUSD: 0,
      ngnbBalance: 0,
      ngnbBalanceUSD: 0,
    };
    
    // Update balances for tokens that exist in user schema
    for (const { token, balance, valueInUSD } of portfolio.tokens) {
      const tokenLower = token.toLowerCase();
      const balanceField = `${tokenLower}Balance`;
      const usdField = `${tokenLower}BalanceUSD`;
      
      if (updateFields.hasOwnProperty(balanceField)) {
        updateFields[balanceField] = balance;
        updateFields[usdField] = valueInUSD;
      }
    }
    
    const updatedUser = await User.findByIdAndUpdate(
      userId, 
      updateFields, 
      { new: true, runValidators: true }
    );
    
    logger.info(`Successfully updated portfolio balances for user ${userId}`, {
      totalUSD: portfolio.totalPortfolioUSD,
      tokenCount: portfolio.tokens.length
    });
    
    return updatedUser;
  } catch (error) {
    logger.error(`Failed to update portfolio balance for user ${userId}`, { error: error.message });
    return null;
  }
}

// Reserves user balance for pending transactions
async function reserveUserBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number' || amount <= 0) {
    throw new Error('Invalid parameters for balance reservation');
  }
  
  try {
    const currencyUpper = currency.toUpperCase();
    
    // Validate currency is supported
    if (!SUPPORTED_TOKENS[currencyUpper]) {
      throw new Error(`Unsupported currency: ${currencyUpper}`);
    }
    
    // Map currency to correct pending balance field
    const pendingBalanceKey = `${currencyUpper.toLowerCase()}PendingBalance`;
    
    const update = { 
      $inc: { [pendingBalanceKey]: amount },
      $set: { lastBalanceUpdate: new Date() }
    };
    
    const user = await User.findByIdAndUpdate(
      userId, 
      update, 
      { new: true, runValidators: true }
    );
    
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    
    logger.info(`Reserved ${amount} ${currencyUpper} for user ${userId}`);
    return user;
  } catch (error) {
    logger.error(`Failed to reserve balance for user ${userId}`, { 
      currency, 
      amount, 
      error: error.message 
    });
    throw error;
  }
}

// Releases reserved user balance
async function releaseReservedBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number' || amount <= 0) {
    throw new Error('Invalid parameters for balance release');
  }
  
  try {
    const currencyUpper = currency.toUpperCase();
    
    // Validate currency is supported
    if (!SUPPORTED_TOKENS[currencyUpper]) {
      throw new Error(`Unsupported currency: ${currencyUpper}`);
    }
    
    // Map currency to correct pending balance field
    const pendingBalanceKey = `${currencyUpper.toLowerCase()}PendingBalance`;
    
    const update = { 
      $inc: { [pendingBalanceKey]: -amount },
      $set: { lastBalanceUpdate: new Date() }
    };
    
    const user = await User.findByIdAndUpdate(
      userId, 
      update, 
      { new: true, runValidators: true }
    );
    
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    
    logger.info(`Released ${amount} ${currencyUpper} for user ${userId}`);
    return user;
  } catch (error) {
    logger.error(`Failed to release reserved balance for user ${userId}`, { 
      currency, 
      amount, 
      error: error.message 
    });
    throw error;
  }
}

// Validates if a token is supported
function isTokenSupported(token) {
  return SUPPORTED_TOKENS.hasOwnProperty(token.toUpperCase());
}

// Clears the price cache
function clearPriceCache() {
  priceCache.data.clear();
  priceCache.lastUpdated = null;
  priceCache.isUpdating = false;
  priceCache.updatePromise = null;
  logger.info('Price cache cleared');
}

// Gets cache statistics
function getCacheStats() {
  return {
    cacheSize: priceCache.data.size,
    lastUpdated: priceCache.lastUpdated,
    isUpdating: priceCache.isUpdating,
    cacheAge: priceCache.lastUpdated ? Date.now() - priceCache.lastUpdated : null,
    ttl: CONFIG.CACHE_TTL,
    usingCurrencyAPI: API_CONFIG.hasValidApiKey,
    supportedTokens: Object.keys(SUPPORTED_TOKENS)
  };
}

// Force refresh prices for specific tokens
async function forceRefreshPrices(tokens = []) {
  logger.info('Force refreshing prices', { tokens });
  
  clearPriceCache();
  
  const tokensToRefresh = tokens.length > 0 ? tokens : Object.keys(SUPPORTED_TOKENS);
  
  return await getPricesWithCache(tokensToRefresh);
}

module.exports = {
  // Core functions
  getPricesWithCache,
  getUserPortfolioBalance,
  updateUserPortfolioBalance,
  reserveUserBalance,
  releaseReservedBalance,
  
  // Cache management
  clearPriceCache,
  getCacheStats,
  forceRefreshPrices,
  isCacheValid,
  
  // Utilities
  isTokenSupported,
  withRetry,
  SUPPORTED_TOKENS,
  handleNGNBPricing,
  
  // Configuration
  CONFIG,
  CURRENCY_API_CONFIG: API_CONFIG, // Alias for compatibility
  
  // Cache object
  priceCache
};