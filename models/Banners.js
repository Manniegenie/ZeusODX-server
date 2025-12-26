const mongoose = require('mongoose');

const bannerSchema = new mongoose.Schema({
  title: { type: String, required: true },
  imageUrl: { type: String, required: true }, // Just the URL string
  link: { type: String },                    // e.g., '/user/Swap'
  isActive: { type: Boolean, default: true },
  priority: { type: Number, default: 0 }     // Higher numbers show first
}, { timestamps: true });

// DATABASE CONDITION: Limit to 4 banners max
bannerSchema.pre('save', async function (next) {
  if (this.isNew) {
    const bannerCount = await mongoose.model('Banner').countDocuments();
    if (bannerCount >= 4) {
      const error = new Error('Limit reached: You can only have a maximum of 4 banners.');
      return next(error);
    }
  }
  next();
});

module.exports = mongoose.model('Banner', bannerSchema);