// utils/generateReferralCode.js
const crypto = require('crypto');

// Unambiguous uppercase alphanumeric alphabet — strips O/0/I/1 to avoid
// user confusion when reading codes aloud or copying them manually.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/**
 * Generate one candidate referral code (not guaranteed unique yet).
 * Uses crypto.randomBytes so distribution is uniform and not predictable.
 */
function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    // Bias-free rejection-sampling via modulo on a 256-bucket alphabet
    // ALPHABET.length = 32 = 2^5, so modulo 32 is perfectly unbiased on a byte.
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return code;
}

/**
 * Generate a referral code that is guaranteed unique across all existing
 * Referral documents. Retries up to maxAttempts times.
 *
 * @returns {Promise<string>} A unique 8-character referral code
 */
async function generateUniqueReferralCode() {
  // Lazy-require to avoid circular-dependency issues at module load time.
  const Referral = require('../models/referral');

  const MAX_ATTEMPTS = 10;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateCode();
    const conflict = await Referral.exists({ referralCode: code });
    if (!conflict) return code;
  }

  // Astronomically unlikely — 32^8 ≈ 1 trillion possible codes.
  throw new Error('Could not generate a unique referral code after 10 attempts');
}

module.exports = { generateUniqueReferralCode, generateCode };
