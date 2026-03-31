/**
 * Obiex Sort Code Migration Map
 * Maps old 3-digit sort codes to new 4-digit sort codes
 * Updated: 2026-03-31
 */
const SORT_CODE_MAP = {
  // Major Commercial Banks
  '044': '0009', // Access Bank
  '058': '0277', // GTBank
  '011': '0215', // First Bank
  '033': '0629', // UBA
  '057': '0671', // Zenith Bank
  '070': '0212', // Fidelity Bank
  '214': '0216', // FCMB
  '082': '0341', // Keystone Bank
  '032': '0628', // Union Bank
  '076': '0496', // Polaris Bank
  '030': '0287', // Heritage Bank
  '215': '0630', // Unity Bank
  '301': '0334', // Jaiz Bank
  '050': '0174', // Ecobank
  '221': '0554', // Stanbic IBTC
  '068': '0556', // Standard Chartered
  '023': '0139', // Citibank
  '101': '0497', // Providus Bank
  '103': '0264', // Globus Bank
  '102': '0611', // Titan Trust Bank
  '100': '0588', // SunTrust Bank
  '035': '0657', // Wema Bank
  '232': '0558', // Sterling Bank

  // Mobile / Fintech Banks
  '305':    '0457', // OPay
  '999991': '0488', // PalmPay
  '50211':  '0356', // Kuda
  '50515':  '0415', // Moniepoint
};

/**
 * Migrate a sort code from old format to new format.
 * If the code is already new (or unknown), return it unchanged.
 * @param {string} code
 * @returns {string}
 */
function migrateCode(code) {
  if (!code) return code;
  const trimmed = String(code).trim();
  return SORT_CODE_MAP[trimmed] || trimmed;
}

module.exports = { migrateCode, SORT_CODE_MAP };
