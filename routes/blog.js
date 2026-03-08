const express = require('express');
const router = express.Router();
const Blog = require('../models/Blog');
const logger = require('../utils/logger');

// GET /blog - List published posts (public)
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, tag, search } = req.query;

    const query = { isPublished: true };
    if (tag) query.tags = tag.toLowerCase();
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { excerpt: { $regex: search, $options: 'i' } },
      ];
    }

    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 50); // cap at 50
    const skip = (pageNum - 1) * limitNum;

    const posts = await Blog.find(query)
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .select('-content -coverImagePublicId'); // exclude heavy/internal fields

    const total = await Blog.countDocuments(query);

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
    logger.error('Error fetching public blog posts', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch blog posts' });
  }
});

// GET /blog/:id - Get single published post (public)
router.get('/:id', async (req, res) => {
  try {
    const post = await Blog.findOne({ _id: req.params.id, isPublished: true }).select('-coverImagePublicId');

    if (!post) {
      return res.status(404).json({ success: false, message: 'Blog post not found' });
    }

    // Increment views
    await Blog.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } });

    res.status(200).json({ success: true, message: 'Blog post retrieved successfully', data: post });
  } catch (error) {
    logger.error('Error fetching public blog post', { id: req.params.id, error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch blog post' });
  }
});

module.exports = router;
