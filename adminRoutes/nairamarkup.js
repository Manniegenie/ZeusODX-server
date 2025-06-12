const express = require('express');
const router = express.Router();
const NairaMark = require('../models/nairamarks');
const logger = require('../utils/logger');

/**
 * Update markup number
 * PUT /api/markup
 */
router.put('/markup', async (req, res) => {
  try {
    const { markup } = req.body;
    
    if (markup === undefined || markup < 0) {
      return res.status(400).json({
        success: false,
        message: 'Markup must be a positive number'
      });
    }
    
    // Update or create single markup record
    const updatedMarkup = await NairaMark.findOneAndUpdate(
      {}, // Find any record (we only have one)
      { markup: markup },
      { 
        new: true, 
        upsert: true // Create if doesn't exist
      }
    );
    
    logger.info(`Markup updated to ₦${markup}`);
    
    return res.status(200).json({
      success: true,
      message: `Markup updated to ₦${markup}`,
      data: updatedMarkup
    });
    
  } catch (error) {
    logger.error('Update markup error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to update markup',
      message: error.message
    });
  }
});

/**
 * Get current markup
 * GET /api/markup
 */
router.get('/markup-record', async (req, res) => {
  try {
    const markupRecord = await NairaMark.findOne({});
    const markup = markupRecord?.markup || 0;
    
    return res.status(200).json({
      success: true,
      message: 'Current markup',
      data: {
        markup: markup
      }
    });
    
  } catch (error) {
    logger.error('Get markup error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to get markup',
      message: error.message
    });
  }
});

module.exports = router;