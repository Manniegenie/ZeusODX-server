const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SALT_WORK_FACTOR = 10;

const userSchema = new mongoose.Schema({
  // Authentication
  username: { type: String },
  email: { type: String, required: true, unique: true },
  password: { type: String },
  passwordpin: { type: String },

  // Personal Information
  firstname: { type: String },
  lastname: { type: String },
  phonenumber: { type: String }, // FIXED: Removed redundant unique constraint
  bvn: { type: String },
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

  // Wallet Addresses + Reference IDs
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

  // 2FA
  twoFASecret: { type: String, default: null },
  is2FAEnabled: { type: Boolean, default: false },

  // Refresh Tokens
  refreshTokens: [
    {
      token: String,
      createdAt: { type: Date, default: Date.now },
    },
  ],
});

// Sparse unique indexes - only enforce uniqueness when values exist
userSchema.index({ username: 1 }, { unique: true, sparse: true });
userSchema.index({ phonenumber: 1 }, { unique: true, sparse: true });
userSchema.index({ bvn: 1 }, { unique: true, sparse: true });
userSchema.index({ twoFASecret: 1 }, { unique: true, sparse: true });

// Wallet address unique indexes (each address type should be unique)
userSchema.index({ 'wallets.BTC_BTC.address': 1 }, { unique: true, sparse: true });
userSchema.index({ 'wallets.ETH_ETH.address': 1 }, { unique: true, sparse: true });
userSchema.index({ 'wallets.SOL_SOL.address': 1 }, { unique: true, sparse: true });
userSchema.index({ 'wallets.USDT_ETH.address': 1 }, { unique: true, sparse: true });
userSchema.index({ 'wallets.USDT_TRX.address': 1 }, { unique: true, sparse: true });
userSchema.index({ 'wallets.USDT_BSC.address': 1 }, { unique: true, sparse: true });
userSchema.index({ 'wallets.USDC_ETH.address': 1 }, { unique: true, sparse: true });
userSchema.index({ 'wallets.USDC_BSC.address': 1 }, { unique: true, sparse: true });
userSchema.index({ 'wallets.NGNB.address': 1 }, { unique: true, sparse: true });

// Wallet reference ID indexes (should also be unique)
userSchema.index({ 'wallets.BTC_BTC.walletReferenceId': 1 }, { unique: true, sparse: true });
userSchema.index({ 'wallets.ETH_ETH.walletReferenceId': 1 }, { unique: true, sparse: true });
userSchema.index({ 'wallets.SOL_SOL.walletReferenceId': 1 }, { unique: true, sparse: true });
userSchema.index({ 'wallets.USDT_ETH.walletReferenceId': 1 }, { unique: true, sparse: true });
userSchema.index({ 'wallets.USDT_TRX.walletReferenceId': 1 }, { unique: true, sparse: true });
userSchema.index({ 'wallets.USDT_BSC.walletReferenceId': 1 }, { unique: true, sparse: true });
userSchema.index({ 'wallets.USDC_ETH.walletReferenceId': 1 }, { unique: true, sparse: true });
userSchema.index({ 'wallets.USDC_BSC.walletReferenceId': 1 }, { unique: true, sparse: true });
userSchema.index({ 'wallets.NGNB.walletReferenceId': 1 }, { unique: true, sparse: true });

// Refresh token uniqueness
userSchema.index({ 'refreshTokens.token': 1 }, { unique: true, sparse: true });

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