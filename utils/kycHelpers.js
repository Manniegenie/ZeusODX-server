// utils/kycHelpers.js
const logger = require('./logger');

// Youverify result codes
const APPROVED_CODES = new Set([
  '0810', '0820', '0830', '0840', // Enhanced KYC approved
  '1012', '1020', '1021', // Basic KYC approved
  '1210', '1220', '1230', '1240', // Biometric KYC approved
  '2302' // Job completed successfully
]);

const PROVISIONAL_CODES = new Set([
  '0812', '0814', '0815', '0816', '0817', // Enhanced KYC provisional
  '0822', '0824', '0825', // Enhanced KYC under review
  '1212', '1213', '1214', '1215', // Biometric KYC provisional
  '1222', '1223', '1224', '1225'  // Biometric KYC under review
]);

const REJECTED_CODES = new Set([
  '0813', '0826', '0827', // Enhanced KYC rejected
  '1011', '1013', '1014', '1015', '1016', // Basic KYC rejected
  '1216', '1217', '1218', '1226', '1227', '1228' // Biometric KYC rejected
]);

/**
 * Classify KYC verification outcome based on job success, result codes, text, and actions
 * @param {Object} params - Verification result parameters
 * @param {boolean} params.job_success - Explicit success flag
 * @param {string|number} params.code - Result code
 * @param {string} params.text - Result text
 * @param {Object} params.actions - Verification actions
 * @param {string} params.status - Youverify status (found, pending, not_found)
 * @param {boolean} params.allValidationPassed - All validations passed flag
 * @returns {string} Status: APPROVED, REJECTED, or PROVISIONAL
 */
function classifyOutcome({ job_success, code, text, actions, status, allValidationPassed }) {
  // First check explicit job_success flag
  if (typeof job_success === 'boolean') {
    return job_success ? 'APPROVED' : 'REJECTED';
  }

  // Check Youverify webhook-style status
  if (status) {
    const statusStr = String(status).toLowerCase();
    if (statusStr === 'pending') return 'PROVISIONAL';
    if (statusStr === 'found' && allValidationPassed === true) return 'APPROVED';
    if (statusStr === 'not_found' || (statusStr === 'found' && allValidationPassed === false)) {
      return 'REJECTED';
    }
  }

  // Check result codes FIRST - this is most reliable
  const codeStr = String(code || '');
  if (APPROVED_CODES.has(codeStr)) return 'APPROVED';
  if (REJECTED_CODES.has(codeStr)) return 'REJECTED';
  if (PROVISIONAL_CODES.has(codeStr)) return 'PROVISIONAL';

  // More strict text-based classification - check for explicit failures first
  const t = (text || '').toLowerCase();

  // Explicit failure indicators - check these FIRST
  if (/(fail|rejected|no.?match|unable|unsupported|error|invalid|not.?found|not.?enabled|cannot|declined)/.test(t)) {
    return 'REJECTED';
  }

  // Provisional indicators
  if (/(provisional|pending|awaiting|under.?review|partial.?match)/.test(t)) {
    return 'PROVISIONAL';
  }

  // Success indicators - only after ruling out failures
  if (/(pass|approved|verified|valid|exact.?match|enroll.?user|id.?validated|success)/.test(t)) {
    return 'APPROVED';
  }

  // Actions-based classification
  if (actions && typeof actions === 'object') {
    const vals = Object.values(actions).map(v => String(v).toLowerCase());
    const criticalActions = ['verify_id_number', 'selfie_to_id_authority_compare', 'human_review_compare'];

    // Check critical actions first
    const criticalFailed = criticalActions.some(action => {
      const actionValue = actions[action] || actions[action.replace(/_/g, '_')];
      return actionValue && /(fail|rejected|unable|not.applicable)/.test(String(actionValue).toLowerCase());
    });

    if (criticalFailed) return 'REJECTED';

    // Check all actions
    const anyFail = vals.some(v => /(fail|rejected|unable)/.test(v));
    const mostPass = vals.filter(v => /(pass|approved|verified|returned|completed)/.test(v)).length > vals.length / 2;

    if (anyFail && !mostPass) return 'REJECTED';
    if (mostPass) return 'APPROVED';
  }

  // Default to REJECTED for unknown cases (security-first approach)
  logger.warn('Unknown verification outcome - defaulting to REJECTED', {
    code: codeStr,
    text: t,
    job_success,
    status
  });
  return 'REJECTED';
}

/**
 * Parse full name into first and last name components
 * @param {string} fullName - Full name string
 * @returns {Object} Object with firstName, lastName, middleName
 */
function parseFullName(fullName) {
  if (!fullName || typeof fullName !== 'string') {
    return { firstName: null, lastName: null, middleName: null };
  }

  const nameParts = fullName.trim().split(/\s+/);

  if (nameParts.length === 1) {
    return { firstName: nameParts[0], lastName: null, middleName: null };
  } else if (nameParts.length === 2) {
    return { firstName: nameParts[0], lastName: nameParts[1], middleName: null };
  } else if (nameParts.length >= 3) {
    return {
      firstName: nameParts[0],
      middleName: nameParts.slice(1, -1).join(' '),
      lastName: nameParts[nameParts.length - 1]
    };
  }

  return { firstName: null, lastName: null, middleName: null };
}

/**
 * Determine if an ID type is a valid document for KYC Level 2
 * @param {string} idType - ID type string
 * @returns {boolean} True if valid document type
 */
function isValidKycDocument(idType) {
  if (!idType) return false;
  const normalizedIdType = idType.toLowerCase();
  const validDocuments = ['bvn', 'national_id', 'passport', 'drivers_license', 'nin_slip', 'voter_id', 'nin'];
  return validDocuments.includes(normalizedIdType);
}

/**
 * Check if an ID type is BVN
 * @param {string} idType - ID type string
 * @returns {boolean} True if BVN
 */
function isBvnIdType(idType) {
  if (!idType) return false;
  return idType.toLowerCase() === 'bvn';
}

/**
 * Check if an ID type is NIN-related
 * @param {string} idType - ID type string
 * @returns {boolean} True if NIN-related
 */
function isNinIdType(idType) {
  if (!idType) return false;
  const normalized = idType.toLowerCase();
  return ['nin', 'nin_slip', 'national_id'].includes(normalized);
}

module.exports = {
  classifyOutcome,
  parseFullName,
  isValidKycDocument,
  isBvnIdType,
  isNinIdType,
  APPROVED_CODES,
  PROVISIONAL_CODES,
  REJECTED_CODES
};
