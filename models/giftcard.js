const mongoose = require('mongoose');

const giftCardSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  cardType: { type: String, required: true },
  cardFormat: { type: String, required: true, index: true },
  country: { type: String, required: true },

  eCode: { type: String, trim: true, default: null, sparse: true },
  cardRange: { type: String, required: true, trim: true },
  cardValue: { type: Number, required: true, index: true },
  currency: { type: String, required: true, default: 'USD', index: true },
  description: { type: String, trim: true },

  // Updated for multiple images
  imageUrls: [{ type: String }],
  imagePublicIds: [{ type: String }],
  totalImages: { type: Number, default: 0 },

  // Rate calculation fields
  expectedRate: { type: Number, required: true },
  expectedRateDisplay: { type: String, required: true },
  expectedAmountToReceive: { type: Number, required: true },
  expectedSourceCurrency: { type: String, required: true },
  expectedTargetCurrency: { type: String, required: true },
  giftCardRateId: { type: mongoose.Schema.Types.ObjectId, ref: 'GiftCardPrice', required: true },

  status: { type: String, default: 'PENDING' },

  vanillaType: { type: String, default: null },

  // Admin review data
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  reviewNotes: { type: String, trim: true },
  rejectionReason: { type: String, default: null },

  // Payment processing
  approvedValue: { type: Number, default: null },
  paymentRate: { type: Number, default: null },
  paymentAmount: { type: Number, default: null },
  paidAt: { type: Date, default: null },
  paymentReference: { type: String, trim: true, default: null },

  transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },

  metadata: {
    submittedAt: { type: Date, default: Date.now },
    imagesMetadata: [{
      originalName: String,
      format: String,
      width: Number,
      height: Number,
      bytes: Number,
      url: String,
      publicId: String
    }],
    userAgent: { type: String, default: null },
    ipAddress: { type: String, default: null }
  }
}, {
  timestamps: true
});

// Compound Indexes
giftCardSchema.index({ userId: 1, status: 1 });
giftCardSchema.index({ cardType: 1, country: 1, status: 1 });
giftCardSchema.index({ status: 1, createdAt: -1 });
giftCardSchema.index({ giftCardRateId: 1 });
giftCardSchema.index({ transactionId: 1 });
giftCardSchema.index({ cardType: 1, vanillaType: 1, status: 1 });

// Virtual for checking if has images
giftCardSchema.virtual('hasImages').get(function() {
  return this.imageUrls && this.imageUrls.length > 0;
});

module.exports = mongoose.model('GiftCard', giftCardSchema);
