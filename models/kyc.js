// ../models/KYC.js
const mongoose = require('mongoose');

const { Schema } = mongoose;

const STATUS = ['APPROVED', 'REJECTED', 'PROVISIONAL', 'PENDING'];

const KYCSchema = new Schema(
  {
    // Who is this KYC for
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // Provider/meta
    provider: { type: String, default: 'smile-id', index: true },
    environment: { type: String, enum: ['sandbox', 'production', 'unknown'], default: 'unknown' },

    // Idempotency keys / linkage
    partnerJobId: { type: String, index: true },       // PartnerParams.job_id
    jobType: { type: String },                         // PartnerParams.job_type / product
    smileJobId: { type: String, index: true, sparse: true }, // SmileJobID

    // Job lifecycle
    jobComplete: { type: Boolean },
    jobSuccess: { type: Boolean },

    // Result summary
    status: { type: String, enum: STATUS, default: 'PROVISIONAL', index: true },
    resultCode: { type: String, index: true },
    resultText: { type: String },

    // Detailed actions / signals
    actions: { type: Schema.Types.Mixed },             // e.g. { Verify_Document: "Passed", ... }

    // Personal/ID info returned
    country: { type: String },
    idType: { type: String },
    idNumber: { type: String, index: true, sparse: true },
    fullName: { type: String },
    dob: { type: String },                             // keep as string; formats vary
    expiresAt: { type: String },                       // doc expiry (string for flexibility)

    // Media/trace
    imageLinks: { type: Schema.Types.Mixed },          // array/object as sent
    history: { type: [Schema.Types.Mixed] },           // optional history entries

    // Signature & timing
    signature: { type: String },
    signatureValid: { type: Boolean, default: false },
    providerTimestamp: { type: Date },                 // parsed from payload.timestamp if present

    // Full raw payload for audit/debug (1–2 MB typical; ensure JSON body limit)
    payload: { type: Schema.Types.Mixed },

    // Convenience flags
    provisionalReason: { type: String },               // optional note (e.g., awaiting review)
    errorReason: { type: String },                     // if failed parsing/verification
  },
  { timestamps: true }
);

// Idempotency/indexing:
// 1) Unique when SmileJobID exists
KYCSchema.index({ smileJobId: 1 }, { unique: true, sparse: true });

// 2) For flows without SmileJobID, dedupe by (userId + partnerJobId)
KYCSchema.index(
  { userId: 1, partnerJobId: 1 },
  { unique: true, partialFilterExpression: { partnerJobId: { $type: 'string' } } }
);

// 3) Useful query patterns
KYCSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('KYC', KYCSchema);
