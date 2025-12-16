// models/KYC.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const STATUS = ['APPROVED', 'REJECTED', 'PROVISIONAL', 'PENDING', 'CANCELLED'];

const KYCSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    provider: { type: String, default: 'youverify', index: true },
    environment: { type: String, enum: ['sandbox', 'production', 'development', 'unknown'], default: 'unknown' },

    partnerJobId: { type: String, index: true },
    jobType: { type: Number, default: 1 }, // 1 = Biometric KYC

    youverifyId: { type: String },
    smileJobId: { type: String }, // Kept for backward compatibility

    jobComplete: { type: Boolean },
    jobSuccess: { type: Boolean },

    status: { type: String, enum: STATUS, default: 'PROVISIONAL', index: true },
    resultCode: { type: String, index: true },
    resultText: { type: String },

    // Youverify-specific fields
    passed: { type: Boolean },
    allValidationPassed: { type: Boolean },
    method: { type: String }, // e.g., 'liveness', 'documentCapture', 'vForm'
    components: [{ type: String }], // e.g., ['liveness', 'id_capture']
    businessId: { type: String },
    requestedById: { type: String },
    parentId: { type: String },

    actions: { type: Schema.Types.Mixed },

    // Document Information (populated when approved)
    country: { type: String, default: 'NG' },
    idType: { type: String }, // Youverify type (passport, nin, drivers-license, etc.)
    frontendIdType: { type: String }, // Our frontend type (bvn, national_id, etc.)
    idNumber: { type: String, index: true, sparse: true },

    // Personal Information from Document
    fullName: { type: String },
    firstName: { type: String }, // Parsed from fullName if available
    lastName: { type: String },  // Parsed from fullName if available
    middleName: { type: String },
    dateOfBirth: { type: String }, // YYYY-MM-DD format
    gender: { type: String, enum: ['Male', 'Female', 'M', 'F', null], default: null },
    documentExpiryDate: { type: String }, // Document expiration date
    documentIssueDate: { type: String },
    address: { type: String },

    // Verification Metadata
    confidenceValue: { type: String }, // Confidence score (if available)
    verificationDate: { type: Date, default: Date.now },
    lastUpdated: { type: Date, default: Date.now },

    // Image and Document Links
    imageLinks: { 
      type: {
        selfie_image: { type: String },
        liveness_images: [{ type: String }],
        document_image: { type: String },
        cropped_image: { type: String },
        // Youverify-specific image fields
        faceImage: { type: String },
        fullDocumentFrontImage: { type: String },
        fullDocumentBackImage: { type: String },
        signatureImage: { type: String }
      },
      default: null
    },
    history: { type: [Schema.Types.Mixed] },

    // Security and Validation
    signature: { type: String },
    signatureValid: { type: Boolean, default: false },
    providerTimestamp: { type: Date },

    // Raw payload from provider (for debugging)
    payload: { type: Schema.Types.Mixed },

    // Reasons for non-approved statuses
    provisionalReason: { type: String },
    errorReason: { type: String },

    // Cancellation metadata (added to preserve audit trail)
    cancelledAt: { type: Date, default: null },
    cancelledReason: { type: String, default: null },

    // Additional metadata for approved documents
    documentMetadata: {
      type: {
        issuingAuthority: { type: String },
        placeOfBirth: { type: String },
        documentSeries: { type: String },
        documentVersion: { type: String },
        faceMatch: { type: Boolean },
        livenessCheck: { type: Boolean },
        documentAuthenticity: { type: Boolean }
      },
      default: null
    }
  },
  { timestamps: true }
);

// Indexes for performance and uniqueness
KYCSchema.index(
  { youverifyId: 1 },
  { unique: true, sparse: true, partialFilterExpression: { youverifyId: { $exists: true, $type: 'string' } } }
);
KYCSchema.index(
  { smileJobId: 1 },
  { unique: true, sparse: true, partialFilterExpression: { smileJobId: { $exists: true, $type: 'string' } } }
);

KYCSchema.index(
  { userId: 1, partnerJobId: 1 },
  { unique: true, partialFilterExpression: { partnerJobId: { $type: 'string' } } }
);

KYCSchema.index({ userId: 1, createdAt: -1 });
KYCSchema.index({ userId: 1, status: 1 });
KYCSchema.index({ idNumber: 1, status: 1 }, { sparse: true });

// Instance Methods
KYCSchema.methods.isApproved = function() {
  return this.status === 'APPROVED';
};

KYCSchema.methods.isRejected = function() {
  return this.status === 'REJECTED';
};

KYCSchema.methods.isProvisional = function() {
  return this.status === 'PROVISIONAL';
};

KYCSchema.methods.getDocumentInfo = function() {
  if (!this.isApproved()) {
    return null;
  }
  
  return {
    idType: this.frontendIdType || this.idType,
    idNumber: this.idNumber,
    fullName: this.fullName,
    firstName: this.firstName,
    lastName: this.lastName,
    dateOfBirth: this.dateOfBirth,
    gender: this.gender,
    expiryDate: this.documentExpiryDate,
    verificationDate: this.verificationDate,
    confidenceScore: this.confidenceValue,
    country: this.country
  };
};

// Static Methods
KYCSchema.statics.findApprovedByUserId = function(userId) {
  return this.find({ userId, status: 'APPROVED' }).sort({ createdAt: -1 });
};

KYCSchema.statics.findLatestByUserId = function(userId) {
  return this.findOne({ userId }).sort({ createdAt: -1 });
};

KYCSchema.statics.countByStatus = function(status) {
  return this.countDocuments({ status });
};

// Middleware
KYCSchema.pre('save', function(next) {
  this.lastUpdated = new Date();
  
  // Parse fullName into firstName and lastName if not already set
  if (this.fullName && (!this.firstName || !this.lastName)) {
    const nameParts = this.fullName.trim().split(' ');
    if (nameParts.length >= 2) {
      this.firstName = nameParts[0];
      this.lastName = nameParts.slice(1).join(' ');
    } else if (nameParts.length === 1) {
      this.firstName = nameParts[0];
    }
  }
  
  next();
});

// Virtual for full document summary
KYCSchema.virtual('documentSummary').get(function() {
  return {
    id: this._id,
    userId: this.userId,
    status: this.status,
    idType: this.frontendIdType || this.idType,
    idNumber: this.idNumber ? this.idNumber.slice(0, 4) + '****' : null,
    fullName: this.fullName,
    verificationDate: this.verificationDate,
    resultCode: this.resultCode,
    confidenceValue: this.confidenceValue
  };
});

// Ensure virtual fields are serialized
KYCSchema.set('toJSON', { virtuals: true });
KYCSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.KYC || mongoose.model('KYC', KYCSchema);
