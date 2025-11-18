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
 * Purchase cable TV subscription via PayBeta
 * @param {Object} params Parameters for purchase
 * @param {string} params.service Cable TV service identifier (dstv, gotv, etc.)
 * @param {string} params.smartCardNumber Smart card/IUC number
 * @param {number} params.amount Amount to charge (in NGN)
 * @param {string} params.packageCode Package/bouquet code
 * @param {string} params.customerName Customer name
 * @param {string} params.reference Transaction reference
 * @returns {Promise<Object>} Normalized PayBeta response
 */
async function purchaseCableSubscription({ service, smartCardNumber, amount, packageCode, customerName, reference }) {
  // Validate required parameters
  if (!service || !smartCardNumber || !amount || !packageCode || !customerName || !reference) {
    const error = new Error('All purchase parameters are required: service, smartCardNumber, amount, packageCode, customerName, reference');
    error.code = 'INVALID_PARAMETERS';
    throw error;
  }

  // Normalize inputs
  const normalizedService = String(service).trim().toLowerCase();
  const normalizedSmartCard = String(smartCardNumber).trim();
  const normalizedAmount = Number.isFinite(Number(amount)) ? Math.round(Number(amount)) : null;
  const normalizedPackageCode = String(packageCode).trim();
  const normalizedCustomerName = String(customerName).trim() || 'CUSTOMER';
  const normalizedReference = String(reference).trim().substring(0, 40); // PayBeta limit

  if (!normalizedAmount || normalizedAmount <= 0) {
    const error = new Error('Amount must be a positive number');
    error.code = 'INVALID_AMOUNT';
    throw error;
  }

  // Determine endpoint based on service
  let endpoint;
  if (normalizedService === 'showmax') {
    endpoint = '/v2/showmax/purchase';
  } else {
    endpoint = '/v2/cable/purchase';
  }

  // Build payload according to PayBeta documentation
  const payload = {
    service: normalizedService,
    smartCardNumber: normalizedSmartCard,
    amount: normalizedAmount,
    packageCode: normalizedPackageCode,
    customerName: normalizedCustomerName,
    reference: normalizedReference
  };

  logger.info('💳 Initiating PayBeta cable purchase', {
    service: normalizedService,
    smartCardNumber: maskForLog(normalizedSmartCard),
    amount: normalizedAmount,
    packageCode: normalizedPackageCode,
    reference: normalizedReference
  });

  let response;
  try {
    response = await payBetaAuth.makeRequest('POST', endpoint, payload, {
      timeout: 25000
    });
  } catch (error) {
    logger.error('❌ PayBeta cable purchase failed', {
      service: normalizedService,
      smartCardNumber: maskForLog(normalizedSmartCard),
      amount: normalizedAmount,
      packageCode: normalizedPackageCode,
      reference: normalizedReference,
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    });

    error.code = error.code || 'PAYBETA_API_ERROR';
    throw error;
  }

  // Validate response structure
  if (!response || response.status !== 'successful') {
    const error = new Error(response?.message || 'Cable TV purchase failed');
    error.code = 'PAYBETA_PURCHASE_FAILED';
    error.status = response?.status || 'failed';
    error.data = response?.data || null;
    throw error;
  }

  // Normalize response to match PayBeta documentation structure
  const purchaseData = response.data || {};
  const structuredResponse = {
    status: response.status,
    message: response.message || 'Transaction successful',
    data: {
      reference: purchaseData.reference || normalizedReference,
      amount: purchaseData.amount || normalizedAmount,
      chargedAmount: purchaseData.chargedAmount || purchaseData.amount || normalizedAmount,
      commission: purchaseData.commission || 0,
      biller: purchaseData.biller || purchaseData.service || normalizedService.toUpperCase(),
      customerId: purchaseData.customerId || normalizedSmartCard,
      token: purchaseData.token || null,
      unit: purchaseData.unit || null,
      bonusToken: purchaseData.bonusToken || null,
      transactionDate: purchaseData.transactionDate || new Date().toISOString(),
      transactionId: purchaseData.transactionId || purchaseData.reference || normalizedReference
    }
  };

  logger.info('✅ PayBeta cable purchase successful', {
    service: normalizedService,
    smartCardNumber: maskForLog(normalizedSmartCard),
    transactionId: structuredResponse.data.transactionId,
    amount: structuredResponse.data.amount,
    chargedAmount: structuredResponse.data.chargedAmount
  });

  return structuredResponse;
}

module.exports = {
  purchaseCableSubscription
};




