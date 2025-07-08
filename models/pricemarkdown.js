const mongoose = require('mongoose');

const globalMarkdownSchema = new mongoose.Schema({
  markdownPercentage: {
    type: Number,
    required: true,
    min: 0,
    max: 100,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  source: {
    type: String,
    enum: ['manual', 'automated', 'api'],
    default: 'manual'
  },
  updatedBy: {
    type: String,
    default: 'admin'
  },
  description: {
    type: String,
    default: 'Global markdown percentage for all assets'
  }
}, {
  timestamps: true
});

// Virtual to get formatted percentage
globalMarkdownSchema.virtual('formattedPercentage').get(function() {
  return `${this.markdownPercentage}%`;
});

// Method to calculate discounted price
globalMarkdownSchema.methods.calculateDiscountedPrice = function(originalPrice) {
  if (!this.isActive) return originalPrice;
  const discountAmount = (originalPrice * this.markdownPercentage) / 100;
  return originalPrice - discountAmount;
};

// Static method to get current global markdown
globalMarkdownSchema.statics.getCurrentMarkdown = function() {
  return this.findOne();
};

// Clean JSON output
globalMarkdownSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('GlobalMarkdown', globalMarkdownSchema);