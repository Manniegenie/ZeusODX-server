const express = require('express');
const router = express.Router();
const Banner = require('../models/Banner');
const logger = require('../utils/logger');

/**
 * POST /api/banners
 * Create a banner with a limit check
 */
router.post('/banner', async (req, res) => {
  try {
    const { title, imageUrl, link, priority } = req.body;

    if (!title || !imageUrl) {
      return res.status(400).json({ error: 'Title and Image URL are required' });
    }

    // Double-Lock Validation: Check limit before processing
    const activeBannerCount = await Banner.countDocuments({ isActive: true });
    if (activeBannerCount >= 4) {
      return res.status(400).json({ 
        error: 'Banner limit reached (Max 4). Please delete one before adding more.' 
      });
    }

    const newBanner = new Banner({ title, imageUrl, link, priority });
    await newBanner.save();
    
    res.status(201).json(newBanner);
  } catch (error) {
    logger.error('Create Banner Error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/banners/:id
 * Remove a banner to free up space for a new one
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const deletedBanner = await Banner.findByIdAndDelete(id);

    if (!deletedBanner) {
      return res.status(404).json({ error: 'Banner not found' });
    }

    logger.info('Banner deleted successfully', { id });
    res.status(200).json({ 
      success: true, 
      message: 'Banner removed successfully',
      deletedId: id 
    });
  } catch (error) {
    logger.error('Delete Banner Error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/banners
 */
router.get('/banners-live', async (req, res) => {
  try {
    const banners = await Banner.find({ isActive: true }).sort({ priority: -1 });
    res.status(200).json({ success: true, data: banners });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;