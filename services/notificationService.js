// services/notificationService.js
// Expo-only notification service (FCM removed to avoid conflicts)
const { Expo } = require('expo-server-sdk');
const User = require('../models/user');
const logger = require('../utils/logger');
const { saveNotification } = require('./notificationStorageService');

async function clearUserTokens(userId) {
  if (!userId) return;

  try {
    await User.findByIdAndUpdate(userId, { expoPushToken: null }, { new: false }).lean();
    logger.info('Cleared invalid Expo push token for user', { userId });
  } catch (error) {
    logger.error('Failed to clear invalid push token', { userId, error: error.message });
  }
}

async function handleExpoReceipts(tickets, userId) {
  const receiptIds = tickets
    .filter((ticket) => ticket?.status === 'ok' && ticket?.id)
    .map((ticket) => ticket.id);

  if (!receiptIds.length) return;

  // Expo recommends waiting briefly before fetching receipts
  await new Promise((resolve) => setTimeout(resolve, 1000));

  try {
    const chunks = expo.chunkPushNotificationReceiptIds(receiptIds);
    for (const chunk of chunks) {
      const receipts = await expo.getPushNotificationReceiptsAsync(chunk);
      for (const [receiptId, receipt] of Object.entries(receipts)) {
        if (receipt.status === 'error') {
          const detailError = receipt.details?.error;
          logger.warn('Expo receipt error', { userId, receiptId, detailError });
          if (detailError === 'DeviceNotRegistered' || detailError === 'NotRegistered') {
            await clearUserTokens(userId);
          }
        }
      }
    }
  } catch (error) {
    logger.error('Failed to fetch Expo push receipts', { userId, error: error.message });
  }
}

// Initialize Expo SDK
const expo = new Expo();

/**
 * Notification templates for different transaction types
 */
const NOTIFICATION_TEMPLATES = {
  DEPOSIT: {
    title: '💰 Deposit Received',
    getMessage: (amount, currency) => `Deposit of ${amount} ${currency} received. Processing...`,
    sound: 'default',
    priority: 'high',
  },
  DEPOSIT_CONFIRMED: {
    title: '✅ Deposit Confirmed',
    getMessage: (amount, currency) => `Deposit of ${amount} ${currency} confirmed. Balance updated.`,
    sound: 'default',
    priority: 'high',
  },
  WITHDRAWAL: {
    title: '📤 Withdrawal Initiated',
    getMessage: (amount, currency) => `Withdrawal of ${amount} ${currency} initiated. Processing...`,
    sound: 'default',
    priority: 'high',
  },
  WITHDRAWAL_COMPLETED: {
    title: '✅ Withdrawal Completed',
    getMessage: (amount, currency) => `Withdrawal of ${amount} ${currency} completed successfully.`,
    sound: 'default',
    priority: 'high',
  },
  WITHDRAWAL_FAILED: {
    title: '❌ Withdrawal Failed',
    getMessage: (amount, currency) => `Withdrawal of ${amount} ${currency} failed. Contact support.`,
    sound: 'default',
    priority: 'high',
  },
  TRANSFER_SENT: {
    title: '📨 Transfer Sent',
    getMessage: (amount, currency, recipient) => `Sent ${amount} ${currency}${recipient ? ` to ${recipient}` : ''}.`,
    sound: 'default',
    priority: 'high',
  },
  TRANSFER_RECEIVED: {
    title: '📬 Transfer Received',
    getMessage: (amount, currency, sender) => `Received ${amount} ${currency}${sender ? ` from ${sender}` : ''}.`,
    sound: 'default',
    priority: 'high',
  },
  SWAP_COMPLETED: {
    title: '🔄 Swap Completed',
    getMessage: (fromAmount, fromCurrency, toAmount, toCurrency) => 
      `Swapped ${fromAmount} ${fromCurrency} to ${toAmount} ${toCurrency}.`,
    sound: 'default',
    priority: 'high',
  },
  PAYMENT_COMPLETED: {
    title: '💳 Payment Successful',
    getMessage: (amount, currency, description) => 
      `Payment of ${amount} ${currency}${description ? ` for ${description}` : ''} completed.`,
    sound: 'default',
    priority: 'high',
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
      `${network} airtime ₦${amount} to ${phone} completed.`,
    sound: 'default',
    priority: 'high',
  },
  AIRTIME_PROCESSING: {
    title: '⏳ Airtime Purchase Processing',
    getMessage: (amount, network, phone) => 
      `Your ${network} airtime purchase of ₦${amount} to ${phone} is being processed.`,
    sound: 'default',
    priority: 'high',
  },
  AIRTIME_FAILED: {
    title: '❌ Airtime Purchase Failed',
    getMessage: (amount, network, phone) => 
      `Your ${network} airtime purchase of ₦${amount} to ${phone} has failed.`,
    sound: 'default',
    priority: 'high',
  },
  KYC_COMPLETED: {
    title: '✅ KYC Verification Completed',
    getMessage: (status, type) => 
      `Your ${type} verification has been ${status.toLowerCase()}. ${status === 'APPROVED' ? 'Your account limits have been updated.' : ''}`,
    sound: 'default',
    priority: 'high',
  },
  NGNZ_SWAP_COMPLETED: {
    title: '💱 NGNZ Swap Completed',
    getMessage: (fromAmount, fromCurrency, toAmount, toCurrency) => 
      `Swapped ${fromAmount} ${fromCurrency} to ${toAmount} ${toCurrency}.`,
    sound: 'default',
    priority: 'high',
  },
  CABLE_TV_COMPLETED: {
    title: '📺 Cable TV Payment',
    getMessage: (amount, provider, account) => 
      `₦${amount} paid for ${provider}${account ? ` (${account})` : ''}.`,
    sound: 'default',
    priority: 'high',
  },
  BETTING_FUNDING_COMPLETED: {
    title: '🎲 Betting Funding',
    getMessage: (amount, provider, account) => 
      `₦${amount} funded to ${provider}${account ? ` (${account})` : ''}.`,
    sound: 'default',
    priority: 'high',
  },
  ELECTRICITY_PAYMENT_COMPLETED: {
    title: '⚡ Electricity Payment',
    getMessage: (amount, provider, account) => 
      `₦${amount} paid for ${provider}${account ? ` (${account})` : ''}.`,
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

    // Use Expo token only (more lenient validation for testing/simulators)
    if (user.expoPushToken && (Expo.isExpoPushToken(user.expoPushToken) || user.expoPushToken.startsWith('ExponentPushToken['))) {
      return {
        success: true,
        expoPushToken: user.expoPushToken,
        deviceId: user.deviceId,
        userInfo: { email: user.email, username: user.username }
      };
    }

    logger.info('User has no valid Expo push token registered', { userId, email: user.email, username: user.username });
    return { success: false, message: 'No Expo push token registered' };
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
 * @param {string} notificationData.priority - Notification priority (default: 'high')
 * @returns {Promise<Object>} Result of notification send
 */
async function sendPushNotification(userId, notificationData) {
  try {
    const { title, body, data = {}, sound = 'default', priority = 'high' } = notificationData;

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
    let pushResult = null;
    let pushVia = null;

    // Use Expo only
    if (expoPushToken) {
      const message = {
        to: expoPushToken,
        sound,
        title,
        body,
        data: { ...data, userId, timestamp: new Date().toISOString() },
        priority,
        channelId: 'transactions',
      };

      const chunks = expo.chunkPushNotifications([message]);
      const tickets = [];
      for (const chunk of chunks) {
        try {
          const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
          tickets.push(...ticketChunk);
        } catch (error) {
          logger.error('Error sending Expo push chunk', { userId, error: error.message });
        }
      }
      const hasErrors = tickets.some(t => t.status === 'error');
      if (hasErrors) logger.warn('Expo push had errors', { userId, tickets });
      handleExpoReceipts(tickets, userId).catch((error) => logger.error('Expo receipt handler failed', { userId, error: error.message }));
      pushResult = { success: true, tickets, hasErrors, via: 'expo' };
      pushVia = 'expo';
    } else {
      pushResult = { success: false, message: 'No valid Expo push token' };
    }

    // Save notification to database (fire-and-forget, don't block response)
    const notificationType = data.type || 'CUSTOM';
    saveNotification(userId, {
      title,
      message: body,
      subtitle: data.subtitle || null,
      type: notificationType,
      data: data,
      pushSent: pushResult.success,
      pushVia: pushVia
    }).catch((saveError) => {
      // Log but don't fail the push notification
      logger.error('Failed to save notification to database', {
        userId,
        error: saveError.message
      });
    });

    return pushResult;

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
      priority: options.priority || 'high',
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

/**
 * Send KYC completion notification
 * @param {string} userId - User ID
 * @param {string} status - Verification status (APPROVED, REJECTED, PROVISIONAL)
 * @param {string} type - Verification type (BVN, Document KYC)
 * @param {Object} additionalData - Additional data to include
 * @returns {Promise<Object>} Notification result
 */
async function sendKycCompletionNotification(userId, status, type, additionalData = {}) {
  try {
    const template = NOTIFICATION_TEMPLATES.KYC_COMPLETED;
    
    const notificationData = {
      title: template.title,
      body: template.getMessage(status, type),
      sound: template.sound,
      priority: template.priority,
      data: {
        type: 'KYC_VERIFICATION',
        status: status.toUpperCase(),
        verificationType: type,
        ...additionalData
      }
    };

    return await sendPushNotification(userId, notificationData);
  } catch (error) {
    logger.error('Error sending KYC completion notification', { userId, status, type, error: error.message });
    return { success: false, message: 'Failed to send KYC completion notification' };
  }
}

/**
 * Send swap completion notification
 * @param {string} userId - User ID
 * @param {number} fromAmount - From amount
 * @param {string} fromCurrency - From currency
 * @param {number} toAmount - To amount
 * @param {string} toCurrency - To currency
 * @param {boolean} isNGNZ - Whether this is an NGNZ swap
 * @param {Object} additionalData - Additional data to include
 * @returns {Promise<Object>} Notification result
 */
async function sendSwapCompletionNotification(userId, fromAmount, fromCurrency, toAmount, toCurrency, isNGNZ = false, additionalData = {}) {
  try {
    const template = isNGNZ ? NOTIFICATION_TEMPLATES.NGNZ_SWAP_COMPLETED : NOTIFICATION_TEMPLATES.SWAP_COMPLETED;
    
    const notificationData = {
      title: template.title,
      body: template.getMessage(fromAmount, fromCurrency, toAmount, toCurrency),
      sound: template.sound,
      priority: template.priority,
      data: {
        type: isNGNZ ? 'NGNZ_SWAP' : 'SWAP',
        fromAmount,
        fromCurrency,
        toAmount,
        toCurrency,
        ...additionalData
      }
    };

    return await sendPushNotification(userId, notificationData);
  } catch (error) {
    logger.error('Error sending swap completion notification', { 
      userId, 
      fromAmount, 
      fromCurrency, 
      toAmount, 
      toCurrency, 
      isNGNZ, 
      error: error.message 
    });
    return { success: false, message: 'Failed to send swap completion notification' };
  }
}

/**
 * Send utility payment notification (Cable TV, Betting, Electricity)
 * @param {string} userId - User ID
 * @param {string} utilityType - Type of utility ('CABLE_TV', 'BETTING', 'ELECTRICITY')
 * @param {number} amount - Payment amount
 * @param {string} provider - Service provider name
 * @param {string} account - Account number/ID
 * @param {Object} additionalData - Additional data to include
 * @returns {Promise<Object>} Notification result
 */
async function sendUtilityPaymentNotification(userId, utilityType, amount, provider, account = '', additionalData = {}) {
  try {
    let template;
    let notificationType;
    
    switch (utilityType.toUpperCase()) {
      case 'CABLE_TV':
        template = NOTIFICATION_TEMPLATES.CABLE_TV_COMPLETED;
        notificationType = 'PAYMENT';
        break;
      case 'BETTING':
        template = NOTIFICATION_TEMPLATES.BETTING_FUNDING_COMPLETED;
        notificationType = 'PAYMENT';
        break;
      case 'ELECTRICITY':
        template = NOTIFICATION_TEMPLATES.ELECTRICITY_PAYMENT_COMPLETED;
        notificationType = 'PAYMENT';
        break;
      default:
        template = NOTIFICATION_TEMPLATES.PAYMENT_COMPLETED;
        notificationType = 'PAYMENT';
    }
    
    const notificationData = {
      title: template.title,
      body: template.getMessage(amount, provider, account),
      sound: template.sound,
      priority: template.priority,
      data: {
        type: notificationType,
        utilityType: utilityType.toUpperCase(),
        amount,
        provider,
        account,
        currency: 'NGNZ',
        ...additionalData
      }
    };

    return await sendPushNotification(userId, notificationData);
  } catch (error) {
    logger.error('Error sending utility payment notification', { 
      userId, 
      utilityType, 
      amount, 
      provider, 
      error: error.message 
    });
    return { success: false, message: 'Failed to send utility payment notification' };
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
  sendKycCompletionNotification,
  sendSwapCompletionNotification,
  sendUtilityPaymentNotification,
  NOTIFICATION_TEMPLATES
};