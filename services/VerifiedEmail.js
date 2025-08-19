const User = require('../models/user'); // Adjust path as needed

class EmailVerificationService {
  /**
   * Check if a user's email is verified by user ID
   * @param {string} userId - The user's MongoDB ObjectId
   * @returns {Promise<boolean>} - True if email is verified, false otherwise
   * @throws {Error} - If user is not found
   */
  static async isEmailVerifiedById(userId) {
    try {
      const user = await User.findById(userId).select('emailVerified');
      
      if (!user) {
        throw new Error('User not found');
      }
      
      return user.emailVerified || false;
    } catch (error) {
      if (error.message === 'User not found') {
        throw error;
      }
      throw new Error(`Failed to check email verification status: ${error.message}`);
    }
  }

  /**
   * Check if a user's email is verified by email address
   * @param {string} email - The user's email address
   * @returns {Promise<boolean>} - True if email is verified, false otherwise
   * @throws {Error} - If user is not found
   */
  static async isEmailVerifiedByEmail(email) {
    try {
      const user = await User.findOne({ email }).select('emailVerified');
      
      if (!user) {
        throw new Error('User not found');
      }
      
      return user.emailVerified || false;
    } catch (error) {
      if (error.message === 'User not found') {
        throw error;
      }
      throw new Error(`Failed to check email verification status: ${error.message}`);
    }
  }

  /**
   * Check if a user object has verified email
   * @param {Object} userObject - The user object/document
   * @returns {boolean} - True if email is verified, false otherwise
   */
  static isEmailVerifiedFromObject(userObject) {
    if (!userObject) {
      throw new Error('User object is required');
    }
    
    return userObject.emailVerified || false;
  }

  /**
   * Get detailed email verification status
   * @param {string} userId - The user's MongoDB ObjectId
   * @returns {Promise<Object>} - Object containing verification status and user info
   */
  static async getEmailVerificationStatus(userId) {
    try {
      const user = await User.findById(userId).select('email emailVerified createdAt');
      
      if (!user) {
        throw new Error('User not found');
      }
      
      return {
        userId: user._id,
        email: user.email,
        isVerified: user.emailVerified || false,
        accountCreated: user.createdAt
      };
    } catch (error) {
      if (error.message === 'User not found') {
        throw error;
      }
      throw new Error(`Failed to get email verification status: ${error.message}`);
    }
  }

  /**
   * Check email verification and throw error if not verified
   * @param {string} userId - The user's MongoDB ObjectId
   * @throws {Error} - If email is not verified or user not found
   */
  static async requireEmailVerified(userId) {
    const isVerified = await this.isEmailVerifiedById(userId);
    
    if (!isVerified) {
      throw new Error('Email verification required');
    }
    
    return true;
  }

  /**
   * Bulk check email verification status for multiple users
   * @param {string[]} userIds - Array of user MongoDB ObjectIds
   * @returns {Promise<Object[]>} - Array of objects with userId and verification status
   */
  static async bulkCheckEmailVerification(userIds) {
    try {
      const users = await User.find({ 
        _id: { $in: userIds } 
      }).select('_id emailVerified');
      
      return userIds.map(userId => {
        const user = users.find(u => u._id.toString() === userId.toString());
        return {
          userId,
          isVerified: user ? (user.emailVerified || false) : null,
          userExists: !!user
        };
      });
    } catch (error) {
      throw new Error(`Failed to bulk check email verification: ${error.message}`);
    }
  }
}

module.exports = EmailVerificationService;