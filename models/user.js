const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SALT_WORK_FACTOR = 10;

const userSchema = new mongoose.Schema({
  // ===============================
  // AUTHENTICATION FIELDS
  // ===============================
  username: { 
    type: String, 
    unique: true,
    sparse: true, // Allows multiple null values
    trim: true,
    minlength: 3,
    maxlength: 30
  },
  email: { 
    type: String, 
    required: true, 
    unique: true,
    trim: true,
    lowercase: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
  },
  password: { type: String },
  passwordpin: { type: String },
  transactionpin: { type: String },

  // ===============================
  // PERSONAL INFORMATION
  // ===============================
  firstname: { 
    type: String,
    trim: true,
    maxlength: 50
  },
  lastname: { 
    type: String,
    trim: true,
    maxlength: 50
  },
  phonenumber: { 
    type: String,
    trim: true,
    maxlength: 20
  },
  bvn: { 
    type: String,
    trim: true,
    length: 11 // BVN is exactly 11 digits
  },
  DoB: { type: String }, // Consider changing to Date type in future

  // ===============================
  // AVATAR INFORMATION
  // ===============================
  avatarUrl: { type: String, default: null },
  avatarLastUpdated: { type: Date, default: null },

  // ===============================
  // KYC VERIFICATION SYSTEM
  // ===============================
  kycLevel: { 
    type: Number, 
    default: 0, 
    min: 0, 
    max: 3,
    enum: [0, 1, 2, 3] // 0 = not verified, 1-3 = KYC levels
  },
  kycStatus: { 
    type: String, 
    default: 'not_verified',
    enum: ['not_verified', 'pending', 'approved', 'rejected', 'under_review']
  },
  kyc: {
    level1: {
      status: { 
        type: String, 
        default: 'not_submitted',
        enum: ['not_submitted', 'pending', 'approved', 'rejected']
      },
      submittedAt: { type: Date, default: null },
      approvedAt: { type: Date, default: null },
      rejectedAt: { type: Date, default: null },
      rejectionReason: { type: String, default: null }
    },
    level2: {
      status: { 
        type: String, 
        default: 'not_submitted',
        enum: ['not_submitted', 'pending', 'approved', 'rejected']
      },
      submittedAt: { type: Date, default: null },
      approvedAt: { type: Date, default: null },
      rejectedAt: { type: Date, default: null },
      rejectionReason: { type: String, default: null },
      documentType: { type: String, default: null }, // ID type submitted
      documentNumber: { type: String, default: null }
    },
    level3: {
      status: { 
        type: String, 
        default: 'not_submitted',
        enum: ['not_submitted', 'pending', 'approved', 'rejected']
      },
      submittedAt: { type: Date, default: null },
      approvedAt: { type: Date, default: null },
      rejectedAt: { type: Date, default: null },
      rejectionReason: { type: String, default: null },
      addressVerified: { type: Boolean, default: false },
      sourceOfFunds: { type: String, default: null }
    }
  },

  // ===============================
  // LOGIN & SECURITY
  // ===============================
  loginAttempts: { type: Number, default: 0 },
  lockUntil: { type: Date, default: null },
  failedLoginAttempts: { type: Number, default: 0 }, // Keep for backward compatibility
  lastFailedLogin: { type: Date },
  lastLoginAt: { type: Date },
  lastActiveAt: { type: Date, default: Date.now },

  // ===============================
  // WALLET ADDRESSES & REFERENCE IDs
  // ===============================
  wallets: {
    // Major Cryptocurrencies
    BTC: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'BTC' }, 
      walletReferenceId: { type: String, default: null }
    },
    ETH: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'ETH' }, 
      walletReferenceId: { type: String, default: null }
    },
    SOL: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'SOL' }, 
      walletReferenceId: { type: String, default: null }
    },

    // USDT on Different Networks
    USDT_ETH: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'ETH' }, 
      walletReferenceId: { type: String, default: null }
    },
    USDT_TRX: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'TRX' }, 
      walletReferenceId: { type: String, default: null }
    },
    USDT_BSC: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'BSC' }, 
      walletReferenceId: { type: String, default: null }
    },

    // USDC on Different Networks
    USDC_ETH: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'ETH' }, 
      walletReferenceId: { type: String, default: null }
    },
    USDC_BSC: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'BSC' }, 
      walletReferenceId: { type: String, default: null }
    },

    // BNB on Different Networks
    BNB_BSC: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'BSC' }, 
      walletReferenceId: { type: String, default: null }
    },
    BNB_BNB: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'BNB' }, 
      walletReferenceId: { type: String, default: null }
    },

    // Other Major Tokens
    MATIC: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'MATIC' }, 
      walletReferenceId: { type: String, default: null }
    },
    XRP: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'XRP' }, 
      walletReferenceId: { type: String, default: null }
    },
    ADA: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'ADA' }, 
      walletReferenceId: { type: String, default: null }
    },
    DOGE: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'DOGE' }, 
      walletReferenceId: { type: String, default: null }
    },
    TRX: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'TRX' }, 
      walletReferenceId: { type: String, default: null }
    },
    LTC: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'LTC' }, 
      walletReferenceId: { type: String, default: null }
    },
    AVAX: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'AVAX' }, 
      walletReferenceId: { type: String, default: null }
    },

    // Naira-backed Stablecoin
    NGNB: { 
      address: { type: String, default: null }, 
      network: { type: String, default: 'NGNB' }, 
      walletReferenceId: { type: String, default: null }
    }
  },

  // ===============================
  // CRYPTOCURRENCY BALANCES
  // ===============================
  
  // Bitcoin (BTC)
  btcBalance: { type: Number, default: 0, min: 0 },
  btcBalanceUSD: { type: Number, default: 0, min: 0 },
  btcPendingBalance: { type: Number, default: 0, min: 0 },

  // Ethereum (ETH)
  ethBalance: { type: Number, default: 0, min: 0 },
  ethBalanceUSD: { type: Number, default: 0, min: 0 },
  ethPendingBalance: { type: Number, default: 0, min: 0 },

  // Solana (SOL)
  solBalance: { type: Number, default: 0, min: 0 },
  solBalanceUSD: { type: Number, default: 0, min: 0 },
  solPendingBalance: { type: Number, default: 0, min: 0 },

  // USDT (Tether) - Combined across all networks
  usdtBalance: { type: Number, default: 0, min: 0 },
  usdtBalanceUSD: { type: Number, default: 0, min: 0 },
  usdtPendingBalance: { type: Number, default: 0, min: 0 },

  // USDC (USD Coin) - Combined across all networks
  usdcBalance: { type: Number, default: 0, min: 0 },
  usdcBalanceUSD: { type: Number, default: 0, min: 0 },
  usdcPendingBalance: { type: Number, default: 0, min: 0 },

  // BNB (Binance Coin)
  bnbBalance: { type: Number, default: 0, min: 0 },
  bnbBalanceUSD: { type: Number, default: 0, min: 0 },
  bnbPendingBalance: { type: Number, default: 0, min: 0 },

  // MATIC (Polygon)
  maticBalance: { type: Number, default: 0, min: 0 },
  maticBalanceUSD: { type: Number, default: 0, min: 0 },
  maticPendingBalance: { type: Number, default: 0, min: 0 },

  // XRP (Ripple)
  xrpBalance: { type: Number, default: 0, min: 0 },
  xrpBalanceUSD: { type: Number, default: 0, min: 0 },
  xrpPendingBalance: { type: Number, default: 0, min: 0 },

  // ADA (Cardano)
  adaBalance: { type: Number, default: 0, min: 0 },
  adaBalanceUSD: { type: Number, default: 0, min: 0 },
  adaPendingBalance: { type: Number, default: 0, min: 0 },

  // DOGE (Dogecoin)
  dogeBalance: { type: Number, default: 0, min: 0 },
  dogeBalanceUSD: { type: Number, default: 0, min: 0 },
  dogePendingBalance: { type: Number, default: 0, min: 0 },

  // TRX (Tron)
  trxBalance: { type: Number, default: 0, min: 0 },
  trxBalanceUSD: { type: Number, default: 0, min: 0 },
  trxPendingBalance: { type: Number, default: 0, min: 0 },

  // LTC (Litecoin)
  ltcBalance: { type: Number, default: 0, min: 0 },
  ltcBalanceUSD: { type: Number, default: 0, min: 0 },
  ltcPendingBalance: { type: Number, default: 0, min: 0 },

  // AVAX (Avalanche)
  avaxBalance: { type: Number, default: 0, min: 0 },
  avaxBalanceUSD: { type: Number, default: 0, min: 0 },
  avaxPendingBalance: { type: Number, default: 0, min: 0 },

  // NGNB (Naira-backed Stablecoin)
  ngnbBalance: { type: Number, default: 0, min: 0 },
  ngnbBalanceUSD: { type: Number, default: 0, min: 0 },
  ngnbPendingBalance: { type: Number, default: 0, min: 0 },

  // Total Portfolio Value
  totalPortfolioBalance: { type: Number, default: 0, min: 0 },
  portfolioLastUpdated: { type: Date, default: Date.now },

  // ===============================
  // TWO-FACTOR AUTHENTICATION
  // ===============================
  twoFASecret: { type: String, default: null },   // base32 secret for TOTP
  is2FAEnabled: { type: Boolean, default: false },
  twoFABackupCodes: [{ type: String }], // Emergency backup codes

  // ===============================
  // REFRESH TOKENS
  // ===============================
  refreshTokens: [{
    token: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date },
    deviceInfo: { type: String }, // Optional device information
    isActive: { type: Boolean, default: true }
  }],

  // ===============================
  // ACCOUNT STATUS & METADATA
  // ===============================
  isEmailVerified: { type: Boolean, default: false },
  isPhoneVerified: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  isSuspended: { type: Boolean, default: false },
  suspensionReason: { type: String, default: null },
  
  // Account creation and updates
  emailVerificationToken: { type: String },
  emailVerificationExpires: { type: Date },
  passwordResetToken: { type: String },
  passwordResetExpires: { type: Date },

}, {
  timestamps: true, // Adds createdAt and updatedAt automatically
  collection: 'users'
});

// ===============================
// INDEXES FOR PERFORMANCE
// ===============================
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ username: 1 }, { unique: true, sparse: true });
userSchema.index({ isActive: 1 });
userSchema.index({ kycLevel: 1 });
userSchema.index({ createdAt: -1 });

// ===============================
// VIRTUAL FIELDS
// ===============================
userSchema.virtual('id').get(function () {
  return this._id.toHexString();
});

userSchema.virtual('fullName').get(function () {
  if (this.firstname && this.lastname) {
    return `${this.firstname} ${this.lastname}`;
  }
  return this.firstname || this.lastname || null;
});

userSchema.virtual('isLocked').get(function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

// ===============================
// JSON TRANSFORMATION
// ===============================
userSchema.set('toJSON', {
  virtuals: true,
  transform: function (doc, ret, options) {
    // Remove sensitive fields from JSON output
    delete ret.password;
    delete ret.passwordpin;
    delete ret.transactionpin;
    delete ret.twoFASecret;
    delete ret.twoFABackupCodes;
    delete ret.refreshTokens;
    delete ret.emailVerificationToken;
    delete ret.passwordResetToken;
    delete ret.__v;
    delete ret._id;
    
    // Only include certain fields in public contexts
    if (options && options.public) {
      delete ret.email;
      delete ret.phonenumber;
      delete ret.bvn;
      delete ret.DoB;
      delete ret.kyc;
      delete ret.loginAttempts;
      delete ret.failedLoginAttempts;
      delete ret.lastFailedLogin;
      delete ret.wallets;
    }
    
    return ret;
  },
});

// ===============================
// PRE-SAVE MIDDLEWARE
// ===============================
userSchema.pre('save', async function (next) {
  try {
    // Hash password if modified
    if (this.isModified('password') && this.password) {
      const salt = await bcrypt.genSalt(SALT_WORK_FACTOR);
      this.password = await bcrypt.hash(this.password, salt);
    }

    // Hash password pin if modified
    if (this.isModified('passwordpin') && this.passwordpin) {
      const salt = await bcrypt.genSalt(SALT_WORK_FACTOR);
      this.passwordpin = await bcrypt.hash(this.passwordpin, salt);
    }

    // Hash transaction pin if modified
    if (this.isModified('transactionpin') && this.transactionpin) {
      const salt = await bcrypt.genSalt(SALT_WORK_FACTOR);
      this.transactionpin = await bcrypt.hash(this.transactionpin, salt);
    }

    // Prevent username changes after initial creation
    if (!this.isNew && this.isModified('username')) {
      const err = new Error('Username cannot be changed once set.');
      err.status = 400;
      return next(err);
    }

    // Update portfolio last updated timestamp if any balance changed
    const balanceFields = [
      'btcBalance', 'ethBalance', 'solBalance', 'usdtBalance', 'usdcBalance',
      'bnbBalance', 'maticBalance', 'xrpBalance', 'adaBalance', 'dogeBalance',
      'trxBalance', 'ltcBalance', 'avaxBalance', 'ngnbBalance'
    ];
    
    if (balanceFields.some(field => this.isModified(field))) {
      this.portfolioLastUpdated = new Date();
    }

    // Update lastActiveAt
    if (this.isModified('lastLoginAt')) {
      this.lastActiveAt = new Date();
    }

    next();
  } catch (err) {
    next(err);
  }
});

// ===============================
// INSTANCE METHODS
// ===============================

// Password comparison
userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

// Password pin comparison
userSchema.methods.comparePasswordPin = async function (candidatePin) {
  if (!this.passwordpin) return false;
  return bcrypt.compare(candidatePin, this.passwordpin);
};

// Transaction pin comparison
userSchema.methods.compareTransactionPin = async function (candidatePin) {
  if (!this.transactionpin) return false;
  return bcrypt.compare(candidatePin, this.transactionpin);
};

// KYC helper methods
userSchema.methods.updateKycLevel = function(level, status = 'approved') {
  if (level >= 1 && level <= 3 && status === 'approved') {
    this.kycLevel = Math.max(this.kycLevel, level);
    this.kycStatus = 'approved';
  }
};

userSchema.methods.getKycLimits = function() {
  const limits = {
    0: { daily: 0, monthly: 0, description: 'No verification' },
    1: { daily: 50000, monthly: 200000, description: 'Basic verification' },
    2: { daily: 5000000, monthly: 20000000, description: 'Identity verified' },
    3: { daily: 20000000, monthly: 200000000, description: 'Enhanced verification' }
  };
  return limits[this.kycLevel] || limits[0];
};

// Account locking methods
userSchema.methods.incrementLoginAttempts = function() {
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({
      $unset: { lockUntil: 1 },
      $set: { loginAttempts: 1, lastFailedLogin: Date.now() }
    });
  }
  
  const updates = { 
    $inc: { loginAttempts: 1, failedLoginAttempts: 1 },
    $set: { lastFailedLogin: Date.now() }
  };
  
  if (this.loginAttempts + 1 >= 5 && !this.isLocked) {
    updates.$set.lockUntil = Date.now() + (30 * 60 * 1000); // 30 minutes
  }
  
  return this.updateOne(updates);
};

userSchema.methods.resetLoginAttempts = function() {
  return this.updateOne({
    $unset: { lockUntil: 1, loginAttempts: 1 },
    $set: { lastLoginAt: Date.now() }
  });
};

// Portfolio calculation
userSchema.methods.calculateTotalPortfolio = function() {
  const usdBalances = [
    this.btcBalanceUSD, this.ethBalanceUSD, this.solBalanceUSD,
    this.usdtBalanceUSD, this.usdcBalanceUSD, this.bnbBalanceUSD,
    this.maticBalanceUSD, this.xrpBalanceUSD, this.adaBalanceUSD,
    this.dogeBalanceUSD, this.trxBalanceUSD, this.ltcBalanceUSD,
    this.avaxBalanceUSD, this.ngnbBalanceUSD
  ];
  
  return usdBalances.reduce((total, balance) => total + (balance || 0), 0);
};

// Wallet management
userSchema.methods.getWalletByToken = function(token, network = null) {
  const walletKey = network ? `${token}_${network}` : token;
  return this.wallets[walletKey] || null;
};

userSchema.methods.hasWalletAddress = function(token, network = null) {
  const wallet = this.getWalletByToken(token, network);
  return wallet && wallet.address;
};

// Clean up expired refresh tokens
userSchema.methods.cleanupExpiredTokens = function() {
  const now = new Date();
  this.refreshTokens = this.refreshTokens.filter(token => 
    !token.expiresAt || token.expiresAt > now
  );
  return this.save();
};

// ===============================
// STATIC METHODS
// ===============================

userSchema.statics.findByEmail = function(email) {
  return this.findOne({ email: email.toLowerCase() });
};

userSchema.statics.findByUsername = function(username) {
  return this.findOne({ username: username });
};

userSchema.statics.findActiveUsers = function() {
  return this.find({ isActive: true, isSuspended: false });
};

userSchema.statics.findByKycLevel = function(level) {
  return this.find({ kycLevel: level });
};

module.exports = mongoose.model('User', userSchema);