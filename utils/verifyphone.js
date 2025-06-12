const axiosRetry = require('axios-retry').default; // Keep retry if you want to retry on failures (optional)
const axios = require('axios');
const config = require('../routes/config');

const { apiKey, senderId, baseUrl } = config.termii;

if (!apiKey || !senderId || !baseUrl) {
  throw new Error('Termii configuration missing. Ensure TERMII_API_KEY, TERMII_SENDER_ID, and TERMII_BASE_URL are set in your .env');
}

// Create axios client with timeout
const axiosClient = axios.create({
  timeout: 30000, // 30 seconds
  headers: { 'Content-Type': 'application/json' }
});

// Add retry mechanism: retry 3 times for network errors and 5xx
axiosRetry(axiosClient, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.code === 'ECONNABORTED';
  }
});

async function sendVerificationCode(phoneNumber) {
  try {
    const formattedPhone = phoneNumber.startsWith('+') ? phoneNumber.slice(1) : phoneNumber;

    const payload = {
      api_key: apiKey,
      message_type: 'NUMERIC',
      to: formattedPhone,
      from: senderId,
      channel: 'dnd',
      pin_attempts: 10,
      pin_time_to_live: 5,
      pin_length: 6,
      pin_placeholder: '< 1234 >',
      message_text: 'Your pin is < 1234 >',
      pin_type: 'NUMERIC'
    };

    const response = await axiosClient.post(`${baseUrl}/api/sms/otp/send`, payload);
    const data = response.data;

    if (data.code !== 'ok') {
      console.error('Termii OTP send failed:', data);
      throw new Error(data.message || 'Failed to send OTP');
    }

    console.log(`OTP sent successfully to ${formattedPhone.slice(0, 5)}****. Pin ID: ${data.pinId}`);

    return {
      success: true,
      pinId: data.pinId,
      to: formattedPhone,
      responseData: data
    };

  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    console.error(`Error sending OTP to ${phoneNumber}:`, msg);
    throw new Error(`Failed to send OTP: ${msg}`);
  }
}

module.exports = { sendVerificationCode };