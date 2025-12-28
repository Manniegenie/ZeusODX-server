// middleware/idempotency.middleware.js
const Idempotency = require('../models/Idempotency');
const logger = require('../utils/logger');

const CACHE_TTL_HOURS = 1;

/**
 * Idempotency Middleware using MongoDB
 */
const idempotencyMiddleware = async (req, res, next) => {
  // Only apply to state-changing methods
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }

  const idempotencyKey = req.headers['x-idempotency-key'];
  const userId = req.user?.id; // Assumes authMiddleware has run

  if (!idempotencyKey) {
    return res.status(400).json({
      success: false,
      error: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'X-Idempotency-Key header is required'
    });
  }

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(idempotencyKey)) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_IDEMPOTENCY_KEY',
      message: 'X-Idempotency-Key must be a valid UUID'
    });
  }

  try {
    // 1. Check MongoDB for existing record
    const cached = await Idempotency.findOne({ key: idempotencyKey, userId });

    if (cached) {
      logger.info(`[Idempotency] Replaying cached response for key: ${idempotencyKey}`);
      return res
        .status(cached.status)
        .set('X-Idempotency-Replay', 'true')
        .json(cached.response);
    }

    // 2. Capture the response to save it later
    const originalJson = res.json.bind(res);

    res.json = function (body) {
      // Only cache successful 2xx responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + CACHE_TTL_HOURS);

        // Fire-and-forget save to MongoDB
        Idempotency.create({
          key: idempotencyKey,
          userId,
          response: body,
          status: res.statusCode,
          method: req.method,
          path: req.originalUrl,
          expiresAt
        }).catch(err => logger.error('[Idempotency] Save error:', err));
      }

      return originalJson(body);
    };

    next();
  } catch (error) {
    logger.error('[Idempotency] Middleware error:', error);
    next(); // Fallback: continue without idempotency if DB fails
  }
};

/**
 * Utility: Manually clear a specific key
 */
const clearIdempotencyKey = async (key, userId) => {
  return await Idempotency.deleteOne({ key, userId });
};

/**
 * Utility: Clear all expired (though MongoDB does this via TTL)
 */
const clearIdempotencyCache = async () => {
  return await Idempotency.deleteMany({});
};

/**
 * Utility: Get stats
 */
const getIdempotencyCacheStats = async () => {
  const count = await Idempotency.countDocuments();
  return {
    totalRecords: count,
    storage: 'MongoDB',
    ttlHours: CACHE_TTL_HOURS
  };
};

module.exports = {
  idempotencyMiddleware,
  clearIdempotencyKey,
  clearIdempotencyCache,
  getIdempotencyCacheStats
};