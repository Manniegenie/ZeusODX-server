const cron = require('node-cron');
const CryptoPrice = require('../models/CryptoPrice');
const { sendPushNotification } = require('./notificationService');
const User = require('../models/user');
const logger = require('../utils/logger');
const { currencyService } = require('./onramppriceservice');

class ScheduledNotificationService {
  constructor() {
    this.isRunning = false;
    this.jobs = [];
    // Define schedules as class property so they're always available
    this.scheduleConfig = [
      { time: '7:00 AM', cron: '0 7 * * *' },
      { time: '12:00 PM', cron: '0 12 * * *' },
      { time: '6:00 PM', cron: '0 18 * * *' },
      { time: '9:00 PM', cron: '0 21 * * *' }
    ];
  }

  // Start all scheduled notifications
  start() {
    if (this.isRunning) {
      logger.warn('Scheduled notifications already running');
      return;
    }

    logger.info('Starting scheduled notification service...');

    this.scheduleConfig.forEach(({ time, cron: cronExpression }) => {
      const job = cron.schedule(cronExpression, async () => {
        logger.info(`Running scheduled price notification at ${time}`);
        await this.sendPriceNotification();
      }, {
        scheduled: false,
        timezone: 'Africa/Lagos' // Adjust timezone as needed
      });

      job.start();
      this.jobs.push({ time, job });
      logger.info(`Scheduled price notification for ${time} (${cronExpression})`);
    });

    this.isRunning = true;
    logger.info('Scheduled notification service started successfully');
  }

  // Stop all scheduled notifications
  stop() {
    if (!this.isRunning) {
      logger.warn('Scheduled notifications not running');
      return;
    }

    this.jobs.forEach(({ time, job }) => {
      job.stop();
      logger.info(`Stopped scheduled notification for ${time}`);
    });

    this.jobs = [];
    this.isRunning = false;
    logger.info('Scheduled notification service stopped');
  }

  // Send price notification to all users
  async sendPriceNotification() {
    try {
      logger.info('Fetching latest crypto prices...');

      // Get NGNZ rate
      let ngnzRate = null;
      try {
        const rateInfo = await currencyService.getUsdToNgnRate();
        ngnzRate = {
          symbol: 'NGNZ',
          price: rateInfo.finalPrice,
          hourly_change: 0
        };
      } catch (error) {
        logger.warn('Failed to fetch NGNZ rate:', error.message);
      }

      // Get latest prices for major tokens
      const latestPrices = await CryptoPrice.getLatestPrices();

      if ((!latestPrices || latestPrices.length === 0) && !ngnzRate) {
        logger.warn('No crypto prices found, skipping notification');
        return;
      }

      // Filter for major tokens (BTC, ETH, SOL)
      const majorTokens = ['BTC', 'ETH', 'SOL'];
      const relevantPrices = (latestPrices || []).filter(price =>
        majorTokens.includes(price.symbol)
      );

      // Add NGNZ at the beginning if available
      const allPrices = ngnzRate ? [ngnzRate, ...relevantPrices] : relevantPrices;

      if (allPrices.length === 0) {
        logger.warn('No prices found, skipping notification');
        return;
      }

      // Format the notification message
      const notification = this.formatPriceNotification(allPrices);
      
      logger.info('Sending price notification to all users...', {
        message: notification.title,
        tokensCount: allPrices.length
      });

      // Get all users with push tokens
      const users = await User.find({
        $or: [
          { fcmToken: { $ne: null } },
          { expoPushToken: { $ne: null } }
        ]
      }).select('_id fcmToken expoPushToken email username');

      if (users.length === 0) {
        logger.warn('No users with push tokens found');
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
              type: 'price_update',
              timestamp: new Date().toISOString(),
              tokens: allPrices.map(p => ({
                symbol: p.symbol,
                price: p.price,
                change: p.hourly_change
              }))
            }
          });

          if (result.success) {
            successCount++;
          } else {
            errorCount++;
            logger.warn('Failed to send notification to user', { 
              userId: user._id, 
              error: result.message 
            });
          }
        } catch (error) {
          errorCount++;
          logger.error('Error sending notification to user', { 
            userId: user._id, 
            error: error.message 
          });
        }
      }

      logger.info('Price notification completed', {
        totalUsers: users.length,
        successCount,
        errorCount,
        tokensIncluded: allPrices.map(p => p.symbol)
      });

    } catch (error) {
      logger.error('Error in scheduled price notification', { error: error.message });
    }
  }

  // Format the price notification message
  formatPriceNotification(prices) {
    const title = 'Latest Rates';

    // Format each token price (keep NGNZ first, then sort the rest)
    const priceLines = prices.map(price => {
      const symbol = price.symbol;

      // NGNZ shows as Naira rate
      if (symbol === 'NGNZ') {
        return `NGNZ: ₦${Math.round(price.price).toLocaleString()}/$`;
      }

      const priceFormatted = this.formatPrice(price.price);
      return `${symbol}: ${priceFormatted}`;
    });

    // Simple format: rates only, no change percentages
    const body = priceLines.join(' | ');

    return {
      title,
      body
    };
  }

  // Format price with appropriate decimal places
  formatPrice(price) {
    if (price >= 1000) {
      return `$${Math.round(price).toLocaleString()}`;
    } else if (price >= 1) {
      return `$${price.toFixed(2)}`;
    } else {
      return `$${price.toFixed(4)}`;
    }
  }

  // Format percentage change with color indicator
  formatChange(change) {
    const sign = change >= 0 ? '+' : '';
    return `${sign}${change.toFixed(2)}%`;
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
    logger.info('Testing price notification...');
    return await this.sendPriceNotificationWithResults();
  }

  // Send price notification and return detailed results
  async sendPriceNotificationWithResults() {
    try {
      logger.info('Fetching latest crypto prices...');

      // Get NGNZ rate
      let ngnzRate = null;
      try {
        const rateInfo = await currencyService.getUsdToNgnRate();
        ngnzRate = {
          symbol: 'NGNZ',
          price: rateInfo.finalPrice,
          hourly_change: 0
        };
      } catch (error) {
        logger.warn('Failed to fetch NGNZ rate:', error.message);
      }

      // Get latest prices for major tokens
      const latestPrices = await CryptoPrice.getLatestPrices();

      if ((!latestPrices || latestPrices.length === 0) && !ngnzRate) {
        return { success: false, reason: 'No crypto prices found' };
      }

      // Filter for major tokens (BTC, ETH, SOL)
      const majorTokens = ['BTC', 'ETH', 'SOL'];
      const relevantPrices = (latestPrices || []).filter(price =>
        majorTokens.includes(price.symbol)
      );

      // Add NGNZ at the beginning if available
      const allPrices = ngnzRate ? [ngnzRate, ...relevantPrices] : relevantPrices;

      if (allPrices.length === 0) {
        return { success: false, reason: 'No prices found' };
      }

      // Format the notification message
      const notification = this.formatPriceNotification(allPrices);

      // Get all users with push tokens
      const users = await User.find({
        $or: [
          { fcmToken: { $ne: null } },
          { expoPushToken: { $ne: null } }
        ]
      }).select('_id fcmToken expoPushToken email username');

      if (users.length === 0) {
        return { success: false, reason: 'No users with push tokens found' };
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
              type: 'price_update',
              timestamp: new Date().toISOString(),
              tokens: allPrices.map(p => ({
                symbol: p.symbol,
                price: p.price,
                change: p.hourly_change
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
        successCount,
        errorCount,
        skippedCount,
        notification: { title: notification.title, body: notification.body },
        errors: errors.slice(0, 5) // Return first 5 errors for debugging
      };

    } catch (error) {
      logger.error('Error in test price notification', { error: error.message });
      return { success: false, reason: error.message };
    }
  }
}

// Create singleton instance
const scheduledNotificationService = new ScheduledNotificationService();

module.exports = scheduledNotificationService;
