// services/obiexSwap.js
const axios = require('axios');
const logger = require('../utils/logger');

let config = {};
try { config = require('../routes/config'); } catch (_) { config = {}; }

const { validateObiexConfig, attachObiexAuth } = require('../utils/obiexAuth');

const baseURL =
  (config.obiex && String(config.obiex.baseURL || '').replace(/\/+$/, '')) ||
  String(process.env.OBIEX_BASE_URL || '').replace(/\/+$/, '');

const obiex = axios.create({ baseURL, timeout: 30000 });
obiex.interceptors.request.use(attachObiexAuth);

// ---- tiny in-memory cache for currencies ----
let _currencyCache = { at: 0, map: null };
const CURRENCIES_TTL_MS = 5 * 60 * 1000; // 5 mins

function pickRequestId(headers = {}) {
  return (
    headers['x-request-id'] ||
    headers['x-correlation-id'] ||
    headers['cf-ray'] ||
    headers['traceparent'] ||
    null
  );
}

async function fetchCurrencyMap(force = false) {
  validateObiexConfig();
  const now = Date.now();
  if (!force && _currencyCache.map && now - _currencyCache.at < CURRENCIES_TTL_MS) {
    return _currencyCache.map;
  }

  try {
    logger.info('Fetching Obiex currencies');
    const res = await obiex.get('/currencies', { headers: { Accept: 'application/json' } });
    const list = res?.data?.data || [];
    const byCode = new Map();
    for (const c of list) {
      if (!c?.code || !c?.id) continue;
      byCode.set(String(c.code).toUpperCase(), c.id);
    }
    _currencyCache = { at: now, map: byCode };
    logger.info('Currencies fetched', { count: byCode.size, requestId: pickRequestId(res?.headers || {}) });
    return byCode;
  } catch (err) {
    const httpStatus = err.response?.status || 500;
    const providerBody = err.response?.data;
    logger.error('Failed to fetch Obiex currencies', {
      httpStatus,
      requestId: pickRequestId(err.response?.headers || {}),
      providerBody,
    });
    throw new Error('OBIEX_CURRENCIES_FETCH_FAILED');
  }
}

async function getCurrencyIdByCode(code) {
  const map = await fetchCurrencyMap(false);
  const id = map.get(String(code).toUpperCase());
  if (!id) {
    // Try refetch once
    const refreshed = await fetchCurrencyMap(true);
    const again = refreshed.get(String(code).toUpperCase());
    if (!again) {
      throw new Error(`OBIEX_CURRENCY_ID_NOT_FOUND:${code}`);
    }
    return again;
  }
  return id;
}

async function createQuote({ sourceId, targetId, amount, side = 'SELL' }) {
  validateObiexConfig();
  const payload = { sourceId, targetId, amount: Number(amount), side: String(side).toUpperCase() };
  logger.info('Creating Obiex trade quote', payload);
  try {
    const res = await obiex.post('/trades/quote', payload, {
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      maxBodyLength: Infinity,
    });
    const data = res?.data?.data || res?.data || {};
    const quoteId = data.id || data.quoteId || data.reference || null;

    logger.info('Trade quote created', {
      quoteId,
      requestId: pickRequestId(res?.headers || {}),
      summary: {
        sourceId,
        targetId,
        side: payload.side,
        amount: payload.amount,
        rate: data.rate || data.price || undefined,
      },
    });

    if (!quoteId) throw new Error('OBIEX_QUOTE_ID_MISSING');

    return { success: true, data, quoteId };
  } catch (err) {
    const httpStatus = err.response?.status || 500;
    const providerBody = err.response?.data;
    logger.error('Create quote failed', {
      httpStatus,
      requestId: pickRequestId(err.response?.headers || {}),
      providerBody,
      payload,
    });
    return { success: false, statusCode: httpStatus, error: providerBody || null };
  }
}

async function acceptQuote(quoteId) {
  validateObiexConfig();
  if (!quoteId) throw new Error('QUOTE_ID_REQUIRED');

  logger.info('Accepting Obiex trade quote', { quoteId });
  try {
    const res = await obiex.post(`/trades/quote/${encodeURIComponent(quoteId)}`, {}, {
      headers: { Accept: 'application/json' },
      maxBodyLength: Infinity,
    });
    const data = res?.data?.data || res?.data || {};
    logger.info('Trade quote accepted', {
      quoteId,
      requestId: pickRequestId(res?.headers || {}),
      status: data.status || data.result || 'OK',
    });
    return { success: true, data };
  } catch (err) {
    const httpStatus = err.response?.status || 500;
    const providerBody = err.response?.data;
    logger.error('Accept quote failed', {
      quoteId,
      httpStatus,
      requestId: pickRequestId(err.response?.headers || {}),
      providerBody,
    });
    return { success: false, statusCode: httpStatus, error: providerBody || null };
  }
}

/**
 * High-level helper: swap a crypto code to NGNX by selling `amount` of the crypto.
 * @param {Object} opts
 *  - sourceCode: e.g., 'USDT', 'BTC', 'TRX', 'ETH', ...
 *  - amount: number (crypto amount to SELL)
 */
async function swapCryptoToNGNX({ sourceCode, amount }) {
  if (!sourceCode || !(Number(amount) > 0)) {
    return { success: false, statusCode: 400, error: 'INVALID_SWAP_PARAMS' };
  }

  const sourceId = await getCurrencyIdByCode(sourceCode);
  const targetId = await getCurrencyIdByCode('NGNX');

  // 1) Quote
  const q = await createQuote({ sourceId, targetId, amount, side: 'SELL' });
  if (!q.success) return q;

  const quoteId = q.quoteId || q.data?.id;
  if (!quoteId) {
    return { success: false, statusCode: 500, error: 'QUOTE_ID_MISSING' };
  }

  // 2) Accept
  return await acceptQuote(quoteId);
}

module.exports = {
  obiexClient: obiex,
  fetchCurrencyMap,
  getCurrencyIdByCode,
  createQuote,
  acceptQuote,
  swapCryptoToNGNX,
};