// src/services/EmailService.js
const brevo = require('@getbrevo/brevo');
require('dotenv').config();

const apiInstance = new brevo.TransactionalEmailsApi();
apiInstance.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

// ---- Defaults for links/branding ----
const APP_WEB_BASE_URL = (process.env.APP_WEB_BASE_URL || process.env.FRONTEND_BASE_URL || '').replace(/\/$/, '');
const APP_DEEP_LINK    = (process.env.APP_DEEP_LINK || 'zeusodx://').replace(/\/$/, '');
const COMPANY_NAME     = process.env.COMPANY_NAME || 'ZeusODX';
const SUPPORT_EMAIL    = process.env.SUPPORT_EMAIL || 'support@zeusodx.com';

function buildVerifyUrls(email) {
  const qs = `email=${encodeURIComponent(email)}`;
  return {
    verifyUrl: `${APP_WEB_BASE_URL}/kyc/verify-email?${qs}`,
    appDeepLink: `${APP_DEEP_LINK}/kyc/verify-email?${qs}`,
  };
}

/**
 * Generic function to send transactional emails via Brevo
 */
async function sendEmail({ to, name, templateId, params = {}, options = {} }) {
  try {
    const email = new brevo.SendSmtpEmail();
    email.to = [{ email: to, name }];
    email.templateId = templateId;
    email.params = params;

    if (options.replyTo) email.replyTo = options.replyTo;
    if (options.headers) email.headers = options.headers;

    console.log('Sending email with params:', {
      to,
      templateId,
      // don’t log OTP directly
      params: { ...params, otp: params?.otp ? `${String(params.otp).slice(0, 2)}****` : undefined }
    });

    const response = await apiInstance.sendTransacEmail(email);
    const messageId = response.body?.messageId || response.messageId || 'No message ID';
    console.log(`Email sent successfully to ${to}: ${messageId}`);
    return { success: true, messageId, response: messageId };
  } catch (error) {
    console.error(`Error sending email to ${to}:`, {
      message: error.message,
      response: error.response?.body || error.response?.data,
      templateId,
      params: Object.keys(params || {}),
    });
    throw error;
  }
}

// === Email Types ===
async function sendLoginEmail(to, name, device, location, time) {
  const params = {
    username: String(name || 'User'),
    device: String(device || 'Unknown Device'),
    location: String(location || 'Unknown Location'),
    time: String(time || new Date().toLocaleString())
  };
  return sendEmail({
    to, name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_LOGIN),
    params
  });
}

async function sendEmailVerificationOTP(
  to,
  name,
  otp,
  expiryMinutes = 10,
  extras = {}
) {
  const { verifyUrl, appDeepLink } = buildVerifyUrls(to);
  const params = {
    username: String(name || 'User'),
    otp: String(otp),
    expiryMinutes: String(expiryMinutes),
    expiryTime: new Date(Date.now() + expiryMinutes * 60 * 1000).toLocaleString(),

    // routing/branding params your template can use
    verifyUrl: String(extras.verifyUrl || verifyUrl),
    appDeepLink: String(extras.appDeepLink || appDeepLink),
    ctaText: String(extras.ctaText || 'Verify email'),
    companyName: String(extras.companyName || COMPANY_NAME),
    supportEmail: String(extras.supportEmail || SUPPORT_EMAIL),
  };

  return sendEmail({
    to, name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_EMAIL_VERIFICATION),
    params
  });
}

async function sendDepositEmail(to, name, amount, currency, reference) {
  return sendEmail({
    to, name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_DEPOSIT),
    params: { username: String(name || 'User'), amount: String(amount), currency: String(currency), reference: String(reference) }
  });
}

async function sendWithdrawalEmail(to, name, amount, currency, reference) {
  return sendEmail({
    to, name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_WITHDRAWAL),
    params: { username: String(name || 'User'), amount: String(amount), currency: String(currency), reference: String(reference) }
  });
}

/**
 * Simple utility email helper (keeps parity with earlier usage)
 * signature: (to, name, utilityType, amount, reference)
 */
async function sendUtilityEmail(to, name, utilityType, amount, reference) {
  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_UTILITY),
    params: {
      username: String(name || 'User'),
      utilityType: String(utilityType || ''),
      amount: String(amount ?? ''),
      currency: String(process.env.DEFAULT_CURRENCY || 'NGN'),
      reference: String(reference || '')
    }
  });
}

// Legacy/simple helper (keeps parity with earlier API usage)
async function sendGiftcardEmail(to, name, giftcardType, amount, reference) {
  return sendEmail({
    to, name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_GIFTCARD),
    params: { username: String(name || 'User'), giftcardType: String(giftcardType), amount: String(amount), reference: String(reference) }
  });
}

/**
 * NEW: sendGiftcardSubmissionEmail
 * Rich payload for giftcard submission templates
 */
async function sendGiftcardSubmissionEmail(
  to,
  name,
  submissionId,
  giftcardType,
  cardFormat,
  country,
  cardValue,
  expectedAmount,
  expectedCurrency,
  rateDisplay,
  totalImages = 0,
  imageUrls = [],
  reference = ''
) {
  const submissionUrl = submissionId ? `${APP_WEB_BASE_URL}/giftcards/${submissionId}` : APP_WEB_BASE_URL;
  const appDeepLink = submissionId ? `${APP_DEEP_LINK}/giftcards/${submissionId}` : APP_DEEP_LINK;

  const params = {
    username: String(name || 'User'),
    submissionId: String(submissionId || ''),
    giftcardType: String(giftcardType || ''),
    cardFormat: String(cardFormat || ''),
    country: String(country || ''),
    cardValue: String(cardValue ?? ''),
    expectedAmount: String(expectedAmount ?? ''),
    expectedCurrency: String(expectedCurrency || ''),
    rateDisplay: String(rateDisplay || ''),
    totalImages: String(totalImages),
    imageUrls: Array.isArray(imageUrls) ? imageUrls.slice(0, 3) : [],
    submissionUrl,
    appDeepLink,
    reference: String(reference || ''),
    companyName: String(COMPANY_NAME),
    supportEmail: String(SUPPORT_EMAIL)
  };

  return sendEmail({
    to, name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_GIFTCARD_SUBMISSION),
    params
  });
}

/**
 * NEW generic utility helper (rich)
 * Use this for all utility-type transactions (airtime, cable, data, betting, etc.)
 *
 * options: {
 *   utilityType, amount, currency, reference, status, date,
 *   recipientPhone, provider, transactionId, account, additionalNote,
 *   webUrl, appDeepLink
 * }
 */
async function sendUtilityTransactionEmail(to, name, options = {}) {
  const {
    utilityType,
    amount,
    currency = process.env.DEFAULT_CURRENCY || 'NGN',
    reference = '',
    status = 'PENDING',
    date = new Date().toLocaleString(),
    recipientPhone = '',
    provider = '',
    transactionId = '',
    account = '',
    additionalNote = '',
    webUrl,
    appDeepLink
  } = options || {};

  const viewUrl = webUrl || (reference ? `${APP_WEB_BASE_URL}/transactions/${reference}` : APP_WEB_BASE_URL);
  const deepLink = appDeepLink || (reference ? `${APP_DEEP_LINK}/transactions/${reference}` : APP_DEEP_LINK);

  const params = {
    username: String(name || 'User'),
    utilityType: String(utilityType || ''),
    amount: String(amount ?? ''),
    currency: String(currency || ''),
    reference: String(reference || ''),
    status: String(status || ''),
    date: String(date || new Date().toLocaleString()),
    recipientPhone: String(recipientPhone || ''),
    provider: String(provider || ''),
    transactionId: String(transactionId || ''),
    account: String(account || ''),
    additionalNote: String(additionalNote || ''),
    viewUrl,
    appDeepLink: deepLink,
    companyName: String(COMPANY_NAME),
    supportEmail: String(SUPPORT_EMAIL)
  };

  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_UTILITY),
    params
  });
}

async function sendKycEmail(to, name, status, comments) {
  return sendEmail({
    to, name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_KYC),
    params: { username: String(name || 'User'), status: String(status), comments: String(comments || '') }
  });
}

async function sendNINVerificationEmail(to, name, status, kycLevel, rejectionReason = null) {
  const params = {
    username: String(name || 'User'),
    status: String(status),
    kycLevel: String(kycLevel || 0),
    companyName: String(COMPANY_NAME),
    supportEmail: String(SUPPORT_EMAIL),
  };
  if (status === 'rejected' && rejectionReason) params.rejectionReason = String(rejectionReason);

  return sendEmail({
    to, name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_NIN_VERIFICATION),
    params
  });
}

module.exports = {
  sendDepositEmail,
  sendWithdrawalEmail,
  sendUtilityEmail,              // legacy/simple helper
  sendUtilityTransactionEmail,   // new generic helper (rich)
  sendGiftcardEmail,
  sendGiftcardSubmissionEmail,
  sendKycEmail,
  sendLoginEmail,
  sendSignupEmail: async (to, name) =>
    sendEmail({
      to, name,
      templateId: parseInt(process.env.BREVO_TEMPLATE_SIGNUP),
      params: { username: String(name || 'User'), companyName: String(COMPANY_NAME) }
    }),
  sendEmailVerificationOTP,
  sendNINVerificationEmail
};
