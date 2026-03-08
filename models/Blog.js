const mongoose = require('mongoose');

const blogSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  excerpt: { type: String, trim: true },
  content: { type: String, required: true },
  coverImage: { type: String, default: null }, // Cloudinary URL
  coverImagePublicId: { type: String, default: null }, // Cloudinary public_id for deletion
  tags: [{ type: String, trim: true, lowercase: true }],
  author: { type: String, required: true, trim: true },
  isPublished: { type: Boolean, default: false },
  publishedAt: { type: Date, default: null },
  views: { type: Number, default: 0 },
}, { timestamps: true });

// Auto-generate slug from title if not provided
blogSchema.pre('validate', function (next) {
  if (!this.slug && this.title) {
    this.slug = this.title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim('-');
  }
  next();
});

// Set publishedAt when post is first published
blogSchema.pre('save', function (next) {
  if (this.isModified('isPublished') && this.isPublished && !this.publishedAt) {
    this.publishedAt = new Date();
  }
  next();
});

module.exports = mongoose.model('Blog', blogSchema);
