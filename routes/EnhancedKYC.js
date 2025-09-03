// routes/kyc.js
// npm i smile-identity-core uuid
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const smileIdentityCore = require('smile-identity-core');

const KYC = require('../models/kyc');
const User = require('../models/user');
const logger = require('../utils/logger');

const {
  PARTNER_ID,
  API_KEY,
  SID_SERVER = '0', // '0' sandbox, '1' prod
} = process.env;

// Guard on startup
if (!PARTNER_ID || !API_KEY) {
  // Prefer crashing early over weird runtime errors
  // eslint-disable-next-line no-console
  console.error('Smile Identity env missing: PARTNER_ID and/or API_KEY.');
}

const envLabel = SID_SERVER === '1' ? 'production' : 'sandbox';

// Smile ID SDK classes
const { IDApi, Utilities, Signature } = smileIdentityCore;
const idApi = new IDApi(PARTNER_ID, API_KEY, SID_SERVER);
const utilities = new Utilities(PARTNER_ID, API_KEY, SID_SERVER);
const signature = new Signature(PARTNER_ID, API_KEY);

// Helpers
const mapDecisionToStatus = (decision) => {
  // Smile result decision → our STATUS enum
  const v = String(decision || '').toUpperCase();
  if (v === 'APPROVED') return 'APPROVED';
  if (v === 'REJECTED') return 'REJECTED';
  // 'PROVISIONAL' or unknown → keep provisional until manual/async completion
  return 'PROVISIONAL';
};

const safeJsonParse = (objOrString) => {
  try {
    if (typeof objOrString === 'string') return JSON.parse(objOrString);
    return objOrString;
  } catch {
    return { raw: String(objOrString) };
  }
};

const buildPartnerParams = (label = 'kyc') => ({
  job_id: `${label}-${uuidv4()}`,
  user_id: `user-${uuidv4()}`,
  job_type: 5, // Enhanced KYC (per Smile ID docs)
});

// ============ BVN: Enhanced KYC ============
/**
 * POST /kyc/bvn/verify
 * Body: { bvn: string, firstName?, lastName?, dob?, phoneNumber? }
 * Auth: requires req.user.id
 */
router.post('/kyc/bvn/verify', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { bvn, firstName, lastName, dob, phoneNumber } = req.body || {};
    const errors = [];
    if (!bvn || String(bvn).replace(/\D/g, '').length !== 11) {
      errors.push('Valid 11-digit BVN is required');
    }
    if (errors.length) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    const partnerParams = buildPartnerParams('bvn');
    const idInfo = {
      country: 'NG',
      id_type: 'BVN',
      id_number: String(bvn),
      first_name: firstName,
      last_name: lastName,
      dob, // 'YYYY-MM-DD' if available
      phone_number: phoneNumber,
    };
    const options = { signature: true };

    // Submit Enhanced KYC (async on Smile’s side)
    const rawResponse = await idApi.submit_job(partnerParams, idInfo, options);
    const providerPayload = safeJsonParse(rawResponse);

    // Prepare initial KYC doc — provisional until callback or poll
    const kycDoc = await KYC.create({
      userId,
      provider: 'smile-id',
      environment: envLabel,
      partnerJobId: partnerParams.job_id,
      jobType: 'EnhancedKyc',
      smileJobId: providerPayload?.SmileJobID || providerPayload?.smile_job_id || undefined,
      jobComplete: !!providerPayload?.job_complete,
      jobSuccess: providerPayload?.result?.Success || providerPayload?.job_success || undefined,
      status: mapDecisionToStatus(providerPayload?.result?.ResultText || providerPayload?.ResultText),
      resultCode: providerPayload?.result?.ResultCode || providerPayload?.ResultCode,
      resultText: providerPayload?.result?.ResultText || providerPayload?.ResultText,
      actions: providerPayload?.Actions || providerPayload?.actions,
      country: idInfo.country,
      idType: idInfo.id_type,
      idNumber: idInfo.id_number,
      fullName: [firstName, lastName].filter(Boolean).join(' ').trim() || undefined,
      dob: idInfo.dob,
      imageLinks: providerPayload?.ImageLinks || providerPayload?.image_links,
      history: providerPayload?.History || providerPayload?.history,
      signature: providerPayload?.Signature || providerPayload?.signature,
      signatureValid: false, // will be set true on callback verification
      providerTimestamp: providerPayload?.timestamp ? new Date(providerPayload.timestamp) : undefined,
      payload: providerPayload,
      provisionalReason: 'Awaiting Smile ID final result (callback/poll).',
    });

    logger.info('BVN Enhanced KYC submitted', {
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
    return res.status(500).json({ success: false, message: 'BVN verification failed', error: error.message });
  }
});

// ============ Digital Address Verification ============
/**
 * POST /kyc/address/verify-digital
 * Body:
 * {
 *   country?: 'NG'|'ZA'|string,
 *   idType?: string,               // default 'ADDRESS' — set to what Smile enables for your account
 *   addressLine1: string,
 *   addressLine2?: string,
 *   city?: string,
 *   state?: string,
 *   postalCode?: string,
 *   phoneNumber?: string
 * }
 * Auth: requires req.user.id
 *
 * Note: Digital Address Verification is offered via Smile’s Enhanced KYC product.
 *       Use the IDApi (no images). The exact id_type & fields can vary by country/product enablement.
 *       Default here assumes 'ADDRESS' id_type; adjust to your Smile config (e.g., 'DIGITAL_ADDRESS').
 */
router.post('/kyc/address/verify-digital', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const {
      country = 'NG',
      idType = 'ADDRESS', // <— set to the exact id_type Smile expects for your plan, e.g., 'DIGITAL_ADDRESS'
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      phoneNumber,
    } = req.body || {};

    const errors = [];
    if (!addressLine1 || String(addressLine1).trim().length < 5) {
      errors.push('addressLine1 is required');
    }
    if (!country) errors.push('country is required');

    if (errors.length) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    const partnerParams = buildPartnerParams('addr');
    const idInfo = {
      country,
      id_type: idType,
      // Common fields partners pass for address checks
      address: String(addressLine1).trim(),
      address2: addressLine2 ? String(addressLine2).trim() : undefined,
      city,
      state,
      postal_code: postalCode,
      phone_number: phoneNumber,
    };
    const options = { signature: true };

    const rawResponse = await idApi.submit_job(partnerParams, idInfo, options);
    const providerPayload = safeJsonParse(rawResponse);

    const kycDoc = await KYC.create({
      userId,
      provider: 'smile-id',
      environment: envLabel,
      partnerJobId: partnerParams.job_id,
      jobType: 'EnhancedKyc:DigitalAddress',
      smileJobId: providerPayload?.SmileJobID || providerPayload?.smile_job_id || undefined,
      jobComplete: !!providerPayload?.job_complete,
      jobSuccess: providerPayload?.result?.Success || providerPayload?.job_success || undefined,
      status: mapDecisionToStatus(providerPayload?.result?.ResultText || providerPayload?.ResultText),
      resultCode: providerPayload?.result?.ResultCode || providerPayload?.ResultCode,
      resultText: providerPayload?.result?.ResultText || providerPayload?.ResultText,
      actions: providerPayload?.Actions || providerPayload?.actions,
      country: idInfo.country,
      idType: idInfo.id_type,
      fullName: undefined,
      dob: undefined,
      imageLinks: providerPayload?.ImageLinks || providerPayload?.image_links,
      history: providerPayload?.History || providerPayload?.history,
      signature: providerPayload?.Signature || providerPayload?.signature,
      signatureValid: false,
      providerTimestamp: providerPayload?.timestamp ? new Date(providerPayload.timestamp) : undefined,
      payload: providerPayload,
      provisionalReason: 'Awaiting Smile ID final result (callback/poll).',
    });

    logger.info('Digital address KYC submitted', {
      userId,
      partnerJobId: partnerParams.job_id,
      smileJobId: kycDoc.smileJobId,
    });

    return res.status(201).json({
      success: true,
      message: 'Digital address verification submitted',
      data: {
        kycId: kycDoc._id,
        partnerJobId: kycDoc.partnerJobId,
        smileJobId: kycDoc.smileJobId,
        status: kycDoc.status,
        jobComplete: kycDoc.jobComplete,
      },
    });
  } catch (error) {
    logger.error('Digital address verification failed', { error: error.message, stack: error.stack });
    return res.status(500).json({
      success: false,
      message: 'Digital address verification failed',
      error: error.message,
    });
  }
});

// ============ (Optional) Smile ID callback ============
/**
 * Smile will POST results here (configure in your Smile partner portal).
 * Verify the signature and update the KYC record.
 */
router.post('/kyc/smile/callback', async (req, res) => {
  try {
    const payload = req.body || {};
    const isValid = signature.confirm_signature(payload);

    const smileJobId =
      payload?.SmileJobID || payload?.smile_job_id || payload?.job?.smile_job_id || undefined;
    const partnerJobId =
      payload?.PartnerParams?.job_id || payload?.partner_params?.job_id || undefined;

    if (!smileJobId && !partnerJobId) {
      logger.warn('Smile callback missing identifiers', { payload: JSON.stringify(payload).slice(0, 1000) });
      return res.status(400).json({ success: false, message: 'Invalid callback payload' });
    }

    const doc = await KYC.findOne(
      smileJobId ? { smileJobId } : { partnerJobId }
    ).sort({ createdAt: -1 });

    if (!doc) {
      logger.warn('KYC record not found for Smile callback', { smileJobId, partnerJobId });
      // 200 OK so Smile doesn’t keep retrying forever; log for manual triage
      return res.sendStatus(200);
    }

    const decision =
      payload?.Result?.ResultText ||
      payload?.result?.ResultText ||
      payload?.Decision ||
      payload?.decision;

    const resultCode =
      payload?.Result?.ResultCode ||
      payload?.result?.ResultCode ||
      payload?.ResultCode ||
      payload?.result_code;

    const jobSuccess =
      payload?.Result?.Success ||
      payload?.result?.Success ||
      payload?.job_success ||
      undefined;

    doc.jobComplete = true;
    doc.jobSuccess = !!jobSuccess;
    doc.status = mapDecisionToStatus(decision);
    doc.resultCode = resultCode || doc.resultCode;
    doc.resultText = decision || doc.resultText;
    doc.imageLinks = payload?.ImageLinks || payload?.image_links || doc.imageLinks;
    doc.history = payload?.History || payload?.history || doc.history;
    doc.signature = payload?.Signature || payload?.signature || doc.signature;
    doc.signatureValid = !!isValid;
    doc.providerTimestamp = payload?.timestamp ? new Date(payload.timestamp) : doc.providerTimestamp;
    doc.payload = payload;

    await doc.save();

    logger.info('KYC updated from Smile callback', {
      kycId: doc._id,
      status: doc.status,
      jobSuccess: doc.jobSuccess,
    });

    return res.sendStatus(200);
  } catch (error) {
    logger.error('Smile callback processing failed', { error: error.message, stack: error.stack });
    // Return 200 so Smile doesn’t hammer retries; rely on logs for manual handling
    return res.sendStatus(200);
  }
});

module.exports = router;
