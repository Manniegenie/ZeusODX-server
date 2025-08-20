const axios = require('axios');
const PriceChange = require('../models/pricechange');
const logger = require('../utils/logger');

// ---- Config ----
const CONFIG = {
  REQUEST_TIMEOUT: 15000,
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
  RATE_LIMIT_DELAY: 30000, // if remote 429/418
  JOB_LOCK_TTL: 10 * 60 * 1000,
  MIN_REQUEST_INTERVAL_MS: 3000, // 1 req / 3s
};

// Prefer mirror first to avoid geo 451
const BINANCE_HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
];

// ---- In-memory lock (single instance) ----
let jobLock = { isLocked: false, lockTime: null, lockId: null };

function isJobLocked() {
  if (!jobLock.isLocked) return false;
  const now = Date.now();
  if (jobLock.lockTime && (now - jobLock.lockTime) > CONFIG.JOB_LOCK_TTL) {
    logger.warn('Job lock expired, releasing', { lockAge: now - jobLock.lockTime, lockId: jobLock.lockId });
    releaseLock();
    return false;
  }
  return true;
}

function acquireLock() {
  if (isJobLocked()) return false;
  const lockId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  jobLock = { isLocked: true, lockTime: Date.now(), lockId };
  logger.info('Job lock acquired', { lockId });
  return lockId;
}

function releaseLock(lockId = null) {
  if (lockId && jobLock.lockId !== lockId) {
    logger.warn('Attempted to release lock with wrong ID', { providedId: lockId, currentId: jobLock.lockId });
    return false;
  }
  const releasedId = jobLock.lockId;
  jobLock = { isLocked: false, lockTime: null, lockId: null };
  logger.info('Job lock released', { lockId: releasedId });
  return true;
}

// ---- Supported tokens ----
const SUPPORTED_TOKENS = {
  BTC: { binanceSymbol: 'BTCUSDT', isStablecoin: false },
  ETH: { binanceSymbol: 'ETHUSDT', isStablecoin: false },
  SOL: { binanceSymbol: 'SOLUSDT', isStablecoin: false },
  USDT: { binanceSymbol: null,       isStablecoin: true  }, // treat as 1.0
  USDC: { binanceSymbol: 'USDCUSDT', isStablecoin: true  },
  BNB: { binanceSymbol: 'BNBUSDT',   isStablecoin: false },
  MATIC:{ binanceSymbol: 'MATICUSDT',isStablecoin: false },
  AVAX: { binanceSymbol: 'AVAXUSDT', isStablecoin: false },
};

// ---- Global rate gate ----
let lastRequestAt = 0;
async function rateLimitGate() {
  const now = Date.now();
  const since = now - lastRequestAt;
  const waitMs = Math.max(0, CONFIG.MIN_REQUEST_INTERVAL_MS - since);
  if (waitMs > 0) {
    logger.debug(`Rate limiting: sleep ${waitMs}ms`);
    await new Promise(res => setTimeout(res, waitMs));
  }
  lastRequestAt = Date.now();
}

// ---- Retry/backoff helper ----
async function withRetry(fn, maxRetries = CONFIG.MAX_RETRIES, delay = CONFIG.RETRY_DELAY) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = error.response?.status;

      if (status === 429 || status === 418) {
        if (attempt === maxRetries) break;
        logger.warn(`Remote rate limited (HTTP ${status}), waiting ${CONFIG.RATE_LIMIT_DELAY}ms before retry ${attempt + 1}`);
        await new Promise(r => setTimeout(r, CONFIG.RATE_LIMIT_DELAY));
        continue;
      }

      if (attempt === maxRetries) break;
      const waitTime = delay * Math.pow(2, attempt);
      logger.warn(`Attempt ${attempt + 1} failed, retrying in ${waitTime}ms`, { error: error.message, status });
      await new Promise(r => setTimeout(r, waitTime));
    }
  }
  throw lastError;
}

// ---- Fetch from Binance with host failover ----
async function fetchBinancePrices() {
  logger.info('Starting Binance API price fetch');

  await rateLimitGate();

  let lastErr;
  for (const base of BINANCE_HOSTS) {
    const url = `${base}/api/v3/ticker/price`;
    try {
      const response = await axios.get(url, {
        timeout: CONFIG.REQUEST_TIMEOUT,
        headers: { 'Accept': 'application/json', 'User-Agent': 'CryptoPriceJob/1.0' }
      });

      if (!Array.isArray(response.data)) throw new Error('Invalid response format from Binance API');

      const usedWeight = response.headers?.['x-mbx-used-weight-1m'];
      if (usedWeight) logger.debug('Binance used-weight-1m', { usedWeight, host: base });

      const bySymbol = new Map(response.data.map(t => [t.symbol, t.price]));
      const prices = {};

      for (const [token, info] of Object.entries(SUPPORTED_TOKENS)) {
        if (token === 'USDT') { prices[token] = 1.0; continue; }
        const raw = bySymbol.get(info.binanceSymbol);
        if (!raw) { logger.warn(`No price for ${token} (${info.binanceSymbol}) on ${base}`); continue; }
        const p = Number(raw);
        if (!Number.isFinite(p) || p <= 0) { logger.warn(`Invalid price for ${token}`, { raw }); continue; }
        prices[token] = p;
      }

      logger.info(`Fetched ${Object.keys(prices).length} prices from ${base}`);
      // annotate originating source (binance vs binance_vision)
      const source = base.includes('binance.vision') ? 'binance_vision' : 'binance';
      return { prices, source };
    } catch (e) {
      lastErr = e;
      logger.warn('Binance host failed, trying next', {
        hostTried: base,
        status: e.response?.status,
        msg: e.message
      });
      // 451 is geo/legal block; just try next immediately
      if (e.response?.status !== 451) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }
  throw lastErr || new Error('All Binance hosts failed');
}

// ---- Main job ----
async function updateCryptoPrices() {
  if (isJobLocked()) {
    logger.warn('Crypto price update job already running, skipping', {
      currentLockId: jobLock.lockId,
      lockAge: Date.now() - jobLock.lockTime
    });
    return { skipped: true, reason: 'Job already running' };
  }

  const lockId = acquireLock();
  if (!lockId) {
    logger.error('Failed to acquire job lock');
    return { skipped: true, reason: 'Failed to acquire lock' };
  }

  const startTime = new Date();
  logger.info('Starting crypto price update job', { timestamp: startTime.toISOString(), lockId });

  try {
    let fetched;
    try {
      fetched = await withRetry(() => fetchBinancePrices());
    } catch (error) {
      logger.error('Failed to fetch prices from Binance, job aborted', { error: error.message, lockId });
      return { success: false, error: error.message };
    }

    const { prices, source } = fetched;
    if (!prices || Object.keys(prices).length === 0) {
      logger.warn('No prices fetched from Binance, job aborted', { lockId });
      return { success: false, error: 'No prices fetched' };
    }

    logger.info(`Processing ${Object.keys(prices).length} tokens for price storage`, {
      lockId, tokens: Object.keys(prices)
    });

    let storedCount = 0;
    try {
      storedCount = await PriceChange.storePrices(prices, source); // source is 'binance' or 'binance_vision'
      if (storedCount > 0) {
        const endTime = new Date();
        const duration = endTime - startTime;
        logger.info('Crypto price update job completed successfully', {
          pricesStored: storedCount,
          duration: `${duration}ms`,
          timestamp: endTime.toISOString(),
          symbols: Object.keys(prices),
          source
        });
        return { success: true, pricesStored: storedCount, duration, symbols: Object.keys(prices), source };
      } else {
        logger.warn('No prices were stored', { lockId });
        return { success: false, error: 'No prices were stored' };
      }
    } catch (storageError) {
      logger.error('Failed to store prices using PriceChange model', {
        error: storageError.message,
        pricesCount: Object.keys(prices).length,
        lockId
      });
      return { success: false, error: `Storage failed: ${storageError.message}` };
    }
  } catch (error) {
    logger.error('Crypto price update job failed', { error: error.message, stack: error.stack, lockId });
    return { success: false, error: error.message };
  } finally {
    releaseLock(lockId);
  }
}

// ---- Housekeeping & diagnostics ----
async function cleanupOldPrices() {
  try {
    const deletedCount = await PriceChange.cleanupOldPrices(30);
    logger.info(`Cleaned up ${deletedCount} old price entries (older than 30 days)`);
    return deletedCount;
  } catch (error) {
    logger.error('Error cleaning up old prices', { error: error.message });
    throw error;
  }
}

async function getPriceStatistics() {
  try {
    const stats = {};
    const tokens = Object.keys(SUPPORTED_TOKENS);
    for (const token of tokens) {
      const latestPrice = await PriceChange.findOne({ symbol: token.toUpperCase() }).sort({ timestamp: -1 });
      const count = await PriceChange.countDocuments({ symbol: token.toUpperCase() });
      stats[token] = {
        count,
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

// ---- Exports ----
module.exports = {
  updateCryptoPrices,
  cleanupOldPrices,
  fetchBinancePrices, // returns { prices, source }
  // Backward-compatible alias:
  fetchFCSApiPrices: fetchBinancePrices,
  getPriceStatistics,
  // Lock helpers
  isJobLocked,
  acquireLock,
  releaseLock,
  // Debug
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
