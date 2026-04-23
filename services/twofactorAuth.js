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
  
  return speakeasy.totp.verify({
    secret: user.twoFASecret,
    encoding: 'base32',
    token: String(twoFactorCode).trim(),
    window: 3,
  });
}

module.exports = {
  validateTwoFactorAuth
};