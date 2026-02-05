/**
 * KYC Service - Bramp-style flow for ZeusODX with Youverify.
 * Handles level upgrades, submit/reject for review, and KYC statistics.
 */
const User = require('../models/user');
const logger = require('../utils/logger');

class KYCService {
  /**
   * Upgrade user to KYC Level 2 (after document approved)
   */
  static async upgradeToLevel2(userId, level2Data = {}) {
    try {
      const user = await User.findById(userId);
      if (!user) throw new Error('User not found');
      if (user.kycLevel >= 2) throw new Error('User is already at KYC Level 2 or higher');
      if (user.kyc?.level1?.status !== 'approved' && !user.kyc?.level1?.phoneVerified) {
        throw new Error('Level 1 KYC must be approved before upgrading to Level 2');
      }

      const updateData = {
        kycLevel: 2,
        kycStatus: 'approved',
        'kyc.level2.status': 'approved',
        'kyc.level2.approvedAt': new Date(),
        portfolioLastUpdated: new Date()
      };
      if (level2Data.documentType) updateData['kyc.level2.documentType'] = level2Data.documentType;
      if (level2Data.documentNumber) updateData['kyc.level2.documentNumber'] = level2Data.documentNumber;

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        { $set: updateData },
        { new: true, runValidators: true, select: '-password -passwordpin -transactionpin -securitypin -twoFASecret' }
      );

      logger.info('User upgraded to KYC Level 2', { userId, previousLevel: user.kycLevel });
      return { success: true, message: 'User successfully upgraded to KYC Level 2', user: updatedUser, previousLevel: user.kycLevel, newLevel: 2 };
    } catch (error) {
      throw new Error(`Failed to upgrade user to Level 2: ${error.message}`);
    }
  }

  /**
   * Submit Level 2 KYC for review (sets status to pending)
   */
  static async submitLevel2ForReview(userId, level2Data) {
    try {
      const user = await User.findById(userId);
      if (!user) throw new Error('User not found');
      if (user.kyc?.level1?.status !== 'approved' && !user.kyc?.level1?.phoneVerified) throw new Error('Level 1 KYC must be approved before submitting Level 2');
      if (user.kyc?.level2?.status === 'approved') throw new Error('Level 2 KYC is already approved');
      if (user.kyc?.level2?.status === 'pending') throw new Error('Level 2 KYC is already pending review');

      const updateData = {
        kycStatus: 'pending',
        'kyc.level2.status': 'pending',
        'kyc.level2.submittedAt': new Date(),
        'kyc.level2.documentType': level2Data.documentType,
        'kyc.level2.documentNumber': level2Data.documentNumber,
        'kyc.level2.rejectedAt': null,
        'kyc.level2.rejectionReason': null
      };

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        { $set: updateData },
        { new: true, runValidators: true, select: '-password -passwordpin -transactionpin -securitypin -twoFASecret' }
      );

      return { success: true, message: 'Level 2 KYC submitted for review', user: updatedUser };
    } catch (error) {
      throw new Error(`Failed to submit Level 2 KYC: ${error.message}`);
    }
  }

  /**
   * Reject Level 2 KYC application
   */
  static async rejectLevel2(userId, rejectionReason) {
    try {
      const user = await User.findById(userId);
      if (!user) throw new Error('User not found');
      if (user.kyc?.level2?.status !== 'pending') throw new Error('Can only reject pending Level 2 KYC applications');

      const updateData = {
        kycStatus: 'rejected',
        'kyc.level2.status': 'rejected',
        'kyc.level2.rejectedAt': new Date(),
        'kyc.level2.rejectionReason': rejectionReason
      };

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        { $set: updateData },
        { new: true, runValidators: true, select: '-password -passwordpin -transactionpin -securitypin -twoFASecret' }
      );

      return { success: true, message: 'Level 2 KYC rejected', user: updatedUser, rejectionReason };
    } catch (error) {
      throw new Error(`Failed to reject Level 2 KYC: ${error.message}`);
    }
  }

  /**
   * Get users by KYC level and optional status
   */
  static async getUsersByKYCLevel(level, status = null) {
    try {
      const query = { kycLevel: level };
      if (status) query.kycStatus = status;
      const users = await User.find(query)
        .select('-password -passwordpin -transactionpin -securitypin -twoFASecret -refreshTokens')
        .sort({ updatedAt: -1 });
      return users;
    } catch (error) {
      throw new Error(`Failed to get users by KYC level: ${error.message}`);
    }
  }

  /**
   * Get KYC statistics (Bramp-style)
   */
  static async getKYCStatistics() {
    try {
      const stats = await User.aggregate([
        { $group: { _id: '$kycLevel', count: { $sum: 1 }, statuses: { $push: '$kycStatus' } } },
        {
          $project: {
            level: '$_id',
            count: 1,
            statusBreakdown: {
              $reduce: {
                input: '$statuses',
                initialValue: {},
                in: {
                  $mergeObjects: [
                    '$$value',
                    {
                      $switch: {
                        branches: [
                          { case: { $eq: ['$$this', 'not_verified'] }, then: { not_verified: { $add: [{ $ifNull: ['$$value.not_verified', 0] }, 1] } } },
                          { case: { $eq: ['$$this', 'pending'] }, then: { pending: { $add: [{ $ifNull: ['$$value.pending', 0] }, 1] } } },
                          { case: { $eq: ['$$this', 'approved'] }, then: { approved: { $add: [{ $ifNull: ['$$value.approved', 0] }, 1] } } },
                          { case: { $eq: ['$$this', 'rejected'] }, then: { rejected: { $add: [{ $ifNull: ['$$value.rejected', 0] }, 1] } } },
                          { case: { $eq: ['$$this', 'under_review'] }, then: { under_review: { $add: [{ $ifNull: ['$$value.under_review', 0] }, 1] } } }
                        ],
                        default: {}
                      }
                    }
                  ]
                }
              }
            }
          }
        }
        },
        { $sort: { level: 1 } }
      ]);
      return { success: true, statistics: stats };
    } catch (error) {
      throw new Error(`Failed to get KYC statistics: ${error.message}`);
    }
  }
}

module.exports = KYCService;
