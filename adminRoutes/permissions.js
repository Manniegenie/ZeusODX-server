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
    const isAdmin = adminUser.role === 'admin';
    const isModerator = adminUser.role === 'moderator';
    
    // Map permissions to feature access
    // CRITICAL: Use role-based logic FIRST, then check database permissions
    // This ensures admins always get the correct permissions even if database is outdated
    const permissions = adminUser.permissions || {};
    
    // Define role-based permissions (what each role SHOULD have)
    const roleBasedPermissions = {
      admin: {
        // Admin role: Only push notifications, user management, banners, giftcards, kyc
        canManagePushNotifications: true,
        canManageUsers: true,
        canManageBanners: true,
        canManageGiftcards: true,
        canManageKYC: true,
      },
      moderator: {
        canViewTransactions: true,
        canAccessReports: true,
      }
    };
    
    // Get effective permissions: role-based first, then database permissions
    let effectivePermissions = {};
    if (isSuperAdmin) {
      // Super admin has everything
      effectivePermissions = {
        canViewTransactions: true,
        canAccessReports: true,
        canManageWallets: true,
        canManageFees: true,
        canManagePushNotifications: true,
        canManageUsers: true,
        canManageKYC: true,
        canManageGiftcards: true,
        canManageBanners: true,
        canRemoveFunding: true,
        canManageBalances: true,
        canDeleteUsers: true,
        canFundUsers: true,
        canManageAdmins: true,
      };
    } else if (isAdmin) {
      // Admin: use role-based permissions (what admin SHOULD have)
      effectivePermissions = { ...roleBasedPermissions.admin };
    } else if (isModerator) {
      // Moderator: use role-based permissions
      effectivePermissions = { ...roleBasedPermissions.moderator };
    }
    
    // Role-based feature access
    const featureAccess = {
      dashboard: true, // Everyone can see dashboard
      platformStats: isSuperAdmin || false, // Admin does NOT have access
      userManagement: isSuperAdmin || effectivePermissions.canManageUsers || false,
      kycReview: isSuperAdmin || effectivePermissions.canManageKYC || false,
      feesAndRates: isSuperAdmin || false, // Admin does NOT have access
      giftCards: isSuperAdmin || effectivePermissions.canManageGiftcards || false,
      banners: isSuperAdmin || effectivePermissions.canManageBanners || false,
      fundingAndBalances: isSuperAdmin || false, // Admin does NOT have access
      pushNotifications: isSuperAdmin || effectivePermissions.canManagePushNotifications || false,
      security: isSuperAdmin || false, // Only super admin
      auditAndMonitoring: isSuperAdmin || false, // Admin does NOT have access
      adminSettings: isSuperAdmin || false, // Admin does NOT have access
      settings: true, // Everyone can access settings
      // Include all permission flags
      canDeleteUsers: isSuperAdmin || false,
      canManageWallets: isSuperAdmin || false,
      canManageFees: isSuperAdmin || false,
      canViewTransactions: isSuperAdmin || false,
      canFundUsers: isSuperAdmin || false,
      canManageKYC: isSuperAdmin || effectivePermissions.canManageKYC || false,
      canAccessReports: isSuperAdmin || false,
      canManageAdmins: isSuperAdmin || false,
      canManagePushNotifications: isSuperAdmin || effectivePermissions.canManagePushNotifications || false,
      canManageUsers: isSuperAdmin || effectivePermissions.canManageUsers || false,
      canManageGiftcards: isSuperAdmin || effectivePermissions.canManageGiftcards || false,
      canManageBanners: isSuperAdmin || effectivePermissions.canManageBanners || false,
      canRemoveFunding: isSuperAdmin || false,
      canManageBalances: isSuperAdmin || false,
    };
    
    // Log for debugging
    logger.info('Admin permissions calculated', {
      adminId: adminUser._id.toString(),
      role: adminUser.role,
      isSuperAdmin,
      isAdmin,
      effectiveCanManageUsers: effectivePermissions.canManageUsers,
      featureAccessUserManagement: featureAccess.userManagement,
      dbCanManageUsers: permissions.canManageUsers
    });

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
