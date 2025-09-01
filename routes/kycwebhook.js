// ../routes/smileid.webhook.js
const express = require('express');
const router = express.Router();

const User = require('../models/user');
const KYC = require('../models/kyc');
const logger = require('../utils/logger');

// Optional: verify Smile signature using their server SDK
let Signature;
try {
  Signature = require('smile-identity-core').Signature; // npm i smile-identity-core
} catch (_) {
  Signature = null;
}

const PARTNER_ID = process.env.SMILE_PARTNER_ID;
const API_KEY = process.env.SMILE_API_KEY;

// ---- helpers ----------------------------------------------------

const APPROVED_CODES = new Set(['0810', '0820', '0840', '1012', '1020', '1021', '1210', '1220', '1240']);
const PROVISIONAL_CODES = new Set(['0812', '0814', '0815', '0816', '0817', '0822', '0824', '0825', '1213']);

function classifyOutcome({ job_success, code, text, actions }) {
  if (typeof job_success === 'boolean') return job_success ? 'APPROVED' : 'REJECTED';
  if (code && APPROVED_CODES.has(String(code))) return 'APPROVED';
  if (code && PROVISIONAL_CODES.has(String(code))) return 'PROVISIONAL';

  const t = (text || '').toLowerCase();
  if (/(provisional|pending|awaiting)/.test(t)) return 'PROVISIONAL';
  if (/(pass|approved|verified|valid|exact match)/.test(t)) return 'APPROVED';
  if (/(fail|rejected|no match|unable|unsupported|error)/.test(t)) return 'REJECTED';

  if (actions && typeof actions === 'object') {
    const vals = Object.values(actions).map(v => String(v).toLowerCase());
    const anyFail = vals.some(v => /(fail|rejected|unable)/.test(v));
    const allPass = vals.length && vals.every(v => /(pass|approved|verified|returned|completed)/.test(v));
    if (anyFail) return 'REJECTED';
    if (allPass) return 'APPROVED';
  }
  return 'PROVISIONAL';
}

function normalize(body) {
  const {
    job_complete,
    job_success,
    code,
    result,
    history,
    image_links,
    Actions,
    Country,
    DOB,
    Document,                // we won't persist raw base64 separately; it's in payload
    ExpirationDate,
    FullName,
    Gender,
    IDNumber,
    IDType,
    ResultCode,
    ResultText,
    SmileJobID,
    PartnerParams = {},
    timestamp,
    signature,
    environment,
  } = body || {};

  const node = result && typeof result === 'object' ? result : body || {};
  return {
    jobComplete: typeof job_complete === 'boolean' ? job_complete : undefined,
    jobSuccess: typeof job_success === 'boolean' ? job_success : undefined,

    actions: node.Actions || Actions || null,
    country: node.Country || Country || null,
    dob: node.DOB || DOB || null,
    expiresAt: node.ExpirationDate || ExpirationDate || null,
    fullName: node.FullName || FullName || null,
    idNumber: node.IDNumber || IDNumber || null,
    idType: node.IDType || IDType || null,
    resultCode: node.ResultCode || ResultCode || code || null,
    resultText: node.ResultText || ResultText || null,

    smileJobId: SmileJobID || body.SmileJobID || null,
    partnerParams: PartnerParams || {},
    providerTimestamp: timestamp ? new Date(timestamp) : undefined,
    signature: signature || null,
    imageLinks: image_links || null,
    history: history || null,
    environment: environment || 'unknown',
  };
}

// ---- webhook ----------------------------------------------------

/**
 * Mount this at: app.use('/webhooks', require('./routes/smileid.webhook'))
 * Ensure JSON body size: app.use(express.json({ limit: '2mb' }))
 */
router.post('/smileid/callback', async (req, res) => {
  const body = req.body || {};
  const norm = normalize(body);

  // 1) signature verification (recommended but optional if already firewalled)
  let signatureValid = false;
  try {
    if (Signature && PARTNER_ID && API_KEY && body.timestamp && body.signature) {
      const sig = new Signature(PARTNER_ID, API_KEY);
      signatureValid = !!sig.confirm_signature(body.timestamp, body.signature);
      if (!signatureValid) {
        // If you want to hard-reject, switch to 401 here.
        // We’ll log and continue to save for forensics.
        logger.warn('SmileID webhook: signature INVALID');
      }
    } else {
      logger.warn('SmileID webhook: signature not verified (missing SDK/envs or ts/sig)');
    }
  } catch (e) {
    logger.error('SmileID signature verify error', { error: e.message });
  }

  // 2) user association
  const { user_id: userId, job_id: partnerJobId, job_type: jobType } = norm.partnerParams || {};
  if (!userId) {
    logger.warn('SmileID callback missing PartnerParams.user_id; acknowledging without write');
    return res.status(200).json({ success: true, ignored: 'missing_user_id' });
  }

  // 3) compute outcome
  const status = classifyOutcome({
    job_success: norm.jobSuccess,
    code: norm.resultCode,
    text: norm.resultText,
    actions: norm.actions,
  });

  // 4) upsert into KYC
  try {
    // Prefer SmileJobID as the idempotency key; fallback to (userId, partnerJobId)
    const filter = norm.smileJobId
      ? { smileJobId: norm.smileJobId }
      : { userId, partnerJobId };

    const update = {
      $setOnInsert: {
        userId,
        provider: 'smile-id',
      },
      $set: {
        environment: norm.environment,
        partnerJobId,
        jobType,

        smileJobId: norm.smileJobId,
        jobComplete: norm.jobComplete,
        jobSuccess: norm.jobSuccess,

        status,
        resultCode: norm.resultCode,
        resultText: norm.resultText,
        actions: norm.actions,

        country: norm.country,
        idType: norm.idType,
        idNumber: norm.idNumber,
        fullName: norm.fullName,
        dob: norm.dob,
        expiresAt: norm.expiresAt,

        imageLinks: norm.imageLinks,
        history: norm.history,

        signature: norm.signature,
        signatureValid,
        providerTimestamp: norm.providerTimestamp,

        payload: body,
        errorReason: null,
        provisionalReason: status === 'PROVISIONAL' ? (norm.resultText || 'Provisional') : null,
      },
    };

    const kycDoc = await KYC.findOneAndUpdate(filter, update, {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
      runValidators: true,
    });

    // 5) (Light) mirror onto User for fast lookups
    try {
      await User.findByIdAndUpdate(
        userId,
        {
          $set: {
            'kyc.provider': 'smile-id',
            'kyc.status': kycDoc.status,
            'kyc.updatedAt': new Date(),
            'kyc.latestKycId': kycDoc._id,
            'kyc.resultCode': kycDoc.resultCode,
            'kyc.resultText': kycDoc.resultText,
          },
        },
        { new: true }
      );
    } catch (e) {
      logger.error('SmileID webhook: failed mirroring KYC to User', { error: e.message, userId });
    }

    logger.info('SmileID KYC stored', {
      userId,
      partnerJobId,
      smileJobId: norm.smileJobId,
      status: kycDoc.status,
      resultCode: kycDoc.resultCode,
    });

    return res.status(200).json({ success: true, kycId: kycDoc._id, status: kycDoc.status });
  } catch (e) {
    logger.error('SmileID webhook DB upsert error', { error: e.message });
    // Acknowledge to reduce retries; mark retriable for your logs/alerts
    return res.status(200).json({ success: false, retriable: true });
  }
});

module.exports = router;
