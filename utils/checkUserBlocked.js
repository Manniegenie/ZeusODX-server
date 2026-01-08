const User = require('../models/user');
const logger = require('./logger');

/**
 * Check if a user is blocked from performing transactions
 * @param {string} userId - The user's ID or email
 * @param {string} idType - 'id' or 'email'
 * @returns {Promise<{isBlocked: boolean, reason?: string}>}
 */
async function checkUserBlocked(userId, idType = 'id') {
  try {
    let user;

    if (idType === 'email') {
      user = await User.findOne({ email: userId }).select('isBlocked blockReason blockedAt');
    } else {
      user = await User.findById(userId).select('isBlocked blockReason blockedAt');
    }

    if (!user) {
      logger.warn(`User not found for block check: ${userId}`);
      return { isBlocked: false };
    }

    if (user.isBlocked) {
      logger.info(`Blocked user attempted transaction: ${userId}`, {
        reason: user.blockReason,
        blockedAt: user.blockedAt
      });

      return {
        isBlocked: true,
        reason: user.blockReason || 'Your account has been blocked. Please contact support.',
        blockedAt: user.blockedAt
      };
    }

    return { isBlocked: false };
  } catch (error) {
    logger.error('Error checking user block status', {
      error: error.message,
      stack: error.stack,
      userId
    });
    // In case of error, don't block the user (fail open for business continuity)
    return { isBlocked: false };
  }
}

/**
 * Middleware to check if user is blocked
 * Use in routes that require user to not be blocked
 */
function requireNotBlocked(req, res, next) {
  const userId = req.user?.userId || req.user?.id;

  if (!userId) {
    return res.status(401).json({
      success: false,
      error: 'User not authenticated'
    });
  }

  checkUserBlocked(userId, 'id')
    .then(result => {
      if (result.isBlocked) {
        return res.status(403).json({
          success: false,
          error: result.reason || 'Your account is blocked',
          isBlocked: true,
          blockedAt: result.blockedAt
        });
      }
      next();
    })
    .catch(error => {
      logger.error('Error in requireNotBlocked middleware', {
        error: error.message,
        userId
      });
      // Fail open - allow request to proceed
      next();
    });
}

module.exports = {
  checkUserBlocked,
  requireNotBlocked
};
