const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SALT_WORK_FACTOR = 10;

const adminUserSchema = new mongoose.Schema({
  // Basic Admin Info
  adminName: { 
    type: String, 
    required: true,
    trim: true,
    maxlength: 100
  },
  email: { 
    type: String, 
    required: true, 
    unique: true,
    lowercase: true,
    trim: true
  },
  
  // Authentication
  passwordPin: { 
    type: String, 
    required: true 
  },
  
  // Admin Role/Permissions
  role: { 
    type: String, 
    default: 'admin', 
    enum: ['admin', 'super_admin', 'moderator'],
    required: true
  },
  
  // Account Status
  isActive: { 
    type: Boolean, 
    default: true 
  },
  
  // Security Features
  loginAttempts: { 
    type: Number, 
    default: 0 
  },
  // 2FA Fields
  twoFASecret: {
    type: String,
    default: null
  },
  is2FAEnabled: {
    type: Boolean,
    default: false
  },
  is2FAVerified: {
    type: Boolean,
    default: false
  },
  is2FASetupCompleted: {
    type: Boolean,
    default: false
  },
  lockUntil: { 
    type: Date, 
    default: null 
  },
  failedLoginAttempts: { 
    type: Number, 
    default: 0 
  },
  lastFailedLogin: { 
    type: Date 
  },
  lastSuccessfulLogin: { 
    type: Date 
  },
  
  // Admin-specific tracking
  createdBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'AdminUser',
    default: null 
  },
  lastPasswordChange: { 
    type: Date, 
    default: Date.now 
  },
  
  // Session Management
  refreshTokens: [{
    token: String,
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } // 7 days
  }],
  
  // Admin Permissions (can be expanded based on needs)
  permissions: {
    canDeleteUsers: { type: Boolean, default: false },
    canManageWallets: { type: Boolean, default: false },
    canManageFees: { type: Boolean, default: false },
    canViewTransactions: { type: Boolean, default: true },
    canFundUsers: { type: Boolean, default: false },
    canManageKYC: { type: Boolean, default: false },
    canAccessReports: { type: Boolean, default: true },
    canManageAdmins: { type: Boolean, default: false },
    canManagePushNotifications: { type: Boolean, default: false },
    canManageUsers: { type: Boolean, default: false },
    canManageGiftcards: { type: Boolean, default: false },
    canManageBanners: { type: Boolean, default: false },
    canRemoveFunding: { type: Boolean, default: false },
    canManageBalances: { type: Boolean, default: false }
  }
}, { 
  timestamps: true 
});

// Indexes
adminUserSchema.index({ email: 1 }, { unique: true });
adminUserSchema.index({ role: 1 });
adminUserSchema.index({ isActive: 1 });
adminUserSchema.index({ lastSuccessfulLogin: 1 });

// Virtuals
adminUserSchema.virtual('id').get(function () { 
  return this._id.toHexString(); 
});

// JSON cleanup - Remove sensitive fields
adminUserSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    delete ret.passwordPin;
    delete ret.refreshTokens;
    delete ret.__v;
    return ret;
  },
});

// Pre-save: Hash password pin
adminUserSchema.pre('save', async function (next) {
  try {
    // Hash password pin if modified
    if (this.isModified('passwordPin') && this.passwordPin) {
      const salt = await bcrypt.genSalt(SALT_WORK_FACTOR);
      this.passwordPin = await bcrypt.hash(this.passwordPin, salt);
      this.lastPasswordChange = new Date();
    }
    next();
  } catch (err) { 
    next(err); 
  }
});

// Authentication Methods
adminUserSchema.methods.comparePasswordPin = async function (candidate) { 
  return this.passwordPin && bcrypt.compare(candidate, this.passwordPin); 
};

// Account Security Methods
adminUserSchema.methods.isLocked = function () { 
  return !!(this.lockUntil && this.lockUntil > Date.now()); 
};

adminUserSchema.methods.incLoginAttempts = async function () {
  // If lock has expired, reset attempts
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({ 
      $unset: { lockUntil: 1 }, 
      $set: { 
        loginAttempts: 1, 
        failedLoginAttempts: 1, 
        lastFailedLogin: Date.now() 
      } 
    });
  }
  
  const updates = { 
    $inc: { loginAttempts: 1, failedLoginAttempts: 1 }, 
    $set: { lastFailedLogin: Date.now() } 
  };
  
  // Lock account after 5 failed attempts for 2 hours
  if (this.loginAttempts + 1 >= 5 && !this.isLocked()) {
    updates.$set.lockUntil = Date.now() + (2 * 60 * 60 * 1000); // 2 hours
  }
  
  return this.updateOne(updates);
};

adminUserSchema.methods.resetLoginAttempts = async function () { 
  const updates = { 
    $unset: { loginAttempts: 1, lockUntil: 1 },
    $set: { lastSuccessfulLogin: Date.now() }
  };
  return this.updateOne(updates);
};

// Permission Methods
adminUserSchema.methods.hasPermission = function(permission) {
  return this.permissions[permission] === true;
};

adminUserSchema.methods.grantPermission = function(permission) {
  if (this.permissions.hasOwnProperty(permission)) {
    this.permissions[permission] = true;
    return this.save();
  }
  throw new Error('Invalid permission');
};

adminUserSchema.methods.revokePermission = function(permission) {
  if (this.permissions.hasOwnProperty(permission)) {
    this.permissions[permission] = false;
    return this.save();
  }
  throw new Error('Invalid permission');
};

// Role-based permission presets
adminUserSchema.methods.setRolePermissions = function() {
  switch(this.role) {
    case 'super_admin':
      Object.keys(this.permissions).forEach(key => {
        this.permissions[key] = true;
      });
      break;
      
    case 'admin':
      // Admin role: Only push notifications, user management, banners, giftcards
      this.permissions.canManagePushNotifications = true;
      this.permissions.canManageUsers = true;
      this.permissions.canManageBanners = true;
      this.permissions.canManageGiftcards = true;
      // All other permissions remain false
      break;
      
    case 'moderator':
      this.permissions.canViewTransactions = true;
      this.permissions.canAccessReports = true;
      break;
      
    default:
      // Reset all permissions
      Object.keys(this.permissions).forEach(key => {
        this.permissions[key] = false;
      });
  }
  return this.save();
};

// Token Management
adminUserSchema.methods.addRefreshToken = function(token) {
  this.refreshTokens.push({
    token: token,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
  });
  
  // Keep only last 5 tokens
  if (this.refreshTokens.length > 5) {
    this.refreshTokens = this.refreshTokens.slice(-5);
  }
  
  return this.save();
};

adminUserSchema.methods.removeRefreshToken = function(token) {
  this.refreshTokens = this.refreshTokens.filter(t => t.token !== token);
  return this.save();
};

adminUserSchema.methods.clearAllRefreshTokens = function() {
  this.refreshTokens = [];
  return this.save();
};

// Account Management
adminUserSchema.methods.deactivate = function() {
  this.isActive = false;
  this.refreshTokens = [];
  return this.save();
};

adminUserSchema.methods.activate = function() {
  this.isActive = true;
  this.loginAttempts = 0;
  this.lockUntil = null;
  return this.save();
};

// Static Methods
adminUserSchema.statics.findActiveAdmins = function() {
  return this.find({ isActive: true }).select('-passwordPin -refreshTokens');
};

adminUserSchema.statics.findByRole = function(role) {
  return this.find({ role: role, isActive: true }).select('-passwordPin -refreshTokens');
};

module.exports = mongoose.model('AdminUser', adminUserSchema);