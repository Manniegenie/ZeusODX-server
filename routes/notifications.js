const express = require('express');
const router = express.Router();
const {
  getUserNotifications,
  getUnreadCount,
  markNotificationAsRead,
  markAllAsRead
} = require('../services/notificationStorageService');
const logger = require('../utils/logger');

/**
 * GET /notifications
 * Get user's notifications
 * Query params: limit, skip, unreadOnly
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 50, skip = 0, unreadOnly = false } = req.query;

    const notifications = await getUserNotifications(userId, {
      limit: parseInt(limit, 10),
      skip: parseInt(skip, 10),
      unreadOnly: unreadOnly === 'true'
    });

    // Format notifications for frontend
    const formattedNotifications = notifications.map(notif => ({
      id: notif._id.toString(),
      title: notif.title,
      message: notif.message,
      subtitle: notif.subtitle || null,
      date: new Date(notif.createdAt).toLocaleDateString('en-US', {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: '2-digit'
      }),
      timestamp: notif.createdAt,
      isRead: notif.isRead,
      type: notif.type,
      data: notif.data
    }));

    res.json({
      success: true,
      data: formattedNotifications,
      count: formattedNotifications.length
    });
  } catch (error) {
    logger.error('Error fetching notifications', {
      userId: req.user?.id,
      error: error.message
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch notifications'
    });
  }
});

/**
 * GET /notifications/unread-count
 * Get unread notification count
 */
router.get('/unread-count', async (req, res) => {
  try {
    const userId = req.user.id;
    const count = await getUnreadCount(userId);

    res.json({
      success: true,
      count
    });
  } catch (error) {
    logger.error('Error fetching unread count', {
      userId: req.user?.id,
      error: error.message
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch unread count'
    });
  }
});

/**
 * PUT /notifications/:id/read
 * Mark a notification as read
 */
router.put('/:id/read', async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    await markNotificationAsRead(userId, id);

    res.json({
      success: true,
      message: 'Notification marked as read'
    });
  } catch (error) {
    logger.error('Error marking notification as read', {
      userId: req.user?.id,
      notificationId: req.params.id,
      error: error.message
    });
    
    if (error.message === 'Notification not found') {
      return res.status(404).json({
        success: false,
        error: 'Notification not found'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to mark notification as read'
    });
  }
});

/**
 * PUT /notifications/read-all
 * Mark all notifications as read
 */
router.put('/read-all', async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await markAllAsRead(userId);

    res.json({
      success: true,
      message: 'All notifications marked as read',
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    logger.error('Error marking all notifications as read', {
      userId: req.user?.id,
      error: error.message
    });
    res.status(500).json({
      success: false,
      error: 'Failed to mark all notifications as read'
    });
  }
});

module.exports = router;


