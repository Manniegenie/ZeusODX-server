// utils/redisLock.js
const { getRedisClient } = require('./redis');
const logger = require('./logger');

/**
 * Distributed lock implementation using Redis
 * Prevents race conditions in withdrawal operations
 */
class RedisLock {
  constructor(lockKey, ttl = 10000) {
    this.lockKey = `lock:${lockKey}`;
    this.ttl = ttl; // Lock timeout in milliseconds
    this.lockValue = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.redis = getRedisClient();
    this.acquired = false;
  }

  /**
   * Acquire the lock
   * @returns {Promise<boolean>} True if lock acquired, false otherwise
   */
  async acquire() {
    try {
      // SET NX (set if not exists) with expiration
      const result = await this.redis.set(
        this.lockKey,
        this.lockValue,
        'PX', // milliseconds
        this.ttl,
        'NX' // only set if not exists
      );

      this.acquired = result === 'OK';

      if (this.acquired) {
        logger.debug(`Lock acquired: ${this.lockKey}`);
      } else {
        logger.debug(`Lock already held: ${this.lockKey}`);
      }

      return this.acquired;
    } catch (error) {
      logger.error(`Error acquiring lock ${this.lockKey}:`, error);
      return false;
    }
  }

  /**
   * Wait to acquire the lock with retry
   * @param {number} maxWaitTime Maximum time to wait in milliseconds
   * @param {number} retryInterval Retry interval in milliseconds
   * @returns {Promise<boolean>} True if lock acquired, false if timeout
   */
  async acquireWithRetry(maxWaitTime = 5000, retryInterval = 50) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const acquired = await this.acquire();
      if (acquired) {
        return true;
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, retryInterval));
    }

    logger.warn(`Failed to acquire lock ${this.lockKey} after ${maxWaitTime}ms`);
    return false;
  }

  /**
   * Release the lock
   * Only releases if this instance holds the lock (checks lock value)
   * @returns {Promise<boolean>} True if released, false otherwise
   */
  async release() {
    if (!this.acquired) {
      return false;
    }

    try {
      // Lua script to atomically check and delete
      // Only delete if the value matches (we still own the lock)
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;

      const result = await this.redis.eval(luaScript, 1, this.lockKey, this.lockValue);

      if (result === 1) {
        logger.debug(`Lock released: ${this.lockKey}`);
        this.acquired = false;
        return true;
      } else {
        logger.warn(`Lock ${this.lockKey} already expired or held by another process`);
        this.acquired = false;
        return false;
      }
    } catch (error) {
      logger.error(`Error releasing lock ${this.lockKey}:`, error);
      return false;
    }
  }

  /**
   * Extend the lock TTL
   * @param {number} additionalTime Additional time in milliseconds
   * @returns {Promise<boolean>} True if extended, false otherwise
   */
  async extend(additionalTime = 5000) {
    if (!this.acquired) {
      return false;
    }

    try {
      // Lua script to check ownership and extend
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("pexpire", KEYS[1], ARGV[2])
        else
          return 0
        end
      `;

      const result = await this.redis.eval(
        luaScript,
        1,
        this.lockKey,
        this.lockValue,
        additionalTime
      );

      if (result === 1) {
        logger.debug(`Lock extended: ${this.lockKey} by ${additionalTime}ms`);
        return true;
      } else {
        logger.warn(`Cannot extend lock ${this.lockKey} - not owner`);
        return false;
      }
    } catch (error) {
      logger.error(`Error extending lock ${this.lockKey}:`, error);
      return false;
    }
  }
}

/**
 * Helper function to execute code with a distributed lock
 * Automatically acquires and releases lock
 *
 * @param {string} lockKey Lock identifier
 * @param {Function} callback Function to execute while holding lock
 * @param {Object} options Lock options
 * @returns {Promise<any>} Result of callback function
 */
async function withLock(lockKey, callback, options = {}) {
  const {
    ttl = 10000,
    maxWaitTime = 5000,
    retryInterval = 50
  } = options;

  const lock = new RedisLock(lockKey, ttl);

  try {
    // Try to acquire lock with retry
    const acquired = await lock.acquireWithRetry(maxWaitTime, retryInterval);

    if (!acquired) {
      throw new Error(`Failed to acquire lock: ${lockKey}`);
    }

    // Execute callback while holding lock
    const result = await callback();

    return result;
  } finally {
    // Always release lock
    await lock.release();
  }
}

module.exports = {
  RedisLock,
  withLock
};
