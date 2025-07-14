// services/portfolio.js

const axios = require('axios');
const Transaction = require('../models/transaction');
const User = require('../models/user');
const GlobalMarkdown = require('../models/pricemarkdown');
const logger = require('../utils/logger');

// Configuration for price sources
const CONFIG = {
  CACHE_TTL: 5 * 60 * 1000,    // 5 minutes
  REQUEST_TIMEOUT: 15000,      // 15 seconds
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,           // 2 seconds
  RATE_LIMIT_DELAY: 30000      // 30 seconds wait on rate limit
};

// Supported tokens (aligned with User schema)
const SUPPORTED_TOKENS = {
  BTC:  { currencyApiSymbol: 'BTC',  isStablecoin: false, supportedByCurrencyAPI: true },
  ETH:  { currencyApiSymbol: 'ETH',  isStablecoin: false, supportedByCurrencyAPI: true },
  SOL:  { currencyApiSymbol: 'SOL',  isStablecoin: false, supportedByCurrencyAPI: true },
  USDT: { currencyApiSymbol: 'USDT', isStablecoin: true,  supportedByCurrencyAPI: false },
  USDC: { currencyApiSymbol: 'USDC', isStablecoin: true,  supportedByCurrencyAPI: false },
  BNB:  { currencyApiSymbol: 'BNB',  isStablecoin: false, supportedByCurrencyAPI: true },
  MATIC:{ currencyApiSymbol: 'MATIC',isStablecoin: false, supportedByCurrencyAPI: true },
  AVAX: { currencyApiSymbol: 'AVAX', isStablecoin: false, supportedByCurrencyAPI: true },
  NGNZ: { currencyApiSymbol: 'NGNZ', isStablecoin: true, isNairaPegged: true, supportedByCurrencyAPI: false }
};

// Price cache
const priceCache = {
  data: new Map(),
  lastUpdated: null,
  isUpdating: false,
  updatePromise: null
};

// Validate CurrencyAPI key
function validateCurrencyApiKey(apiKey) {
  return typeof apiKey === 'string' && apiKey.length >= 32;
}

const API_CONFIG = {
  hasValidApiKey: validateCurrencyApiKey(process.env.CURRENCYAPI_KEY),
  baseUrl: 'https://api.currencyapi.com/v3',
  apiKey: process.env.CURRENCYAPI_KEY
};

/** Get global markdown percentage */
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

/** Apply markdown to a map of prices */
function applyMarkdownToPrices(priceMap, markdownPercentage) {
  if (!markdownPercentage || markdownPercentage <= 0) return priceMap;
  const multiplier = (100 - markdownPercentage) / 100;
  const markedDown = new Map();
  for (const [token, price] of priceMap.entries()) {
    const info = SUPPORTED_TOKENS[token];
    if (info && (info.isStablecoin || info.isNairaPegged)) {
      markedDown.set(token, price);
    } else {
      markedDown.set(token, price * multiplier);
    }
  }
  logger.info(`Applied ${markdownPercentage}% markdown`, { discountMultiplier: multiplier });
  return markedDown;
}

/** Handle NGNZ pricing */
function handleNGNZPricing(tokens) {
  const prices = {};
  if (tokens.includes('NGNZ')) {
    const rate = 1 / 1554.42;
    prices['NGNZ'] = rate;
  }
  return prices;
}

/** Check if cache is still valid */
function isCacheValid(tokens) {
  if (!priceCache.lastUpdated) return false;
  if (Date.now() - priceCache.lastUpdated > CONFIG.CACHE_TTL) return false;
  return tokens.every(t => priceCache.data.has(t));
}

/** Retry helper */
async function withRetry(fn, maxRetries = CONFIG.MAX_RETRIES, delay = CONFIG.RETRY_DELAY) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.response?.status === 429 && i < maxRetries) {
        await new Promise(r => setTimeout(r, CONFIG.RATE_LIMIT_DELAY));
      } else if (i < maxRetries) {
        await new Promise(r => setTimeout(r, delay * Math.pow(2, i)));
      } else {
        break;
      }
    }
  }
  throw lastErr;
}

/** Fetch from CurrencyAPI */
async function fetchCurrencyApiPrices(tokens) {
  logger.info('Fetching prices from CurrencyAPI', { tokens });
  const supported = tokens.filter(t => SUPPORTED_TOKENS[t]?.supportedByCurrencyAPI);
  const prices = new Map();
  // stablecoins
  ['USDT','USDC'].forEach(t => tokens.includes(t) && prices.set(t, 1.0));
  // NGNZ
  Object.entries(handleNGNZPricing(tokens)).forEach(([t,p]) => prices.set(t,p));
  if (supported.length === 0) return prices;
  const params = { base_currency: 'USD', currencies: supported.join(',') };
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'Portfolio-Service/1.0',
    ...(API_CONFIG.hasValidApiKey ? { apikey: API_CONFIG.apiKey } : {})
  };
  const res = await axios.get(`${API_CONFIG.baseUrl}/latest`, { params, timeout: CONFIG.REQUEST_TIMEOUT, headers });
  const data = res.data.data;
  for (const t of supported) {
    const v = data[t]?.value;
    if (v > 0) prices.set(t, 1 / v);
  }
  logger.info('CurrencyAPI fetch complete', { count: prices.size });
  return prices;
}

/** Fallback prices */
async function getFallbackPrices(tokens) {
  const fallbacks = {
    BTC:65000, ETH:3200, SOL:200,
    USDT:1, USDC:1, BNB:580,
    MATIC:0.85, AVAX:35, NGNZ:1/1554.42
  };
  const map = new Map();
  tokens.forEach(t => map.set(t, fallbacks[t]||0));
  return map;
}

/** Get prices with cache + markdown */
async function getPricesWithCache(tokenSymbols) {
  if (!Array.isArray(tokenSymbols) || tokenSymbols.length === 0) return {};
  const tokens = [...new Set(tokenSymbols.map(t => t.toUpperCase()).filter(t => SUPPORTED_TOKENS[t]))];
  if (tokens.length === 0) return {};

  if (isCacheValid(tokens)) {
    return Object.fromEntries(tokens.map(t => [t, priceCache.data.get(t)]));
  }
  if (priceCache.isUpdating) {
    await priceCache.updatePromise;
    return Object.fromEntries(tokens.map(t => [t, priceCache.data.get(t) || 0]));
  }

  priceCache.isUpdating = true;
  priceCache.updatePromise = (async () => {
    try {
      let priceMap;
      try {
        priceMap = await withRetry(() => fetchCurrencyApiPrices(tokens));
      } catch {
        priceMap = await getFallbackPrices(tokens);
      }
      const md = await getGlobalMarkdownPercentage();
      if (md.hasMarkdown) priceMap = applyMarkdownToPrices(priceMap, md.percentage);
      priceCache.data = priceMap;
      priceCache.lastUpdated = Date.now();
      return priceMap;
    } catch {
      if (priceCache.data.size > 0) return priceCache.data;
      const fallback = await getFallbackPrices(tokens);
      priceCache.data = fallback;
      priceCache.lastUpdated = Date.now();
      return fallback;
    } finally {
      priceCache.isUpdating = false;
      priceCache.updatePromise = null;
    }
  })();

  const result = await priceCache.updatePromise;
  return Object.fromEntries(tokens.map(t => [t, result.get(t) || 0]));
}

/** Update one currency balance (not used for swaps) */
async function updateUserBalance(userId, currency, amount, session=null) {
  if (!userId || !currency || typeof amount !== 'number') {
    throw new Error('Invalid parameters for balance update');
  }
  const cu = currency.toUpperCase();
  if (!SUPPORTED_TOKENS[cu]) throw new Error(`Unsupported currency: ${cu}`);
  const prices = await getPricesWithCache([cu]);
  const usdAmt = (prices[cu]||0) * amount;
  const lower = cu.toLowerCase();
  const inc = { [`${lower}Balance`]: amount, [`${lower}BalanceUSD`]: usdAmt };
  await User.findByIdAndUpdate(userId, { $inc: inc, $set: { lastBalanceUpdate: new Date() } }, { new: true, runValidators: true, session });
  const u = await User.findById(userId);
  const total = ['btc','eth','sol','usdt','usdc','bnb','matic','avax','ngnz']
    .reduce((sum, tok) => sum + (u[`${tok}BalanceUSD`]||0), 0);
  await User.findByIdAndUpdate(userId, { $set: { totalPortfolioBalance: parseFloat(total.toFixed(2)), portfolioLastUpdated: new Date() } }, { session });
  return u;
}

/**
 * Calculate user balances from transactions (treat SWAP_IN/OUT properly)
 */
async function getUserPortfolioBalance(userId, asOfDate=null) {
  if (!userId) throw new Error('User ID is required');

  const query = { userId, status: { $in: ['CONFIRMED','SUCCESSFUL'] } };
  if (asOfDate) {
    const d = new Date(asOfDate);
    if (isNaN(d)) throw new Error('Invalid asOfDate');
    query.createdAt = { $lte: d };
  }

  const txs = await Transaction.find(query).lean();
  logger.info(`Found ${txs.length} transactions for ${userId}`);

  const balances = new Map();
  for (const tx of txs) {
    if (!tx.currency || typeof tx.amount !== 'number' || !tx.type) continue;
    const tok = tx.currency.toUpperCase();
    if (!SUPPORTED_TOKENS[tok]) continue;
    const curr = balances.get(tok) || 0;
    if (tx.type === 'DEPOSIT' || tx.type === 'SWAP_IN') {
      balances.set(tok, curr + tx.amount);
    } else if (tx.type === 'WITHDRAWAL' || tx.type === 'SWAP_OUT') {
      balances.set(tok, curr - tx.amount);
    }
  }

  // Filter zero balances
  const nonZero = Array.from(balances.entries()).filter(([,b]) => Math.abs(b) > 1e-8);
  if (nonZero.length === 0) {
    return { totalPortfolioUSD: 0, tokens: [], lastUpdated: priceCache.lastUpdated ? new Date(priceCache.lastUpdated).toISOString() : null, asOfDate: asOfDate||null };
  }

  const tokens = nonZero.map(([t]) => t);
  const prices = await getPricesWithCache(tokens);
  let total = 0;
  const portfolio = nonZero.map(([t,b]) => {
    const price = prices[t]||0;
    const val = b * price;
    total += val;
    return { token: t, balance: parseFloat(b.toFixed(8)), priceInUSD: parseFloat(price.toFixed(8)), valueInUSD: parseFloat(val.toFixed(2)), isNairaPegged: t==='NGNZ' };
  });

  portfolio.sort((a,b) => b.valueInUSD - a.valueInUSD);

  return {
    totalPortfolioUSD: parseFloat(total.toFixed(2)),
    tokens: portfolio,
    lastUpdated: priceCache.lastUpdated ? new Date(priceCache.lastUpdated).toISOString() : null,
    asOfDate: asOfDate || null
  };
}

/** Persist calculated portfolio into User document */
async function updateUserPortfolioBalance(userId, asOfDate=null) {
  if (!userId) throw new Error('User ID is required');
  const pf = await getUserPortfolioBalance(userId, asOfDate);
  const user = await User.findById(userId);
  if (!user) throw new Error(`User not found: ${userId}`);

  // reset all balances
  const reset = {
    solBalance:0, solBalanceUSD:0,
    btcBalance:0, btcBalanceUSD:0,
    usdtBalance:0, usdtBalanceUSD:0,
    usdcBalance:0, usdcBalanceUSD:0,
    ethBalance:0, ethBalanceUSD:0,
    bnbBalance:0, bnbBalanceUSD:0,
    maticBalance:0, maticBalanceUSD:0,
    avaxBalance:0, avaxBalanceUSD:0,
    ngnzBalance:0, ngnzBalanceUSD:0
  };

  const fields = {
    totalPortfolioBalance: pf.totalPortfolioUSD,
    portfolioLastUpdated: new Date(),
    ...reset
  };

  // fill in non-zero tokens
  pf.tokens.forEach(({ token, balance, valueInUSD }) => {
    const lower = token.toLowerCase();
    fields[`${lower}Balance`]    = balance;
    fields[`${lower}BalanceUSD`] = valueInUSD;
  });

  const updated = await User.findByIdAndUpdate(userId, fields, { new: true, runValidators: true });
  logger.info(`Updated portfolio for ${userId}`, { totalUSD: pf.totalPortfolioUSD });
  return updated;
}

/** Reserve and release (unchanged) */
async function reserveUserBalance(userId, currency, amount) {
  if (!userId||!currency||typeof amount!=='number'||amount<=0) throw new Error('Invalid params');
  const cu = currency.toUpperCase();
  if (!SUPPORTED_TOKENS[cu]) throw new Error(`Unsupported currency: ${cu}`);
  const key = `${cu.toLowerCase()}PendingBalance`;
  const user = await User.findByIdAndUpdate(userId, { $inc: { [key]: amount }, $set: { lastBalanceUpdate: new Date() } }, { new: true, runValidators: true });
  if (!user) throw new Error(`User not found: ${userId}`);
  logger.info(`Reserved ${amount} ${cu} for ${userId}`);
  return user;
}

async function releaseReservedBalance(userId, currency, amount) {
  if (!userId||!currency||typeof amount!=='number'||amount<=0) throw new Error('Invalid params');
  const cu = currency.toUpperCase();
  if (!SUPPORTED_TOKENS[cu]) throw new Error(`Unsupported currency: ${cu}`);
  const key = `${cu.toLowerCase()}PendingBalance`;
  const user = await User.findByIdAndUpdate(userId, { $inc: { [key]: -amount }, $set: { lastBalanceUpdate: new Date() } }, { new: true, runValidators: true });
  if (!user) throw new Error(`User not found: ${userId}`);
  logger.info(`Released ${amount} ${cu} for ${userId}`);
  return user;
}

/** Utilities */
function isTokenSupported(token) {
  return SUPPORTED_TOKENS.hasOwnProperty(token.toUpperCase());
}
function clearPriceCache() {
  priceCache.data.clear();
  priceCache.lastUpdated = null;
  priceCache.isUpdating = false;
  priceCache.updatePromise = null;
  logger.info('Price cache cleared');
}
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
async function forceRefreshPrices(tokens=[]) {
  clearPriceCache();
  const toFetch = tokens.length ? tokens : Object.keys(SUPPORTED_TOKENS);
  return await getPricesWithCache(toFetch);
}
async function getOriginalPricesWithCache(tokenSymbols) {
  if (!Array.isArray(tokenSymbols)||tokenSymbols.length===0) return {};
  const tokens = [...new Set(tokenSymbols.map(t=>t.toUpperCase()).filter(t=>SUPPORTED_TOKENS[t]))];
  if (!tokens.length) return {};
  try {
    let pm = await withRetry(() => fetchCurrencyApiPrices(tokens));
    return Object.fromEntries(tokens.map(t=>[t,pm.get(t)||0]));
  } catch {
    const fb = await getFallbackPrices(tokens);
    return Object.fromEntries(tokens.map(t=>[t,fb.get(t)||0]));
  }
}

module.exports = {
  getPricesWithCache,
  getOriginalPricesWithCache,
  getUserPortfolioBalance,
  updateUserPortfolioBalance,
  updateUserBalance,
  reserveUserBalance,
  releaseReservedBalance,
  getGlobalMarkdownPercentage,
  applyMarkdownToPrices,
  clearPriceCache,
  getCacheStats,
  forceRefreshPrices,
  isCacheValid,
  isTokenSupported,
  withRetry,
  SUPPORTED_TOKENS,
  handleNGNZPricing,
  CONFIG,
  CURRENCY_API_CONFIG: API_CONFIG,
  priceCache
};
