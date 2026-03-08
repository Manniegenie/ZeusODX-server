const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const Blog = require('../models/Blog');
const logger = require('../utils/logger');

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer - memory storage (buffer passed directly to Cloudinary)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

// Upload image buffer to Cloudinary
function uploadToCloudinary(fileBuffer) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        folder: 'blog',
        transformation: [
          { width: 1200, height: 630, crop: 'limit' },
          { quality: 'auto' },
          { fetch_format: 'auto' },
        ],
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    ).end(fileBuffer);
  });
}

// DELETE image from Cloudinary
async function deleteFromCloudinary(publicId) {
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    logger.error('Failed to delete image from Cloudinary', { publicId, error: error.message });
  }
}

// GET /admin/blog - Get all posts with pagination and filters
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 10, isPublished, tag, search, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    const query = {};
    if (isPublished !== undefined) query.isPublished = isPublished === 'true';
    if (tag) query.tags = tag.toLowerCase();
    if (search) query.$or = [
      { title: { $regex: search, $options: 'i' } },
      { excerpt: { $regex: search, $options: 'i' } },
    ];

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const sortObj = {};
    sortObj[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const posts = await Blog.find(query)
      .sort(sortObj)
      .skip(skip)
      .limit(limitNum)
      .select('-content'); // Exclude full content from list view

    const total = await Blog.countDocuments(query);

    logger.info('Admin fetched blog posts', { total, page: pageNum, limit: limitNum });

    res.status(200).json({
      success: true,
      message: 'Blog posts retrieved successfully',
      data: {
        posts,
        pagination: {
          currentPage: pageNum,
          totalPages: Math.ceil(total / limitNum),
          totalItems: total,
          limit: limitNum,
        },
      },
    });
  } catch (error) {
    logger.error('Error fetching blog posts', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch blog posts' });
  }
});

// GET /admin/blog/:id - Get single post (full content)
router.get('/:id', async (req, res) => {
  try {
    const post = await Blog.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Blog post not found' });

    res.status(200).json({ success: true, message: 'Blog post retrieved successfully', data: post });
  } catch (error) {
    logger.error('Error fetching blog post', { id: req.params.id, error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch blog post' });
  }
});

// POST /admin/blog - Create new post (with optional cover image upload)
router.post('/', upload.single('coverImage'), async (req, res) => {
  try {
    const { title, slug, excerpt, content, tags, author, isPublished } = req.body;

    if (!title || !content || !author) {
      return res.status(400).json({ success: false, message: 'title, content, and author are required' });
    }

    let coverImage = null;
    let coverImagePublicId = null;

    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer);
      coverImage = result.secure_url;
      coverImagePublicId = result.public_id;
    }

    const post = new Blog({
      title,
      slug: slug || undefined, // Model auto-generates from title if omitted
      excerpt,
      content,
      coverImage,
      coverImagePublicId,
      tags: tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim())) : [],
      author,
      isPublished: isPublished === 'true' || isPublished === true,
    });

    await post.save();

    logger.info('Blog post created by admin', { postId: post._id, title: post.title });

    res.status(201).json({ success: true, message: 'Blog post created successfully', data: post });
  } catch (error) {
    logger.error('Error creating blog post', { error: error.message });

    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'A post with this slug already exists' });
    }

    res.status(500).json({ success: false, message: 'Failed to create blog post' });
  }
});

// PUT /admin/blog/:id - Update post (with optional new cover image)
router.put('/:id', upload.single('coverImage'), async (req, res) => {
  try {
    const post = await Blog.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Blog post not found' });

    const { title, slug, excerpt, content, tags, author, isPublished } = req.body;

    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (slug !== undefined) updateData.slug = slug;
    if (excerpt !== undefined) updateData.excerpt = excerpt;
    if (content !== undefined) updateData.content = content;
    if (author !== undefined) updateData.author = author;
    if (isPublished !== undefined) updateData.isPublished = isPublished === 'true' || isPublished === true;
    if (tags !== undefined) {
      updateData.tags = Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim());
    }

    // Handle new cover image upload
    if (req.file) {
      // Delete old image from Cloudinary
      if (post.coverImagePublicId) {
        await deleteFromCloudinary(post.coverImagePublicId);
      }
      const result = await uploadToCloudinary(req.file.buffer);
      updateData.coverImage = result.secure_url;
      updateData.coverImagePublicId = result.public_id;
    }

    // Set publishedAt if publishing for the first time
    if (updateData.isPublished && !post.isPublished && !post.publishedAt) {
      updateData.publishedAt = new Date();
    }

    const updated = await Blog.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true });

    logger.info('Blog post updated by admin', { postId: req.params.id, updatedFields: Object.keys(updateData) });

    res.status(200).json({ success: true, message: 'Blog post updated successfully', data: updated });
  } catch (error) {
    logger.error('Error updating blog post', { id: req.params.id, error: error.message });

    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'A post with this slug already exists' });
    }

    res.status(500).json({ success: false, message: 'Failed to update blog post' });
  }
});

// DELETE /admin/blog/:id - Delete post (and its Cloudinary image)
router.delete('/:id', async (req, res) => {
  try {
    const post = await Blog.findByIdAndDelete(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Blog post not found' });

    if (post.coverImagePublicId) {
      await deleteFromCloudinary(post.coverImagePublicId);
    }

    logger.info('Blog post deleted by admin', { postId: req.params.id, title: post.title });

    res.status(200).json({ success: true, message: 'Blog post deleted successfully', data: { id: post._id, title: post.title } });
  } catch (error) {
    logger.error('Error deleting blog post', { id: req.params.id, error: error.message });
    res.status(500).json({ success: false, message: 'Failed to delete blog post' });
  }
});

// PATCH /admin/blog/:id/publish - Toggle published status
router.patch('/:id/publish', async (req, res) => {
  try {
    const post = await Blog.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Blog post not found' });

    post.isPublished = !post.isPublished;
    if (post.isPublished && !post.publishedAt) {
      post.publishedAt = new Date();
    }
    await post.save();

    logger.info('Blog post publish status toggled', { postId: req.params.id, isPublished: post.isPublished });

    res.status(200).json({
      success: true,
      message: `Blog post ${post.isPublished ? 'published' : 'unpublished'} successfully`,
      data: { id: post._id, title: post.title, isPublished: post.isPublished, publishedAt: post.publishedAt },
    });
  } catch (error) {
    logger.error('Error toggling blog post publish status', { id: req.params.id, error: error.message });
    res.status(500).json({ success: false, message: 'Failed to toggle publish status' });
  }
});

// Multer error handler
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message === 'Only image files are allowed') {
    return res.status(400).json({ success: false, message: err.message });
  }
  next(err);
});

module.exports = router;
