// services/emailService.js
const brevo = require('@getbrevo/brevo');
require('dotenv').config();

// Use your original authentication method (which was working)
const apiInstance = new brevo.TransactionalEmailsApi();
apiInstance.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

/**
 * Generic function to send transactional emails via Brevo
 */
async function sendEmail({ to, name, templateId, params = {}, options = {} }) {
  try {
    const email = new brevo.SendSmtpEmail();
    
    // Set recipient
    email.to = [{ email: to, name }];
    
    // Set template ID
    email.templateId = templateId;
    
    // Set parameters - ensure they're clean strings
    email.params = params;

    // Optional configurations
    if (options.replyTo) email.replyTo = options.replyTo;
    if (options.headers) email.headers = options.headers;

    // Debug logging
    console.log('Sending email with params:', {
      to,
      templateId,
      params: email.params
    });

    const response = await apiInstance.sendTransacEmail(email);
    
    // Clean logging - just log the message ID
    const messageId = response.body?.messageId || response.messageId || 'No message ID';
    console.log(`Email sent successfully to ${to}: ${messageId}`);
    
    return { success: true, messageId, response: messageId };
  } catch (error) {
    console.error(`Error sending email to ${to}:`, {
      message: error.message,
      response: error.response?.body || error.response?.data,
      templateId,
      params
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

  console.log('Login email params:', params);

  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_LOGIN),
    params
  });
}

async function sendEmailVerificationOTP(to, name, otp, expiryMinutes = 10) {
  const params = {
    username: String(name || 'User'),
    otp: String(otp),
    expiryMinutes: String(expiryMinutes),
    expiryTime: new Date(Date.now() + expiryMinutes * 60 * 1000).toLocaleString()
  };

  console.log('Email verification OTP params:', {
    username: params.username,
    otp: params.otp.slice(0, 2) + '****',
    expiryMinutes: params.expiryMinutes
  });

  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_EMAIL_VERIFICATION),
    params
  });
}

async function sendDepositEmail(to, name, amount, currency, reference) {
  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_DEPOSIT),
    params: { 
      username: String(name || 'User'),
      amount: String(amount),
      currency: String(currency),
      reference: String(reference)
    }
  });
}

async function sendWithdrawalEmail(to, name, amount, currency, reference) {
  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_WITHDRAWAL),
    params: { 
      username: String(name || 'User'),
      amount: String(amount),
      currency: String(currency),
      reference: String(reference)
    }
  });
}

async function sendUtilityEmail(to, name, utilityType, amount, reference) {
  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_UTILITY),
    params: { 
      username: String(name || 'User'),
      utilityType: String(utilityType),
      amount: String(amount),
      reference: String(reference)
    }
  });
}

async function sendGiftcardEmail(to, name, giftcardType, amount, reference) {
  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_GIFTCARD),
    params: { 
      username: String(name || 'User'),
      giftcardType: String(giftcardType),
      amount: String(amount),
      reference: String(reference)
    }
  });
}

async function sendKycEmail(to, name, status, comments) {
  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_KYC),
    params: { 
      username: String(name || 'User'),
      status: String(status),
      comments: String(comments || '')
    }
  });
}

async function sendNINVerificationEmail(to, name, status, kycLevel, rejectionReason = null) {
  const params = {
    username: String(name || 'User'),
    status: String(status),
    kycLevel: String(kycLevel || 0)
  };

  // Add rejection reason if status is rejected
  if (status === 'rejected' && rejectionReason) {
    params.rejectionReason = String(rejectionReason);
  }

  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_NIN_VERIFICATION),
    params
  });
}

async function sendSignupEmail(to, name) {
  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_SIGNUP),
    params: { 
      username: String(name || 'User')
    }
  });
}

module.exports = {
  sendDepositEmail,
  sendWithdrawalEmail,
  sendUtilityEmail,
  sendGiftcardEmail,
  sendKycEmail,
  sendLoginEmail,
  sendSignupEmail,
  sendEmailVerificationOTP,
  sendNINVerificationEmail
};