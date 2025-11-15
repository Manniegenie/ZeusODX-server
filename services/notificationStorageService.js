/**
 * Notification Storage Service
 * Saves notifications to the database for in-app display
 */
const Notification = require('../models/notification');
const logger = require('../utils/logger');

/**
 * Save notification to database
 * @param {string} userId - User ID
 * @param {Object} notificationData - Notification data
 * @param {string} notificationData.title - Notification title
 * @param {string} notificationData.message - Notification message/body
 * @param {string} notificationData.subtitle - Optional subtitle
 * @param {string} notificationData.type - Notification type (DEPOSIT, WITHDRAWAL, etc.)
 * @param {Object} notificationData.data - Additional data/metadata
 * @param {boolean} notificationData.pushSent - Whether push notification was sent
 * @param {string} notificationData.pushVia - Push notification method (fcm, expo)
 * @returns {Promise<Object>} Saved notification document
 */
async function saveNotification(userId, notificationData) {
  try {
    const {
      title,
      message,
      subtitle = null,
      type = 'CUSTOM',
      data = {},
      pushSent = false,
      pushVia = null
    } = notificationData;

    if (!userId || !title || !message) {
      logger.warn('Invalid notification data provided', { userId, hasTitle: !!title, hasMessage: !!message });
      return null;
    }

    const notification = new Notification({
      userId,
      title,
      message,
      subtitle,
      type,
      data,
      pushSent,
      pushVia,
      pushSentAt: pushSent ? new Date() : null
    });

    await notification.save();

    logger.info('Notification saved to database', {
      userId,
      notificationId: notification._id,
      type,
      title: title.substring(0, 50)
    });

    return notification;
  } catch (error) {
    logger.error('Failed to save notification to database', {
      userId,
      error: error.message,
      stack: error.stack
    });
    // Don't throw - notification storage failure shouldn't break push notifications
    return null;
  }
}

/**
 * Get user notifications
 * @param {string} userId - User ID
 * @param {Object} options - Query options
 * @param {number} options.limit - Number of notifications to return
 * @param {number} options.skip - Number of notifications to skip
 * @param {boolean} options.unreadOnly - Only return unread notifications
 * @returns {Promise<Array>} Array of notifications
 */
async function getUserNotifications(userId, options = {}) {
  try {
    const {
      limit = 50,
      skip = 0,
      unreadOnly = false
    } = options;

    const query = { userId };
    if (unreadOnly) {
      query.isRead = false;
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .lean();

    return notifications;
  } catch (error) {
    logger.error('Failed to fetch user notifications', {
      userId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Get unread notification count
 * @param {string} userId - User ID
 * @returns {Promise<number>} Unread count
 */
async function getUnreadCount(userId) {
  try {
    const count = await Notification.getUnreadCount(userId);
    return count;
  } catch (error) {
    logger.error('Failed to get unread notification count', {
      userId,
      error: error.message
    });
    return 0;
  }
}

/**
 * Mark notification as read
 * @param {string} userId - User ID
 * @param {string} notificationId - Notification ID
 * @returns {Promise<Object>} Updated notification
 */
async function markNotificationAsRead(userId, notificationId) {
  try {
    const notification = await Notification.findOne({
      _id: notificationId,
      userId
    });

    if (!notification) {
      throw new Error('Notification not found');
    }

    await notification.markAsRead();

    logger.info('Notification marked as read', {
      userId,
      notificationId
    });

    return notification;
  } catch (error) {
    logger.error('Failed to mark notification as read', {
      userId,
      notificationId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Mark all notifications as read for a user
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Update result
 */
async function markAllAsRead(userId) {
  try {
    const result = await Notification.markAllAsRead(userId);

    logger.info('All notifications marked as read', {
      userId,
      modifiedCount: result.modifiedCount
    });

    return result;
  } catch (error) {
    logger.error('Failed to mark all notifications as read', {
      userId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Delete old notifications (cleanup)
 * @param {number} daysOld - Delete notifications older than this many days
 * @returns {Promise<Object>} Delete result
 */
async function deleteOldNotifications(daysOld = 90) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await Notification.deleteMany({
      createdAt: { $lt: cutoffDate }
    });

    logger.info('Old notifications deleted', {
      daysOld,
      deletedCount: result.deletedCount
    });

    return result;
  } catch (error) {
    logger.error('Failed to delete old notifications', {
      error: error.message
    });
    throw error;
  }
}

module.exports = {
  saveNotification,
  getUserNotifications,
  getUnreadCount,
  markNotificationAsRead,
  markAllAsRead,
  deleteOldNotifications
};



