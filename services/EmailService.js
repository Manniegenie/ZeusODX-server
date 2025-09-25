const brevo = require('@getbrevo/brevo');
require('dotenv').config();

const apiInstance = new brevo.TransactionalEmailsApi();
apiInstance.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

// ---- Defaults for links/branding ----
const APP_WEB_BASE_URL = (process.env.APP_WEB_BASE_URL || process.env.FRONTEND_BASE_URL || '').replace(/\/$/, '');
const APP_DEEP_LINK    = (process.env.APP_DEEP_LINK || 'zeusodx://').replace(/\/$/, '');
const COMPANY_NAME     = process.env.COMPANY_NAME || 'ZeusODX';
const SUPPORT_EMAIL    = process.env.SUPPORT_EMAIL || 'support@zeusodx.com';
const SENDER_EMAIL     = process.env.SENDER_EMAIL || process.env.SUPPORT_EMAIL || 'noreply@zeusodx.com';
const SENDER_NAME      = process.env.SENDER_NAME || process.env.COMPANY_NAME || 'ZeusODX';

function buildVerifyUrls(email) {
  const qs = `email=${encodeURIComponent(email)}`;
  return {
    verifyUrl: `${APP_WEB_BASE_URL}/kyc/verify-email?${qs}`,
    appDeepLink: `${APP_DEEP_LINK}/kyc/verify-email?${qs}`
  };
}

/**
 * Safe template ID parser
 */
function safeParseTemplateId(envVar, fallback = null) {
  const parsed = parseInt(envVar);
  if (isNaN(parsed)) {
    console.warn(`Invalid template ID: ${envVar}, using fallback: ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * Helper function to safely format numbers for email templates
 */
function formatNumber(value, decimals = 2) {
  if (value === null || value === undefined || value === '') return '0.00';
  const num = parseFloat(value);
  if (isNaN(num)) return '0.00';
  return num.toLocaleString('en-US', { 
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals 
  });
}

/**
 * Helper function to format currency amounts with symbol
 */
function formatCurrency(amount, currency = 'NGN') {
  const formattedAmount = formatNumber(amount);
  
  // Currency symbol mapping
  const currencySymbols = {
    'NGN': '₦',
    'USD': '$',
    'EUR': '€',
    'GBP': '£',
    'CAD': 'C$'
  };
  
  const symbol = currencySymbols[currency?.toUpperCase()] || currency || '₦';
  return `${symbol}${formattedAmount}`;
}

/**
 * Helper function to safely format dates for email templates
 */
function formatDate(date, includeTime = true) {
  if (!date) return new Date().toLocaleString();
  
  let dateObj;
  if (typeof date === 'string') {
    dateObj = new Date(date);
  } else if (date instanceof Date) {
    dateObj = date;
  } else {
    dateObj = new Date();
  }
  
  // Check if date is valid
  if (isNaN(dateObj.getTime())) {
    dateObj = new Date();
  }
  
  if (includeTime) {
    return dateObj.toLocaleString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } else {
    return dateObj.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }
}

/**
 * Generic function to send transactional emails via Brevo
 */
async function sendEmail({ to, name, templateId, params = {}, options = {} }) {
  try {
    // Validate template ID
    if (!templateId || isNaN(templateId)) {
      throw new Error(`Invalid template ID: ${templateId}`);
    }

    const email = new brevo.SendSmtpEmail();
    email.to = [{ email: to, name }];
    email.templateId = templateId;
    email.params = params;

    // Set sender (required by Brevo)
    email.sender = { 
      email: SENDER_EMAIL, 
      name: SENDER_NAME 
    };

    if (options.replyTo) email.replyTo = options.replyTo;
    if (options.headers) email.headers = options.headers;

    console.log('Sending email with params:', {
      to,
      templateId,
      sender: email.sender,
      // don't log OTP directly
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
      params: Object.keys(params || {})
    });
    throw error;
  }
}

// === Email Types ===
async function sendLoginEmail(to, name, device, location, time) {
  try {
    const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_LOGIN);
    if (!templateId) throw new Error('Login email template ID not configured');

    const params = {
      username: String(name || 'User'),
      device: String(device || 'Unknown Device'),
      location: String(location || 'Unknown Location'),
      time: formatDate(time)
    };
    return await sendEmail({ to, name, templateId, params });
  } catch (error) {
    console.error('Failed to send login email:', error.message);
    throw error;
  }
}

async function sendEmailVerificationOTP(
  to,
  name,
  otp,
  expiryMinutes = 10,
  extras = {}
) {
  try {
    const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_EMAIL_VERIFICATION);
    if (!templateId) throw new Error('Email verification template ID not configured');

    const { verifyUrl, appDeepLink } = buildVerifyUrls(to);
    const expiryTime = new Date(Date.now() + expiryMinutes * 60 * 1000);
    
    const params = {
      username: String(name || 'User'),
      otp: String(otp),
      expiryMinutes: String(expiryMinutes),
      expiryTime: formatDate(expiryTime),

      // routing/branding params your template can use
      verifyUrl: String(extras.verifyUrl || verifyUrl),
      appDeepLink: String(extras.appDeepLink || appDeepLink),
      ctaText: String(extras.ctaText || 'Verify email'),
      companyName: String(extras.companyName || COMPANY_NAME),
      supportEmail: String(extras.supportEmail || SUPPORT_EMAIL)
    };

    return await sendEmail({ to, name, templateId, params });
  } catch (error) {
    console.error('Failed to send email verification OTP:', error.message);
    throw error;
  }
}

async function sendDepositEmail(to, name, amount, currency, reference) {
  try {
    const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_DEPOSIT);
    if (!templateId) throw new Error('Deposit email template ID not configured');

    return await sendEmail({
      to, name, templateId,
      params: { 
        username: String(name || 'User'), 
        amount: formatNumber(amount), 
        currency: String(currency || 'NGN'),
        amountWithCurrency: formatCurrency(amount, currency),
        reference: String(reference || ''),
        date: formatDate(new Date())
      }
    });
  } catch (error) {
    console.error('Failed to send deposit email:', error.message);
    throw error;
  }
}

async function sendWithdrawalEmail(to, name, amount, currency, reference) {
  try {
    const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_WITHDRAWAL);
    if (!templateId) throw new Error('Withdrawal email template ID not configured');

    return await sendEmail({
      to, name, templateId,
      params: { 
        username: String(name || 'User'), 
        amount: formatNumber(amount), 
        currency: String(currency || 'NGN'),
        amountWithCurrency: formatCurrency(amount, currency),
        reference: String(reference || ''),
        date: formatDate(new Date())
      }
    });
  } catch (error) {
    console.error('Failed to send withdrawal email:', error.message);
    throw error;
  }
}

/**
 * Simple utility email helper (keeps parity with earlier usage)
 * signature: (to, name, utilityType, amount, reference)
 */
async function sendUtilityEmail(to, name, utilityType, amount, reference) {
  try {
    const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_UTILITY);
    if (!templateId) throw new Error('Utility email template ID not configured');

    const currency = process.env.DEFAULT_CURRENCY || 'NGN';

    return await sendEmail({
      to, name, templateId,
      params: {
        username: String(name || 'User'),
        utilityType: String(utilityType || ''),
        amount: formatNumber(amount),
        currency: String(currency),
        amountWithCurrency: formatCurrency(amount, currency),
        reference: String(reference || ''),
        date: formatDate(new Date())
      }
    });
  } catch (error) {
    console.error('Failed to send utility email:', error.message);
    throw error;
  }
}

// Legacy/simple helper (keeps parity with earlier API usage)
async function sendGiftcardEmail(to, name, giftcardType, amount, reference) {
  try {
    const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_GIFTCARD);
    if (!templateId) throw new Error('Giftcard email template ID not configured');

    const currency = 'NGN'; // Default for giftcards

    return await sendEmail({
      to, name, templateId,
      params: { 
        username: String(name || 'User'), 
        giftcardType: String(giftcardType || ''), 
        amount: formatNumber(amount),
        currency: currency,
        amountWithCurrency: formatCurrency(amount, currency),
        reference: String(reference || ''),
        date: formatDate(new Date())
      }
    });
  } catch (error) {
    console.error('Failed to send giftcard email:', error.message);
    throw error;
  }
}

/**
 * Updated sendGiftcardSubmissionEmail to use provided params
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
  totalImages,
  imageUrls,
  reference
) {
  try {
    const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_GIFTCARD_SUBMISSION);
    if (!templateId) throw new Error('Giftcard submission email template ID not configured');

    const params = {
      username: String(name || 'User'),
      submissionId: String(submissionId || ''),
      giftcardType: String(giftcardType || ''),
      cardFormat: String(cardFormat || ''),
      country: String(country || ''),
      cardValue: String(cardValue || '0'),
      expectedAmount: String(expectedAmount || '0.00'),
      expectedCurrency: String(expectedCurrency || 'NGN'),
      rateDisplay: String(rateDisplay || ''),
      totalImages: String(totalImages || '0'),
      imageUrls: Array.isArray(imageUrls) ? imageUrls.slice(0, 3) : [],
      submissionUrl: String(submissionId ? `${APP_WEB_BASE_URL}/giftcards/${submissionId}` : APP_WEB_BASE_URL),
      appDeepLink: String(submissionId ? `${APP_DEEP_LINK}/giftcards/${submissionId}` : APP_DEEP_LINK),
      reference: String(reference || ''),
      submissionDate: String(formatDate(new Date(), false)),
      companyName: String(COMPANY_NAME),
      supportEmail: String(SUPPORT_EMAIL)
    };

    return await sendEmail({ to, name, templateId, params });
  } catch (error) {
    console.error('Failed to send giftcard submission email:', error.message);
    throw error;
  }
}

/**
 * NEW generic utility helper (rich)
 * Use this for all utility-type transactions (airtime, cable, data, betting, etc.)
 */
async function sendUtilityTransactionEmail(to, name, options = {}) {
  try {
    const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_UTILITY);
    if (!templateId) throw new Error('Utility transaction email template ID not configured');

    const {
      utilityType,
      amount,
      currency = process.env.DEFAULT_CURRENCY || 'NGN',
      reference = '',
      status = 'PENDING',
      date,
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
      amount: formatNumber(amount),
      amountWithCurrency: formatCurrency(amount, currency),
      currency: String(currency || 'NGN'),
      reference: String(reference || ''),
      status: String(status || 'PENDING'),
      date: formatDate(date),
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

    return await sendEmail({ to, name, templateId, params });
  } catch (error) {
    console.error('Failed to send utility transaction email:', error.message);
    throw error;
  }
}

async function sendKycEmail(to, name, status, comments) {
  try {
    const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_KYC);
    if (!templateId) throw new Error('KYC email template ID not configured');

    return await sendEmail({
      to, name, templateId,
      params: { 
        username: String(name || 'User'), 
        status: String(status || ''), 
        comments: String(comments || ''),
        date: formatDate(new Date())
      }
    });
  } catch (error) {
    console.error('Failed to send KYC email:', error.message);
    throw error;
  }
}

async function sendNINVerificationEmail(to, name, status, kycLevel, rejectionReason = null) {
  try {
    const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_NIN_VERIFICATION);
    if (!templateId) throw new Error('NIN verification email template ID not configured');

    const params = {
      username: String(name || 'User'),
      status: String(status || ''),
      kycLevel: String(kycLevel || 0),
      date: formatDate(new Date()),
      companyName: String(COMPANY_NAME),
      supportEmail: String(SUPPORT_EMAIL)
    };
    if (status === 'rejected' && rejectionReason) {
      params.rejectionReason = String(rejectionReason);
    }

    return await sendEmail({ to, name, templateId, params });
  } catch (error) {
    console.error('Failed to send NIN verification email:', error.message);
    throw error;
  }
}

async function sendSignupEmail(to, name) {
  try {
    const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_SIGNUP);
    if (!templateId) throw new Error('Signup email template ID not configured');

    return await sendEmail({
      to, name, templateId,
      params: { 
        username: String(name || 'User'), 
        companyName: String(COMPANY_NAME),
        signupDate: formatDate(new Date())
      }
    });
  } catch (error) {
    console.error('Failed to send signup email:', error.message);
    throw error;
  }
}

module.exports = {
  sendDepositEmail,
  sendWithdrawalEmail,
  sendUtilityEmail,              
  sendUtilityTransactionEmail,   
  sendGiftcardEmail,
  sendGiftcardSubmissionEmail,   
  sendKycEmail,
  sendLoginEmail,
  sendSignupEmail,
  sendEmailVerificationOTP,
  sendNINVerificationEmail
};