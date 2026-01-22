const express = require('express');
const router = express.Router();
const Banner = require('../models/Banners');
const logger = require('../utils/logger');

// GET /admin/banners - Get all banners with pagination and filters
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 10, isActive, sortBy = 'priority', sortOrder = 'desc' } = req.query;

    const query = {};
    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const sortObj = {};
    sortObj[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const banners = await Banner.find(query)
      .sort(sortObj)
      .skip(skip)
      .limit(limitNum);

    const total = await Banner.countDocuments(query);

    logger.info('Admin fetched banners', {
      total,
      page: pageNum,
      limit: limitNum
    });

    res.status(200).json({
      success: true,
      message: 'Banners retrieved successfully',
      data: {
        banners: banners.map(banner => ({
          id: banner._id,
          title: banner.title,
          imageUrl: banner.imageUrl,
          link: banner.link,
          isActive: banner.isActive,
          priority: banner.priority,
          createdAt: banner.createdAt,
          updatedAt: banner.updatedAt
        })),
        pagination: {
          currentPage: pageNum,
          totalPages: Math.ceil(total / limitNum),
          totalItems: total,
          limit: limitNum
        }
      }
    });

  } catch (error) {
    logger.error('Error fetching banners', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch banners'
    });
  }
});

// GET /admin/banners/:id - Get single banner
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const banner = await Banner.findById(id);

    if (!banner) {
      return res.status(404).json({
        success: false,
        message: 'Banner not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Banner retrieved successfully',
      data: {
        id: banner._id,
        title: banner.title,
        imageUrl: banner.imageUrl,
        link: banner.link,
        isActive: banner.isActive,
        priority: banner.priority,
        createdAt: banner.createdAt,
        updatedAt: banner.updatedAt
      }
    });

  } catch (error) {
    logger.error('Error fetching banner', { bannerId: req.params.id, error: error.message });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch banner'
    });
  }
});

// POST /admin/banners - Create new banner
router.post('/', async (req, res) => {
  try {
    const { title, imageUrl, link, priority, isActive } = req.body;

    // Validation
    if (!title || !imageUrl) {
      return res.status(400).json({
        success: false,
        message: 'Title and imageUrl are required'
      });
    }

    // Check banner limit (max 4)
    const bannerCount = await Banner.countDocuments();
    if (bannerCount >= 4) {
      return res.status(400).json({
        success: false,
        message: 'Banner limit reached (max 4). Please delete one before adding more.'
      });
    }

    const newBanner = new Banner({
      title,
      imageUrl,
      link: link || null,
      priority: priority !== undefined ? priority : 0,
      isActive: isActive !== undefined ? isActive : true
    });

    await newBanner.save();

    logger.info('Banner created by admin', {
      bannerId: newBanner._id,
      title: newBanner.title
    });

    res.status(201).json({
      success: true,
      message: 'Banner created successfully',
      data: {
        id: newBanner._id,
        title: newBanner.title,
        imageUrl: newBanner.imageUrl,
        link: newBanner.link,
        isActive: newBanner.isActive,
        priority: newBanner.priority,
        createdAt: newBanner.createdAt
      }
    });

  } catch (error) {
    logger.error('Error creating banner', { error: error.message, requestBody: req.body });

    if (error.message.includes('Limit reached')) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create banner'
    });
  }
});

// PUT /admin/banners/:id - Update existing banner
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, imageUrl, link, priority, isActive } = req.body;

    const existingBanner = await Banner.findById(id);
    if (!existingBanner) {
      return res.status(404).json({
        success: false,
        message: 'Banner not found'
      });
    }

    // Build update data from allowed fields
    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (imageUrl !== undefined) updateData.imageUrl = imageUrl;
    if (link !== undefined) updateData.link = link;
    if (priority !== undefined) updateData.priority = priority;
    if (isActive !== undefined) updateData.isActive = isActive;

    const updatedBanner = await Banner.findByIdAndUpdate(id, updateData, { new: true });

    logger.info('Banner updated by admin', {
      bannerId: id,
      updatedFields: Object.keys(updateData)
    });

    res.status(200).json({
      success: true,
      message: 'Banner updated successfully',
      data: {
        id: updatedBanner._id,
        title: updatedBanner.title,
        imageUrl: updatedBanner.imageUrl,
        link: updatedBanner.link,
        isActive: updatedBanner.isActive,
        priority: updatedBanner.priority,
        createdAt: updatedBanner.createdAt,
        updatedAt: updatedBanner.updatedAt
      }
    });

  } catch (error) {
    logger.error('Error updating banner', { bannerId: req.params.id, error: error.message });
    res.status(500).json({
      success: false,
      message: 'Failed to update banner'
    });
  }
});

// DELETE /admin/banners/:id - Delete banner
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const deletedBanner = await Banner.findByIdAndDelete(id);

    if (!deletedBanner) {
      return res.status(404).json({
        success: false,
        message: 'Banner not found'
      });
    }

    logger.info('Banner deleted by admin', {
      bannerId: id,
      title: deletedBanner.title
    });

    res.status(200).json({
      success: true,
      message: 'Banner deleted successfully',
      data: {
        deletedBanner: {
          id: deletedBanner._id,
          title: deletedBanner.title
        }
      }
    });

  } catch (error) {
    logger.error('Error deleting banner', { bannerId: req.params.id, error: error.message });
    res.status(500).json({
      success: false,
      message: 'Failed to delete banner'
    });
  }
});

// PATCH /admin/banners/:id/toggle - Toggle banner active status
router.patch('/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;

    const banner = await Banner.findById(id);

    if (!banner) {
      return res.status(404).json({
        success: false,
        message: 'Banner not found'
      });
    }

    banner.isActive = !banner.isActive;
    await banner.save();

    logger.info('Banner toggled by admin', {
      bannerId: id,
      isActive: banner.isActive
    });

    res.status(200).json({
      success: true,
      message: `Banner ${banner.isActive ? 'activated' : 'deactivated'} successfully`,
      data: {
        id: banner._id,
        title: banner.title,
        isActive: banner.isActive
      }
    });

  } catch (error) {
    logger.error('Error toggling banner', { bannerId: req.params.id, error: error.message });
    res.status(500).json({
      success: false,
      message: 'Failed to toggle banner status'
    });
  }
});

// PUT /admin/banners/reorder - Reorder banners by priority
router.put('/reorder/priorities', async (req, res) => {
  try {
    const { bannerPriorities } = req.body;

    // Validate input: expect array of { id, priority }
    if (!Array.isArray(bannerPriorities) || bannerPriorities.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'bannerPriorities must be a non-empty array of { id, priority }'
      });
    }

    // Update each banner's priority
    const updatePromises = bannerPriorities.map(({ id, priority }) =>
      Banner.findByIdAndUpdate(id, { priority }, { new: true })
    );

    await Promise.all(updatePromises);

    logger.info('Banners reordered by admin', {
      count: bannerPriorities.length
    });

    // Fetch updated banners
    const banners = await Banner.find().sort({ priority: -1 });

    res.status(200).json({
      success: true,
      message: 'Banners reordered successfully',
      data: {
        banners: banners.map(banner => ({
          id: banner._id,
          title: banner.title,
          priority: banner.priority,
          isActive: banner.isActive
        }))
      }
    });

  } catch (error) {
    logger.error('Error reordering banners', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Failed to reorder banners'
    });
  }
});

module.exports = router;
