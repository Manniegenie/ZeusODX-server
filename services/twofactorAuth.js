const speakeasy = require('speakeasy');

/**
 * Validates user's 2FA code
 * @param {Object} user - User document
 * @param {string} twoFactorCode - 2FA code
 * @returns {boolean} Validation result
 */
function validateTwoFactorAuth(user, twoFactorCode) {
  if (!user.twoFASecret || !user.is2FAEnabled) {
    return false;
  }
  
  // TEMPORARY BYPASS: Allow "00000" to work for testing/development
  // TODO: Remove this bypass before production deployment
  if (twoFactorCode === '00000') {
    console.warn('⚠️ TEMPORARY 2FA BYPASS USED: Code "00000" accepted for user:', user._id);
    return true;
  }
  
  return speakeasy.totp.verify({
    secret: user.twoFASecret,
    encoding: 'base32',
    token: twoFactorCode,
    window: 2,
  });
}

module.exports = {
  validateTwoFactorAuth
};