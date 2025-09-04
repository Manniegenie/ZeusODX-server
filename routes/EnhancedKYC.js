// routes/kyc.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const router = express.Router();

const User = require('../models/user');
const KYC = require('../models/kyc');
const logger = require('../utils/logger');

// If you have these helpers already, they’ll be used.
// Otherwise we fall back to local implementations below.
let smileSigHelpers = null;
try { smileSigHelpers = require('../utils/smileSignature'); } catch (_) {}
let idApi = null;
let signature = null;
try {
  // Your existing Smile-ID server SDK wrapper (keeps BVN flow unchanged)
  ({ idApi, signature } = require('../services/smile'));
} catch (_) { /* we'll soft-fallback for BVN error messaging */ }

// ---- Config ----
const cfg = (() => { try { return require('../routes/config'); } catch { return {}; } })();
const envLabel = cfg.env || process.env.NODE_ENV || 'production';

const SMILE_BASE = (cfg.smile?.baseURL || process.env.SMILE_BASE_URL || 'https://api.smileidentity.com').replace(/\/+$/, '');
const SMILE_PARTNER_ID = cfg.smile?.partnerId || process.env.SMILE_PARTNER_ID;
const SMILE_API_KEY = cfg.smile?.apiKey || process.env.SMILE_API_KEY;
const SMILE_CALLBACK_URL = cfg.smile?.callbackUrl || process.env.SMILE_CALLBACK_URL;

const SOURCE_SDK = 'rest_api';
const SOURCE_VER = '1.0.0';

// ---- Utils ----
function nowIso() { return new Date().toISOString(); }
function genJobId() { return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'); }
function safeJsonParse(x) { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return x; } }

function makeSmileSignature(ts) {
  if (!SMILE_API_KEY || !SMILE_PARTNER_ID) return '';
  return crypto.createHmac('sha256', SMILE_API_KEY)
    .update(String(SMILE_PARTNER_ID) + String(ts))
    .digest('hex');
}

function mapDecisionToStatus(txt) {
  const t = String(txt || '').toLowerCase();
  if (/success/.test(t) || /verified/.test(t)) return 'VERIFIED';
  if (/review|warning|stale/.test(t)) return 'REVIEW';
  if (/fail|not found|unavailable|error/.test(t)) return 'FAILED';
  return 'PENDING';
}

function isDigits(v, len) {
  const s = String(v || '');
  return (!len ? /^\d+$/.test(s) : new RegExp(`^\\d{${len}}$`).test(s));
}

function buildPartnerParams(kind, userId) {
  return { user_id: `${kind}-${userId}`, job_id: genJobId() };
}

// ===================================================
// 1) BVN Verification (kept; uses your Smile SDK path)
// ===================================================
/**
 * POST /kyc/bvn
 * body: { bvn: "11-digit", phoneNumber?: string }
 */
router.post('/bvn', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { bvn, phoneNumber } = req.body || {};
    const errors = [];
    if (!bvn || !isDigits(bvn, 11)) errors.push('bvn must be 11 digits');

    if (!idApi || !signature) {
      errors.push('Smile server SDK not configured for BVN (services/smile)');
    }
    if (errors.length) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    const partnerParams = buildPartnerParams('bvn', userId);
    const idInfo = {
      country: 'NG',
      id_type: 'BVN',
      id_number: String(bvn).trim(),
      phone_number: phoneNumber ? String(phoneNumber).trim() : undefined,
    };
    const options = { signature: true };

    // Submit EnhancedKyc job via your existing SDK wrapper
    const rawResponse = await idApi.submit_job(partnerParams, idInfo, options);
    const providerPayload = safeJsonParse(rawResponse);

    const kycDoc = await KYC.create({
      userId,
      provider: 'smile-id',
      environment: envLabel,
      partnerJobId: partnerParams.job_id,
      jobType: 'EnhancedKyc:BVN',
      smileJobId: providerPayload?.SmileJobID || providerPayload?.smile_job_id || undefined,
      jobComplete: !!providerPayload?.job_complete,
      jobSuccess: providerPayload?.result?.Success ?? providerPayload?.job_success ?? undefined,
      status: mapDecisionToStatus(providerPayload?.result?.ResultText || providerPayload?.ResultText),
      resultCode: providerPayload?.result?.ResultCode || providerPayload?.ResultCode,
      resultText: providerPayload?.result?.ResultText || providerPayload?.ResultText,
      actions: providerPayload?.Actions || providerPayload?.actions,
      country: 'NG',
      idType: 'BVN',
      imageLinks: providerPayload?.ImageLinks || providerPayload?.image_links,
      history: providerPayload?.History || providerPayload?.history,
      signature: providerPayload?.Signature || providerPayload?.signature,
      signatureValid: false,
      providerTimestamp: providerPayload?.timestamp ? new Date(providerPayload.timestamp) : undefined,
      payload: providerPayload,
      provisionalReason: 'Awaiting Smile ID final result (callback/poll).',
    });

    logger.info('BVN KYC submitted', {
      userId,
      partnerJobId: partnerParams.job_id,
      smileJobId: kycDoc.smileJobId,
    });

    return res.status(201).json({
      success: true,
      message: 'BVN verification submitted',
      data: {
        kycId: kycDoc._id,
        partnerJobId: kycDoc.partnerJobId,
        smileJobId: kycDoc.smileJobId,
        status: kycDoc.status,
        jobComplete: kycDoc.jobComplete,
      },
    });
  } catch (error) {
    logger.error('BVN verification failed', { error: error.message, stack: error.stack });
    return res.status(500).json({
      success: false,
      message: 'BVN verification failed',
      error: error.message,
    });
  }
});

// ==================================================================
// 2) Nigeria Digital Address Verification (new; REST v2 async route)
// ==================================================================
const NG_DISCOS = new Set([
  'AEDC','BEDC','EKEDC','EEDC','IBEDC','IKEDC','JEDC','KAEDCO','KEDCO','PHEDC','YEDC'
]);
function normalizeUtilityType(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'postpaid' || s === 'post-paid') return 'PostPaid';
  return 'PrePaid';
}

function oneLineAddress(input) {
  const { address, addressLine1, addressLine2, city, state, postalCode } = input || {};
  if (address && String(address).trim()) return String(address).trim();
  return [addressLine1, addressLine2, city, state, postalCode]
    .map(v => (v || '').toString().trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * POST /kyc/address  (NG only)
 * body: {
 *   address: string (or addressLine1/2/city/state/postalCode),
 *   fullName: string,
 *   utilityNumber: string,
 *   utilityProvider: 'AEDC' | ...,
 *   utilityType: 'PrePaid' | 'PostPaid'
 * }
 */
router.post('/address', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const {
      address,
      fullName,
      utilityNumber,
      utilityProvider,
      utilityType,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
    } = req.body || {};

    const addr = oneLineAddress({ address, addressLine1, addressLine2, city, state, postalCode });
    const disco = String(utilityProvider || '').trim().toUpperCase();
    const uType = normalizeUtilityType(utilityType);

    const errs = [];
    if (!SMILE_PARTNER_ID || !SMILE_API_KEY) errs.push('Smile credentials not configured');
    if (!SMILE_CALLBACK_URL) errs.push('Smile callbackUrl not configured');
    if (!addr || addr.length < 5) errs.push('address is required');
    if (!fullName || String(fullName).trim().length < 3) errs.push('fullName is required');
    if (!utilityNumber) errs.push('utilityNumber is required');
    if (!NG_DISCOS.has(disco)) errs.push('utilityProvider must be a supported DisCo');
    if (!/^(PrePaid|PostPaid)$/.test(uType)) errs.push('utilityType must be PrePaid or PostPaid');

    if (errs.length) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errs });
    }

    const partnerParams = { user_id: `addr-${userId}`, job_id: genJobId() };
    const ts = nowIso();
    const sig = (smileSigHelpers?.generate_signature)
      ? smileSigHelpers.generate_signature(ts)
      : makeSmileSignature(ts);

    const headers = {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'smileid-partner-id': SMILE_PARTNER_ID,
      'smileid-request-signature': sig,
      'smileid-timestamp': ts,
      'smileid-source-sdk': 'rest_api',
      'smileid-source-sdk-version': '1.0.0',
    };

    const body = {
      callback_url: SMILE_CALLBACK_URL,
      country: 'NG',
      address: addr,
      full_name: String(fullName).trim(),
      utility_number: String(utilityNumber).trim(),
      utility_provider: disco,
      utility_type: uType,
      partner_params: partnerParams,
    };

    const resp = await axios.post(`${SMILE_BASE}/v2/async-verify-address`, body, { headers, timeout: 30000 });

    const kycDoc = await KYC.create({
      userId,
      provider: 'smile-id',
      environment: envLabel,
      partnerJobId: partnerParams.job_id,
      jobType: 'address_verification',
      smileJobId: undefined,
      jobComplete: false,
      jobSuccess: false,
      status: 'PENDING',
      country: 'NG',
      fullName: String(fullName).trim(),
      submittedAddress: {
        full_address: addr,
        address_line_1: addressLine1 || addr,
        address_line_2: addressLine2 || '',
        city: city || '',
        state: state || '',
        postal_code: postalCode || '',
        country: 'NG',
      },
      payload: {
        requestAccepted: !!resp?.data?.success,
        requestBody: body,
        response: resp?.data,
      },
      provisionalReason: 'Awaiting Smile ID callback.',
    });

    logger.info('NG Digital Address submitted', {
      userId,
      partnerJobId: partnerParams.job_id,
      disco,
      uType,
    });

    return res.status(201).json({
      success: true,
      message: 'Digital address verification submitted',
      data: {
        kycId: kycDoc._id,
        partnerJobId: kycDoc.partnerJobId,
        status: kycDoc.status,
        jobComplete: kycDoc.jobComplete,
      },
    });
  } catch (error) {
    logger.error('NG address verification failed', { error: error.message, stack: error.stack });
    return res.status(500).json({ success: false, message: 'Digital address verification failed', error: error.message });
  }
});

// ===================================================
// 3) Shared Smile Callback (BVN + Address)
// ===================================================
router.post('/kyc/smile/callback', async (req, res) => {
  try {
    const payload = req.body || {};

    // Optional signature verification for callbacks
    let sigOk = true;
    if (smileSigHelpers?.confirm_signature) {
      try { sigOk = !!smileSigHelpers.confirm_signature(payload); } catch { sigOk = false; }
    } else if (signature?.confirm_signature) {
      try { sigOk = !!signature.confirm_signature(payload); } catch { sigOk = false; }
    }

    const smileJobId =
      payload?.SmileJobID || payload?.smile_job_id || payload?.job?.smile_job_id || undefined;
    const partnerJobId =
      payload?.PartnerParams?.job_id || payload?.partner_params?.job_id || undefined;

    if (!smileJobId && !partnerJobId) {
      logger.warn('Smile callback missing identifiers', { payload: JSON.stringify(payload).slice(0, 1000) });
      return res.sendStatus(200);
    }

    const doc = await KYC.findOne(smileJobId ? { smileJobId } : { partnerJobId }).sort({ createdAt: -1 });
    if (!doc) {
      logger.warn('KYC record not found for Smile callback', { smileJobId, partnerJobId });
      return res.sendStatus(200);
    }

    // Pull generic decision fields
    const decision =
      payload?.Result?.ResultText ||
      payload?.result?.ResultText ||
      payload?.Decision ||
      payload?.decision ||
      payload?.message;

    const resultCode =
      payload?.Result?.ResultCode ||
      payload?.result?.ResultCode ||
      payload?.ResultCode ||
      payload?.result_code ||
      payload?.code;

    const jobSuccess =
      payload?.Result?.Success ||
      payload?.result?.Success ||
      (/verification successful/i.test(payload?.message || '')) ||
      (resultCode === '1012') ||
      undefined;

    doc.jobComplete = true;
    doc.jobSuccess = !!jobSuccess;
    doc.status = mapDecisionToStatus(decision);
    doc.resultCode = resultCode || doc.resultCode;
    doc.resultText = decision || doc.resultText;
    doc.smileJobId = doc.smileJobId || smileJobId;

    // Address-specific extras (if present)
    doc.providerAddress = payload?.matched_address || doc.providerAddress;
    doc.otherAddresses = payload?.other_addresses || doc.otherAddresses;
    doc.submittedAddress = payload?.submitted_address || doc.submittedAddress;

    // Common extras
    doc.fullName = payload?.full_name || doc.fullName;
    doc.fullNameMatch = payload?.full_name_match || doc.fullNameMatch;

    doc.signature = payload?.Signature || payload?.signature || doc.signature;
    doc.signatureValid = !!sigOk;

    doc.providerTimestamp = payload?.timestamp ? new Date(payload.timestamp) : doc.providerTimestamp;
    doc.payload = payload;

    await doc.save();

    logger.info('KYC updated from Smile callback', {
      kycId: doc._id,
      status: doc.status,
      jobSuccess: doc.jobSuccess,
      code: doc.resultCode,
    });

    return res.sendStatus(200);
  } catch (error) {
    logger.error('Smile callback processing failed', { error: error.message, stack: error.stack });
    return res.sendStatus(200);
  }
});

module.exports = router;
