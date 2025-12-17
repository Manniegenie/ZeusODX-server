const User = require('../models/user');
const logger = require('../utils/logger');

/**
 * BVN Check Service
 * Validates if a user's BVN is verified before allowing certain operations
 */
class BVNCheckService {
  /**
   * Check if user's BVN is verified
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Check result with success, message, and data
   */
  async checkBVNVerified(userId) {
    try {
      if (!userId) {
        return {
          success: false,
          message: 'User ID is required',
          code: 'MISSING_USER_ID',
          data: { userId: null }
        };
      }

      const user = await User.findById(userId).select('bvn bvnVerified firstname lastname email phonenumber');

      if (!user) {
        logger.warn('BVN check: User not found', { userId });
        return {
          success: false,
          message: 'User not found',
          code: 'USER_NOT_FOUND',
          data: { userId }
        };
      }

      // Check if BVN is verified
      if (!user.bvnVerified) {
        logger.info('BVN check failed: BVN not verified', {
          userId,
          hasBvn: !!user.bvn,
          bvnVerified: user.bvnVerified,
          userEmail: user.email
        });

        return {
          success: false,
          message: 'BVN verification is required to complete this transaction. Please verify your BVN first.',
          code: 'BVN_NOT_VERIFIED',
          data: {
            userId,
            hasBvn: !!user.bvn,
            bvnVerified: user.bvnVerified,
            requiresVerification: true
          }
        };
      }

      logger.info('BVN check passed: BVN is verified', {
        userId,
        hasBvn: !!user.bvn,
        bvnVerified: user.bvnVerified
      });

      return {
        success: true,
        message: 'BVN is verified',
        code: 'BVN_VERIFIED',
        data: {
          userId,
          hasBvn: !!user.bvn,
          bvnVerified: user.bvnVerified
        }
      };

    } catch (error) {
      logger.error('BVN check service error', {
        userId,
        error: error.message,
        stack: error.stack
      });

      return {
        success: false,
        message: 'Failed to verify BVN status',
        code: 'BVN_CHECK_ERROR',
        data: {
          userId,
          error: error.message
        }
      };
    }
  }

  /**
   * Check if user's BVN is verified (alias for consistency)
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Check result
   */
  async validateBVN(userId) {
    return this.checkBVNVerified(userId);
  }
}

// Export singleton instance
const bvnCheckService = new BVNCheckService();
module.exports = { bvnCheckService, BVNCheckService };
