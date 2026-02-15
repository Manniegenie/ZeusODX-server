// services/appsFlyerS2SService.js
// Server-to-Server (S2S) events API for AppsFlyer
// Documentation: https://dev.appsflyer.com/hc/reference/s2s-events-api3-overview

const axios = require('axios');
const logger = require('../utils/logger');

class AppsFlyerS2SService {
  constructor() {
    // Get AppsFlyer credentials from environment variables
    this.devKey = process.env.APPSFLYER_DEV_KEY || '';
    this.s2sApiToken = process.env.APPSFLYER_S2S_API_TOKEN || '';
    this.iosAppId = process.env.APPSFLYER_IOS_APP_ID || 'id6755314395';
    this.androidAppId = process.env.APPSFLYER_ANDROID_APP_ID || 'com.manniegenie.zeusodx';
    
    // AppsFlyer S2S API endpoint
    this.apiEndpoint = 'https://api3.appsflyer.com/inappevent';
    
    if (!this.devKey || !this.s2sApiToken) {
      logger.warn('AppsFlyer S2S credentials not configured. S2S events will be skipped.');
    }
  }

  /**
   * Send S2S event to AppsFlyer
   * @param {Object} params - Event parameters
   * @param {string} params.appsflyer_id - AppsFlyer UID (required)
   * @param {string} params.eventName - Event name (required)
   * @param {Object} params.eventValue - Event parameters (optional)
   * @param {string} params.platform - 'ios' or 'android' (required)
   * @param {string} params.customerUserId - Your app's user ID (optional but recommended)
   * @param {number} params.eventTime - Unix timestamp in milliseconds (optional, defaults to now)
   * @returns {Promise<Object>} Result object with success status
   */
  async sendEvent({
    appsflyer_id,
    eventName,
    eventValue = {},
    platform,
    customerUserId = null,
    eventTime = null
  }) {
    // Validate required fields
    if (!appsflyer_id) {
      logger.warn('AppsFlyer S2S: Missing appsflyer_id, skipping event', { eventName });
      return { success: false, error: 'appsflyer_id is required' };
    }

    if (!eventName) {
      logger.warn('AppsFlyer S2S: Missing eventName, skipping event');
      return { success: false, error: 'eventName is required' };
    }

    if (!platform || !['ios', 'android'].includes(platform.toLowerCase())) {
      logger.warn('AppsFlyer S2S: Invalid platform, skipping event', { eventName, platform });
      return { success: false, error: 'platform must be "ios" or "android"' };
    }

    if (!this.devKey || !this.s2sApiToken) {
      logger.warn('AppsFlyer S2S: Credentials not configured, skipping event', { eventName });
      return { success: false, error: 'AppsFlyer credentials not configured' };
    }

    // Determine app ID based on platform
    let appId;
    if (platform.toLowerCase() === 'ios') {
      // iOS app ID should be prefixed with "id" if it's an App Store ID
      appId = this.iosAppId.startsWith('id') ? this.iosAppId : `id${this.iosAppId}`;
    } else {
      appId = this.androidAppId;
    }

    // Build event payload
    const payload = {
      appsflyer_id,
      eventName,
      eventValue: {
        ...eventValue,
        // Add OS parameter (required for iOS 14+)
        os: platform.toLowerCase() === 'ios' ? 'iOS' : 'Android',
        // Add customer user ID if provided
        ...(customerUserId && { customer_user_id: customerUserId })
      },
      // Event time in Unix timestamp (milliseconds)
      eventTime: eventTime || Date.now()
    };

    // Build API URL
    const url = `${this.apiEndpoint}/${appId}`;

    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Authorization': `Bearer ${this.s2sApiToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000 // 10 second timeout
      });

      if (response.status === 200) {
        logger.info('AppsFlyer S2S event sent successfully', {
          eventName,
          appsflyer_id: appsflyer_id.substring(0, 10) + '...',
          platform
        });
        return { success: true, data: response.data };
      } else {
        logger.warn('AppsFlyer S2S event returned non-200 status', {
          eventName,
          status: response.status,
          data: response.data
        });
        return { success: false, error: `HTTP ${response.status}`, data: response.data };
      }
    } catch (error) {
      logger.error('AppsFlyer S2S event failed', {
        eventName,
        error: error.message,
        response: error.response?.data,
        status: error.response?.status
      });
      return {
        success: false,
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      };
    }
  }

  /**
   * Send sign_up event
   */
  async trackSignUp({ appsflyer_id, platform, customerUserId, registrationMethod = 'phone' }) {
    return this.sendEvent({
      appsflyer_id,
      eventName: 'sign_up',
      eventValue: {
        registration_method: registrationMethod
      },
      platform,
      customerUserId
    });
  }

  /**
   * Send login event
   */
  async trackLogin({ appsflyer_id, platform, customerUserId, loginMethod = 'pin' }) {
    return this.sendEvent({
      appsflyer_id,
      eventName: 'login_',
      eventValue: {
        login_method: loginMethod
      },
      platform,
      customerUserId
    });
  }

  /**
   * Send swap event
   */
  async trackSwap({ appsflyer_id, platform, customerUserId, fromCurrency, toCurrency, amount }) {
    return this.sendEvent({
      appsflyer_id,
      eventName: 'Swap_',
      eventValue: {
        from_currency: fromCurrency,
        to_currency: toCurrency,
        amount: amount
      },
      platform,
      customerUserId
    });
  }

  /**
   * Send withdrawal event
   */
  async trackWithdrawal({ appsflyer_id, platform, customerUserId, amount, currency, method }) {
    return this.sendEvent({
      appsflyer_id,
      eventName: 'Withdrawal',
      eventValue: {
        amount: amount,
        currency: currency,
        withdrawal_method: method
      },
      platform,
      customerUserId
    });
  }

  /**
   * Send deposit event
   */
  async trackDeposit({ appsflyer_id, platform, customerUserId, amount, currency, method }) {
    return this.sendEvent({
      appsflyer_id,
      eventName: 'Deposit',
      eventValue: {
        amount: amount,
        currency: currency,
        deposit_method: method
      },
      platform,
      customerUserId
    });
  }

  /**
   * Send utility event (for all utilities: airtime, data, electricity, cable TV, betting)
   */
  async trackUtility({ appsflyer_id, platform, customerUserId, utilityType, amount, currency, provider }) {
    return this.sendEvent({
      appsflyer_id,
      eventName: 'Utility',
      eventValue: {
        utility_type: utilityType, // 'airtime', 'data', 'electricity', 'cable_tv', 'betting'
        amount: amount,
        currency: currency,
        provider: provider
      },
      platform,
      customerUserId
    });
  }

  /**
   * Send email verified event
   */
  async trackEmailVerified({ appsflyer_id, platform, customerUserId }) {
    return this.sendEvent({
      appsflyer_id,
      eventName: 'Email Verified',
      eventValue: {},
      platform,
      customerUserId
    });
  }

  /**
   * Send KYC Level 1 completed event
   */
  async trackKYC1({ appsflyer_id, platform, customerUserId }) {
    return this.sendEvent({
      appsflyer_id,
      eventName: 'KYC_1',
      eventValue: {},
      platform,
      customerUserId
    });
  }

  /**
   * Send KYC Level 2 completed event
   */
  async trackKYC2({ appsflyer_id, platform, customerUserId }) {
    return this.sendEvent({
      appsflyer_id,
      eventName: 'KYC_2',
      eventValue: {},
      platform,
      customerUserId
    });
  }
}

module.exports = new AppsFlyerS2SService();
