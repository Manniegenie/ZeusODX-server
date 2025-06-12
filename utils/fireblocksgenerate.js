const logger = require('../utils/logger');
const fireblocksService = require('../services/fireblockservice');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const CONCURRENCY_LIMIT = 3;

const assetIdsToCreate = [
  'BTC_TEST', // Bitcoin Testnet
  'ETH_TEST3', // Ethereum Goerli
  'SOL_TEST', // Solana Testnet
  'USDT_ERC20_TEST', // USDT on Ethereum Goerli
  'USDT_TRX_TEST', // USDT on Tron Testnet
  'USDT_BSC_TEST', // USDT on Binance Smart Chain Testnet
  'USDC_ERC20_TEST', // USDC on Ethereum Goerli
  'USDC_BSC_TEST', // USDC on Binance Smart Chain Testnet
];

// ... rest of the file unchanged ...

// Retry wrapper
const retryWithBackoff = async (fn, retries = MAX_RETRIES, delay = RETRY_DELAY_MS) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isRetryable = [429, 500, 502, 503, 504].includes(error.response?.status);
      if (!isRetryable || attempt === retries) throw error;

      const backoff = delay * 2 ** (attempt - 1) + Math.random() * 500;
      logger.warn(`Retry ${attempt} failed: ${error.message}. Retrying in ${backoff}ms...`);
      await new Promise(res => setTimeout(res, backoff));
    }
  }
};

// Concurrency limiter
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

// Wallet generation logic
const generateWallets = async (email, userId) => {
  logger.info(`Starting wallet generation for user ${email}`, { userId });

  const results = {};

  const tasks = assetIdsToCreate.map((assetId) =>
    limit(async () => {
      try {
        const response = await retryWithBackoff(() =>
          fireblocksService.generateAddress(assetId)
        );

        results[assetId] = {
          assetId,
          address: response.address,
          status: response.success ? 'success' : 'no_address',
        };

        logger.info(`Generated wallet for ${assetId}: ${response.address}`);
      } catch (err) {
        logger.warn(`Failed to generate wallet for ${assetId}`, {
          assetId,
          userId,
          email,
          error: err.response?.data || err.message,
          status: err.response?.status,
        });

        results[assetId] = {
          assetId,
          address: null,
          status: 'failed',
          error: err.message,
        };
      }

      await new Promise((res) => setTimeout(res, 200));
    })
  );

  await Promise.all(tasks);

  const successCount = Object.values(results).filter(r => r.status === 'success').length;

  logger.info(`Wallet generation complete for ${email}: ${successCount}/${assetIdsToCreate.length} successful`);

  return {
    success: successCount > 0,
    totalRequested: assetIdsToCreate.length,
    successfullyCreated: successCount,
    wallets: results,
    summary: {
      successful: Object.keys(results).filter(key => results[key].status === 'success'),
      failed: Object.keys(results).filter(key => results[key].status === 'failed'),
    },
  };
};

module.exports = generateWallets;
