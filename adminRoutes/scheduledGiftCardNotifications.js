const express = require('express');
const router = express.Router();
const scheduledGiftCardNotificationService = require('../services/scheduledGiftCardNotificationService');
const logger = require('../utils/logger');

// GET /scheduled-giftcard-notifications/status - Get status of scheduled gift card notifications
router.get('/status', (req, res) => {
  try {
    const status = scheduledGiftCardNotificationService.getStatus();
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    logger.error('Error getting gift card notification status', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get gift card notification status'
    });
  }
});

// POST /scheduled-giftcard-notifications/start - Start scheduled gift card notifications
router.post('/start', (req, res) => {
  try {
    scheduledGiftCardNotificationService.start();
    res.json({
      success: true,
      message: 'Gift card notifications started successfully'
    });
  } catch (error) {
    logger.error('Error starting gift card notifications', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to start gift card notifications'
    });
  }
});

// POST /scheduled-giftcard-notifications/stop - Stop scheduled gift card notifications
router.post('/stop', (req, res) => {
  try {
    scheduledGiftCardNotificationService.stop();
    res.json({
      success: true,
      message: 'Gift card notifications stopped successfully'
    });
  } catch (error) {
    logger.error('Error stopping gift card notifications', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to stop gift card notifications'
    });
  }
});

// POST /scheduled-giftcard-notifications/test - Test gift card notification
router.post('/test', async (req, res) => {
  try {
    const result = await scheduledGiftCardNotificationService.testNotification();

    if (!result.success && result.reason) {
      return res.json({
        success: false,
        message: result.reason,
        data: result
      });
    }

    res.json({
      success: result.success,
      message: result.success
        ? `Notifications sent: ${result.delivered}/${result.totalUsers} users`
        : 'No notifications delivered',
      data: {
        totalUsers: result.totalUsers,
        delivered: result.delivered,
        failed: result.failed,
        skipped: result.skipped,
        notification: result.notification,
        errors: result.errors
      }
    });
  } catch (error) {
    logger.error('Error sending test gift card notification', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to send test gift card notification'
    });
  }
});

module.exports = router;
