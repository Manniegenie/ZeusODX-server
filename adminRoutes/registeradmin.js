const express = require("express");
const { body, validationResult } = require("express-validator");
const router = express.Router();

const AdminUser = require("../models/admin");
const logger = require("../utils/logger");

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
        role
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

      // Return success response (excluding sensitive data)
      res.status(201).json({
        success: true,
        message: "Admin registered successfully.",
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

module.exports = router;