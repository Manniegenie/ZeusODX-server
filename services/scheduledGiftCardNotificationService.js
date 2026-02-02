const cron = require('node-cron');
const GiftCardPrice = require('../models/giftcardPrice');
const { sendPushNotification } = require('./notificationService');
const User = require('../models/user');
const logger = require('../utils/logger');

class ScheduledGiftCardNotificationService {
  constructor() {
    this.isRunning = false;
    this.jobs = [];
    // Schedules: 11:00 AM and 3:00 PM (Africa/Lagos)
    this.scheduleConfig = [
      { time: '11:00 AM', cron: '0 11 * * *' },
      { time: '3:00 PM', cron: '0 15 * * *' }
    ];
    // Card types to include in notifications
    this.targetCards = [
      { cardType: 'APPLE', displayName: 'iTunes' },
      { cardType: 'STEAM', displayName: 'Steam' },
      { cardType: 'RAZOR_GOLD', displayName: 'Razer Gold' }
    ];
  }

  // Start all scheduled notifications
  start() {
    if (this.isRunning) {
      logger.warn('Gift card scheduled notifications already running');
      return;
    }

    logger.info('Starting gift card scheduled notification service...');

    this.scheduleConfig.forEach(({ time, cron: cronExpression }) => {
      const job = cron.schedule(cronExpression, async () => {
        logger.info(`Running gift card notification at ${time} (${cronExpression})`);
        try {
          await this.sendGiftCardNotification();
        } catch (err) {
          logger.error('Gift card notification job failed', { time, error: err.message });
        }
      }, {
        scheduled: false,
        timezone: 'Africa/Lagos'
      });

      job.start();
      this.jobs.push({ time, job });
      logger.info(`Scheduled gift card notification for ${time} (${cronExpression})`);
    });

    this.isRunning = true;
    logger.info('Gift card scheduled notification service started successfully');
  }

  // Stop all scheduled notifications
  stop() {
    if (!this.isRunning) {
      logger.warn('Gift card scheduled notifications not running');
      return;
    }

    this.jobs.forEach(({ time, job }) => {
      job.stop();
      logger.info(`Stopped gift card notification for ${time}`);
    });

    this.jobs = [];
    this.isRunning = false;
    logger.info('Gift card scheduled notification service stopped');
  }

  // Send gift card notification to all users
  async sendGiftCardNotification() {
    try {
      logger.info('Fetching gift card rates...');

      // Get rates for target cards (US country, most common)
      const rates = [];
      for (const { cardType, displayName } of this.targetCards) {
        try {
          const rateDoc = await GiftCardPrice.getRateByCardTypeAndCountry(cardType, 'US');
          if (rateDoc && rateDoc.rate) {
            rates.push({
              cardType,
              displayName,
              rate: rateDoc.rate
            });
          }
        } catch (err) {
          logger.warn(`Failed to fetch rate for ${cardType}:`, err.message);
        }
      }

      if (rates.length === 0) {
        logger.warn('No gift card rates available for notification');
        return;
      }

      // Format the notification message
      const notification = this.formatGiftCardNotification(rates);

      logger.info('Sending gift card notification to all users...', {
        title: notification.title,
        cardsCount: rates.length
      });

      // Get all users with valid Expo push tokens
      const users = await User.find({
        expoPushToken: { $exists: true, $nin: [null, ''] }
      }).select('_id expoPushToken email username');

      if (users.length === 0) {
        logger.warn('No users with Expo push tokens found');
        return;
      }

      // Send notification to each user
      let successCount = 0;
      let errorCount = 0;

      for (const user of users) {
        try {
          const result = await sendPushNotification(user._id.toString(), {
            title: notification.title,
            body: notification.body,
            data: {
              type: 'giftcard_rates',
              timestamp: new Date().toISOString(),
              rates: rates.map(r => ({
                cardType: r.cardType,
                displayName: r.displayName,
                rate: r.rate
              }))
            }
          });

          if (result.success) {
            successCount++;
          } else {
            errorCount++;
            logger.warn('Failed to send gift card notification to user', {
              userId: user._id,
              error: result.message
            });
          }
        } catch (error) {
          errorCount++;
          logger.error('Error sending gift card notification to user', {
            userId: user._id,
            error: error.message
          });
        }
      }

      logger.info('Gift card notification completed', {
        totalUsers: users.length,
        successCount,
        errorCount,
        cardsIncluded: rates.map(r => r.displayName)
      });

    } catch (error) {
      logger.error('Error in scheduled gift card notification', { error: error.message });
    }
  }

  // Format the gift card notification message
  formatGiftCardNotification(rates) {
    const title = 'Gift Card Rates';

    // Format each card rate
    const rateLines = rates.map(r => {
      return `${r.displayName}: ₦${Math.round(r.rate).toLocaleString()}/$`;
    });

    const body = rateLines.join(' | ');

    return { title, body };
  }

  // Get status of scheduled notifications
  getStatus() {
    return {
      isRunning: this.isRunning,
      jobsCount: this.isRunning ? this.scheduleConfig.length : 0,
      schedules: this.scheduleConfig.map(({ time }) => ({
        time,
        running: this.isRunning
      }))
    };
  }

  // Test the notification (for manual testing) - returns detailed results
  async testNotification() {
    logger.info('Testing gift card notification...');
    return await this.sendGiftCardNotificationWithResults();
  }

  // Send gift card notification and return detailed results
  async sendGiftCardNotificationWithResults() {
    try {
      logger.info('Fetching gift card rates for test...');

      // Get rates for target cards (US country)
      const rates = [];
      for (const { cardType, displayName } of this.targetCards) {
        try {
          const rateDoc = await GiftCardPrice.getRateByCardTypeAndCountry(cardType, 'US');
          if (rateDoc && rateDoc.rate) {
            rates.push({
              cardType,
              displayName,
              rate: rateDoc.rate
            });
          }
        } catch (err) {
          logger.warn(`Failed to fetch rate for ${cardType}:`, err.message);
        }
      }

      if (rates.length === 0) {
        return { success: false, reason: 'No gift card rates configured. Set rates for iTunes, Steam, Razer Gold (US) in admin.' };
      }

      // Format the notification message
      const notification = this.formatGiftCardNotification(rates);

      // Get all users with valid Expo push tokens
      const users = await User.find({
        expoPushToken: { $exists: true, $nin: [null, ''] }
      }).select('_id expoPushToken email username');

      if (users.length === 0) {
        return { success: false, reason: 'No users with Expo push tokens registered.' };
      }

      // Send notification to each user
      let successCount = 0;
      let errorCount = 0;
      let skippedCount = 0;
      const errors = [];

      for (const user of users) {
        try {
          const result = await sendPushNotification(user._id.toString(), {
            title: notification.title,
            body: notification.body,
            data: {
              type: 'giftcard_rates',
              timestamp: new Date().toISOString(),
              rates: rates.map(r => ({
                cardType: r.cardType,
                displayName: r.displayName,
                rate: r.rate
              }))
            }
          });

          if (result.success) {
            successCount++;
          } else if (result.skipped) {
            skippedCount++;
          } else {
            errorCount++;
            errors.push({ userId: user._id, email: user.email, error: result.message });
          }
        } catch (error) {
          errorCount++;
          errors.push({ userId: user._id, email: user.email, error: error.message });
        }
      }

      return {
        success: successCount > 0,
        totalUsers: users.length,
        delivered: successCount,
        failed: errorCount,
        skipped: skippedCount,
        notification: { title: notification.title, body: notification.body },
        errors: errors.slice(0, 5)
      };

    } catch (error) {
      logger.error('Error in test gift card notification', { error: error.message });
      return { success: false, reason: error.message };
    }
  }
}

// Create singleton instance
const scheduledGiftCardNotificationService = new ScheduledGiftCardNotificationService();

module.exports = scheduledGiftCardNotificationService;
