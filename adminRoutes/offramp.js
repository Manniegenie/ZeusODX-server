const express = require('express');
const router = express.Router();
const NairaMarkdown = require('../models/offramp');
const User = require('../models/user');
const logger = require('../utils/logger');
const { sendBulkNotifications } = require('../services/notificationService');

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
    const previousRate = rateDoc?.offrampRate ?? null;

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
      previousRate,
      newRate: rate,
      updatedAt: rateDoc.updatedAt
    });

    // Notify all customers with Expo push tokens about the rate change
    // Fire-and-forget — don't let notification failures block the response
    (async () => {
      try {
        const direction = previousRate !== null
          ? rate > previousRate ? '📈' : rate < previousRate ? '📉' : '➡️'
          : '➡️';

        const formattedRate    = `₦${Number(rate).toLocaleString('en-NG')}`;
        const formattedPrev    = previousRate !== null
          ? ` (was ₦${Number(previousRate).toLocaleString('en-NG')})`
          : '';

        const users = await User.find(
          { expoPushToken: { $ne: null } },
          { _id: 1 }
        ).lean();

        const userIds = users.map(u => u._id.toString());
        if (!userIds.length) return;

        await sendBulkNotifications(userIds, {
          title: `${direction} Sell Rate Updated`,
          body: `New off-ramp rate: ${formattedRate}/USD${formattedPrev}. Open the app to sell crypto at the latest rate.`,
          sound: 'default',
          priority: 'high',
          data: {
            type: 'RATE_UPDATE',
            rateType: 'offramp',
            newRate: rate,
            previousRate,
            updatedAt: rateDoc.updatedAt,
          },
        });

        logger.info('Offramp rate change notifications sent', {
          recipientCount: userIds.length,
          newRate: rate,
          previousRate,
        });
      } catch (notifErr) {
        logger.error('Failed to send offramp rate change notifications', {
          error: notifErr.message,
          newRate: rate,
        });
      }
    })();

    res.status(200).json({
      success: true,
      message: 'Offramp rate updated successfully',
      data: {
        offrampRate: rate,
        previousRate,
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