// models/kyc.js
const mongoose = require('mongoose');

const kycSchema = new mongoose.Schema({
  // User reference
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // NIN Verification
  ninVerification: {
    status: {
      type: String,
      enum: ['not_submitted', 'pending', 'verified', 'failed'],
      default: 'not_submitted'
    },
    ninNumber: String,
    
    // Face verification results
    faceMatch: {
      score: { type: Number, min: 0, max: 100 },
      threshold: { type: Number, default: 70 },
      passed: { type: Boolean, default: false }
    },
    
    // Digital identity verification results
    digitalMatch: {
      firstnameMatch: { type: Boolean, default: false },
      lastnameMatch: { type: Boolean, default: false },
      phoneMatch: { type: Boolean, default: false },
      emailMatch: { type: Boolean, default: false },
      genderMatch: { type: Boolean, default: false },
      dobMatch: { type: Boolean, default: false },
      overallScore: { type: Number, min: 0, max: 100 },
      passed: { type: Boolean, default: false }
    },

    // Combined verification result
    combinedScore: { type: Number, min: 0, max: 100 }, // Average of face + digital
    overallPassed: { type: Boolean, default: false },   // Both face + digital >= 70%
    
    // Verification metadata
    verificationId: String, // QoreID verification ID
    submittedAt: { type: Date, default: Date.now },
    verifiedAt: Date,
    attempts: { type: Number, default: 0 },
    
    // Official NIN data from NIMC
    officialData: {
      title: String,
      firstname: String,
      lastname: String,
      phone: String,
      email: String,
      gender: String,
      height: String,
      profession: String,
      maritalStatus: String,
      employmentStatus: String,
      birthdate: String,
      birthState: String,
      birthCountry: String,
      nextOfKin: Object,
      nativeLanguage: String,
      otherLanguage: String,
      religion: String,
      residence: Object,
      lgaOfOrigin: String,
      placeOfOrigin: String,
      stateOfOrigin: String,
      trackingId: String
    },
    
    // Selfie storage
    selfie: {
      cloudinaryUrl: String,
      cloudinaryPublicId: String,
      uploadedAt: Date,
      fileSize: Number,
      format: String
    }
  },

  // Driver's License Verification
  driversLicenseVerification: {
    status: {
      type: String,
      enum: ['not_submitted', 'pending', 'verified', 'failed'],
      default: 'not_submitted'
    },
    licenseNumber: String,
    
    // Face verification results
    faceMatch: {
      score: { type: Number, min: 0, max: 100 },
      threshold: { type: Number, default: 70 },
      passed: { type: Boolean, default: false }
    },
    
    // Digital identity verification results
    digitalMatch: {
      firstnameMatch: { type: Boolean, default: false },
      lastnameMatch: { type: Boolean, default: false },
      dobMatch: { type: Boolean, default: false },
      genderMatch: { type: Boolean, default: false },
      overallScore: { type: Number, min: 0, max: 100 },
      passed: { type: Boolean, default: false }
    },

    // Combined verification result
    combinedScore: { type: Number, min: 0, max: 100 },
    overallPassed: { type: Boolean, default: false },
    
    // Verification metadata
    verificationId: String,
    submittedAt: { type: Date, default: Date.now },
    verifiedAt: Date,
    attempts: { type: Number, default: 0 },
    
    // Official license data
    officialData: {
      firstname: String,
      lastname: String,
      dateOfBirth: String,
      gender: String,
      issueDate: String,
      expiryDate: String,
      licenseClass: String,
      stateOfIssue: String,
      address: String
    },
    
    // Selfie storage
    selfie: {
      cloudinaryUrl: String,
      cloudinaryPublicId: String,
      uploadedAt: Date,
      fileSize: Number,
      format: String
    }
  },

  // Passport Verification
  passportVerification: {
    status: {
      type: String,
      enum: ['not_submitted', 'pending', 'verified', 'failed'],
      default: 'not_submitted'
    },
    passportNumber: String,
    
    // Face verification results
    faceMatch: {
      score: { type: Number, min: 0, max: 100 },
      threshold: { type: Number, default: 70 },
      passed: { type: Boolean, default: false }
    },
    
    // Digital identity verification results
    digitalMatch: {
      firstnameMatch: { type: Boolean, default: false },
      lastnameMatch: { type: Boolean, default: false },
      dobMatch: { type: Boolean, default: false },
      genderMatch: { type: Boolean, default: false },
      nationalityMatch: { type: Boolean, default: false },
      overallScore: { type: Number, min: 0, max: 100 },
      passed: { type: Boolean, default: false }
    },

    // Combined verification result
    combinedScore: { type: Number, min: 0, max: 100 },
    overallPassed: { type: Boolean, default: false },
    
    // Verification metadata
    verificationId: String,
    submittedAt: { type: Date, default: Date.now },
    verifiedAt: Date,
    attempts: { type: Number, default: 0 },
    
    // Official passport data
    officialData: {
      firstname: String,
      lastname: String,
      middlename: String,
      dateOfBirth: String,
      gender: String,
      nationality: String,
      passportType: String,
      issueDate: String,
      expiryDate: String,
      placeOfIssue: String,
      issuingAuthority: String
    },
    
    // Selfie storage
    selfie: {
      cloudinaryUrl: String,
      cloudinaryPublicId: String,
      uploadedAt: Date,
      fileSize: Number,
      format: String
    }
  },

  // Voters Card Verification (future implementation)
  votersCardVerification: {
    status: {
      type: String,
      enum: ['not_submitted', 'pending', 'verified', 'failed'],
      default: 'not_submitted'
    },
    votersCardNumber: String,
    // Similar structure to other verifications...
  },

  // Overall KYC Status
  overallKycScore: { type: Number, min: 0, max: 100, default: 0 },
  highestVerificationLevel: { type: Number, min: 0, max: 3, default: 0 },
  
  // Tracking
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Update the updatedAt field before saving
kycSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Index for efficient queries
kycSchema.index({ userId: 1 }, { unique: true });

// KYC Methods

/**
 * Updates NIN verification with combined face + digital verification
 * @param {Object} verificationData - Complete verification data
 * @returns {boolean} Whether user should be upgraded to KYC Level 2
 */
kycSchema.methods.updateNinVerification = function(verificationData) {
  const {
    ninNumber,
    faceMatchScore,
    digitalMatchData,
    verificationId,
    officialData,
    selfieData
  } = verificationData;

  // Update face match data
  this.ninVerification.faceMatch.score = faceMatchScore;
  this.ninVerification.faceMatch.passed = faceMatchScore >= 70;

  // Update digital match data
  this.ninVerification.digitalMatch = {
    firstnameMatch: digitalMatchData.firstnameMatch,
    lastnameMatch: digitalMatchData.lastnameMatch,
    phoneMatch: digitalMatchData.phoneMatch || false,
    emailMatch: digitalMatchData.emailMatch || false,
    genderMatch: digitalMatchData.genderMatch || false,
    dobMatch: digitalMatchData.dobMatch || false,
    overallScore: digitalMatchData.overallScore,
    passed: digitalMatchData.overallScore >= 70
  };

  // Calculate combined score (face 60% + digital 40%)
  const combinedScore = (faceMatchScore * 0.6) + (digitalMatchData.overallScore * 0.4);
  this.ninVerification.combinedScore = combinedScore;
  
  // Overall pass requires both face AND digital to be >= 70%
  const overallPassed = this.ninVerification.faceMatch.passed && 
                       this.ninVerification.digitalMatch.passed;
  this.ninVerification.overallPassed = overallPassed;

  if (overallPassed) {
    this.ninVerification.status = 'verified';
    this.ninVerification.verifiedAt = new Date();
    this.ninVerification.ninNumber = ninNumber;
    this.ninVerification.verificationId = verificationId;
    this.ninVerification.officialData = officialData;
    this.ninVerification.selfie = selfieData;
    
    // Update overall KYC metrics
    this.overallKycScore = Math.max(this.overallKycScore, combinedScore);
    this.highestVerificationLevel = Math.max(this.highestVerificationLevel, 2);
    
    return true; // Should upgrade to KYC Level 2
  } else {
    this.ninVerification.status = 'failed';
    return false;
  }
};

/**
 * Updates Driver's License verification
 * @param {Object} verificationData - Complete verification data
 * @returns {boolean} Whether user should be upgraded to KYC Level 2
 */
kycSchema.methods.updateDriversLicenseVerification = function(verificationData) {
  const {
    licenseNumber,
    faceMatchScore,
    digitalMatchData,
    verificationId,
    officialData,
    selfieData
  } = verificationData;

  // Similar logic to NIN verification
  this.driversLicenseVerification.faceMatch.score = faceMatchScore;
  this.driversLicenseVerification.faceMatch.passed = faceMatchScore >= 70;

  this.driversLicenseVerification.digitalMatch = {
    firstnameMatch: digitalMatchData.firstnameMatch,
    lastnameMatch: digitalMatchData.lastnameMatch,
    dobMatch: digitalMatchData.dobMatch || false,
    genderMatch: digitalMatchData.genderMatch || false,
    overallScore: digitalMatchData.overallScore,
    passed: digitalMatchData.overallScore >= 70
  };

  const combinedScore = (faceMatchScore * 0.6) + (digitalMatchData.overallScore * 0.4);
  this.driversLicenseVerification.combinedScore = combinedScore;
  
  const overallPassed = this.driversLicenseVerification.faceMatch.passed && 
                       this.driversLicenseVerification.digitalMatch.passed;
  this.driversLicenseVerification.overallPassed = overallPassed;

  if (overallPassed) {
    this.driversLicenseVerification.status = 'verified';
    this.driversLicenseVerification.verifiedAt = new Date();
    this.driversLicenseVerification.licenseNumber = licenseNumber;
    this.driversLicenseVerification.verificationId = verificationId;
    this.driversLicenseVerification.officialData = officialData;
    this.driversLicenseVerification.selfie = selfieData;
    
    this.overallKycScore = Math.max(this.overallKycScore, combinedScore);
    this.highestVerificationLevel = Math.max(this.highestVerificationLevel, 2);
    
    return true; // Should upgrade to KYC Level 2
  } else {
    this.driversLicenseVerification.status = 'failed';
    return false;
  }
};

/**
 * Updates Passport verification
 * @param {Object} verificationData - Complete verification data
 * @returns {boolean} Whether user should be upgraded to KYC Level 2
 */
kycSchema.methods.updatePassportVerification = function(verificationData) {
  const {
    passportNumber,
    faceMatchScore,
    digitalMatchData,
    verificationId,
    officialData,
    selfieData
  } = verificationData;

  this.passportVerification.faceMatch.score = faceMatchScore;
  this.passportVerification.faceMatch.passed = faceMatchScore >= 70;

  this.passportVerification.digitalMatch = {
    firstnameMatch: digitalMatchData.firstnameMatch,
    lastnameMatch: digitalMatchData.lastnameMatch,
    dobMatch: digitalMatchData.dobMatch || false,
    genderMatch: digitalMatchData.genderMatch || false,
    nationalityMatch: digitalMatchData.nationalityMatch || false,
    overallScore: digitalMatchData.overallScore,
    passed: digitalMatchData.overallScore >= 70
  };

  const combinedScore = (faceMatchScore * 0.6) + (digitalMatchData.overallScore * 0.4);
  this.passportVerification.combinedScore = combinedScore;
  
  const overallPassed = this.passportVerification.faceMatch.passed && 
                       this.passportVerification.digitalMatch.passed;
  this.passportVerification.overallPassed = overallPassed;

  if (overallPassed) {
    this.passportVerification.status = 'verified';
    this.passportVerification.verifiedAt = new Date();
    this.passportVerification.passportNumber = passportNumber;
    this.passportVerification.verificationId = verificationId;
    this.passportVerification.officialData = officialData;
    this.passportVerification.selfie = selfieData;
    
    this.overallKycScore = Math.max(this.overallKycScore, combinedScore);
    this.highestVerificationLevel = Math.max(this.highestVerificationLevel, 2);
    
    return true; // Should upgrade to KYC Level 2
  } else {
    this.passportVerification.status = 'failed';
    return false;
  }
};

/**
 * Checks if user has any verified identity document
 * @returns {boolean} Whether user has at least one verified document
 */
kycSchema.methods.hasVerifiedIdentity = function() {
  return this.ninVerification.overallPassed || 
         this.driversLicenseVerification.overallPassed || 
         this.passportVerification.overallPassed;
};

/**
 * Gets the best verification score across all documents
 * @returns {number} Highest combined score
 */
kycSchema.methods.getBestVerificationScore = function() {
  const scores = [
    this.ninVerification.combinedScore || 0,
    this.driversLicenseVerification.combinedScore || 0,
    this.passportVerification.combinedScore || 0
  ];
  return Math.max(...scores);
};

/**
 * Gets verification summary for user
 * @returns {Object} Complete verification summary
 */
kycSchema.methods.getVerificationSummary = function() {
  return {
    hasVerifiedIdentity: this.hasVerifiedIdentity(),
    bestScore: this.getBestVerificationScore(),
    overallKycScore: this.overallKycScore,
    highestVerificationLevel: this.highestVerificationLevel,
    verifications: {
      nin: {
        status: this.ninVerification.status,
        passed: this.ninVerification.overallPassed,
        combinedScore: this.ninVerification.combinedScore,
        faceScore: this.ninVerification.faceMatch.score,
        digitalScore: this.ninVerification.digitalMatch.overallScore
      },
      driversLicense: {
        status: this.driversLicenseVerification.status,
        passed: this.driversLicenseVerification.overallPassed,
        combinedScore: this.driversLicenseVerification.combinedScore,
        faceScore: this.driversLicenseVerification.faceMatch.score,
        digitalScore: this.driversLicenseVerification.digitalMatch.overallScore
      },
      passport: {
        status: this.passportVerification.status,
        passed: this.passportVerification.overallPassed,
        combinedScore: this.passportVerification.combinedScore,
        faceScore: this.passportVerification.faceMatch.score,
        digitalScore: this.passportVerification.digitalMatch.overallScore
      }
    }
  };
};

module.exports = mongoose.model('KYC', kycSchema);