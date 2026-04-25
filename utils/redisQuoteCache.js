// utils/redisQuoteCache.js
//
// Drop-in replacement for the in-memory Map used as ngnzQuoteCache.
// Stores quotes in Redis so they survive server restarts and work correctly
// across multiple PM2 processes / load-balanced nodes.
//
// API mirrors the subset of Map used in NGNZSwaps.js:
//   cache.set(key, value)          – store with TTL (30 s default)
//   cache.get(key)                 – retrieve (returns parsed object or undefined)
//   cache.delete(key)              – remove immediately
//
// Falls back silently to an in-memory Map if Redis is unavailable, so the
// existing swap flow is never blocked by a Redis outage.

'use strict';

const { getRedisClient } = require('./redis');
const logger = require('./logger');

const QUOTE_TTL_SECONDS = 30; // matches the existing 30-second quote expiry
const KEY_PREFIX = 'ngnz_quote:';

class RedisQuoteCache {
  constructor() {
    // In-memory fallback — used when Redis is down
    this._fallback = new Map();
  }

  async set(key, value) {
    try {
      const redis = getRedisClient();
      if (redis) {
        await redis.set(
          `${KEY_PREFIX}${key}`,
          JSON.stringify(value),
          'EX',
          QUOTE_TTL_SECONDS
        );
        return;
      }
    } catch (err) {
      logger.warn('RedisQuoteCache.set failed — using in-memory fallback', { key, error: err.message });
    }
    // Fallback: store in-memory with manual TTL cleanup
    this._fallback.set(key, value);
    setTimeout(() => this._fallback.delete(key), QUOTE_TTL_SECONDS * 1000);
  }

  async get(key) {
    try {
      const redis = getRedisClient();
      if (redis) {
        const raw = await redis.get(`${KEY_PREFIX}${key}`);
        if (raw === null) return undefined;
        return JSON.parse(raw);
      }
    } catch (err) {
      logger.warn('RedisQuoteCache.get failed — using in-memory fallback', { key, error: err.message });
    }
    return this._fallback.get(key);
  }

  async delete(key) {
    try {
      const redis = getRedisClient();
      if (redis) {
        await redis.del(`${KEY_PREFIX}${key}`);
        return;
      }
    } catch (err) {
      logger.warn('RedisQuoteCache.delete failed — using in-memory fallback', { key, error: err.message });
    }
    this._fallback.delete(key);
  }
}

module.exports = new RedisQuoteCache();
