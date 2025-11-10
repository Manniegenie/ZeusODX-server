require('dotenv').config();
const crypto = require('crypto');
const queryString = require('query-string');

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
 * Axios request interceptor for Obiex API auth headers.
 * @param {object} config - Axios request config
 * @returns {object} - Updated config with auth headers
 */
function attachObiexAuth(config) {
  validateObiexConfig();
  const originalUrl = config.url;
  if (config.params) {
    config.url = originalUrl + '?' + queryString.stringify(config.params);
    config.params = null;
  }
  const { timestamp, signature } = signRequest(config.method, config.url);
  config.headers = {
    ...config.headers,
    'x-api-timestamp': timestamp,
    'x-api-signature': signature,
    'x-api-key': process.env.OBIEX_API_KEY,
    'content-type': 'application/json',
    // Keep browser-like headers to avoid Cloudflare challenges
    'Accept': config.headers['Accept'] || 'application/json, text/plain, */*',
    'User-Agent': config.headers['User-Agent'] || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  return config;
}

module.exports = {
  validateObiexConfig,
  attachObiexAuth,
};