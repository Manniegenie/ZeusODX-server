const express = require("express");
const { body, validationResult } = require("express-validator");
const router = express.Router();

const AdminUser = require("../models/admin");
const logger = require("../utils/logger");
const { sendAdminWelcomeEmail } = require("../services/EmailService");

// POST: /admin/register - Register new admin
router.post(
  "/register",
  [
    body("adminName")
      .trim()
      .notEmpty()
      .withMessage("Admin name is required.")
      .isLength({ min: 2, max: 100 })
      .withMessage("Admin name must be between 2 and 100 characters."),
    
    body("email")
      .trim()
      .notEmpty()
      .withMessage("Email is required.")
      .isEmail()
      .withMessage("Invalid email format.")
      .normalizeEmail(),
    
    body("passwordPin")
      .trim()
      .notEmpty()
      .withMessage("Password PIN is required.")
      .customSanitizer((value) => String(value).padStart(6, '0'))
      .custom((value) => {
        if (!/^\d{6}$/.test(value)) {
          throw new Error("Password PIN must be exactly 6 digits.");
        }
        return true;
      }),
    
    body("role")
      .optional()
      .isIn(['admin', 'super_admin', 'moderator'])
      .withMessage("Invalid role. Must be admin, super_admin, or moderator.")
  ],
  async (req, res) => {
    try {
      // Check validation errors
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Validation failed.",
          errors: errors.array()
        });
      }

      const { adminName, email, passwordPin, role = 'admin' } = req.body;

      // Check if admin with email already exists
      const existingAdmin = await AdminUser.findOne({ email });
      if (existingAdmin) {
        return res.status(409).json({
          success: false,
          message: "Admin with this email already exists."
        });
      }

      // Create new admin user
      const newAdmin = new AdminUser({
        adminName,
        email,
        passwordPin, // Will be hashed by pre-save hook
        role,
        // Initialize 2FA fields
        twoFASecret: null,
        is2FAEnabled: false,
        is2FAVerified: false
      });

      // Save admin (password will be hashed automatically)
      await newAdmin.save();

      // Set default permissions based on role
      await newAdmin.setRolePermissions();

      logger.info("New admin registered", {
        adminId: newAdmin._id,
        email: newAdmin.email,
        role: newAdmin.role,
        timestamp: new Date().toISOString()
      });

      // Send welcome email with 2FA setup link
      try {
        await sendAdminWelcomeEmail(newAdmin.email, newAdmin.adminName, newAdmin.role);
        logger.info("Admin welcome email sent", {
          adminId: newAdmin._id,
          email: newAdmin.email
        });
      } catch (emailError) {
        // Log email error but don't fail registration
        logger.error("Failed to send admin welcome email", {
          adminId: newAdmin._id,
          email: newAdmin.email,
          error: emailError.message
        });
      }

      // Return success response (excluding sensitive data)
      res.status(201).json({
        success: true,
        message: "Admin registered successfully. A welcome email with 2FA setup instructions has been sent.",
        data: {
          adminId: newAdmin._id,
          adminName: newAdmin.adminName,
          email: newAdmin.email,
          role: newAdmin.role,
          permissions: newAdmin.permissions,
          isActive: newAdmin.isActive,
          createdAt: newAdmin.createdAt
        }
      });

    } catch (error) {
      logger.error("Admin registration error", {
        error: error.message,
        email: req.body.email,
        timestamp: new Date().toISOString()
      });

      // Handle duplicate key error
      if (error.code === 11000) {
        return res.status(409).json({
          success: false,
          message: "Admin with this email already exists."
        });
      }

      res.status(500).json({
        success: false,
        message: "Server error during admin registration. Please try again."
      });
    }
  }
);

// GET: /admin/register - Get all admins
router.get("/register", async (req, res) => {
  try {
    // Fetch all admins, excluding sensitive fields
    const admins = await AdminUser.find({})
      .select('-passwordPin -refreshTokens -twoFASecret')
      .sort({ createdAt: -1 })
      .lean();

    logger.info("Fetched all admins", {
      count: admins.length,
      timestamp: new Date().toISOString()
    });

    res.status(200).json({
      success: true,
      data: admins
    });

  } catch (error) {
    logger.error("Error fetching admins", {
      error: error.message,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      success: false,
      message: "Server error while fetching admins. Please try again."
    });
  }
});

// GET: /admin/permissions - Get current admin's permissions and feature access
router.get("/permissions", async (req, res) => {
  try {
    // Get token from header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: "Authorization token required."
      });
    }

    const token = authHeader.split(' ')[1];
    const jwt = require('jsonwebtoken');
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired token."
      });
    }

    // Find admin by id from token
    const admin = await AdminUser.findById(decoded.id).select('-passwordPin -refreshTokens -twoFASecret');
    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Admin not found."
      });
    }

    if (!admin.isActive) {
      return res.status(403).json({
        success: false,
        message: "Admin account is deactivated."
      });
    }

    // Return only the role/permission type
    res.status(200).json({
      success: true,
      data: {
        role: admin.role
      }
    });

  } catch (error) {
    logger.error("Error fetching admin permissions", {
      error: error.message,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      success: false,
      message: "Server error while fetching permissions. Please try again."
    });
  }
});

// DELETE: /admin/register/:adminId - Delete an admin (requires super admin authentication)
router.delete("/register/:adminId", [
  body("email")
    .trim()
    .notEmpty()
    .withMessage("Email is required.")
    .isEmail()
    .withMessage("Invalid email format."),

  body("passwordPin")
    .trim()
    .notEmpty()
    .withMessage("Password PIN is required.")
    .customSanitizer((value) => String(value).padStart(6, '0'))
    .custom((value) => {
      if (!/^\d{6}$/.test(value)) {
        throw new Error("Password PIN must be exactly 6 digits.");
      }
      return true;
    })
], async (req, res) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: "Validation failed.",
        errors: errors.array()
      });
    }

    const { adminId } = req.params;
    const { email, passwordPin } = req.body;

    // Find requesting admin (must be super admin)
    const requestingAdmin = await AdminUser.findOne({ email });
    if (!requestingAdmin) {
      return res.status(404).json({
        success: false,
        message: "Admin not found."
      });
    }

    // Verify password PIN
    const isValidPin = await requestingAdmin.comparePasswordPin(passwordPin);
    if (!isValidPin) {
      logger.warn("Invalid PIN during admin delete attempt", {
        requestingAdminId: requestingAdmin._id,
        email: requestingAdmin.email
      });
      return res.status(401).json({
        success: false,
        message: "Invalid password PIN."
      });
    }

    // Check if requesting admin is super admin
    if (requestingAdmin.role !== 'super_admin') {
      logger.warn("Non-super admin attempted to delete admin", {
        requestingAdminId: requestingAdmin._id,
        role: requestingAdmin.role
      });
      return res.status(403).json({
        success: false,
        message: "Only super admins can delete other admins."
      });
    }

    // Find target admin to delete
    const targetAdmin = await AdminUser.findById(adminId);
    if (!targetAdmin) {
      return res.status(404).json({
        success: false,
        message: "Target admin not found."
      });
    }

    // Prevent self-deletion
    if (requestingAdmin._id.toString() === targetAdmin._id.toString()) {
      return res.status(400).json({
        success: false,
        message: "You cannot delete your own admin account."
      });
    }

    // Delete the admin
    await AdminUser.findByIdAndDelete(adminId);

    logger.info("Admin deleted by super admin", {
      superAdminId: requestingAdmin._id,
      superAdminEmail: requestingAdmin.email,
      deletedAdminId: targetAdmin._id,
      deletedAdminEmail: targetAdmin.email,
      deletedAdminName: targetAdmin.adminName,
      timestamp: new Date().toISOString()
    });

    res.status(200).json({
      success: true,
      message: `Admin ${targetAdmin.adminName} has been deleted successfully.`
    });

  } catch (error) {
    logger.error("Error deleting admin", {
      error: error.message,
      adminId: req.params.adminId,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      success: false,
      message: "Server error while deleting admin. Please try again."
    });
  }
});

module.exports = router;