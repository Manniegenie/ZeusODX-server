const mongoose = require('mongoose');

const giftCardSchema = new mongoose.Schema({
  // REMOVED index: true since we have compound index { userId: 1, status: 1 }
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  
  // UPDATED: Fixed cardType enum to match endpoint exactly
  cardType: {
    type: String, required: true,
    enum: ['APPLE', 'STEAM', 'NORDSTROM', 'MACY', 'NIKE', 'GOOGLE_PLAY', 'AMAZON', 'VISA', 'VANILLA', 'RAZOR_GOLD', 'AMERICAN_EXPRESS', 'SEPHORA', 'FOOTLOCKER', 'XBOX', 'EBAY']
  },
  
  // Keep index: true - not covered by compound indexes
  cardFormat: { type: String, required: true, enum: ['PHYSICAL', 'E_CODE'], index: true },
  
  // REMOVED index: true since we have compound index { cardType: 1, country: 1, status: 1 }
  country: { type: String, required: true, enum: ['US', 'CANADA', 'AUSTRALIA', 'SWITZERLAND'] },
  
  // UPDATED: Added minlength: 5 to match endpoint validation (5-100 characters)
  eCode: { type: String, trim: true, minlength: 5, maxlength: 100, default: null, sparse: true },
  cardRange: { type: String, required: true, trim: true, maxlength: 50 },
  
  // Keep index: true - useful for value-based queries
  cardValue: { type: Number, required: true, min: 5, max: 2000, index: true },
  
  // Keep index: true - useful for currency-based queries
  currency: { type: String, required: true, enum: ['USD', 'NGN', 'GBP', 'EUR', 'CAD'], default: 'USD', index: true },
  description: { type: String, trim: true, maxlength: 500 },
  
  // Updated for multiple images
  imageUrls: [{ type: String }], // Array of image URLs
  imagePublicIds: [{ type: String }], // Array of Cloudinary public IDs
  totalImages: { type: Number, default: 0, min: 0, max: 20 },
  
  // Rate calculation fields
  expectedRate: { type: Number, required: true, min: 0 },
  expectedRateDisplay: { type: String, required: true },
  expectedAmountToReceive: { type: Number, required: true, min: 0 },
  expectedSourceCurrency: { type: String, required: true },
  expectedTargetCurrency: { type: String, required: true },
  giftCardRateId: { type: mongoose.Schema.Types.ObjectId, ref: 'GiftCardPrice', required: true },
  
  // REMOVED index: true since we have multiple compound indexes with status
  status: { type: String, enum: ['PENDING', 'REVIEWING', 'APPROVED', 'REJECTED', 'PAID'], default: 'PENDING' },
  
  // NEW: Added vanillaType field to support VANILLA cards
  vanillaType: { 
    type: String, 
    enum: ['4097', '4118'],
    default: null
  },
  
  // Admin review data
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  reviewNotes: { type: String, trim: true, maxlength: 1000 },
  rejectionReason: { 
    type: String, 
    enum: ['INVALID_IMAGE', 'ALREADY_USED', 'INSUFFICIENT_BALANCE', 'FAKE_CARD', 'UNREADABLE', 'WRONG_TYPE', 'EXPIRED', 'INVALID_ECODE', 'DUPLICATE_ECODE', 'OTHER'],
    default: null 
  },
  
  // Payment processing
  approvedValue: { type: Number, min: 0, default: null },
  paymentRate: { type: Number, min: 0, max: 1, default: null },
  paymentAmount: { type: Number, min: 0, default: null },
  paidAt: { type: Date, default: null },
  paymentReference: { type: String, trim: true, default: null },
  
  // REMOVED index: true since we have dedicated compound index { giftCardRateId: 1 }
  transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
  
  metadata: {
    submittedAt: { type: Date, default: Date.now },
    // Updated for multiple images metadata
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

// Compound Indexes (these cover the removed single-field indexes efficiently)
giftCardSchema.index({ userId: 1, status: 1 });                    // Covers userId queries
giftCardSchema.index({ cardType: 1, country: 1, status: 1 });      // Covers cardType, country queries
giftCardSchema.index({ status: 1, createdAt: -1 });                // Covers status queries with sorting
giftCardSchema.index({ giftCardRateId: 1 });                       // For rate lookups
giftCardSchema.index({ transactionId: 1 });                        // For transaction lookups
// NEW: Index for vanilla type queries
giftCardSchema.index({ cardType: 1, vanillaType: 1, status: 1 });  // For VANILLA card queries

// Validation
giftCardSchema.pre('save', function(next) {
  if (this.cardFormat === 'E_CODE' && (!this.eCode || this.eCode.trim().length === 0)) {
    return next(new Error('E-code is required when card format is E_CODE'));
  }
  if (this.cardFormat === 'PHYSICAL') this.eCode = null;
  if (this.cardFormat === 'PHYSICAL' && (!this.imageUrls || this.imageUrls.length === 0)) {
    return next(new Error('At least one image is required for physical cards'));
  }
  
  // NEW: Validate vanillaType for VANILLA cards
  if (this.cardType === 'VANILLA' && !this.vanillaType) {
    return next(new Error('vanillaType is required for VANILLA gift cards'));
  }
  if (this.cardType !== 'VANILLA' && this.vanillaType) {
    return next(new Error('vanillaType can only be specified for VANILLA gift cards'));
  }
  
  // Update totalImages count
  this.totalImages = this.imageUrls ? this.imageUrls.length : 0;
  
  next();
});

// Virtual for checking if has images
giftCardSchema.virtual('hasImages').get(function() {
  return this.imageUrls && this.imageUrls.length > 0;
});

module.exports = mongoose.model('GiftCard', giftCardSchema);