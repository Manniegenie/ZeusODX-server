const mongoose = require('mongoose');

const GlobalSwapMarkdownSchema = new mongoose.Schema({
  markdownPercentage: {
    type: Number,
    required: true,
    default: 0, // Global markdown percentage (e.g., 2.5 for 2.5% reduction)
    min: 0,
    max: 100,
  },
  isActive: {
    type: Boolean,
    default: true, // Whether markdown is currently active
  },
}, {
  timestamps: true,
});

// Ensure only one document exists
GlobalSwapMarkdownSchema.index({}, { unique: true });

// Method to apply markdown to reduce the amount user receives
GlobalSwapMarkdownSchema.methods.applyMarkdown = function(amount) {
  if (!this.isActive) return amount;
  
  // Apply markdown by reducing the amount: amount * (1 - markdown/100)
  return amount * (1 - this.markdownPercentage / 100);
};

// Static method to get the global markdown percentage
GlobalSwapMarkdownSchema.statics.getGlobalMarkdown = async function() {
  let config = await this.findOne();
  if (!config) {
    // Create default config if none exists
    config = await this.create({ markdownPercentage: 0, isActive: true });
  }
  return config;
};

// Static method to apply global markdown to an amount
GlobalSwapMarkdownSchema.statics.applyGlobalMarkdown = async function(amount) {
  const config = await this.getGlobalMarkdown();
  return config.applyMarkdown(amount);
};

// Static method to update global markdown
GlobalSwapMarkdownSchema.statics.updateGlobalMarkdown = async function(markdownPercentage, isActive = undefined) {
  let config = await this.findOne();
  if (!config) {
    config = new this({ markdownPercentage, isActive: isActive !== undefined ? isActive : true });
  } else {
    config.markdownPercentage = markdownPercentage;
    if (isActive !== undefined) config.isActive = isActive;
  }
  await config.save();
  return config;
};

module.exports = mongoose.model('GlobalSwapMarkdown', GlobalSwapMarkdownSchema);