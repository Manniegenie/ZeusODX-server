const express = require('express');
const router = express.Router();
const AdminUser = require('../models/admin');
const logger = require('../utils/logger');

/**
 * GET /admin/permissions
 * Returns feature access based on admin permissions
 */
router.get('/', async (req, res) => {
  try {
    const adminId = req.admin.id || req.admin._id;
    
    if (!adminId) {
      return res.status(401).json({
        success: false,
        error: 'Admin ID not found in token'
      });
    }

    // Load admin user to get permissions
    const adminUser = await AdminUser.findById(adminId);
    
    if (!adminUser) {
      return res.status(404).json({
        success: false,
        error: 'Admin user not found'
      });
    }

    // Super admins have all permissions
    const isSuperAdmin = adminUser.role === 'super_admin';
    
    // Map permissions to feature access
    const permissions = adminUser.permissions || {};
    
    const featureAccess = {
      dashboard: true, // Everyone can see dashboard
      platformStats: isSuperAdmin || permissions.canAccessReports || false,
      userManagement: isSuperAdmin || permissions.canManageUsers || false,
      kycReview: isSuperAdmin || permissions.canManageKYC || false,
      feesAndRates: isSuperAdmin || permissions.canManageFees || false,
      giftCards: isSuperAdmin || permissions.canManageGiftcards || false,
      banners: isSuperAdmin || permissions.canManageBanners || false,
      fundingAndBalances: isSuperAdmin || permissions.canRemoveFunding || permissions.canManageBalances || false,
      pushNotifications: isSuperAdmin || permissions.canManagePushNotifications || false,
      security: isSuperAdmin || false, // Only super admin for now
      auditAndMonitoring: isSuperAdmin || permissions.canAccessReports || false,
      adminSettings: isSuperAdmin || permissions.canManageAdmins || false,
      settings: true, // Everyone can access settings
      // Include all permission flags
      canDeleteUsers: isSuperAdmin || permissions.canDeleteUsers || false,
      canManageWallets: isSuperAdmin || permissions.canManageWallets || false,
      canManageFees: isSuperAdmin || permissions.canManageFees || false,
      canViewTransactions: isSuperAdmin || permissions.canViewTransactions || false,
      canFundUsers: isSuperAdmin || permissions.canFundUsers || false,
      canManageKYC: isSuperAdmin || permissions.canManageKYC || false,
      canAccessReports: isSuperAdmin || permissions.canAccessReports || false,
      canManageAdmins: isSuperAdmin || permissions.canManageAdmins || false,
      canManagePushNotifications: isSuperAdmin || permissions.canManagePushNotifications || false,
      canManageUsers: isSuperAdmin || permissions.canManageUsers || false,
      canManageGiftcards: isSuperAdmin || permissions.canManageGiftcards || false,
      canManageBanners: isSuperAdmin || permissions.canManageBanners || false,
      canRemoveFunding: isSuperAdmin || permissions.canRemoveFunding || false,
      canManageBalances: isSuperAdmin || permissions.canManageBalances || false,
    };

    logger.info('Admin permissions fetched', {
      adminId: adminUser._id,
      role: adminUser.role,
      isSuperAdmin
    });

    return res.status(200).json({
      success: true,
      data: {
        featureAccess,
        permissions: adminUser.permissions,
        role: adminUser.role
      }
    });

  } catch (error) {
    logger.error('Error fetching admin permissions', {
      error: error.message,
      stack: error.stack
    });
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

module.exports = router;
