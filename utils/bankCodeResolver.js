/**
 * bankCodeResolver.js
 *
 * Resolves a bank's current sortCode from the live Obiex bank list by matching
 * on bank name. Falls back to the migration map if Obiex is unreachable or the
 * bank name cannot be matched.
 *
 * This replaces the static SORT_CODE_MAP approach: instead of maintaining a
 * hardcoded old→new mapping that breaks every time Obiex changes their codes,
 * we fetch the authoritative list from Obiex at withdrawal time and match by name.
 */

const axios = require('axios');
const { attachObiexAuth } = require('./obiexAuth');
const { migrateCode } = require('./sortCodeMigration');
const logger = require('./logger');

const baseURL = String(process.env.OBIEX_BASE_URL || 'https://api.obiex.finance').replace(/\/+$/, '');

const obiex = axios.create({ baseURL, timeout: 15000 });
obiex.interceptors.request.use(attachObiexAuth);

// ---------- In-memory cache ----------
let _cache = null;
let _cacheAt = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ---------- Name normalisation ----------
// Strip noise words so "Moniepoint MFB" and "Moniepoint Microfinance Bank" both
// normalise to "moniepoint", enabling a reliable fuzzy match.
function normalise(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(bank|plc|limited|ltd\.?|microfinance|mfb|micro-finance|nigeria|nig\.?)\b/gi, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Fetch & cache ----------
async function fetchBanks() {
  const now = Date.now();
  if (_cache && (now - _cacheAt) < CACHE_TTL) return _cache;

  try {
    const response = await obiex.get('/ngn-payments/banks');
    const banks = response?.data?.data || response?.data || [];

    if (Array.isArray(banks) && banks.length > 0) {
      _cache = banks;
      _cacheAt = now;
      logger.info(`[bankCodeResolver] Fetched ${banks.length} banks from Obiex — cache refreshed`);
    } else {
      logger.warn('[bankCodeResolver] Obiex returned empty bank list — keeping stale cache');
    }
  } catch (err) {
    logger.error('[bankCodeResolver] Failed to fetch bank list from Obiex', { error: err.message });
    // Keep serving stale cache if available — better than failing withdrawals
  }

  return _cache || [];
}

// ---------- Main resolver ----------
/**
 * Resolve the current live sortCode for a bank by its name.
 *
 * Strategy:
 *   1. Fetch live Obiex bank list (cached 1hr)
 *   2. Exact normalised name match
 *   3. Partial normalised name match (one contains the other)
 *   4. Fall back to migrateCode(storedCode) — the old migration map
 *
 * @param {string} bankName   - Bank name as stored on the user's account
 * @param {string} storedCode - Bank code as stored on the user's account
 * @returns {Promise<string>} - The live sortCode to send to Obiex
 */
async function resolveCode(bankName, storedCode) {
  const banks = await fetchBanks();

  if (!banks.length) {
    const fallback = migrateCode(storedCode);
    logger.warn('[bankCodeResolver] No live bank data — falling back to migration map', {
      bankName, storedCode, fallback
    });
    return fallback;
  }

  const needle = normalise(bankName);

  // 1. Exact normalised match
  let match = banks.find(b => normalise(b.name) === needle);

  // 2. Partial match — one name contains the other
  if (!match && needle) {
    match = banks.find(b => {
      const n = normalise(b.name);
      return n && (n.includes(needle) || needle.includes(n));
    });
  }

  if (match) {
    const liveCode = match.sortCode || match.uuid;
    if (liveCode !== storedCode) {
      logger.info('[bankCodeResolver] Resolved live sortCode (differs from stored code)', {
        bankName,
        storedCode,
        liveCode,
        matchedBank: match.name
      });
    }
    return liveCode;
  }

  // 3. No name match — fall back to migration map
  const fallback = migrateCode(storedCode);
  logger.warn('[bankCodeResolver] Bank not found in live list — falling back to migration map', {
    bankName, storedCode, fallback
  });
  return fallback;
}

/**
 * Manually invalidate the cache (e.g. after a known Obiex code change).
 */
function invalidateCache() {
  _cache = null;
  _cacheAt = 0;
  logger.info('[bankCodeResolver] Cache manually invalidated');
}

module.exports = { resolveCode, fetchBanks, invalidateCache };
