const axios = require('axios');
const logger = require('../utils/logger');

const BREVO_SMS_URL = 'https://api.brevo.com/v3/transactionalSMS/send';
const SENDER_NAME = process.env.BREVO_SMS_SENDER || 'ZeusODX';

/**
 * Send an OTP via Brevo transactional SMS.
 * @param {string} phoneNumber - E.164 format, e.g. '+2348141751569'
 * @param {string} otp - The OTP code to send
 * @returns {{ success: boolean, error?: string }}
 */
async function sendBrevoSMS(phoneNumber, otp) {
  if (!process.env.BREVO_API_KEY) {
    logger.warn('BrevoSMS: BREVO_API_KEY not set — skipping');
    return { success: false, error: 'BREVO_API_KEY not configured' };
  }

  // Ensure E.164 with leading +
  const recipient = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;

  try {
    const response = await axios.post(
      BREVO_SMS_URL,
      {
        sender: SENDER_NAME,
        recipient,
        content: `Your ZeusODX verification code is: ${otp}`,
        type: 'transactional',
      },
      {
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 10000,
      }
    );

    logger.info('BrevoSMS: OTP sent', {
      phone: recipient.slice(0, 6) + '****',
      messageId: response.data?.messageId,
    });
    return { success: true, response: response.data };
  } catch (error) {
    const detail = error.response?.data?.message || error.message;
    logger.error('BrevoSMS: send failed', {
      phone: recipient.slice(0, 6) + '****',
      status: error.response?.status,
      error: detail,
    });
    return { success: false, error: detail };
  }
}

module.exports = { sendBrevoSMS };
