const obiexService = require('../services/createwalletaddress');
const logger = require('../utils/logger');
const { validateObiexConfig } = require('../utils/obiexAuth');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // 1 second
const CONCURRENCY_LIMIT = 3;

const currenciesToCreate = [
  { currency: 'BTC', network: 'BTC' },
  { currency: 'ETH', network: 'ETH' },
  { currency: 'SOL', network: 'SOL' },
  { currency: 'USDT', network: 'ETH' },
  { currency: 'USDT', network: 'TRX' },
  { currency: 'USDT', network: 'BSC' },
  { currency: 'USDC', network: 'ETH' },
  { currency: 'USDC', network: 'BSC' },
];

// Retry wrapper with exponential backoff and jitter
const retryWithBackoff = async (fn, retries = MAX_RETRIES, delay = RETRY_DELAY_MS) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = error.response?.status;
      const isRetryable = !status || [429, 500, 502, 503, 504].includes(status);
      const isLastAttempt = attempt === retries;

      if (!isRetryable || isLastAttempt) throw error;

      logger.warn(`Retry attempt ${attempt} failed: ${error.message}. Retrying...`);

      const backoff = delay * 2 ** (attempt - 1) + Math.random() * 500;
      await new Promise(res => setTimeout(res, backoff));
    }
  }
};

// Simple concurrency limiter semaphore
const semaphore = (limit) => {
  let activeCount = 0;
  const queue = [];

  const next = () => {
    if (queue.length === 0 || activeCount >= limit) return;
    activeCount++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        activeCount--;
        next();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      process.nextTick(next);
    });
};

const limit = semaphore(CONCURRENCY_LIMIT);

const generateWallets = async (email, userId) => {
  validateObiexConfig();
  logger.info(`Starting wallet generation for ${email}`, { userId });

  // Ensure purpose is alphanumeric and uses only hyphens
  const cleanedPurpose = String(userId).replace(/[^a-zA-Z0-9-]/g, '-');
  const walletResults = {};

  const tasks = currenciesToCreate.map(({ currency, network }) => {
    return limit(async () => {
      const key = `${currency}_${network}`;
      const payload = {
        purpose: cleanedPurpose,
        currency,
        network,
      };

      try {
        logger.info(`Creating wallet: ${key}`, { currency, network });
        const response = await retryWithBackoff(() => obiexService.createDepositAddress(payload));
        const address = response?.value || response?.data?.value || null;
        const addressId = response?.id || response?.data?.id || null;
        const referenceId = response?.reference || response?.data?.reference || null; // Capture reference ID

        walletResults[key] = {
          address,
          addressId,
          referenceId,
          network,
          currency,
          status: address ? 'success' : 'no_address',
        };

        logger.info(`Wallet created: ${key}`, { address: address || 'Not returned', addressId, referenceId });
      } catch (err) {
        const errorData = err.response?.data || {};
        logger.warn('Wallet creation failed', {
          key,
          email,
          network,
          error: errorData,
          message: errorData?.message || err.message,
          status: err.response?.status,
        });

        walletResults[key] = {
          address: null,
          addressId: null,
          referenceId: null,
          network,
          currency,
          status: 'failed',
          error: errorData?.message || err.message,
        };
      }

      // Slight delay between wallet creations for rate limiting safety
      await new Promise(res => setTimeout(res, 200));
    });
  });

  await Promise.all(tasks);

  const successCount = Object.values(walletResults).filter(w => w.status === 'success').length;
  const totalCount = currenciesToCreate.length;

  logger.info(`Wallet generation complete: ${successCount}/${totalCount} successful`, {
    userId,
    email,
    successCount,
    totalCount,
  });

  return {
    success: successCount > 0,
    totalRequested: totalCount,
    successfullyCreated: successCount,
    wallets: walletResults,
    summary: {
      successful: Object.keys(walletResults).filter(k => walletResults[k].status === 'success'),
      failed: Object.keys(walletResults).filter(k => walletResults[k].status === 'failed'),
    },
  };
};

module.exports = generateWallets;