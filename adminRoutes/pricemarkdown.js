const express = require('express');
const router = express.Router();
const GlobalMarkdown = require('../models/pricemarkdown');
const logger = require('../utils/logger');

// POST /asset-markdown/set-global - Set the global markdown percentage
router.post('/set-global', async (req, res) => {
  const { markdownPercentage, description, updatedBy } = req.body;

  if (typeof markdownPercentage !== 'number' || markdownPercentage < 0 || markdownPercentage > 100) {
    return res.status(400).json({ 
      success: false,
      message: 'Invalid markdown percentage. Must be a number between 0 and 100.' 
    });
  }

  try {
    let markdownDoc = await GlobalMarkdown.findOne();
    if (!markdownDoc) {
      markdownDoc = new GlobalMarkdown({ 
        markdownPercentage,
        source: 'manual',
        description: description || 'Global markdown percentage for all assets',
        updatedBy: updatedBy || 'admin',
        isActive: true
      });
    } else {
      markdownDoc.markdownPercentage = markdownPercentage;
      markdownDoc.source = 'manual';
      markdownDoc.description = description || markdownDoc.description;
      markdownDoc.updatedBy = updatedBy || 'admin';
      markdownDoc.isActive = true;
    }

    await markdownDoc.save();
    
    logger.info('Global markdown percentage updated successfully', {
      newMarkdownPercentage: markdownPercentage,
      updatedBy: updatedBy || 'admin',
      updatedAt: markdownDoc.updatedAt
    });

    res.status(200).json({ 
      success: true,
      message: 'Global markdown percentage updated successfully', 
      data: {
        markdownPercentage: markdownDoc.markdownPercentage,
        formattedPercentage: markdownDoc.formattedPercentage,
        description: markdownDoc.description,
        isActive: markdownDoc.isActive,
        updatedAt: markdownDoc.updatedAt,
        updatedBy: markdownDoc.updatedBy
      }
    });
  } catch (err) {
    logger.error('Failed to update global markdown percentage', {
      error: err.message,
      requestedMarkdown: markdownPercentage
    });
    
    res.status(500).json({ 
      success: false,
      message: 'Failed to update global markdown percentage'
    });
  }
});

// GET /asset-markdown/global - Get current global markdown percentage
router.get('/global', async (req, res) => {
  try {
    const markdownDoc = await GlobalMarkdown.getCurrentMarkdown();
    
    if (!markdownDoc) {
      return res.status(404).json({ 
        success: false,
        message: 'No global markdown percentage configured'
      });
    }
    
    res.status(200).json({ 
      success: true,
      data: {
        markdownPercentage: markdownDoc.markdownPercentage,
        formattedPercentage: markdownDoc.formattedPercentage,
        description: markdownDoc.description,
        isActive: markdownDoc.isActive,
        lastUpdated: markdownDoc.updatedAt,
        updatedBy: markdownDoc.updatedBy
      }
    });
  } catch (err) {
    logger.error('Failed to get global markdown percentage', {
      error: err.message
    });
    
    res.status(500).json({ 
      success: false,
      message: 'Failed to get global markdown percentage'
    });
  }
});

// PUT /asset-markdown/toggle-global - Toggle global markdown active status
router.put('/toggle-global', async (req, res) => {
  const { updatedBy } = req.body;

  try {
    const markdownDoc = await GlobalMarkdown.findOne();
    
    if (!markdownDoc) {
      return res.status(404).json({ 
        success: false,
        message: 'No global markdown percentage configured'
      });
    }
    
    markdownDoc.isActive = !markdownDoc.isActive;
    markdownDoc.updatedBy = updatedBy || 'admin';
    await markdownDoc.save();
    
    logger.info('Global markdown status toggled', {
      newStatus: markdownDoc.isActive,
      markdownPercentage: markdownDoc.markdownPercentage,
      updatedBy: updatedBy || 'admin'
    });
    
    res.status(200).json({ 
      success: true,
      message: `Global markdown ${markdownDoc.isActive ? 'activated' : 'deactivated'}`,
      data: {
        markdownPercentage: markdownDoc.markdownPercentage,
        formattedPercentage: markdownDoc.formattedPercentage,
        isActive: markdownDoc.isActive,
        updatedAt: markdownDoc.updatedAt,
        updatedBy: markdownDoc.updatedBy
      }
    });
  } catch (err) {
    logger.error('Failed to toggle global markdown status', {
      error: err.message
    });
    
    res.status(500).json({ 
      success: false,
      message: 'Failed to toggle global markdown status'
    });
  }
});

// GET /asset-markdown/calculate-price - Calculate discounted price for any asset
router.get('/calculate-price', async (req, res) => {
  const { originalPrice, asset } = req.query;

  if (!originalPrice || isNaN(originalPrice)) {
    return res.status(400).json({ 
      success: false,
      message: 'Valid original price is required' 
    });
  }

  try {
    const markdownDoc = await GlobalMarkdown.getCurrentMarkdown();
    
    if (!markdownDoc) {
      return res.status(404).json({ 
        success: false,
        message: 'No global markdown percentage configured'
      });
    }

    const originalPriceNum = parseFloat(originalPrice);
    const discountedPrice = markdownDoc.calculateDiscountedPrice(originalPriceNum);
    const discountAmount = originalPriceNum - discountedPrice;
    
    res.status(200).json({ 
      success: true,
      data: {
        asset: asset || 'N/A',
        originalPrice: originalPriceNum,
        markdownPercentage: markdownDoc.markdownPercentage,
        formattedPercentage: markdownDoc.formattedPercentage,
        discountAmount: discountAmount,
        discountedPrice: discountedPrice,
        isActive: markdownDoc.isActive,
        calculatedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    logger.error('Failed to calculate discounted price', {
      error: err.message,
      originalPrice,
      asset
    });
    
    res.status(500).json({ 
      success: false,
      message: 'Failed to calculate discounted price'
    });
  }
});

module.exports = router;