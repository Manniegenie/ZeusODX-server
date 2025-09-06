// models/KYC.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const STATUS = ['APPROVED', 'REJECTED', 'PROVISIONAL', 'PENDING'];

const KYCSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    provider: { type: String, default: 'smile-id', index: true },
    environment: { type: String, enum: ['sandbox', 'production', 'unknown'], default: 'unknown' },

    partnerJobId: { type: String, index: true },
    jobType: { type: String },

    // ❌ remove inline index/sparse here
    smileJobId: { type: String },

    jobComplete: { type: Boolean },
    jobSuccess: { type: Boolean },

    status: { type: String, enum: STATUS, default: 'PROVISIONAL', index: true },
    resultCode: { type: String, index: true },
    resultText: { type: String },

    actions: { type: Schema.Types.Mixed },

    country: { type: String },
    idType: { type: String },
    idNumber: { type: String, index: true, sparse: true },

    fullName: { type: String },
    dob: { type: String },
    expiresAt: { type: String },

    imageLinks: { type: Schema.Types.Mixed },
    history: { type: [Schema.Types.Mixed] },

    signature: { type: String },
    signatureValid: { type: Boolean, default: false },
    providerTimestamp: { type: Date },

    payload: { type: Schema.Types.Mixed },

    provisionalReason: { type: String },
    errorReason: { type: String },
  },
  { timestamps: true }
);

// ✅ define indexes only here
KYCSchema.index(
  { smileJobId: 1 },
  // Prefer partial filter to sparse for uniques
  { unique: true, partialFilterExpression: { smileJobId: { $exists: true, $type: 'string' } } }
);

KYCSchema.index(
  { userId: 1, partnerJobId: 1 },
  { unique: true, partialFilterExpression: { partnerJobId: { $type: 'string' } } }
);

KYCSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.models.KYC || mongoose.model('KYC', KYCSchema);
