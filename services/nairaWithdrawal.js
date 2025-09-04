// services/nairaWithdrawal.js
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

let config = {};
try { 
  config = require('../routes/config'); 
} catch (_) { 
  config = {}; 
}

const { validateObiexConfig, attachObiexAuth } = require('../utils/obiexAuth');

const baseURL = (config.obiex && String(config.obiex.baseURL || '').replace(/\/+$/, '')) ||
  String(process.env.OBIEX_BASE_URL || '').replace(/\/+$/, '');

const obiex = axios.create({ 
  baseURL, 
  timeout: 30000 
});

obiex.interceptors.request.use(attachObiexAuth);

// ---------- Helper Functions ----------

function uuid() {
  return (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(16).toString('hex');
}

function maskAccountNumber(acct) {
  if (!acct) return '';
  const s = String(acct).replace(/\s+/g, '');
  return s.length <= 4 ? s : `${s.slice(0, 2)}****${s.slice(-2)}`;
}

function cleanStr(v) { 
  return (v ?? '').toString().trim(); 
}

function sanitizeDestination(d = {}) {
  return {
    accountNumber: cleanStr(d.accountNumber),
    accountName: cleanStr(d.accountName),
    bankName: cleanStr(d.bankName),
    bankCode: cleanStr(d.bankCode),
    // Optional fields
    pagaBankCode: d.pagaBankCode ? cleanStr(d.pagaBankCode) : undefined,
    merchantCode: d.merchantCode ? cleanStr(d.merchantCode) : undefined,
  };
}

/**
 * Sanitize and prepare the payload for Obiex fiat debit
 * Currency should be NGNX for Obiex (NGNZ maps to NGNX)
 */
function sanitizeFiatPayload(body = {}) {
  const destination = sanitizeDestination(body.destination || {});
  const amount = Number(body.amount);
  const currency = cleanStr(body.currency || 'NGNX').toUpperCase();
  const narration = cleanStr(body.narration) || 
    `NGNX withdrawal to ${destination.accountName || 'beneficiary'} (${maskAccountNumber(destination.accountNumber)})`;

  return { destination, amount, currency, narration };
}

function validateFiatPayload(clean) {
  const errors = [];
  
  if (!clean.destination.accountNumber) {
    errors.push('destination.accountNumber is required');
  }
  if (!clean.destination.accountName) {
    errors.push('destination.accountName is required');
  }
  if (!clean.destination.bankName) {
    errors.push('destination.bankName is required');
  }
  if (!clean.destination.bankCode) {
    errors.push('destination.bankCode is required');
  }
  if (!clean.amount || isNaN(clean.amount) || clean.amount <= 0) {
    errors.push('amount must be a positive number');
  }
  if (!clean.currency) {
    errors.push('currency is required');
  }
  
  return errors;
}

function pickRequestId(headers = {}) {
  return (
    headers['x-request-id'] ||
    headers['x-correlation-id'] ||
    headers['cf-ray'] ||
    headers['traceparent'] ||
    null
  );
}

// ---------- Main Service Function ----------

/**
 * Debit NGNX via Obiex for bank withdrawal
 * 
 * @param {Object} payload - Withdrawal payload
 * @param {Object} payload.destination - Bank details
 * @param {string} payload.destination.accountNumber - Account number
 * @param {string} payload.destination.accountName - Account name
 * @param {string} payload.destination.bankName - Bank name
 * @param {string} payload.destination.bankCode - Bank code
 * @param {number} payload.amount - Amount in NGNX (1:1 with NGN)
 * @param {string} payload.currency - Currency code (should be NGNX)
 * @param {string} [payload.narration] - Transaction narration
 * 
 * @param {Object} opts - Options
 * @param {string} [opts.userId] - User ID for tracking
 * @param {string} [opts.idempotencyKey] - Idempotency key
 * 
 * @returns {Promise<Object>} Result object
 */
async function debitNaira(payload, opts = {}) {
  // Validate Obiex configuration
  validateObiexConfig();

  const clean = sanitizeFiatPayload(payload);
  const errors = validateFiatPayload(clean);
  
  if (errors.length) {
    return { 
      success: false, 
      statusCode: 400, 
      message: errors.join('; ') 
    };
  }

  const idempotencyKey = opts.idempotencyKey ||
    `ngnx-withdrawal-${opts.userId || 'anon'}-${maskAccountNumber(clean.destination.accountNumber)}-${clean.amount}-${Date.now()}-${uuid()}`;

  const payloadPreview = {
    destination: {
      accountNumber: maskAccountNumber(clean.destination.accountNumber),
      accountName: clean.destination.accountName,
      bankName: clean.destination.bankName,
      bankCode: clean.destination.bankCode,
      ...(clean.destination.pagaBankCode ? { pagaBankCode: clean.destination.pagaBankCode } : {}),
      ...(clean.destination.merchantCode ? { merchantCode: clean.destination.merchantCode } : {}),
    },
    amount: clean.amount,
    currency: clean.currency, // NGNX
    narration: clean.narration,
    idempotencyKey,
  };

  try {
    logger.info('Initiating NGNX bank withdrawal via Obiex', {
      ...payloadPreview,
      userId: opts.userId
    });

    const response = await obiex.post('/wallets/ext/debit/fiat', clean, {
      headers: {
        'Idempotency-Key': idempotencyKey,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      maxBodyLength: Infinity,
    });

    const data = response?.data?.data || response?.data || {};
    const result = {
      id: data.id || data.transactionId || null,
      reference: data.reference || data.ref || null,
      status: data.status || data.payout?.status || 'PENDING',
      payout: data.payout || null,
      raw: data,
    };

    logger.info('Obiex NGNX withdrawal successful', {
      obiexId: result.id,
      reference: result.reference,
      status: result.status,
      userId: opts.userId,
      requestId: pickRequestId(response?.headers || {}),
    });

    return { 
      success: true, 
      data: result, 
      idempotencyKey 
    };

  } catch (error) {
    // Extract error details
    const httpStatus = error.response?.status || 500;
    const httpStatusText = error.response?.statusText || null;
    const providerHeaders = error.response?.headers || {};
    const providerBody = error.response?.data;
    const requestId = pickRequestId(providerHeaders);
    
    // Extract provider-specific error info
    const providerCode = (providerBody && typeof providerBody === 'object' && providerBody.code) 
      ? providerBody.code 
      : null;
    const providerMessage = (providerBody && typeof providerBody === 'object' && providerBody.message)
      ? providerBody.message
      : null;

    logger.error('Obiex NGNX withdrawal failed', {
      axiosErrorCode: error.code || null,
      httpStatus,
      httpStatusText,
      userId: opts.userId,
      payloadPreview,
      providerBody,
      providerCode,
      providerMessage,
      requestId,
      errorMessage: error.message
    });

    return {
      success: false,
      statusCode: httpStatus,
      message: providerMessage || error.message || 'Withdrawal service temporarily unavailable',
      providerCode,
      providerRaw: providerBody,
      requestId,
    };
  }
}

/**
 * Get withdrawal status from Obiex (if needed for future implementation)
 * 
 * @param {string} transactionId - Obiex transaction ID
 * @returns {Promise<Object>} Status result
 */
async function getWithdrawalStatus(transactionId) {
  try {
    validateObiexConfig();

    logger.info('Checking withdrawal status', { transactionId });

    const response = await obiex.get(`/transactions/${transactionId}`, {
      headers: {
        'Accept': 'application/json',
      }
    });

    const data = response?.data?.data || response?.data || {};
    
    logger.info('Withdrawal status retrieved', { 
      transactionId, 
      status: data.status 
    });

    return {
      success: true,
      data: {
        id: data.id,
        reference: data.reference,
        status: data.status,
        amount: data.amount,
        currency: data.currency,
        raw: data
      }
    };

  } catch (error) {
    const httpStatus = error.response?.status || 500;
    const providerBody = error.response?.data;
    
    logger.error('Failed to get withdrawal status', {
      transactionId,
      httpStatus,
      providerBody,
      errorMessage: error.message
    });

    return {
      success: false,
      statusCode: httpStatus,
      message: error.message || 'Failed to retrieve withdrawal status'
    };
  }
}

module.exports = {
  debitNaira,
  getWithdrawalStatus,
  obiexClient: obiex,
};