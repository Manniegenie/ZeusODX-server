// utils/cacheManager.js
// Global cache management for balance-sensitive operations

const logger = require('./logger');

// Global cache registry
const globalCaches = new Map();

/**
 * Register a cache for global management
 * @param {string} name - Cache name
 * @param {Map} cache - Cache instance
 */
function registerCache(name, cache) {
  globalCaches.set(name, cache);
  logger.info(`Registered cache: ${name}`);
}

/**
 * Clear all caches for a specific user
 * @param {string} userId - User ID
 */
function clearUserCaches(userId) {
  let clearedCount = 0;
  
  for (const [cacheName, cache] of globalCaches.entries()) {
    const keysToDelete = [];
    
    // Find all keys related to this user
    for (const [key] of cache.entries()) {
      if (key.includes(userId) || 
          key.includes(`user_${userId}`) || 
          key.includes(`user_balance_${userId}`) ||
          key.includes('price_changes') || 
          key.includes('market_prices')) {
        keysToDelete.push(key);
      }
    }
    
    // Delete found keys
    keysToDelete.forEach(key => {
      cache.delete(key);
      clearedCount++;
    });
    
    if (keysToDelete.length > 0) {
      logger.info(`Cleared ${keysToDelete.length} keys from cache: ${cacheName}`, {
        userId,
        clearedKeys: keysToDelete
      });
    }
  }
  
  logger.info(`Total cache entries cleared for user ${userId}: ${clearedCount}`);
  return clearedCount;
}

/**
 * Clear all caches (use with caution)
 */
function clearAllCaches() {
  let totalCleared = 0;
  
  for (const [cacheName, cache] of globalCaches.entries()) {
    const size = cache.size;
    cache.clear();
    totalCleared += size;
    logger.info(`Cleared entire cache: ${cacheName} (${size} entries)`);
  }
  
  logger.info(`Total cache entries cleared: ${totalCleared}`);
  return totalCleared;
}

/**
 * Get cache statistics
 */
function getCacheStats() {
  const stats = {};
  
  for (const [cacheName, cache] of globalCaches.entries()) {
    stats[cacheName] = {
      size: cache.size,
      keys: Array.from(cache.keys())
    };
  }
  
  return stats;
}

module.exports = {
  registerCache,
  clearUserCaches,
  clearAllCaches,
  getCacheStats
};
