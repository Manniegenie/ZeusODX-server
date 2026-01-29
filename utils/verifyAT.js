require('dotenv').config();
const AfricasTalking = require('africastalking');

// Initialize Africa's Talking SDK
const africastalking = AfricasTalking({
  apiKey: process.env.AT_API_KEY,
  username: process.env.AT_USERNAME, // e.g., 'Bramp' or 'sandbox'
});

const sms = africastalking.SMS;

// Admin phone numbers for transaction alerts
const ADMIN_PHONES = [
  '+2348141751569',
  '+2347069510203'
];

/**
 * Send verification code via SMS
 * @param {string} phoneNumber - e.g. '2348141751569' (no plus sign)
 * @param {string} code - e.g. '123456'
 */
async function sendVerificationCode(phoneNumber, code) {
  if (!process.env.AT_API_KEY || !process.env.AT_USERNAME) {
    console.error('⚠️ Africa\'s Talking API credentials missing in .env');
    return { success: false, error: 'Missing API credentials' };
  }

  const recipient = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
  const senderId = process.env.AT_SENDER_ID || 'sandbox';
  const message = `Your ZeusODX verification code is: ${code}`;

  // Log final values
  console.log('📨 Prepared SMS:');
  console.log('To:', [recipient]);
  console.log('From:', senderId);
  console.log('Message:', message);

  try {
    const response = await sms.send({
      to: [recipient],
      message,
      from: senderId,
    });

    console.log('✅ SMS sent:', response);
    return { success: true, response };
  } catch (error) {
    console.error('❌ Failed to send SMS:', error.message || error);
    return { success: false, error };
  }
}

/**
 * Format currency amount with commas
 */
function formatAmount(amount) {
  return Number(amount).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

/**
 * Send giftcard submission alert to admins
 * @param {Object} details - Transaction details
 * @param {string} details.username - User's name or username
 * @param {string} details.cardType - Type of gift card
 * @param {string} details.cardFormat - PHYSICAL or E_CODE
 * @param {number} details.cardValue - Card value in USD
 * @param {number} details.expectedAmount - Expected payout in NGN
 * @param {string} details.country - Country of origin
 * @param {string} details.submissionId - Submission reference ID
 */
async function sendGiftcardAlert(details) {
  if (!process.env.AT_API_KEY || !process.env.AT_USERNAME) {
    console.error('⚠️ Africa\'s Talking API credentials missing in .env');
    return { success: false, error: 'Missing API credentials' };
  }

  const {
    username,
    cardType,
    cardFormat,
    cardValue,
    expectedAmount,
    country,
    submissionId
  } = details;

  const senderId = process.env.AT_SENDER_ID || 'ZeusODX';
  const message = `ZeusODX Alert\n\nNew giftcard submission.\n\nCustomer: ${username}\nCard: ${cardType} (${cardFormat === 'E_CODE' ? 'E-Code' : 'Physical'})\nValue: $${formatAmount(cardValue)} ${country}\nPayout: NGN ${formatAmount(expectedAmount)}\nRef: ${submissionId}\n\nReview in admin panel.`;

  console.log('📨 Sending giftcard alert to admins');

  try {
    const response = await sms.send({
      to: ADMIN_PHONES,
      message,
      from: senderId,
    });

    console.log('✅ Giftcard alert sent:', response);
    return { success: true, response };
  } catch (error) {
    console.error('❌ Failed to send giftcard alert:', error.message || error);
    return { success: false, error: error.message || error };
  }
}

module.exports = { sendVerificationCode, sendGiftcardAlert };
