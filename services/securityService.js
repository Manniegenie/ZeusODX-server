// services/securityService.js
const { getRedisClient } = require('../utils/redis');
const logger = require('../utils/logger');

/**
 * Security service for rate limiting and brute force protection
 */
class SecurityService {
  constructor() {
    this.redis = getRedisClient();
  }

  /**
   * Track and check 2FA attempts
   * Implements exponential backoff for failed attempts
   *
   * @param {string} userId User ID
   * @returns {Promise<Object>} { allowed: boolean, attemptsRemaining: number, lockUntil: Date|null }
   */
  async check2FAAttempts(userId) {
    const attemptKey = `2fa_attempts:${userId}`;
    const lockKey = `2fa_locked:${userId}`;

    try {
      // Check if user is locked
      const lockUntil = await this.redis.get(lockKey);
      if (lockUntil) {
        const lockTime = parseInt(lockUntil, 10);
        if (Date.now() < lockTime) {
          const minutesRemaining = Math.ceil((lockTime - Date.now()) / 60000);
          return {
            allowed: false,
            attemptsRemaining: 0,
            lockUntil: new Date(lockTime),
            message: `Too many failed 2FA attempts. Account locked for ${minutesRemaining} minute(s).`
          };
        } else {
          // Lock expired, clear it
          await this.redis.del(lockKey);
        }
      }

      // Get current attempt count
      const attempts = await this.redis.get(attemptKey);
      const attemptCount = attempts ? parseInt(attempts, 10) : 0;

      // Allow up to 5 attempts before locking
      const maxAttempts = 5;

      if (attemptCount >= maxAttempts) {
        // Calculate lockout time with exponential backoff
        // 5 attempts: 5 min, 6: 10 min, 7: 20 min, 8: 40 min, etc.
        const lockDuration = Math.pow(2, attemptCount - maxAttempts) * 5 * 60000;
        const lockUntilTime = Date.now() + lockDuration;

        await this.redis.set(lockKey, lockUntilTime.toString(), 'PX', lockDuration);

        logger.warn(`2FA locked for user ${userId} until ${new Date(lockUntilTime).toISOString()}`);

        return {
          allowed: false,
          attemptsRemaining: 0,
          lockUntil: new Date(lockUntilTime),
          message: `Too many failed attempts. Try again in ${Math.ceil(lockDuration / 60000)} minutes.`
        };
      }

      return {
        allowed: true,
        attemptsRemaining: maxAttempts - attemptCount,
        lockUntil: null
      };
    } catch (error) {
      logger.error('Error checking 2FA attempts:', error);
      // Fail open - allow attempt if Redis fails
      return { allowed: true, attemptsRemaining: 5, lockUntil: null };
    }
  }

  /**
   * Record a failed 2FA attempt
   *
   * @param {string} userId User ID
   * @returns {Promise<void>}
   */
  async record2FAFailure(userId) {
    const attemptKey = `2fa_attempts:${userId}`;

    try {
      const attempts = await this.redis.incr(attemptKey);

      // Set expiration on first attempt (15 minute window)
      if (attempts === 1) {
        await this.redis.expire(attemptKey, 900); // 15 minutes
      }

      logger.warn(`Failed 2FA attempt for user ${userId}. Total: ${attempts}`);
    } catch (error) {
      logger.error('Error recording 2FA failure:', error);
    }
  }

  /**
   * Reset 2FA attempts after successful authentication
   *
   * @param {string} userId User ID
   * @returns {Promise<void>}
   */
  async reset2FAAttempts(userId) {
    const attemptKey = `2fa_attempts:${userId}`;

    try {
      await this.redis.del(attemptKey);
      logger.debug(`Reset 2FA attempts for user ${userId}`);
    } catch (error) {
      logger.error('Error resetting 2FA attempts:', error);
    }
  }

  /**
   * Track and check PIN attempts
   * Locks account after 5 failed attempts
   *
   * @param {string} userId User ID
   * @returns {Promise<Object>} { allowed: boolean, attemptsRemaining: number, accountLocked: boolean }
   */
  async checkPINAttempts(userId) {
    const attemptKey = `pin_attempts:${userId}`;
    const lockKey = `pin_locked:${userId}`;

    try {
      // Check if account is locked
      const locked = await this.redis.get(lockKey);
      if (locked) {
        const lockUntil = parseInt(locked, 10);
        if (Date.now() < lockUntil) {
          const hoursRemaining = Math.ceil((lockUntil - Date.now()) / 3600000);
          return {
            allowed: false,
            attemptsRemaining: 0,
            accountLocked: true,
            lockUntil: new Date(lockUntil),
            message: `Account locked due to too many failed PIN attempts. Locked for ${hoursRemaining} hour(s). Contact support to unlock.`
          };
        } else {
          // Lock expired
          await this.redis.del(lockKey);
        }
      }

      // Get current attempt count
      const attempts = await this.redis.get(attemptKey);
      const attemptCount = attempts ? parseInt(attempts, 10) : 0;

      // Allow up to 5 attempts before locking account
      const maxAttempts = 5;

      if (attemptCount >= maxAttempts) {
        // Lock account for 24 hours
        const lockDuration = 24 * 60 * 60 * 1000; // 24 hours
        const lockUntilTime = Date.now() + lockDuration;

        await this.redis.set(lockKey, lockUntilTime.toString(), 'PX', lockDuration);

        logger.error(`Account locked for user ${userId} due to PIN failures until ${new Date(lockUntilTime).toISOString()}`);

        return {
          allowed: false,
          attemptsRemaining: 0,
          accountLocked: true,
          lockUntil: new Date(lockUntilTime),
          message: 'Account locked due to too many failed PIN attempts. Contact support to unlock.'
        };
      }

      return {
        allowed: true,
        attemptsRemaining: maxAttempts - attemptCount,
        accountLocked: false,
        lockUntil: null
      };
    } catch (error) {
      logger.error('Error checking PIN attempts:', error);
      // Fail open
      return { allowed: true, attemptsRemaining: 5, accountLocked: false, lockUntil: null };
    }
  }

  /**
   * Record a failed PIN attempt
   *
   * @param {string} userId User ID
   * @returns {Promise<number>} Number of attempts
   */
  async recordPINFailure(userId) {
    const attemptKey = `pin_attempts:${userId}`;

    try {
      const attempts = await this.redis.incr(attemptKey);

      // Set expiration on first attempt (1 hour window)
      if (attempts === 1) {
        await this.redis.expire(attemptKey, 3600); // 1 hour
      }

      logger.warn(`Failed PIN attempt for user ${userId}. Total: ${attempts}/5`);
      return attempts;
    } catch (error) {
      logger.error('Error recording PIN failure:', error);
      return 0;
    }
  }

  /**
   * Reset PIN attempts after successful authentication
   *
   * @param {string} userId User ID
   * @returns {Promise<void>}
   */
  async resetPINAttempts(userId) {
    const attemptKey = `pin_attempts:${userId}`;

    try {
      await this.redis.del(attemptKey);
      logger.debug(`Reset PIN attempts for user ${userId}`);
    } catch (error) {
      logger.error('Error resetting PIN attempts:', error);
    }
  }

  /**
   * Check if a 2FA code has already been used (without marking it)
   *
   * @param {string} userId User ID
   * @param {string} code 2FA code
   * @returns {Promise<boolean>} True if code was already used, false if not
   */
  async check2FACodeReplay(userId, code) {
    const replayKey = `2fa_used:${userId}:${code}`;

    try {
      const alreadyUsed = await this.redis.get(replayKey);

      if (alreadyUsed) {
        logger.warn(`2FA code replay detected for user ${userId}`);
        return true;
      }

      return false;
    } catch (error) {
      logger.error('Error checking 2FA replay:', error);
      return false;
    }
  }

  /**
   * Mark a 2FA code as used after successful validation
   * Should only be called AFTER the code has been verified as valid
   *
   * @param {string} userId User ID
   * @param {string} code 2FA code
   */
  async mark2FACodeUsed(userId, code) {
    const replayKey = `2fa_used:${userId}:${code}`;

    try {
      await this.redis.setex(replayKey, 90, '1');
    } catch (error) {
      logger.error('Error marking 2FA code as used:', error);
    }
  }

  /**
   * Check if account is locked (PIN or other reasons)
   *
   * @param {string} userId User ID
   * @returns {Promise<boolean>} True if account is locked
   */
  async isAccountLocked(userId) {
    const lockKey = `pin_locked:${userId}`;

    try {
      const locked = await this.redis.get(lockKey);
      if (locked) {
        const lockUntil = parseInt(locked, 10);
        return Date.now() < lockUntil;
      }
      return false;
    } catch (error) {
      logger.error('Error checking account lock:', error);
      return false;
    }
  }
}

// Export singleton instance
module.exports = new SecurityService();
