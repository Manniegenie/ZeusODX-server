const express = require('express');
const router = express.Router();
const NairaMarkdown = require('../models/offramp');
const logger = require('../utils/logger');

// POST /naira-price/offramp-rate - Set the offramp rate directly
router.post('/offramp-rate', async (req, res) => {
  const { rate } = req.body;

  if (typeof rate !== 'number' || rate <= 0) {
    return res.status(400).json({ 
      success: false,
      message: 'Invalid rate. Must be a positive number.' 
    });
  }

  try {
    let rateDoc = await NairaMarkdown.findOne();
    if (!rateDoc) {
      rateDoc = new NairaMarkdown({ 
        offrampRate: rate,
        rateSource: 'manual'
      });
    } else {
      rateDoc.offrampRate = rate;
      rateDoc.rateSource = 'manual';
    }

    await rateDoc.save();
    
    logger.info('Offramp rate updated successfully', {
      newRate: rate,
      updatedAt: rateDoc.updatedAt
    });

    res.status(200).json({ 
      success: true,
      message: 'Offramp rate updated successfully', 
      data: {
        offrampRate: rate,
        updatedAt: rateDoc.updatedAt
      }
    });
  } catch (err) {
    logger.error('Failed to update offramp rate', {
      error: err.message,
      requestedRate: rate
    });
    
    res.status(500).json({ 
      success: false,
      message: 'Failed to update offramp rate'
    });
  }
});

// GET /naira-price/offramp-rate - Get current offramp rate
router.get('/offramp-rate', async (req, res) => {
  try {
    const rateDoc = await NairaMarkdown.findOne();
    
    if (!rateDoc || !rateDoc.offrampRate) {
      return res.status(404).json({ 
        success: false,
        message: 'No offramp rate configured'
      });
    }
    
    res.status(200).json({ 
      success: true,
      data: {
        offrampRate: rateDoc.offrampRate,
        lastUpdated: rateDoc.updatedAt
      }
    });
  } catch (err) {
    logger.error('Failed to get offramp rate', {
      error: err.message
    });
    
    res.status(500).json({ 
      success: false,
      message: 'Failed to get offramp rate'
    });
  }
});

module.exports = router;