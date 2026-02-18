// utils/appsFlyerHelper.js
// Helper functions for AppsFlyer S2S event tracking

const appsFlyerS2S = require('../services/appsFlyerS2SService');
const User = require('../models/user');
const logger = require('./logger');

/**
 * Detect platform from user agent or request headers
 * @param {Object} req - Express request object
 * @returns {string} 'ios' or 'android'
 */
function detectPlatform(req) {
  const userAgent = req.headers['user-agent'] || '';
  const platformHeader = req.headers['x-platform'] || req.body?.platform;
  
  // Check explicit platform header first
  if (platformHeader) {
    const platform = platformHeader.toLowerCase();
    if (platform === 'ios' || platform === 'android') {
      return platform;
    }
  }
  
  // Detect from user agent
  const ua = userAgent.toLowerCase();
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) {
    return 'ios';
  }
  if (ua.includes('android')) {
    return 'android';
  }
  
  // Default to android if unknown
  return 'android';
}

/**
 * Get user's AppsFlyer ID and send S2S event
 * @param {string} userId - User ID
 * @param {string} eventName - Event name
 * @param {Object} eventParams - Event parameters
 * @param {Object} req - Express request object (for platform detection)
 * @returns {Promise<void>}
 */
async function trackEvent(userId, eventName, eventParams = {}, req = null) {
  try {
    if (!userId) {
      logger.warn('AppsFlyer S2S: No user ID provided', { eventName });
      return;
    }

    // Get user with AppsFlyer ID
    const user = await User.findById(userId).select('appsflyer_id').lean();
    
    if (!user || !user.appsflyer_id) {
      logger.debug('AppsFlyer S2S: User has no appsflyer_id, skipping event', {
        eventName,
        userId: userId.toString().substring(0, 10)
      });
      return;
    }

    // Detect platform
    const platform = req ? detectPlatform(req) : 'android'; // Default to android if req not provided

    // Map event name to tracking function
    const eventMap = {
      'sign_up': () => appsFlyerS2S.trackSignUp({
        appsflyer_id: user.appsflyer_id,
        platform,
        customerUserId: userId.toString(),
        registrationMethod: eventParams.registrationMethod || 'phone'
      }),
      'login_': () => appsFlyerS2S.trackLogin({
        appsflyer_id: user.appsflyer_id,
        platform,
        customerUserId: userId.toString(),
        loginMethod: eventParams.loginMethod || 'pin'
      }),
      'Swap_': () => appsFlyerS2S.trackSwap({
        appsflyer_id: user.appsflyer_id,
        platform,
        customerUserId: userId.toString(),
        fromCurrency: eventParams.fromCurrency,
        toCurrency: eventParams.toCurrency,
        amount: eventParams.amount
      }),
      'Withdrawal': () => appsFlyerS2S.trackWithdrawal({
        appsflyer_id: user.appsflyer_id,
        platform,
        customerUserId: userId.toString(),
        amount: eventParams.amount,
        currency: eventParams.currency || 'NGN',
        method: eventParams.method
      }),
      'Deposit': () => appsFlyerS2S.trackDeposit({
        appsflyer_id: user.appsflyer_id,
        platform,
        customerUserId: userId.toString(),
        amount: eventParams.amount,
        currency: eventParams.currency || 'NGN',
        method: eventParams.method
      }),
      'Utility': () => appsFlyerS2S.trackUtility({
        appsflyer_id: user.appsflyer_id,
        platform,
        customerUserId: userId.toString(),
        utilityType: eventParams.utilityType,
        amount: eventParams.amount,
        currency: eventParams.currency || 'NGN',
        provider: eventParams.provider
      }),
      'Email Verified': () => appsFlyerS2S.trackEmailVerified({
        appsflyer_id: user.appsflyer_id,
        platform,
        customerUserId: userId.toString()
      }),
      'KYC_1': () => appsFlyerS2S.trackKYC1({
        appsflyer_id: user.appsflyer_id,
        platform,
        customerUserId: userId.toString()
      }),
      'KYC_2': () => appsFlyerS2S.trackKYC2({
        appsflyer_id: user.appsflyer_id,
        platform,
        customerUserId: userId.toString()
      })
    };

    const trackFunction = eventMap[eventName];
    if (!trackFunction) {
      logger.warn('AppsFlyer S2S: Unknown event name', { eventName });
      return;
    }

    // Send event (non-blocking)
    trackFunction().catch(error => {
      logger.error('AppsFlyer S2S: Failed to send event', {
        eventName,
        userId: userId.toString().substring(0, 10),
        error: error.message
      });
    });

  } catch (error) {
    logger.error('AppsFlyer S2S: Error tracking event', {
      eventName,
      userId: userId?.toString().substring(0, 10),
      error: error.message
    });
  }
}

module.exports = {
  detectPlatform,
  trackEvent
};
