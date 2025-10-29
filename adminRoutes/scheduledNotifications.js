const express = require('express');
const router = express.Router();
const scheduledNotificationService = require('../services/scheduledNotificationService');
const logger = require('../utils/logger');

// GET /scheduled-notifications/status - Get status of scheduled notifications
router.get('/status', (req, res) => {
  try {
    const status = scheduledNotificationService.getStatus();
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    logger.error('Error getting scheduled notification status', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get scheduled notification status'
    });
  }
});

// POST /scheduled-notifications/start - Start scheduled notifications
router.post('/start', (req, res) => {
  try {
    scheduledNotificationService.start();
    res.json({
      success: true,
      message: 'Scheduled notifications started successfully'
    });
  } catch (error) {
    logger.error('Error starting scheduled notifications', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to start scheduled notifications'
    });
  }
});

// POST /scheduled-notifications/stop - Stop scheduled notifications
router.post('/stop', (req, res) => {
  try {
    scheduledNotificationService.stop();
    res.json({
      success: true,
      message: 'Scheduled notifications stopped successfully'
    });
  } catch (error) {
    logger.error('Error stopping scheduled notifications', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to stop scheduled notifications'
    });
  }
});

// POST /scheduled-notifications/test - Test price notification
router.post('/test', async (req, res) => {
  try {
    await scheduledNotificationService.testNotification();
    res.json({
      success: true,
      message: 'Test notification sent successfully'
    });
  } catch (error) {
    logger.error('Error sending test notification', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to send test notification'
    });
  }
});

module.exports = router;
