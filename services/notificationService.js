// services/pushNotificationService.js
const { Expo } = require('expo-server-sdk');
const User = require('../models/user');
const logger = require('../utils/logger');

// Initialize Expo SDK
const expo = new Expo();

/**
 * Notification templates for different transaction types
 */
const NOTIFICATION_TEMPLATES = {
  DEPOSIT: {
    title: '💰 Deposit Received',
    getMessage: (amount, currency) => `Your deposit of ${amount} ${currency} has been received and is being processed.`,
    sound: 'default',
    priority: 'high',
  },
  DEPOSIT_CONFIRMED: {
    title: '✅ Deposit Confirmed',
    getMessage: (amount, currency) => `Your deposit of ${amount} ${currency} has been confirmed and added to your balance.`,
    sound: 'default',
    priority: 'high',
  },
  WITHDRAWAL: {
    title: '📤 Withdrawal Initiated',
    getMessage: (amount, currency) => `Your withdrawal of ${amount} ${currency} has been initiated and is being processed.`,
    sound: 'default',
    priority: 'high',
  },
  WITHDRAWAL_COMPLETED: {
    title: '✅ Withdrawal Completed',
    getMessage: (amount, currency) => `Your withdrawal of ${amount} ${currency} has been completed successfully.`,
    sound: 'default',
    priority: 'high',
  },
  WITHDRAWAL_FAILED: {
    title: '❌ Withdrawal Failed',
    getMessage: (amount, currency) => `Your withdrawal of ${amount} ${currency} has failed. Please contact support.`,
    sound: 'default',
    priority: 'high',
  },
  TRANSFER_SENT: {
    title: '📨 Transfer Sent',
    getMessage: (amount, currency, recipient) => `You sent ${amount} ${currency}${recipient ? ` to ${recipient}` : ''}.`,
    sound: 'default',
    priority: 'default',
  },
  TRANSFER_RECEIVED: {
    title: '📬 Transfer Received',
    getMessage: (amount, currency, sender) => `You received ${amount} ${currency}${sender ? ` from ${sender}` : ''}.`,
    sound: 'default',
    priority: 'high',
  },
  SWAP_COMPLETED: {
    title: '🔄 Swap Completed',
    getMessage: (fromAmount, fromCurrency, toAmount, toCurrency) => 
      `Swapped ${fromAmount} ${fromCurrency} to ${toAmount} ${toCurrency}.`,
    sound: 'default',
    priority: 'default',
  },
  PAYMENT_COMPLETED: {
    title: '💳 Payment Successful',
    getMessage: (amount, currency, description) => 
      `Payment of ${amount} ${currency}${description ? ` for ${description}` : ''} was successful.`,
    sound: 'default',
    priority: 'default',
  },
  SECURITY_ALERT: {
    title: '🔒 Security Alert',
    getMessage: (message) => message,
    sound: 'default',
    priority: 'high',
  },
  AIRTIME_PURCHASE: {
    title: '📱 Airtime Purchase Successful',
    getMessage: (amount, network, phone) => 
      `Your ${network} airtime purchase of ₦${amount} to ${phone} was successful.`,
    sound: 'default',
    priority: 'default',
  },
  AIRTIME_PROCESSING: {
    title: '⏳ Airtime Purchase Processing',
    getMessage: (amount, network, phone) => 
      `Your ${network} airtime purchase of ₦${amount} to ${phone} is being processed.`,
    sound: 'default',
    priority: 'default',
  },
  AIRTIME_FAILED: {
    title: '❌ Airtime Purchase Failed',
    getMessage: (amount, network, phone) => 
      `Your ${network} airtime purchase of ₦${amount} to ${phone} has failed.`,
    sound: 'default',
    priority: 'high',
  },
};

/**
 * Get user's expo push token and device ID
 * @param {string} userId - User ID
 * @returns {Promise<Object>} User's push notification data
 */
async function getUserPushToken(userId) {
  try {
    const user = await User.findById(userId).select('expoPushToken deviceId email username');
    
    if (!user) {
      logger.warn('User not found for push notification', { userId });
      return { success: false, message: 'User not found' };
    }

    if (!user.expoPushToken) {
      logger.info('User has no push token registered', { 
        userId, 
        email: user.email,
        username: user.username 
      });
      return { success: false, message: 'No push token registered' };
    }

    // Validate that the token is a valid Expo push token
    if (!Expo.isExpoPushToken(user.expoPushToken)) {
      logger.warn('Invalid Expo push token format', { 
        userId, 
        token: user.expoPushToken.substring(0, 20) + '...' 
      });
      return { success: false, message: 'Invalid push token format' };
    }

    return {
      success: true,
      expoPushToken: user.expoPushToken,
      deviceId: user.deviceId,
      userInfo: {
        email: user.email,
        username: user.username
      }
    };
  } catch (error) {
    logger.error('Error fetching user push token', { userId, error: error.message });
    return { success: false, message: 'Error fetching push token' };
  }
}

/**
 * Send push notification to a specific user
 * @param {string} userId - User ID to send notification to
 * @param {Object} notificationData - Notification data
 * @param {string} notificationData.title - Notification title
 * @param {string} notificationData.body - Notification body
 * @param {Object} notificationData.data - Additional data to send with notification
 * @param {string} notificationData.sound - Sound to play (default: 'default')
 * @param {string} notificationData.priority - Notification priority (default: 'default')
 * @returns {Promise<Object>} Result of notification send
 */
async function sendPushNotification(userId, notificationData) {
  try {
    const { title, body, data = {}, sound = 'default', priority = 'default' } = notificationData;

    // Get user's push token
    const tokenResult = await getUserPushToken(userId);
    
    if (!tokenResult.success) {
      return {
        success: false,
        message: tokenResult.message,
        skipped: true
      };
    }

    const { expoPushToken, deviceId, userInfo } = tokenResult;

    // Construct the notification message
    const message = {
      to: expoPushToken,
      sound: sound,
      title: title,
      body: body,
      data: {
        ...data,
        userId: userId,
        timestamp: new Date().toISOString()
      },
      priority: priority,
      channelId: 'transactions', // Android notification channel
    };

    logger.info('Sending push notification', {
      userId,
      deviceId,
      title,
      body: body.substring(0, 50) + (body.length > 50 ? '...' : ''),
      email: userInfo.email
    });

    // Send the notification
    const chunks = expo.chunkPushNotifications([message]);
    const tickets = [];

    for (const chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      } catch (error) {
        logger.error('Error sending push notification chunk', {
          userId,
          error: error.message
        });
      }
    }

    // Check for errors in tickets
    const hasErrors = tickets.some(ticket => ticket.status === 'error');
    
    if (hasErrors) {
      const errorTickets = tickets.filter(ticket => ticket.status === 'error');
      logger.warn('Push notification sent with errors', {
        userId,
        errors: errorTickets.map(t => t.message)
      });
    }

    logger.info('Push notification sent successfully', {
      userId,
      deviceId,
      ticketCount: tickets.length,
      hasErrors
    });

    return {
      success: true,
      tickets,
      hasErrors,
      message: 'Notification sent successfully'
    };

  } catch (error) {
    logger.error('Failed to send push notification', {
      userId,
      error: error.message,
      stack: error.stack
    });

    return {
      success: false,
      message: 'Failed to send notification',
      error: error.message
    };
  }
}

/**
 * Send deposit notification
 * @param {string} userId - User ID
 * @param {number} amount - Deposit amount
 * @param {string} currency - Currency
 * @param {string} status - Deposit status ('pending' or 'confirmed')
 * @param {Object} additionalData - Additional data to include
 * @returns {Promise<Object>} Notification result
 */
async function sendDepositNotification(userId, amount, currency, status = 'pending', additionalData = {}) {
  try {
    const template = status === 'confirmed' ? NOTIFICATION_TEMPLATES.DEPOSIT_CONFIRMED : NOTIFICATION_TEMPLATES.DEPOSIT;
    
    const notificationData = {
      title: template.title,
      body: template.getMessage(amount, currency),
      sound: template.sound,
      priority: template.priority,
      data: {
        type: 'DEPOSIT',
        status: status.toUpperCase(),
        amount,
        currency,
        ...additionalData
      }
    };

    return await sendPushNotification(userId, notificationData);
  } catch (error) {
    logger.error('Error sending deposit notification', { userId, amount, currency, error: error.message });
    return { success: false, message: 'Failed to send deposit notification' };
  }
}

/**
 * Send withdrawal notification
 * @param {string} userId - User ID
 * @param {number} amount - Withdrawal amount
 * @param {string} currency - Currency
 * @param {string} status - Withdrawal status ('initiated', 'completed', 'failed')
 * @param {Object} additionalData - Additional data to include
 * @returns {Promise<Object>} Notification result
 */
async function sendWithdrawalNotification(userId, amount, currency, status = 'initiated', additionalData = {}) {
  try {
    let template;
    
    switch (status.toLowerCase()) {
      case 'completed':
        template = NOTIFICATION_TEMPLATES.WITHDRAWAL_COMPLETED;
        break;
      case 'failed':
        template = NOTIFICATION_TEMPLATES.WITHDRAWAL_FAILED;
        break;
      default:
        template = NOTIFICATION_TEMPLATES.WITHDRAWAL;
    }
    
    const notificationData = {
      title: template.title,
      body: template.getMessage(amount, currency),
      sound: template.sound,
      priority: template.priority,
      data: {
        type: 'WITHDRAWAL',
        status: status.toUpperCase(),
        amount,
        currency,
        ...additionalData
      }
    };

    return await sendPushNotification(userId, notificationData);
  } catch (error) {
    logger.error('Error sending withdrawal notification', { userId, amount, currency, error: error.message });
    return { success: false, message: 'Failed to send withdrawal notification' };
  }
}

/**
 * Send transfer notification
 * @param {string} userId - User ID
 * @param {number} amount - Transfer amount
 * @param {string} currency - Currency
 * @param {string} type - Transfer type ('sent' or 'received')
 * @param {string} otherParty - Other party's username/identifier
 * @param {Object} additionalData - Additional data to include
 * @returns {Promise<Object>} Notification result
 */
async function sendTransferNotification(userId, amount, currency, type = 'sent', otherParty = null, additionalData = {}) {
  try {
    const template = type === 'received' ? NOTIFICATION_TEMPLATES.TRANSFER_RECEIVED : NOTIFICATION_TEMPLATES.TRANSFER_SENT;
    
    const notificationData = {
      title: template.title,
      body: template.getMessage(amount, currency, otherParty),
      sound: template.sound,
      priority: template.priority,
      data: {
        type: 'TRANSFER',
        direction: type.toUpperCase(),
        amount,
        currency,
        otherParty,
        ...additionalData
      }
    };

    return await sendPushNotification(userId, notificationData);
  } catch (error) {
    logger.error('Error sending transfer notification', { userId, amount, currency, error: error.message });
    return { success: false, message: 'Failed to send transfer notification' };
  }
}

/**
 * Send swap notification
 * @param {string} userId - User ID
 * @param {number} fromAmount - From amount
 * @param {string} fromCurrency - From currency
 * @param {number} toAmount - To amount
 * @param {string} toCurrency - To currency
 * @param {Object} additionalData - Additional data to include
 * @returns {Promise<Object>} Notification result
 */
async function sendSwapNotification(userId, fromAmount, fromCurrency, toAmount, toCurrency, additionalData = {}) {
  try {
    const template = NOTIFICATION_TEMPLATES.SWAP_COMPLETED;
    
    const notificationData = {
      title: template.title,
      body: template.getMessage(fromAmount, fromCurrency, toAmount, toCurrency),
      sound: template.sound,
      priority: template.priority,
      data: {
        type: 'SWAP',
        fromAmount,
        fromCurrency,
        toAmount,
        toCurrency,
        ...additionalData
      }
    };

    return await sendPushNotification(userId, notificationData);
  } catch (error) {
    logger.error('Error sending swap notification', { userId, error: error.message });
    return { success: false, message: 'Failed to send swap notification' };
  }
}

/**
 * Send payment notification
 * @param {string} userId - User ID
 * @param {number} amount - Payment amount
 * @param {string} currency - Currency
 * @param {string} description - Payment description
 * @param {Object} additionalData - Additional data to include
 * @returns {Promise<Object>} Notification result
 */
async function sendPaymentNotification(userId, amount, currency, description = '', additionalData = {}) {
  try {
    const template = NOTIFICATION_TEMPLATES.PAYMENT_COMPLETED;
    
    const notificationData = {
      title: template.title,
      body: template.getMessage(amount, currency, description),
      sound: template.sound,
      priority: template.priority,
      data: {
        type: 'PAYMENT',
        amount,
        currency,
        description,
        ...additionalData
      }
    };

    return await sendPushNotification(userId, notificationData);
  } catch (error) {
    logger.error('Error sending payment notification', { userId, amount, currency, error: error.message });
    return { success: false, message: 'Failed to send payment notification' };
  }
}

/**
 * Send security alert notification
 * @param {string} userId - User ID
 * @param {string} message - Alert message
 * @param {Object} additionalData - Additional data to include
 * @returns {Promise<Object>} Notification result
 */
async function sendSecurityAlert(userId, message, additionalData = {}) {
  try {
    const template = NOTIFICATION_TEMPLATES.SECURITY_ALERT;
    
    const notificationData = {
      title: template.title,
      body: template.getMessage(message),
      sound: template.sound,
      priority: template.priority,
      data: {
        type: 'SECURITY_ALERT',
        ...additionalData
      }
    };

    return await sendPushNotification(userId, notificationData);
  } catch (error) {
    logger.error('Error sending security alert', { userId, error: error.message });
    return { success: false, message: 'Failed to send security alert' };
  }
}

/**
 * Send airtime purchase notification - NO PHONE MASKING
 * @param {string} userId - User ID
 * @param {number} amount - Purchase amount
 * @param {string} network - Network provider (MTN, AIRTEL, GLO, 9MOBILE)
 * @param {string} phone - Phone number (full number, not masked)
 * @param {string} status - Purchase status ('completed', 'processing', 'failed')
 * @param {Object} additionalData - Additional data to include
 * @returns {Promise<Object>} Notification result
 */
async function sendAirtimePurchaseNotification(userId, amount, network, phone, status = 'completed', additionalData = {}) {
  try {
    let template;
    
    switch (status.toLowerCase()) {
      case 'completed':
      case 'completed-api':
        template = NOTIFICATION_TEMPLATES.AIRTIME_PURCHASE;
        break;
      case 'processing':
      case 'processing-api':
      case 'initiated-api':
        template = NOTIFICATION_TEMPLATES.AIRTIME_PROCESSING;
        break;
      case 'failed':
        template = NOTIFICATION_TEMPLATES.AIRTIME_FAILED;
        break;
      default:
        template = NOTIFICATION_TEMPLATES.AIRTIME_PURCHASE;
    }
    
    const notificationData = {
      title: template.title,
      body: template.getMessage(amount.toLocaleString(), network.toUpperCase(), phone),
      sound: template.sound,
      priority: template.priority,
      data: {
        type: 'AIRTIME_PURCHASE',
        status: status.toUpperCase(),
        amount,
        network: network.toUpperCase(),
        phone: phone,
        currency: 'NGNZ',
        ...additionalData
      }
    };

    return await sendPushNotification(userId, notificationData);
  } catch (error) {
    logger.error('Error sending airtime purchase notification', { 
      userId, 
      amount, 
      network, 
      error: error.message 
    });
    return { success: false, message: 'Failed to send airtime purchase notification' };
  }
}

/**
 * Send custom notification
 * @param {string} userId - User ID
 * @param {string} title - Notification title
 * @param {string} message - Notification message
 * @param {Object} data - Additional data
 * @param {Object} options - Notification options (sound, priority)
 * @returns {Promise<Object>} Notification result
 */
async function sendCustomNotification(userId, title, message, data = {}, options = {}) {
  try {
    const notificationData = {
      title,
      body: message,
      sound: options.sound || 'default',
      priority: options.priority || 'default',
      data: {
        type: 'CUSTOM',
        ...data
      }
    };

    return await sendPushNotification(userId, notificationData);
  } catch (error) {
    logger.error('Error sending custom notification', { userId, error: error.message });
    return { success: false, message: 'Failed to send custom notification' };
  }
}

/**
 * Send bulk notifications to multiple users
 * @param {Array<string>} userIds - Array of user IDs
 * @param {Object} notificationData - Notification data
 * @returns {Promise<Object>} Bulk notification results
 */
async function sendBulkNotifications(userIds, notificationData) {
  try {
    logger.info('Sending bulk notifications', { userCount: userIds.length });

    const results = await Promise.allSettled(
      userIds.map(userId => sendPushNotification(userId, notificationData))
    );

    const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    const failed = results.filter(r => r.status === 'rejected' || !r.value.success).length;
    const skipped = results.filter(r => r.status === 'fulfilled' && r.value.skipped).length;

    logger.info('Bulk notifications completed', {
      total: userIds.length,
      successful,
      failed,
      skipped
    });

    return {
      success: true,
      total: userIds.length,
      successful,
      failed,
      skipped,
      results
    };
  } catch (error) {
    logger.error('Error sending bulk notifications', { error: error.message });
    return {
      success: false,
      message: 'Failed to send bulk notifications',
      error: error.message
    };
  }
}

module.exports = {
  sendPushNotification,
  sendDepositNotification,
  sendWithdrawalNotification,
  sendTransferNotification,
  sendSwapNotification,
  sendPaymentNotification,
  sendSecurityAlert,
  sendAirtimePurchaseNotification,
  sendCustomNotification,
  sendBulkNotifications,
  getUserPushToken,
  NOTIFICATION_TEMPLATES
};