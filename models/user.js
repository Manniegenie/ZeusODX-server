const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SALT_WORK_FACTOR = 10;

const userSchema = new mongoose.Schema({
  // Authentication
  username: { type: String, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String },
  passwordpin: { type: String },

  // Personal Information
  firstname: { type: String },
  lastname: { type: String },
  middlename: { type: String }, // Added for address verification
  phonenumber: { type: String, unique: true }, // Added unique constraint
  bvn: { type: String },
  nin: { type: String }, // Added NIN field
  driversLicense: { type: String }, // Added Driver's License field
  passport: { type: String }, // Added Passport field
  DoB: { type: String },
  gender: { type: String, enum: ['M', 'F', 'Male', 'Female', ''] }, // Added for address verification

  // Avatar
  avatarUrl: { type: String, default: null },
  avatarLastUpdated: { type: Date, default: null },

  // BVN Verification (Separate from KYC)
  bvnVerification: {
    status: { 
      type: String, 
      default: 'not_verified',
      enum: ['not_verified', 'verified', 'failed'] 
    },
    matchScore: { type: Number, default: null },
    verifiedAt: { type: Date, default: null },
    qoreIdVerificationId: { type: String, default: null },
    faceMatchPassed: { type: Boolean, default: false },
    nameMatchPassed: { type: Boolean, default: false },
    verificationCount: { type: Number, default: 0 } // Track how many times user tried
  },

  // NIN Verification (Separate from KYC)
  ninVerification: {
    status: { 
      type: String, 
      default: 'not_verified',
      enum: ['not_verified', 'verified', 'failed'] 
    },
    matchScore: { type: Number, default: null },
    verifiedAt: { type: Date, default: null },
    qoreIdVerificationId: { type: String, default: null },
    faceMatchPassed: { type: Boolean, default: false },
    nameMatchPassed: { type: Boolean, default: false },
    ninData: { type: Object, default: null }, // Store NIN data from QoreID
    verificationCount: { type: Number, default: 0 } // Track how many times user tried
  },

  // Driver's License Verification (Separate from KYC)
  driversLicenseVerification: {
    status: { 
      type: String, 
      default: 'not_verified',
      enum: ['not_verified', 'verified', 'failed'] 
    },
    matchScore: { type: Number, default: null },
    verifiedAt: { type: Date, default: null },
    qoreIdVerificationId: { type: String, default: null },
    faceMatchPassed: { type: Boolean, default: false },
    nameMatchPassed: { type: Boolean, default: false },
    driversLicenseData: { type: Object, default: null }, // Store Driver's License data from QoreID
    verificationCount: { type: Number, default: 0 } // Track how many times user tried
  },

  // Passport Verification (Separate from KYC)
  passportVerification: {
    status: { 
      type: String, 
      default: 'not_verified',
      enum: ['not_verified', 'verified', 'failed'] 
    },
    matchScore: { type: Number, default: null },
    verifiedAt: { type: Date, default: null },
    qoreIdVerificationId: { type: String, default: null },
    faceMatchPassed: { type: Boolean, default: false },
    nameMatchPassed: { type: Boolean, default: false },
    passportData: { type: Object, default: null }, // Store Passport data from QoreID
    verificationCount: { type: Number, default: 0 } // Track how many times user tried
  },

  // Address Verification (Required for KYC Level 3)
  addressVerification: {
    status: { 
      type: String, 
      default: 'not_submitted',
      enum: ['not_submitted', 'in_progress', 'verified', 'failed'] 
    },
    submittedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    qoreIdVerificationId: { type: String, default: null },
    customerReference: { type: String, default: null },
    addressData: { type: Object, default: null }, // Store submitted address data
    qoreIdStatus: { type: Object, default: null }, // Store full QoreID status response
    failureReason: { type: String, default: null },
    verificationCount: { type: Number, default: 0 } // Track how many times user tried
  },

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

// ADD: BVN verification helper (separate from KYC)
userSchema.methods.updateBvnVerification = function(matchScore, verificationId, nameMatchPassed) {
  const MATCH_THRESHOLD = 70; // Industry standard
  const faceMatchPassed = matchScore >= MATCH_THRESHOLD;
  const isFullyVerified = faceMatchPassed && nameMatchPassed;
  
  if (isFullyVerified) {
    this.bvnVerification = {
      status: 'verified',
      matchScore,
      verifiedAt: new Date(),
      qoreIdVerificationId: verificationId,
      faceMatchPassed: true,
      nameMatchPassed: true,
      verificationCount: (this.bvnVerification?.verificationCount || 0) + 1
    };
  } else {
    this.bvnVerification = {
      ...this.bvnVerification,
      status: 'failed',
      matchScore,
      faceMatchPassed,
      nameMatchPassed,
      verificationCount: (this.bvnVerification?.verificationCount || 0) + 1
    };
  }
  
  return isFullyVerified;
};

// ADD: NIN verification helper (separate from KYC)
userSchema.methods.updateNinVerification = function(matchScore, verificationId, nameMatchPassed, ninData) {
  const MATCH_THRESHOLD = 70; // Industry standard
  const faceMatchPassed = matchScore >= MATCH_THRESHOLD;
  const isFullyVerified = faceMatchPassed && nameMatchPassed;
  
  if (isFullyVerified) {
    this.ninVerification = {
      status: 'verified',
      matchScore,
      verifiedAt: new Date(),
      qoreIdVerificationId: verificationId,
      faceMatchPassed: true,
      nameMatchPassed: true,
      ninData: ninData,
      verificationCount: (this.ninVerification?.verificationCount || 0) + 1
    };
  } else {
    this.ninVerification = {
      ...this.ninVerification,
      status: 'failed',
      matchScore,
      faceMatchPassed,
      nameMatchPassed,
      ninData: ninData,
      verificationCount: (this.ninVerification?.verificationCount || 0) + 1
    };
  }
  
  return isFullyVerified;
};

// ADD: Check if BVN verification is valid
userSchema.methods.isBvnVerified = function() {
  return this.bvnVerification?.status === 'verified' &&
         this.bvnVerification?.faceMatchPassed === true &&
         this.bvnVerification?.nameMatchPassed === true;
};

// ADD: Check if NIN verification is valid
userSchema.methods.isNinVerified = function() {
  return this.ninVerification?.status === 'verified' &&
         this.ninVerification?.faceMatchPassed === true &&
         this.ninVerification?.nameMatchPassed === true;
};

// ADD: Driver's License verification helper (separate from KYC)
userSchema.methods.updateDriversLicenseVerification = function(matchScore, verificationId, nameMatchPassed, driversLicenseData) {
  const MATCH_THRESHOLD = 70; // Industry standard
  const faceMatchPassed = matchScore >= MATCH_THRESHOLD;
  const isFullyVerified = faceMatchPassed && nameMatchPassed;
  
  if (isFullyVerified) {
    this.driversLicenseVerification = {
      status: 'verified',
      matchScore,
      verifiedAt: new Date(),
      qoreIdVerificationId: verificationId,
      faceMatchPassed: true,
      nameMatchPassed: true,
      driversLicenseData: driversLicenseData,
      verificationCount: (this.driversLicenseVerification?.verificationCount || 0) + 1
    };
  } else {
    this.driversLicenseVerification = {
      ...this.driversLicenseVerification,
      status: 'failed',
      matchScore,
      faceMatchPassed,
      nameMatchPassed,
      driversLicenseData: driversLicenseData,
      verificationCount: (this.driversLicenseVerification?.verificationCount || 0) + 1
    };
  }
  
  return isFullyVerified;
};

// ADD: Check if Driver's License verification is valid
userSchema.methods.isDriversLicenseVerified = function() {
  return this.driversLicenseVerification?.status === 'verified' &&
         this.driversLicenseVerification?.faceMatchPassed === true &&
         this.driversLicenseVerification?.nameMatchPassed === true;
};

// ADD: Check if Driver's License verification is valid
userSchema.methods.isDriversLicenseVerified = function() {
  return this.driversLicenseVerification?.status === 'verified' &&
         this.driversLicenseVerification?.faceMatchPassed === true &&
         this.driversLicenseVerification?.nameMatchPassed === true;
};

// ADD: Passport verification helper (separate from KYC)
userSchema.methods.updatePassportVerification = function(matchScore, verificationId, nameMatchPassed, passportData) {
  const MATCH_THRESHOLD = 70; // Industry standard
  const faceMatchPassed = matchScore >= MATCH_THRESHOLD;
  const isFullyVerified = faceMatchPassed && nameMatchPassed;
  
  if (isFullyVerified) {
    this.passportVerification = {
      status: 'verified',
      matchScore,
      verifiedAt: new Date(),
      qoreIdVerificationId: verificationId,
      faceMatchPassed: true,
      nameMatchPassed: true,
      passportData: passportData,
      verificationCount: (this.passportVerification?.verificationCount || 0) + 1
    };
  } else {
    this.passportVerification = {
      ...this.passportVerification,
      status: 'failed',
      matchScore,
      faceMatchPassed,
      nameMatchPassed,
      passportData: passportData,
      verificationCount: (this.passportVerification?.verificationCount || 0) + 1
    };
  }
  
  return isFullyVerified;
};

// ADD: Check if Passport verification is valid
userSchema.methods.isPassportVerified = function() {
  return this.passportVerification?.status === 'verified' &&
         this.passportVerification?.faceMatchPassed === true &&
         this.passportVerification?.nameMatchPassed === true;
};

// ADD: Check if Address verification is valid
userSchema.methods.isAddressVerified = function() {
  return this.addressVerification?.status === 'verified';
};

// ADD: Auto-approve KYC Level 2 when any identity verification is complete (NIN, Driver's License, or Passport)
userSchema.methods.autoApproveKycLevel2 = function() {
  // Auto-approve if any identity document is verified and KYC level 2 is not already approved
  const isNinVerified = this.isNinVerified();
  const isDriversLicenseVerified = this.isDriversLicenseVerified();
  const isPassportVerified = this.isPassportVerified();
  const hasIdentityVerification = isNinVerified || isDriversLicenseVerified || isPassportVerified;
  const isLevel2Eligible = this.kycLevel < 2 && hasIdentityVerification;
  
  if (isLevel2Eligible) {
    this.kycLevel = 2;
    this.kycStatus = 'approved';
    
    // Determine document type based on what's verified
    let documentType = 'Unknown';
    let documentNumber = null;
    
    if (isNinVerified) {
      documentType = 'NIN';
      documentNumber = this.nin;
    } else if (isDriversLicenseVerified) {
      documentType = 'Driver\'s License';
      documentNumber = this.driversLicense;
    } else if (isPassportVerified) {
      documentType = 'Passport';
      documentNumber = this.passport;
    }
    
    // Update level 2 KYC status
    this.kyc.level2.status = 'approved';
    this.kyc.level2.approvedAt = new Date();
    this.kyc.level2.documentType = documentType;
    this.kyc.level2.documentNumber = documentNumber;
    
    return true;
  }
  
  return false;
};

// ADD: Auto-approve KYC Level 3 when address verification is complete
userSchema.methods.autoApproveKycLevel3 = function() {
  // Auto-approve if BVN and Address verification are complete and KYC level 3 is not already approved
  const isBvnVerified = this.isBvnVerified();
  const isAddressVerified = this.isAddressVerified();
  const isLevel3Eligible = this.kycLevel < 3 && isBvnVerified && isAddressVerified;
  
  if (isLevel3Eligible) {
    this.kycLevel = 3;
    this.kycStatus = 'approved';
    
    // Update level 3 KYC status
    this.kyc.level3.status = 'approved';
    this.kyc.level3.approvedAt = new Date();
    this.kyc.level3.addressVerified = true;
    
    return true;
  }
  
  return false;
};

// ADD: Check if user can apply for specific KYC level
userSchema.methods.canApplyForKycLevel = function(level) {
  const requirements = {
    1: {
      bvnRequired: false,
      ninRequired: false,
      addressRequired: false,
      description: 'Basic verification - no identity documents required'
    },
    2: {
      bvnRequired: false,
      ninRequired: false, // Any identity document (NIN, Driver's License, or Passport)
      addressRequired: false,
      description: 'Identity verification - NIN, Driver\'s License, or Passport verification required'
    },
    3: {
      bvnRequired: true,
      ninRequired: false,
      addressRequired: true,
      description: 'Enhanced verification - BVN and Address verification required'
    }
  };
  
  const requirement = requirements[level];
  if (!requirement) return { canApply: false, reason: 'Invalid KYC level' };
  
  // For level 2, any identity verification is acceptable
  if (level === 2) {
    const hasIdentityVerification = this.isNinVerified() || this.isDriversLicenseVerified() || this.isPassportVerified();
    
    if (!hasIdentityVerification) {
      return { 
        canApply: false, 
        reason: 'Identity verification required. Please complete NIN, Driver\'s License, or Passport verification.' 
      };
    }
  }
  
  // For level 3, BVN verification is specifically required
  if (requirement.bvnRequired && !this.isBvnVerified()) {
    return { 
      canApply: false, 
      reason: 'BVN verification required before applying for this KYC level' 
    };
  }
  
  // For level 3, address verification is specifically required
  if (requirement.addressRequired && !this.isAddressVerified()) {
    return { 
      canApply: false, 
      reason: 'Address verification required before applying for this KYC level' 
    };
  }
  
  return { canApply: true, description: requirement.description };
};

module.exports = mongoose.model('User', userSchema);