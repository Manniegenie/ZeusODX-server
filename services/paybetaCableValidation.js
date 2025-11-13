const { payBetaAuth } = require('../auth/paybetaAuth');
const logger = require('../utils/logger');

const maskForLog = (value) => {
  if (!value) return '***';
  const str = String(value);
  if (str.length <= 4) {
    return `${str}***`;
  }
  return `${str.slice(0, 4)}***`;
};

/**
 * Validate a cable TV customer against PayBeta
 * @param {Object} params Parameters for validation
 * @param {string} params.service Cable TV service identifier (dstv, gotv, etc.)
 * @param {string} params.smartCardNumber Smart card/IUC number to validate
 * @returns {Promise<Object>} Normalized PayBeta response
 */
async function validateCableAccount({ service, smartCardNumber }) {
  if (!service || !smartCardNumber) {
    const error = new Error('Service and smart card number are required');
    error.code = 'INVALID_PARAMETERS';
    throw error;
  }

  const normalizedService = String(service).trim().toLowerCase();
  const normalizedSmartCard = String(smartCardNumber).trim();

  const payload = {
    service: normalizedService,
    smartCardNumber: normalizedSmartCard
  };

  logger.info('🔍 Initiating PayBeta cable account validation', {
    service: normalizedService,
    smartCardNumber: maskForLog(normalizedSmartCard)
  });

  let response;
  try {
    response = await payBetaAuth.makeRequest('POST', '/v2/cable/validate', payload);
  } catch (error) {
    logger.error('❌ PayBeta cable account validation failed', {
      service: normalizedService,
      smartCardNumber: maskForLog(normalizedSmartCard),
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    });

    error.code = error.code || 'PAYBETA_API_ERROR';
    throw error;
  }

  if (!response || response.status !== 'successful') {
    const error = new Error(response?.message || 'Cable account validation failed');
    error.code = 'PAYBETA_VALIDATION_FAILED';
    error.status = response?.status || 'failed';
    error.data = response?.data || null;
    throw error;
  }

  const customerData = response.data || {};
  const serviceLabel = (customerData.service || normalizedService).toUpperCase();
  const structuredResponse = {
    status: response.status,
    message: response.message || 'Request processed successfully.',
    data: {
      customerName: customerData.customerName || customerData.CustomerName || null,
      smartCardNumber: customerData.smartCardNumber || normalizedSmartCard,
      service: serviceLabel
    }
  };

  logger.info('✅ PayBeta cable account validation successful', {
    service: serviceLabel,
    smartCardNumber: maskForLog(structuredResponse.data.smartCardNumber)
  });

  return structuredResponse;
}

module.exports = {
  validateCableAccount
};
