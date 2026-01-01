require('dotenv').config({ path: '/Users/mac/Projects/Bramp-Server/.env' });
module.exports = {
  port: process.env.PORT || 3000,
  mongoURI: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  refreshjwtSecret: process.env.REFRESH_JWT_SECRET,
  termii: {
    apiKey: process.env.TERMII_API_KEY,
    senderId: process.env.TERMII_SENDER_ID,
    baseUrl: process.env.TERMII_BASE_URL || 'https://api.ng.termii.com'
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    senderverifyServiceSidId: process.env.TWILIO_VERIFY_SERVICE_SID
  },
  FIREBLOCKS_API_KEY: process.env.FIREBLOCKS_API_KEY,
  FIREBLOCKS_KEY_PATH: process.env.FIREBLOCKS_KEY_PATH,
  VAULT_ACCOUNT_ID: process.env.VAULT_ACCOUNT_ID,

  obiex: {
    apiKey: process.env.OBIEX_API_KEY,
    apiSecret: process.env.OBIEX_API_SECRET,
    baseURL: process.env.OBIEX_BASE_URL, // Changed from baseUrl to baseURL
    webhookSecret: process.env.OBIEX_WEBHOOK_SECRET,
  },

  youverify: {
    publicMerchantKey: process.env.YOUVERIFY_PUBLIC_MERCHANT_KEY,
    secretKey: process.env.YOUVERIFY_SECRET_KEY,
    callbackUrl: process.env.YOUVERIFY_CALLBACK_URL || 'https://your-domain.com/kyc-webhook/callback',
    apiBaseUrl: process.env.YOUVERIFY_API_URL || 'https://api.youverify.co'
  }
};