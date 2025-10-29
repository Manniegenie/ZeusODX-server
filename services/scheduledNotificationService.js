const cron = require('node-cron');
const CryptoPrice = require('../models/CryptoPrice');
const { sendPushNotification } = require('./pushNotificationService');
const User = require('../models/user');
const logger = require('./logger');

class ScheduledNotificationService {
  constructor() {
    this.isRunning = false;
    this.jobs = [];
  }

  // Start all scheduled notifications
  start() {
    if (this.isRunning) {
      logger.warn('Scheduled notifications already running');
      return;
    }

    logger.info('Starting scheduled notification service...');

    // Schedule price notifications at 6am, 12pm, 6pm, and 9pm
    const schedules = [
      { time: '6:00 AM', cron: '0 6 * * *' },
      { time: '12:00 PM', cron: '0 12 * * *' },
      { time: '6:00 PM', cron: '0 18 * * *' },
      { time: '9:00 PM', cron: '0 21 * * *' }
    ];

    schedules.forEach(({ time, cron: cronExpression }) => {
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
      
      // Get latest prices for major tokens
      const latestPrices = await CryptoPrice.getLatestPrices();
      
      if (!latestPrices || latestPrices.length === 0) {
        logger.warn('No crypto prices found, skipping notification');
        return;
      }

      // Filter for major tokens (BTC, ETH, BNB, SOL)
      const majorTokens = ['BTC', 'ETH', 'BNB', 'SOL'];
      const relevantPrices = latestPrices.filter(price => 
        majorTokens.includes(price.symbol)
      );

      if (relevantPrices.length === 0) {
        logger.warn('No major token prices found, skipping notification');
        return;
      }

      // Format the notification message
      const notification = this.formatPriceNotification(relevantPrices);
      
      logger.info('Sending price notification to all users...', { 
        message: notification.title,
        tokensCount: relevantPrices.length 
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
              tokens: relevantPrices.map(p => ({
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
        tokensIncluded: relevantPrices.map(p => p.symbol)
      });

    } catch (error) {
      logger.error('Error in scheduled price notification', { error: error.message });
    }
  }

  // Format the price notification message
  formatPriceNotification(prices) {
    const title = 'Latest Prices';
    
    // Sort prices by symbol for consistent ordering
    const sortedPrices = prices.sort((a, b) => a.symbol.localeCompare(b.symbol));
    
    // Format each token price
    const priceLines = sortedPrices.map(price => {
      const symbol = price.symbol;
      const priceFormatted = this.formatPrice(price.price);
      const changeFormatted = this.formatChange(price.hourly_change);
      
      return `${symbol} - ${priceFormatted} (${changeFormatted})`;
    });

    // Join with commas and add "Trade now" at the end
    const body = `${priceLines.join(', ')}. Trade now.`;

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
      jobsCount: this.jobs.length,
      schedules: this.jobs.map(({ time, job }) => ({
        time,
        running: job.running
      }))
    };
  }

  // Test the notification (for manual testing)
  async testNotification() {
    logger.info('Testing price notification...');
    await this.sendPriceNotification();
  }
}

// Create singleton instance
const scheduledNotificationService = new ScheduledNotificationService();

module.exports = scheduledNotificationService;
