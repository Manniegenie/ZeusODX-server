const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const queryString = require('query-string');
const logger = require('../utils/logger');

let config = {};
try { config = require('../routes/config'); } catch (_) { config = {}; }

const baseURL =
  (config.obiex && String(config.obiex.baseURL || '').replace(/\/+$/, '')) ||
  String(process.env.OBIEX_BASE_URL || '').replace(/\/+$/, '') ||
  'https://api.obiex.finance';

const router = express.Router();

// ---------- embedded auth ----------
function validateObiexConfig() {
  if (!process.env.OBIEX_API_KEY || !process.env.OBIEX_API_SECRET) {
    throw new Error('Missing OBIEX_API_KEY or OBIEX_API_SECRET in .env');
  }
}

/**
 * Signs the request for Obiex API.
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string} url - Request URL path, including query string if present
 * @returns {{timestamp: number, signature: string}}
 */
function signRequest(method, url) {
  const timestamp = Date.now();
  const path = url.startsWith('/') ? url : `/${url}`;
  // Note: Adjust '/v1' prefix if Obiex API documentation specifies a different format
  const content = `${method.toUpperCase()}/v1${path}${timestamp}`;
  const signature = crypto
    .createHmac('sha256', process.env.OBIEX_API_SECRET)
    .update(content)
    .digest('hex');
  return { timestamp, signature };
}

/**
 * Generate auth headers for Obiex API.
 * @param {string} method - HTTP method
 * @param {string} urlPath - URL path including query string
 * @returns {object} - Auth headers
 */
function generateAuthHeaders(method, urlPath) {
  validateObiexConfig();
  const { timestamp, signature } = signRequest(method, urlPath);
  return {
    'x-api-timestamp': timestamp,
    'x-api-signature': signature,
    'x-api-key': process.env.OBIEX_API_KEY,
    'content-type': 'application/json',
  };
}

// ---------- helpers ----------
function cleanStr(v) { return (v ?? '').toString().trim(); }

function pickRequestId(headers = {}) {
  return (
    headers['x-request-id'] ||
    headers['x-correlation-id'] ||
    headers['cf-ray'] ||
    headers['traceparent'] ||
    null
  );
}

function sanitizeAccountQuery(query = {}) {
  return {
    sortCode: cleanStr(query.sortCode),
    accountNumber: cleanStr(query.accountNumber),
  };
}

function validateAccountQuery(clean) {
  const errs = [];
  if (!clean.sortCode) errs.push('sortCode is required');
  if (!clean.accountNumber) errs.push('accountNumber is required');
  if (!/^\d+$/.test(clean.sortCode)) errs.push('sortCode must be numeric');
  if (!/^\d+$/.test(clean.accountNumber)) errs.push('accountNumber must be numeric');
  return errs;
}

// Build exact request format: {{baseURL}}/v1/ngn-payments/accounts/resolve?sortCode=...&accountNumber=...
function buildResolveUrl(sortCode, accountNumber) {
  const base = String(baseURL)
    .replace(/\/+$/, '')
    .replace(/\/v1$/, ''); // ensure we add /v1 exactly once
  const qs = `sortCode=${encodeURIComponent(sortCode)}&accountNumber=${encodeURIComponent(accountNumber)}`;
  return `${base}/v1/ngn-payments/accounts/resolve?${qs}`;
}

// Extract URL path for signature (everything after the base URL)
function extractUrlPath(fullUrl) {
  const base = String(baseURL).replace(/\/+$/, '');
  return fullUrl.replace(base, '');
}

// ---------- main routes ----------

/**
 * Resolve Naira Bank Account Name
 * GET /accountname/resolve?sortCode=305&accountNumber=0239573384
 */
router.get('/resolve', async (req, res) => {
  try {
    validateObiexConfig();

    const clean = sanitizeAccountQuery(req.query);
    const errors = validateAccountQuery(clean);
    if (errors.length) {
      return res.status(400).json({
        success: false,
        message: errors.join('; '),
        data: null
      });
    }

    const finalUrl = buildResolveUrl(clean.sortCode, clean.accountNumber);
    const urlPath = extractUrlPath(finalUrl);
    
    // Generate auth headers with the complete URL path including query params
    const authHeaders = generateAuthHeaders('GET', urlPath);
    const headers = {
      ...authHeaders,
      Accept: 'application/json',
    };

    logger.info('Resolving account name via Obiex', {
      sortCode: clean.sortCode,
      accountNumber: clean.accountNumber,
      url: finalUrl,
      urlPath,
    });

    const response = await axios.get(finalUrl, {
      headers,
      timeout: 15000,
      maxBodyLength: Infinity,
    });

    const data = response?.data?.data || response?.data || {};
    const out = {
      bankId: data.bankId || null,
      accountName: data.accountName || null,
      accountNumber: data.accountNumber || clean.accountNumber,
      raw: data,
    };

    logger.info('Obiex account resolution success', {
      accountName: out.accountName,
      accountNumber: clean.accountNumber,
      requestId: pickRequestId(response?.headers || {}),
    });

    return res.status(200).json({
      success: true,
      message: response?.data?.message || 'Account resolved successfully',
      data: out
    });

  } catch (err) {
    const httpStatus = err.response?.status || 500;
    const httpStatusText = err.response?.statusText || null;
    const providerHeaders = err.response?.headers || {};
    const providerBody = err.response?.data;
    const requestId = pickRequestId(providerHeaders);
    const providerCode = Object.prototype.hasOwnProperty.call(providerBody || {}, 'code')
      ? providerBody.code
      : null;
    const providerMessage = Object.prototype.hasOwnProperty.call(providerBody || {}, 'message')
      ? providerBody.message
      : null;

    logger.error('Obiex account resolution failed', {
      axiosErrorCode: err.code || null,
      httpStatus,
      httpStatusText,
      queryPreview: sanitizeAccountQuery(req.query),
      providerBody,
      providerCode,
      providerHeaders,
      requestId,
    });

    return res.status(httpStatus).json({
      success: false,
      message: providerMessage || err.message || 'Account resolution service temporarily unavailable',
      data: null,
      providerCode,
      requestId,
    });
  }
});

/**
 * Batch resolve multiple accounts
 * POST /accountname/resolve-batch
 * Body: { accounts: [{ sortCode, accountNumber }, ...] }
 * Uses same URL format per account.
 */
router.post('/resolve-batch', async (req, res) => {
  try {
    validateObiexConfig();

    const { accounts } = req.body;

    if (!Array.isArray(accounts) || accounts.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'accounts must be a non-empty array',
        data: null
      });
    }

    if (accounts.length > 10) {
      return res.status(400).json({
        success: false,
        message: 'Maximum 10 accounts per batch request',
        data: null
      });
    }

    logger.info('Batch resolving accounts via Obiex', { count: accounts.length });

    const results = [];
    for (let i = 0; i < accounts.length; i++) {
      const account = sanitizeAccountQuery(accounts[i]);
      const errs = validateAccountQuery(account);
      if (errs.length) {
        results.push({
          sortCode: account.sortCode,
          accountNumber: account.accountNumber,
          success: false,
          error: errs.join(', ')
        });
        continue;
      }

      const finalUrl = buildResolveUrl(account.sortCode, account.accountNumber);
      const urlPath = extractUrlPath(finalUrl);
      
      // Generate auth headers for each request
      const authHeaders = generateAuthHeaders('GET', urlPath);
      const headers = {
        ...authHeaders,
        Accept: 'application/json',
      };

      try {
        const response = await axios.get(finalUrl, {
          headers,
          timeout: 15000,
          maxBodyLength: Infinity,
        });

        const data = response?.data?.data || response?.data || {};
        results.push({
          sortCode: account.sortCode,
          accountNumber: account.accountNumber,
          success: true,
          data: {
            bankId: data.bankId || null,
            accountName: data.accountName || null,
            accountNumber: data.accountNumber || account.accountNumber,
          }
        });

        if (i < accounts.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }

      } catch (err) {
        const httpStatus = err.response?.status || 500;
        const providerBody = err.response?.data;
        const providerMessage = Object.prototype.hasOwnProperty.call(providerBody || {}, 'message')
          ? providerBody.message
          : null;

        logger.warn('Obiex account resolution failed in batch', {
          sortCode: account.sortCode,
          accountNumber: account.accountNumber,
          httpStatus,
          error: err.message,
        });

        results.push({
          sortCode: account.sortCode,
          accountNumber: account.accountNumber,
          success: false,
          error: providerMessage || err.message || 'Resolution failed'
        });
      }
    }

    const successful = results.filter(r => r.success).length;
    const failed = results.length - successful;

    logger.info('Obiex batch account resolution completed', {
      total: results.length,
      successful,
      failed,
    });

    return res.status(200).json({
      success: true,
      message: 'Batch resolution completed',
      data: {
        total: results.length,
        successful,
        failed,
        results
      }
    });

  } catch (err) {
    logger.error('Batch account resolution failed', {
      error: err.message,
      accountCount: req.body?.accounts?.length || 0,
    });

    return res.status(500).json({
      success: false,
      message: 'Batch resolution service temporarily unavailable',
      data: null
    });
  }
});

module.exports = router;