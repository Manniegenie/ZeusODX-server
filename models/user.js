const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SALT_WORK_FACTOR = 10;

const userSchema = new mongoose.Schema({
  // Authentication
  username: { type: String, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String },
  passwordpin: { type: String },
  transactionpin: { type: String },

  // Personal Information
  firstname: { type: String },
  lastname: { type: String },
  phonenumber: { type: String },
  bvn: { type: String },
  DoB: { type: String },

  // Avatar
  avatarUrl: { type: String, default: null },
  avatarLastUpdated: { type: Date, default: null },

  // Login Info
  failedLoginAttempts: { type: Number, default: 0 },
  lastFailedLogin: { type: Date },

  // Wallet Addresses + Reference IDs from Obiex
  wallets: {
    BTC: { address: String, network: String, walletReferenceId: String },
    ETH: { address: String, network: String, walletReferenceId: String },
    SOL: { address: String, network: String, walletReferenceId: String },
    USDT_BSC: { address: String, network: String, walletReferenceId: String },
    USDT_TRX: { address: String, network: String, walletReferenceId: String },
    USDT_ETH: { address: String, network: String, walletReferenceId: String },
    USDC_BSC: { address: String, network: String, walletReferenceId: String },
    USDC_ETH: { address: String, network: String, walletReferenceId: String },
    NGNB: { address: String, network: String, walletReferenceId: String },
  },

  // Wallet Balances (enforce no negative values)
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

  // NGNB Stablecoin Balances (Naira-pegged stablecoin)
  ngnbBalance: { type: Number, default: 0, min: 0 },
  ngnbBalanceUSD: { type: Number, default: 0, min: 0 }, // NGNB value in USD
  ngnbPendingBalance: { type: Number, default: 0, min: 0 },

  totalPortfolioBalance: { type: Number, default: 0, min: 0 },

  // 2FA Fields
  twoFASecret: { type: String, default: null },   // base32 secret
  is2FAEnabled: { type: Boolean, default: false },

  // Refresh Tokens
  refreshTokens: [
    {
      token: String,
      createdAt: { type: Date, default: Date.now },
    },
  ],
});

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
    delete ret.twoFASecret;  // never send secret
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

module.exports = mongoose.model('User', userSchema);