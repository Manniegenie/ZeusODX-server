// models/user.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SALT_WORK_FACTOR = 10;

// Import logger for KYC upgrade logging
const logger = require('../utils/logger');

const userSchema = new mongoose.Schema({
  // Authentication
  username: { type: String },
  isUsernameCustom: { type: Boolean, default: false },
  email: { type: String, required: true, unique: true },
  emailVerified: { type: Boolean, default: false },
  password: { type: String },
  passwordpin: { type: String },
  transactionpin: { type: String },
  securitypin: { type: String },
  expoPushToken: { type: String, default: null },
  deviceId: { type: String, default: null },

  // OTP fields (used for both pin changes and email verification)
  pinChangeOtp: { type: String, default: null },
  pinChangeOtpCreatedAt: { type: Date, default: null },
  pinChangeOtpExpiresAt: { type: Date, default: null },
  pinChangeOtpVerified: { type: Boolean, default: false },

  // Personal Info
  firstname: { type: String },
  lastname: { type: String },
  phonenumber: { type: String },
  bvn: { type: String },
  bvnVerified: { type: Boolean, default: false },

  // Avatar
  avatarUrl: { type: String, default: null },
  avatarLastUpdated: { type: Date, default: null },

  // Bank Accounts (Limited to 10 per user) - includes bankCode
  bankAccounts: {
    type: [{
      accountName: { type: String, required: true },
      bankName: { type: String, required: true },
      bankCode: { type: String, required: true },
      accountNumber: { type: String, required: true },
      addedAt: { type: Date, default: Date.now },
      isVerified: { type: Boolean, default: false },
      isActive: { type: Boolean, default: true }
    }],
    validate: {
      validator: function (accounts) {
        return accounts.length <= 10;
      },
      message: 'Maximum of 10 bank accounts allowed per user'
    },
    default: []
  },

  // KYC Levels (Updated structure - removed level 3)
  kycLevel: { type: Number, default: 0, min: 0, max: 2, enum: [0, 1, 2] },
  kycStatus: {
    type: String,
    default: 'not_verified',
    enum: ['not_verified', 'pending', 'approved', 'rejected', 'under_review']
  },
  kyc: {
    level1: {
      // Phone verification - automatic on signup
      status: { type: String, default: 'not_submitted', enum: ['not_submitted', 'pending', 'approved', 'rejected'] },
      phoneVerified: { type: Boolean, default: false },
      verifiedAt: { type: Date, default: null },
      rejectionReason: { type: String, default: null }
    },
    level2: {
      // Email + Document verification
      status: { type: String, default: 'not_submitted', enum: ['not_submitted', 'pending', 'approved', 'rejected'] },
      emailVerified: { type: Boolean, default: false },
      documentSubmitted: { type: Boolean, default: false },
      documentType: { type: String, default: null },
      documentNumber: { type: String, default: null },
      submittedAt: { type: Date, default: null },
      approvedAt: { type: Date, default: null },
      rejectedAt: { type: Date, default: null },
      rejectionReason: { type: String, default: null }
    }
  },

  // Login info
  loginAttempts: { type: Number, default: 0 },
  lockUntil: { type: Date, default: null },
  failedLoginAttempts: { type: Number, default: 0 },
  lastFailedLogin: { type: Date },
  lastLoginEmailSent: { type: Date, default: null },

  // Wallets (expanded to include canonical network variants)
  wallets: {
    // Bitcoin variants
    BTC_BTC: { address: String, network: String, walletReferenceId: String },
    BTC_BSC: { address: String, network: String, walletReferenceId: String },

    // Ethereum variants
    ETH_ETH: { address: String, network: String, walletReferenceId: String },
    ETH_ARBITRUM: { address: String, network: String, walletReferenceId: String },
    ETH_BASE: { address: String, network: String, walletReferenceId: String },
    ETH_BSC: { address: String, network: String, walletReferenceId: String },

    // Solana
    SOL_SOL: { address: String, network: String, walletReferenceId: String },

    // USDT variants
    USDT_ETH: { address: String, network: String, walletReferenceId: String },
    USDT_TRX: { address: String, network: String, walletReferenceId: String },
    USDT_BSC: { address: String, network: String, walletReferenceId: String },
    USDT_ARBITRUM: { address: String, network: String, walletReferenceId: String },
    USDT_BASE: { address: String, network: String, walletReferenceId: String },

    // USDC variants
    USDC_ETH: { address: String, network: String, walletReferenceId: String },
    USDC_BSC: { address: String, network: String, walletReferenceId: String },
    USDC_ARBITRUM: { address: String, network: String, walletReferenceId: String },
    USDC_BASE: { address: String, network: String, walletReferenceId: String },
    USDC_AVAX: { address: String, network: String, walletReferenceId: String },
    USDC_POLYGON: { address: String, network: String, walletReferenceId: String },
    USDC_SOL: { address: String, network: String, walletReferenceId: String },

    // BNB variants
    BNB_ETH: { address: String, network: String, walletReferenceId: String },
    BNB_BSC: { address: String, network: String, walletReferenceId: String },

    // Polygon (MATIC)
    MATIC_ETH: { address: String, network: String, walletReferenceId: String },
    MATIC_ARBITRUM: { address: String, network: String, walletReferenceId: String },

    // Avalanche variants
    AVAX_BSC: { address: String, network: String, walletReferenceId: String },
    AVAX_ARBITRUM: { address: String, network: String, walletReferenceId: String },

    // NGN stable / on-platform currency
    NGNZ: { address: String, network: String, walletReferenceId: String }
  },

  // Balances
  solBalance: { type: Number, default: 0, min: 0 },
  solPendingBalance: { type: Number, default: 0, min: 0 },
  btcBalance: { type: Number, default: 0, min: 0 },
  btcPendingBalance: { type: Number, default: 0, min: 0 },
  usdtBalance: { type: Number, default: 0, min: 0 },
  usdtPendingBalance: { type: Number, default: 0, min: 0 },
  usdcBalance: { type: Number, default: 0, min: 0 },
  usdcPendingBalance: { type: Number, default: 0, min: 0 },
  ethBalance: { type: Number, default: 0, min: 0 },
  ethPendingBalance: { type: Number, default: 0, min: 0 },
  bnbBalance: { type: Number, default: 0, min: 0 },
  bnbPendingBalance: { type: Number, default: 0, min: 0 },
  maticBalance: { type: Number, default: 0, min: 0 },
  maticPendingBalance: { type: Number, default: 0, min: 0 },
  avaxBalance: { type: Number, default: 0, min: 0 },
  avaxPendingBalance: { type: Number, default: 0, min: 0 },
  ngnzBalance: { type: Number, default: 0, min: 0 },
  ngnzPendingBalance: { type: Number, default: 0, min: 0 },

  lastBalanceUpdate: { type: Date, default: null },
  portfolioLastUpdated: { type: Date, default: null },

  // 2FA
  twoFASecret: { type: String, default: null },
  is2FAEnabled: { type: Boolean, default: false },
  is2FAVerified: { type: Boolean, default: false },

  // Refresh tokens
  refreshTokens: [
    { token: String, createdAt: { type: Date, default: Date.now } }
  ]
}, { timestamps: true });

// Indexes
userSchema.index({ username: 1 }, { unique: true, sparse: true });
userSchema.index({ phonenumber: 1 }, { unique: true, sparse: true });
userSchema.index({ bvn: 1 }, { unique: true, sparse: true });
userSchema.index({ kycLevel: 1, kycStatus: 1 });

// Virtuals
userSchema.virtual('id').get(function () { return this._id.toHexString(); });
userSchema.virtual('fullName').get(function () {
  return this.firstname && this.lastname ? `${this.firstname} ${this.lastname}` : this.firstname || this.lastname || '';
});

// JSON cleanup
userSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    delete ret.password;
    delete ret.passwordpin;
    delete ret.transactionpin;
    delete ret.securitypin;
    delete ret.twoFASecret;
    delete ret.__v;
    return ret;
  }
});

// Pre-save: Hash sensitive fields + balance tracking + KYC upgrade checks
userSchema.pre('save', async function (next) {
  try {
    const fieldsToHash = ['password', 'passwordpin', 'transactionpin', 'securitypin'];
    for (const field of fieldsToHash) {
      if (this.isModified(field) && this[field]) {
        const salt = await bcrypt.genSalt(SALT_WORK_FACTOR);
        this[field] = await bcrypt.hash(this[field], salt);
      }
    }

    const balanceFields = [
      'solBalance', 'btcBalance', 'usdtBalance', 'usdcBalance', 'ethBalance',
      'bnbBalance', 'maticBalance', 'avaxBalance', 'ngnzBalance'
    ];
    if (balanceFields.some(f => this.isModified(f))) {
      this.lastBalanceUpdate = new Date();
    }

    // Auto-check for KYC upgrades when relevant fields change
    const kycRelevantFields = [
      'emailVerified',
      'kyc.level2.status',
      'kyc.level2.documentSubmitted'
    ];

    if (kycRelevantFields.some(field => this.isModified(field))) {
      // Only check if we're not already at the highest level
      if (this.kycLevel < 2) {
        await this.autoUpgradeKYC();
      }
    }

    next();
  } catch (err) {
    next(err);
  }
});

// Authentication Methods
userSchema.methods.comparePassword = async function (candidate) { return this.password && bcrypt.compare(candidate, this.password); };
userSchema.methods.comparePasswordPin = async function (candidate) { return this.passwordpin && bcrypt.compare(candidate, this.passwordpin); };
userSchema.methods.compareTransactionPin = async function (candidate) { return this.transactionpin && bcrypt.compare(candidate, this.transactionpin); };
userSchema.methods.compareSecurityPin = async function (candidate) { return this.securitypin && bcrypt.compare(candidate, this.securitypin); };

// Account Security Methods
userSchema.methods.canUpdateUsername = function () { return !this.isUsernameCustom; };
userSchema.methods.isLocked = function () { return !!(this.lockUntil && this.lockUntil > Date.now()); };
userSchema.methods.incLoginAttempts = async function () {
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({ $unset: { lockUntil: 1 }, $set: { loginAttempts: 1, failedLoginAttempts: 1, lastFailedLogin: Date.now() } });
  }
  const updates = { $inc: { loginAttempts: 1, failedLoginAttempts: 1 }, $set: { lastFailedLogin: Date.now() } };
  if (this.loginAttempts + 1 >= 5 && !this.isLocked()) updates.$set.lockUntil = Date.now() + (2 * 60 * 60 * 1000);
  return this.updateOne(updates);
};
userSchema.methods.resetLoginAttempts = async function () { return this.updateOne({ $unset: { loginAttempts: 1, lockUntil: 1 } }); };

// Email Methods
userSchema.methods.shouldSendLoginEmail = function () {
  if (!this.lastLoginEmailSent) return true;
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
  return this.lastLoginEmailSent < fifteenMinutesAgo;
};

// Updated markEmailAsVerified to trigger KYC upgrade check
userSchema.methods.markEmailAsVerified = async function () {
  this.emailVerified = true;
  this.kyc.level2.emailVerified = true;
  this.pinChangeOtp = null;
  this.pinChangeOtpCreatedAt = null;
  this.pinChangeOtpExpiresAt = null;
  this.pinChangeOtpVerified = false;

  // Check for KYC upgrade after email verification
  await this.autoUpgradeKYC();

  return this.save();
};

// Email verification check method
userSchema.methods.isEmailVerified = function () {
  return this.emailVerified === true;
};

userSchema.methods.generateEmailVerificationOTP = function () {
  function generateOTP(length = 6) {
    const digits = '0123456789';
    let otp = '';
    for (let i = 0; i < length; i++) {
      otp += digits[Math.floor(Math.random() * Math.random() * 10)]; // fallback secure-ish generation
    }
    return otp;
  }

  const otp = generateOTP();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000);

  this.pinChangeOtp = otp;
  this.pinChangeOtpCreatedAt = createdAt;
  this.pinChangeOtpExpiresAt = expiresAt;
  this.pinChangeOtpVerified = false;

  return otp;
};

userSchema.methods.isEmailVerificationOTPValid = function (otp) {
  return this.pinChangeOtp === otp &&
    this.pinChangeOtpExpiresAt &&
    this.pinChangeOtpExpiresAt > new Date();
};

userSchema.methods.hasEmailVerificationOTPExpired = function () {
  return !this.pinChangeOtpExpiresAt || new Date() > this.pinChangeOtpExpiresAt;
};

userSchema.methods.clearPinChangeOtp = function () {
  this.pinChangeOtp = null;
  this.pinChangeOtpCreatedAt = null;
  this.pinChangeOtpExpiresAt = null;
  this.pinChangeOtpVerified = false;
  return this.save();
};

// Bank Account Methods (with bankCode)
userSchema.methods.addBankAccount = function (accountData) {
  if (this.bankAccounts.length >= 10) {
    throw new Error('Maximum of 10 bank accounts allowed per user');
  }
  if (!accountData.bankCode) {
    throw new Error('Bank code is required');
  }
  const existingAccount = this.bankAccounts.find(
    account => account.accountNumber === accountData.accountNumber && account.isActive
  );
  if (existingAccount) {
    throw new Error('Bank account with this account number already exists');
  }
  this.bankAccounts.push({
    accountName: accountData.accountName,
    bankName: accountData.bankName,
    bankCode: accountData.bankCode,
    accountNumber: accountData.accountNumber,
    addedAt: new Date(),
    isVerified: false,
    isActive: true
  });
  return this.save();
};

userSchema.methods.removeBankAccount = function (accountId) {
  this.bankAccounts.id(accountId).remove();
  return this.save();
};

userSchema.methods.getActiveBankAccounts = function () {
  return this.bankAccounts.filter(account => account.isActive);
};

userSchema.methods.getBankAccountsCount = function () {
  return this.bankAccounts.filter(account => account.isActive).length;
};

userSchema.methods.canAddBankAccount = function () {
  return this.getBankAccountsCount() < 10;
};

// KYC Limits (Updated structure - removed level 3)
userSchema.methods.getKycLimits = function () {
  const limits = {
    0: {
      ngnb: { daily: 0, monthly: 0 },
      crypto: { daily: 0, monthly: 0 },
      utilities: { daily: 0, monthly: 0 },
      description: 'No verification - No transactions allowed'
    },
    1: {
      ngnb: { daily: 0, monthly: 0 }, // No NGN transactions allowed
      crypto: { daily: 0, monthly: 0 }, // No crypto transactions allowed
      utilities: { daily: 50000, monthly: 200000 }, // Only utilities allowed
      description: 'Phone verification (automatic on signup)'
    },
    2: {
      ngnb: { daily: 25000000, monthly: 200000000 },
      crypto: { daily: 2000000, monthly: 2000000 },
      utilities: { daily: 500000, monthly: 2000000 },
      description: 'Email verification + Document verification'
    }
  };
  return limits[this.kycLevel] || limits[0];
};

userSchema.methods.getNgnbLimits = function () {
  const limits = this.getKycLimits();
  return limits.ngnb;
};

userSchema.methods.getCryptoLimits = function () {
  const limits = this.getKycLimits();
  return limits.crypto;
};

userSchema.methods.getUtilityLimits = function () {
  const limits = this.getKycLimits();
  return limits.utilities;
};

// Compatibility alias if other parts of ZeusODX still call NGNZ limits
userSchema.methods.getNgnzLimits = function () {
  return this.getNgnbLimits();
};

// Get or create KYC record
userSchema.methods.getOrCreateKyc = async function () {
  const KYC = require('./kyc');
  let kycDoc = await KYC.findOne({ userId: this._id });
  if (!kycDoc) kycDoc = await KYC.create({ userId: this._id });
  return kycDoc;
};

// Enhanced Auto-upgrade KYC levels based on completed verifications
userSchema.methods.autoUpgradeKYC = async function () {
  let upgraded = false;

  // Auto-upgrade to Level 1 on phone verification
  if (this.kycLevel < 1 && this.phonenumber) {
    this.kycLevel = 1;
    this.kyc.level1.status = 'approved';
    this.kyc.level1.phoneVerified = true;
    this.kyc.level1.verifiedAt = new Date();
    this.kycStatus = 'approved';
    upgraded = true;

    logger.info('User auto-upgraded to KYC Level 1', { userId: this._id, phone: this.phonenumber?.slice(0, 5) + '****' });
  }

  // Auto-upgrade to Level 2 if BOTH email verified AND identity document verified
  if (this.kycLevel < 2 && this.canUpgradeToLevel2()) {
    this.kycLevel = 2;
    this.kyc.level2.status = 'approved';
    this.kyc.level2.emailVerified = true;
    this.kyc.level2.approvedAt = new Date();
    this.kycStatus = 'approved';
    upgraded = true;

    logger.info('User auto-upgraded to KYC Level 2', {
      userId: this._id,
      emailVerified: this.emailVerified,
      documentStatus: this.kyc.level2.status,
      documentType: this.kyc.level2.documentType
    });
  }

  if (upgraded) {
    await this.save();
  }

  return upgraded;
};

// Check if user can be upgraded to KYC Level 2
userSchema.methods.canUpgradeToLevel2 = function () {
  const emailVerified = this.emailVerified === true;
  const identityVerified = this.kyc.level2.status === 'approved' && this.kyc.level2.documentSubmitted === true;

  return emailVerified && identityVerified;
};

// Check if identity document verification is complete
userSchema.methods.isIdentityDocumentVerified = function () {
  return this.kyc.level2.status === 'approved' && this.kyc.level2.documentSubmitted === true;
};

// Comprehensive KYC status check
userSchema.methods.getKycRequirements = function () {
  const requirements = {
    level1: {
      phone: {
        required: true,
        completed: !!this.phonenumber && this.kyc.level1.phoneVerified === true,
        status: this.kyc.level1.status
      }
    },
    level2: {
      email: {
        required: true,
        completed: this.emailVerified === true,
        status: this.emailVerified ? 'approved' : 'not_submitted'
      },
      identity: {
        required: true,
        completed: this.isIdentityDocumentVerified(),
        status: this.kyc.level2.status,
        documentType: this.kyc.level2.documentType,
        documentNumber: this.kyc.level2.documentNumber
      }
    }
  };

  // Calculate completion percentages
  const level1Complete = requirements.level1.phone.completed;
  const level2Complete = requirements.level2.email.completed && 
                        requirements.level2.identity.completed;

  return {
    currentLevel: this.kycLevel,
    status: this.kycStatus,
    canUpgradeToLevel2: this.canUpgradeToLevel2(),
    requirements,
    completion: {
      level1: level1Complete,
      level2: level2Complete
    }
  };
};

// Method to call after identity document verification is completed
userSchema.methods.onIdentityDocumentVerified = async function (documentType, documentNumber) {
  // This method should be called from the webhook after successful identity verification
  // The webhook already updates kyc.level2.status to 'approved', but we can double-check here

  if (this.kyc.level2.status === 'approved') {
    logger.info('Identity document verified, checking for KYC upgrade', {
      userId: this._id,
      documentType,
      documentNumber,
      emailVerified: this.emailVerified
    });

    // Trigger KYC upgrade check
    await this.autoUpgradeKYC();
  }

  return this.save();
};

// Phone verification check method
userSchema.methods.isPhoneVerified = function () {
  return this.kyc && this.kyc.level1 && this.kyc.level1.phoneVerified === true;
};

module.exports = mongoose.model('User', userSchema);