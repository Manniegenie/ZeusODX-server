const axios = require('axios');
const Transaction = require('../models/transaction');
const User = require('../models/user');
const GlobalMarkdown = require('../models/pricemarkdown'); // Import markdown model
const logger = require('../utils/logger');

// Configuration for price sources
const CONFIG = {
  CACHE_TTL: 5 * 60 * 1000, // 5 minutes
  REQUEST_TIMEOUT: 15000, // 15 seconds
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000, // 2 seconds
  RATE_LIMIT_DELAY: 30000, // 30 seconds wait on rate limit
};

// ALIGNED WITH USER SCHEMA: All tokens that exist in user.js balance fields - DOGE REMOVED
const SUPPORTED_TOKENS = {
  BTC: { currencyApiSymbol: 'BTC', isStablecoin: false, supportedByCurrencyAPI: true },
  ETH: { currencyApiSymbol: 'ETH', isStablecoin: false, supportedByCurrencyAPI: true },
  SOL: { currencyApiSymbol: 'SOL', isStablecoin: false, supportedByCurrencyAPI: true },
  USDT: { currencyApiSymbol: 'USDT', isStablecoin: true, supportedByCurrencyAPI: false }, // Handle as stablecoin
  USDC: { currencyApiSymbol: 'USDC', isStablecoin: true, supportedByCurrencyAPI: false }, // Handle as stablecoin
  BNB: { currencyApiSymbol: 'BNB', isStablecoin: false, supportedByCurrencyAPI: true },
  // DOGE: REMOVED COMPLETELY
  MATIC: { currencyApiSymbol: 'MATIC', isStablecoin: false, supportedByCurrencyAPI: true },
  AVAX: { currencyApiSymbol: 'AVAX', isStablecoin: false, supportedByCurrencyAPI: true },
  NGNZ: { currencyApiSymbol: 'NGNZ', isStablecoin: true, isNairaPegged: true, supportedByCurrencyAPI: false },
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

// Special handling for NGNZ (Naira-pegged stablecoin)
function handleNGNZPricing(tokens) {
  const ngnzPrices = {};
  if (tokens.some(token => token.toUpperCase() === 'NGNZ')) {
    const ngnToUsdRate = 1 / 1554.42; // Approximate NGN to USD rate
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

// FIXED: Fetch prices from CurrencyAPI.com - only request supported tokens
async function fetchCurrencyApiPrices(tokens) {
  try {
    logger.info('Starting CurrencyAPI price fetch', { requestedTokens: tokens });
    
    // Filter to only tokens that CurrencyAPI actually supports
    const currencyApiTokens = tokens.filter(token => {
      const upperToken = token.toUpperCase();
      const tokenInfo = SUPPORTED_TOKENS[upperToken];
      return tokenInfo && tokenInfo.supportedByCurrencyAPI;
    });
    
    logger.info('Tokens supported by CurrencyAPI', { currencyApiTokens });
    
    const prices = new Map();
    
    // Handle stablecoins (always $1.00)
    const stablecoins = ['USDT', 'USDC'];
    for (const token of tokens) {
      const upperToken = token.toUpperCase();
      if (stablecoins.includes(upperToken)) {
        prices.set(upperToken, 1.0);
        logger.debug(`Set stablecoin price: ${upperToken} = $1.00`);
      }
    }
    
    // Handle NGNZ separately (Naira-pegged)
    const ngnzPrices = handleNGNZPricing(tokens);
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
    
    if (API_CONFIG.hasValidApiKey) {
      config.headers['apikey'] = API_CONFIG.apiKey;
    } else {
      logger.warn('No valid CurrencyAPI key found, request may fail');
    }
    
    const response = await axios.get(`${API_CONFIG.baseUrl}/latest`, config);
    
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
    // 'DOGE': REMOVED
    'MATIC': 0.85,
    'AVAX': 35,
    'NGNZ': 1 / 1554.42,
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
        priceMap = await withRetry(() => fetchCurrencyApiPrices(normalizedTokens));
      } catch (apiError) {
        logger.warn('CurrencyAPI failed, using fallback prices', { error: apiError.message });
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
      // (user.dogeBalanceUSD || 0) + // REMOVED
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
    
    // Get current prices (with markdown applied)
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
        isNairaPegged: token === 'NGNZ'
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

// UPDATED: Updates user's portfolio balance in the database - DOGE REMOVED
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
    
    // Update fields EXACTLY matching user schema - DOGE REMOVED
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
      bnbBalance: 0,
      bnbBalanceUSD: 0,
      // dogeBalance: 0, // REMOVED
      // dogeBalanceUSD: 0, // REMOVED
      maticBalance: 0,
      maticBalanceUSD: 0,
      avaxBalance: 0,
      avaxBalanceUSD: 0,
      ngnzBalance: 0,
      ngnzBalanceUSD: 0,
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
      priceMap = await withRetry(() => fetchCurrencyApiPrices(normalizedTokens));
    } catch (apiError) {
      logger.warn('CurrencyAPI failed, using fallback prices for original prices', { error: apiError.message });
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

module.exports = {
  // Core functions
  getPricesWithCache,
  getOriginalPricesWithCache, // NEW: Get prices without markdown
  getUserPortfolioBalance,
  updateUserPortfolioBalance,
  updateUserBalance,
  reserveUserBalance,
  releaseReservedBalance,
  
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
  CURRENCY_API_CONFIG: API_CONFIG,
  
  // Cache object
  priceCache
};