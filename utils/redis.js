// utils/redis.js
const Redis = require('ioredis');
const logger = require('./logger');

let redisClient = null;

/**
 * Initialize Redis client with retry logic
 */
function createRedisClient() {
  if (redisClient) {
    return redisClient;
  }

  const redisConfig = {
    host: '127.0.0.1',
    port: 6379,
    password: process.env.REDIS_PASSWORD,
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      logger.warn(`Redis connection attempt ${times}, retrying in ${delay}ms`);
      return delay;
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    showFriendlyErrorStack: process.env.NODE_ENV !== 'production'
  };

  redisClient = new Redis(redisConfig);

  redisClient.on('connect', () => {
    logger.info('✅ Redis client connected');
  });

  redisClient.on('ready', () => {
    logger.info('✅ Redis client ready for commands');
  });

  redisClient.on('error', (err) => {
    logger.error('❌ Redis client error:', err);
  });

  redisClient.on('close', () => {
    logger.warn('⚠️  Redis connection closed');
  });

  redisClient.on('reconnecting', () => {
    logger.info('🔄 Redis reconnecting...');
  });

  return redisClient;
}

/**
 * Get Redis client instance
 */
function getRedisClient() {
  if (!redisClient) {
    return createRedisClient();
  }
  return redisClient;
}

/**
 * Gracefully close Redis connection
 */
async function closeRedisClient() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info('Redis client disconnected');
  }
}

/**
 * Check if Redis is connected
 */
async function isRedisConnected() {
  try {
    const client = getRedisClient();
    const result = await client.ping();
    return result === 'PONG';
  } catch (error) {
    logger.error('Redis health check failed:', error);
    return false;
  }
}

module.exports = {
  getRedisClient,
  closeRedisClient,
  isRedisConnected
};
