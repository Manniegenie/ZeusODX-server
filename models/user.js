const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SALT_WORK_FACTOR = 10;

const userSchema = new mongoose.Schema({
  // Authentication
  username: { type: String }, // Unique index defined below with sparse
  email: { type: String, required: true, unique: true }, // Only field-level unique constraint
  password: { type: String },
  passwordpin: { type: String },
  transactionpin: { type: String },
  securitypin: { type: String },

  // Personal Information
  firstname: { type: String },
  lastname: { type: String },
  phonenumber: { type: String }, // Unique index defined below with sparse
  bvn: { type: String }, // Unique index defined below with sparse
  DoB: { type: String },

  // Avatar
  avatarUrl: { type: String, default: null },
  avatarLastUpdated: { type: Date, default: null },

  // KYC Verification Levels
  kycLevel: { 
    type: Number, 
    default: 0, 
    min: 0, 
    max: 3,
    enum: [0, 1, 2, 3]
  },
  kycStatus: { 
    type: String, 
    default: 'not_verified',
    enum: ['not_verified', 'pending', 'approved', 'rejected', 'under_review']
  },
  kyc: {
    level1: {
      status: { type: String, default: 'not_submitted', enum: ['not_submitted', 'pending', 'approved', 'rejected'] },
      submittedAt: { type: Date, default: null },
      approvedAt: { type: Date, default: null },
      rejectedAt: { type: Date, default: null },
      rejectionReason: { type: String, default: null }
    },
    level2: {
      status: { type: String, default: 'not_submitted', enum: ['not_submitted', 'pending', 'approved', 'rejected'] },
      submittedAt: { type: Date, default: null },
      approvedAt: { type: Date, default: null },
      rejectedAt: { type: Date, default: null },
      rejectionReason: { type: String, default: null },
      documentType: { type: String, default: null },
      documentNumber: { type: String, default: null }
    },
    level3: {
      status: { type: String, default: 'not_submitted', enum: ['not_submitted', 'pending', 'approved', 'rejected'] },
      submittedAt: { type: Date, default: null },
      approvedAt: { type: Date, default: null },
      rejectedAt: { type: Date, default: null },
      rejectionReason: { type: String, default: null },
      addressVerified: { type: Boolean, default: false },
      sourceOfFunds: { type: String, default: null }
    }
  },

  // Login Info
  loginAttempts: { type: Number, default: 0 },
  lockUntil: { type: Date, default: null },
  failedLoginAttempts: { type: Number, default: 0 },
  lastFailedLogin: { type: Date },

  // Wallet Addresses + Reference IDs - NO UNIQUE CONSTRAINTS
  wallets: {
    BTC_BTC: { address: String, network: String, walletReferenceId: String },
    ETH_ETH: { address: String, network: String, walletReferenceId: String },
    SOL_SOL: { address: String, network: String, walletReferenceId: String },
    USDT_ETH: { address: String, network: String, walletReferenceId: String },
    USDT_TRX: { address: String, network: String, walletReferenceId: String },
    USDT_BSC: { address: String, network: String, walletReferenceId: String },
    USDC_ETH: { address: String, network: String, walletReferenceId: String },
    USDC_BSC: { address: String, network: String, walletReferenceId: String },
    NGNB: { address: String, network: String, walletReferenceId: String },
  },

  // Wallet Balances
  solBalance: { type: Number, default: 0, min: 0 },
  solBalanceUSD: { type: Number, default: 0, min: 0 },
  solPendingBalance: { type: Number, default: 0, min: 0 },

  btcBalance: { type: Number, default: 0, min: 0 },
  btcBalanceUSD: { type: Number, default: 0, min: 0 },
  btcPendingBalance: { type: Number, default: 0, min: 0 },

  usdtBalance: { type: Number, default: 0, min: 0 },
  usdtBalanceUSD: { type: Number, default: 0, min: 0 },
  usdtPendingBalance: { type: Number, default: 0, min: 0 },

  usdcBalance: { type: Number, default: 0, min: 0 },
  usdcBalanceUSD: { type: Number, default: 0, min: 0 },
  usdcPendingBalance: { type: Number, default: 0, min: 0 },

  ethBalance: { type: Number, default: 0, min: 0 },
  ethBalanceUSD: { type: Number, default: 0, min: 0 },
  ethPendingBalance: { type: Number, default: 0, min: 0 },

  ngnbBalance: { type: Number, default: 0, min: 0 },
  ngnbBalanceUSD: { type: Number, default: 0, min: 0 },
  ngnbPendingBalance: { type: Number, default: 0, min: 0 },

  totalPortfolioBalance: { type: Number, default: 0, min: 0 },

  // 2FA - NO UNIQUE CONSTRAINTS
  twoFASecret: { type: String, default: null },
  is2FAEnabled: { type: Boolean, default: false },
  is2FAVerified: { type: Boolean, default: false },

  // Refresh Tokens - NO UNIQUE CONSTRAINTS
  refreshTokens: [
    {
      token: String,
      createdAt: { type: Date, default: Date.now },
    },
  ],
});

// UNIQUE INDEXES: Only on username, phonenumber, bvn (sparse allows null values)
userSchema.index({ username: 1 }, { unique: true, sparse: true });
userSchema.index({ phonenumber: 1 }, { unique: true, sparse: true });
userSchema.index({ bvn: 1 }, { unique: true, sparse: true });
// Note: email already has unique: true in field definition above

// Virtual 'id' field
userSchema.virtual('id').get(function () {
  return this._id.toHexString();
});

// Clean JSON output
userSchema.set('toJSON', {
  virtuals: true,
  transform: function (doc, ret) {
    delete ret.password;
    delete ret.passwordpin;
    delete ret.transactionpin;
    delete ret.securitypin;
    delete ret.twoFASecret;
    delete ret.__v;
    return ret;
  },
});

// Hash sensitive fields before saving
userSchema.pre('save', async function (next) {
  try {
    if (this.isModified('password') && this.password) {
      const salt = await bcrypt.genSalt(SALT_WORK_FACTOR);
      this.password = await bcrypt.hash(this.password, salt);
    }

    if (this.isModified('passwordpin') && this.passwordpin) {
      const salt = await bcrypt.genSalt(SALT_WORK_FACTOR);
      this.passwordpin = await bcrypt.hash(this.passwordpin, salt);
    }

    if (this.isModified('transactionpin') && this.transactionpin) {
      const salt = await bcrypt.genSalt(SALT_WORK_FACTOR);
      this.transactionpin = await bcrypt.hash(this.transactionpin, salt);
    }

    if (this.isModified('securitypin') && this.securitypin) {
      const salt = await bcrypt.genSalt(SALT_WORK_FACTOR);
      this.securitypin = await bcrypt.hash(this.securitypin, salt);
    }

    if (!this.isNew && this.isModified('username')) {
      const err = new Error('Username cannot be changed once set.');
      err.status = 400;
      return next(err);
    }

    next();
  } catch (err) {
    next(err);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

// Compare password pin method
userSchema.methods.comparePasswordPin = async function (candidatePin) {
  if (!this.passwordpin) return false;
  return bcrypt.compare(candidatePin, this.passwordpin);
};

// Compare transaction pin method
userSchema.methods.compareTransactionPin = async function (candidatePin) {
  if (!this.transactionpin) return false;
  return bcrypt.compare(candidatePin, this.transactionpin);
};

// Compare security pin method
userSchema.methods.compareSecurityPin = async function (candidatePin) {
  if (!this.securitypin) return false;
  return bcrypt.compare(candidatePin, this.securitypin);
};

// KYC helpers
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

module.exports = mongoose.model('User', userSchema);