const express = require('express');
const router = express.Router();
const NairaMarkup = require('../models/onramp');
const logger = require('../utils/logger');

// POST /naira-price/onramp-rate - Set the onramp rate directly
router.post('/onramp-rate', async (req, res) => {
  const { rate } = req.body;

  if (typeof rate !== 'number' || rate <= 0) {
    return res.status(400).json({ 
      success: false,
      message: 'Invalid rate. Must be a positive number.' 
    });
  }

  try {
    let rateDoc = await NairaMarkup.findOne();
    if (!rateDoc) {
      rateDoc = new NairaMarkup({ 
        onrampRate: rate,
        rateSource: 'manual'
      });
    } else {
      rateDoc.onrampRate = rate;
      rateDoc.rateSource = 'manual';
    }

    await rateDoc.save();
    
    logger.info('Onramp rate updated successfully', {
      newRate: rate,
      updatedAt: rateDoc.updatedAt
    });

    res.status(200).json({ 
      success: true,
      message: 'Onramp rate updated successfully', 
      data: {
        onrampRate: rate,
        updatedAt: rateDoc.updatedAt
      }
    });
  } catch (err) {
    logger.error('Failed to update onramp rate', {
      error: err.message,
      requestedRate: rate
    });
    
    res.status(500).json({ 
      success: false,
      message: 'Failed to update onramp rate'
    });
  }
});

// GET /naira-price/onramp-rate - Get current onramp rate
router.get('/onramp-rate', async (req, res) => {
  try {
    const rateDoc = await NairaMarkup.findOne();
    
    if (!rateDoc || !rateDoc.onrampRate) {
      return res.status(404).json({ 
        success: false,
        message: 'No onramp rate configured'
      });
    }
    
    res.status(200).json({ 
      success: true,
      data: {
        onrampRate: rateDoc.onrampRate,
        lastUpdated: rateDoc.updatedAt
      }
    });
  } catch (err) {
    logger.error('Failed to get onramp rate', {
      error: err.message
    });
    
    res.status(500).json({ 
      success: false,
      message: 'Failed to get onramp rate'
    });
  }
});

module.exports = router;