const axios = require('axios');
const { attachObiexAuth } = require('./utils/obiexAuth');

/**
 * Configuration constants
 */
const CONFIG = {
  BASE_URL: process.env.OBIEX_BASE_URL || 'https://api.obiex.finance',
  REQUEST_TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT) || 10000,
  API_VERSION: '/v1',
  ENDPOINTS: {
    PAIRS: '/trades/pairs'
  }
};

/**
 * Response status constants
 */
const RESPONSE_STATUS = {
  SUCCESS: 'success',
  ERROR: 'error',
  NOT_FOUND: 'not_found'
};

/**
 * Validates currency code format
 * @param {string} currency - Currency code to validate
 * @returns {boolean} - True if valid currency code
 */
function isValidCurrencyCode(currency) {
  if (!currency || typeof currency !== 'string') {
    return false;
  }
  return /^[A-Z0-9]{2,10}$/i.test(currency.trim());
}

/**
 * Creates axios instance with authentication and interceptors
 * @returns {object} - Configured axios instance
 */
function createApiClient() {
  const client = axios.create({
    baseURL: CONFIG.BASE_URL,
    timeout: CONFIG.REQUEST_TIMEOUT,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });

  // Request interceptor for authentication
  client.interceptors.request.use(
    (config) => {
      try {
        return attachObiexAuth(config);
      } catch (error) {
        console.error('Authentication error:', error.message);
        return Promise.reject(error);
      }
    },
    (error) => {
      console.error('Request interceptor error:', error);
      return Promise.reject(error);
    }
  );

  // Response interceptor for consistent error handling
  client.interceptors.response.use(
    (response) => {
      console.log(`API Success: ${response.config.method?.toUpperCase()} ${response.config.url}`);
      return response;
    },
    (error) => {
      const errorDetails = {
        method: error.config?.method?.toUpperCase(),
        url: error.config?.url,
        status: error.response?.status,
        message: error.response?.data?.message || error.message
      };
      console.error('API Error:', errorDetails);
      return Promise.reject(error);
    }
  );

  return client;
}

/**
 * Creates standardized service response
 * @param {boolean} success - Success status
 * @param {*} data - Response data
 * @param {string} message - Response message
 * @param {number} total - Total count (optional)
 * @param {*} error - Error object (optional)
 * @returns {object} - Standardized response
 */
function createResponse(success, data, message, total = null, error = null) {
  const response = {
    success,
    status: success ? RESPONSE_STATUS.SUCCESS : RESPONSE_STATUS.ERROR,
    data,
    message,
    timestamp: new Date().toISOString()
  };

  if (total !== null) {
    response.total = total;
  }

  if (error) {
    response.error = error;
  }

  return response;
}

/**
 * Handles service errors with consistent format
 * @param {string} operation - Operation that failed
 * @param {Error} error - Original error object
 * @returns {object} - Standardized error response
 */
function handleServiceError(operation, error) {
  const errorMessage = `Failed to ${operation}`;
  const errorData = {
    code: error.response?.status || 'UNKNOWN',
    details: error.response?.data || error.message,
    operation
  };

  console.error(`Service Error [${operation}]:`, errorData);
  
  return createResponse(false, null, errorMessage, 0, errorData);
}

/**
 * Fetches all trading pairs from the API
 * @returns {Promise<object>} - Service response with all trading pairs
 */
async function getAllPairs() {
  try {
    console.log('Fetching all trading pairs...');
    
    const apiClient = createApiClient();
    const response = await apiClient.get(`${CONFIG.API_VERSION}${CONFIG.ENDPOINTS.PAIRS}`);
    
    const pairs = response.data?.data || [];
    const message = response.data?.message || 'Trading pairs retrieved successfully';
    
    console.log(`Retrieved ${pairs.length} trading pairs`);
    
    return createResponse(true, pairs, message, pairs.length);
    
  } catch (error) {
    return handleServiceError('fetch all trading pairs', error);
  }
}

/**
 * Gets only active trading pairs
 * @returns {Promise<object>} - Service response with active pairs
 */
async function getActivePairs() {
  try {
    console.log('Fetching active trading pairs...');
    
    const result = await getAllPairs();
    
    if (!result.success) {
      return result;
    }
    
    const activePairs = result.data.filter(pair => pair.active === true);
    
    console.log(`Found ${activePairs.length} active pairs out of ${result.total} total pairs`);
    
    return createResponse(
      true, 
      activePairs, 
      'Active trading pairs retrieved successfully', 
      activePairs.length
    );
    
  } catch (error) {
    return handleServiceError('fetch active trading pairs', error);
  }
}

/**
 * Gets trading pairs filtered by source currency
 * @param {string} sourceCurrency - Source currency code (e.g., 'BTC')
 * @returns {Promise<object>} - Service response with filtered pairs
 */
async function getPairsBySource(sourceCurrency) {
  try {
    if (!isValidCurrencyCode(sourceCurrency)) {
      return createResponse(
        false, 
        null, 
        'Invalid source currency code provided', 
        0, 
        { code: 'INVALID_INPUT', details: 'Currency code must be 2-10 alphanumeric characters' }
      );
    }

    const normalizedCurrency = sourceCurrency.trim().toUpperCase();
    console.log(`Fetching pairs for source currency: ${normalizedCurrency}`);
    
    const result = await getAllPairs();
    
    if (!result.success) {
      return result;
    }
    
    const filteredPairs = result.data.filter(pair => 
      pair.source?.code?.toUpperCase() === normalizedCurrency
    );
    
    console.log(`Found ${filteredPairs.length} pairs for source currency ${normalizedCurrency}`);
    
    return createResponse(
      true, 
      filteredPairs, 
      `Pairs for source currency ${normalizedCurrency} retrieved successfully`, 
      filteredPairs.length
    );
    
  } catch (error) {
    return handleServiceError(`fetch pairs for source currency ${sourceCurrency}`, error);
  }
}

/**
 * Gets trading pairs filtered by target currency
 * @param {string} targetCurrency - Target currency code (e.g., 'USDT')
 * @returns {Promise<object>} - Service response with filtered pairs
 */
async function getPairsByTarget(targetCurrency) {
  try {
    if (!isValidCurrencyCode(targetCurrency)) {
      return createResponse(
        false, 
        null, 
        'Invalid target currency code provided', 
        0, 
        { code: 'INVALID_INPUT', details: 'Currency code must be 2-10 alphanumeric characters' }
      );
    }

    const normalizedCurrency = targetCurrency.trim().toUpperCase();
    console.log(`Fetching pairs for target currency: ${normalizedCurrency}`);
    
    const result = await getAllPairs();
    
    if (!result.success) {
      return result;
    }
    
    const filteredPairs = result.data.filter(pair => 
      pair.target?.code?.toUpperCase() === normalizedCurrency
    );
    
    console.log(`Found ${filteredPairs.length} pairs for target currency ${normalizedCurrency}`);
    
    return createResponse(
      true, 
      filteredPairs, 
      `Pairs for target currency ${normalizedCurrency} retrieved successfully`, 
      filteredPairs.length
    );
    
  } catch (error) {
    return handleServiceError(`fetch pairs for target currency ${targetCurrency}`, error);
  }
}

/**
 * Finds a specific trading pair
 * @param {string} sourceCurrency - Source currency code
 * @param {string} targetCurrency - Target currency code
 * @returns {Promise<object>} - Service response with the specific pair or not found
 */
async function findPair(sourceCurrency, targetCurrency) {
  try {
    if (!isValidCurrencyCode(sourceCurrency) || !isValidCurrencyCode(targetCurrency)) {
      return createResponse(
        false, 
        null, 
        'Invalid currency codes provided', 
        0, 
        { code: 'INVALID_INPUT', details: 'Both currency codes must be 2-10 alphanumeric characters' }
      );
    }

    const normalizedSource = sourceCurrency.trim().toUpperCase();
    const normalizedTarget = targetCurrency.trim().toUpperCase();
    const pairName = `${normalizedSource}-${normalizedTarget}`;
    
    console.log(`Searching for trading pair: ${pairName}`);
    
    const result = await getAllPairs();
    
    if (!result.success) {
      return result;
    }
    
    const pair = result.data.find(p => 
      p.source?.code?.toUpperCase() === normalizedSource &&
      p.target?.code?.toUpperCase() === normalizedTarget
    );
    
    if (!pair) {
      console.log(`Trading pair ${pairName} not found`);
      return createResponse(
        false, 
        null, 
        `Trading pair ${pairName} not found`, 
        0, 
        { code: 'PAIR_NOT_FOUND', details: `No trading pair exists for ${pairName}` }
      );
    }
    
    console.log(`Found trading pair: ${pairName}`);
    
    return createResponse(
      true, 
      pair, 
      `Trading pair ${pairName} found successfully`, 
      1
    );
    
  } catch (error) {
    return handleServiceError(`find trading pair ${sourceCurrency}-${targetCurrency}`, error);
  }
}

/**
 * Gets trading pairs formatted for UI display
 * @returns {Promise<object>} - Service response with UI-formatted pairs
 */
async function getFormattedPairs() {
  try {
    console.log('Fetching and formatting trading pairs for UI...');
    
    const result = await getAllPairs();
    
    if (!result.success) {
      return result;
    }
    
    const formattedPairs = result.data.map(pair => {
      const sourceCode = pair.source?.code || 'N/A';
      const targetCode = pair.target?.code || 'N/A';
      const sourceName = pair.source?.name || 'Unknown';
      const targetName = pair.target?.name || 'Unknown';
      
      return {
        id: pair.id,
        active: Boolean(pair.active),
        sourceCode,
        targetCode,
        sourceName,
        targetName,
        pairName: `${sourceCode}-${targetCode}`,
        pairDisplay: `${sourceName} (${sourceCode}) → ${targetName} (${targetCode})`,
        capabilities: {
          isBuyable: Boolean(pair.isBuyable),
          isSellable: Boolean(pair.isSellable),
          isLeverage: Boolean(pair.isLeverage)
        },
        specifications: {
          sourceDecimals: pair.source?.maximumDecimalPlaces || 0,
          targetDecimals: pair.target?.maximumDecimalPlaces || 0,
          sourceType: pair.source?.type || 'UNKNOWN',
          targetType: pair.target?.type || 'UNKNOWN'
        },
        limits: {
          sourceMinWithdrawal: pair.source?.minimumWithdrawal || 0,
          sourceMaxWithdrawal: pair.source?.maximumWithdrawal || 0,
          targetMinWithdrawal: pair.target?.minimumWithdrawal || 0,
          targetMaxWithdrawal: pair.target?.maximumWithdrawal || 0
        }
      };
    });
    
    console.log(`Formatted ${formattedPairs.length} trading pairs for UI`);
    
    return createResponse(
      true, 
      formattedPairs, 
      'Trading pairs formatted successfully for UI', 
      formattedPairs.length
    );
    
  } catch (error) {
    return handleServiceError('format trading pairs for UI', error);
  }
}

/**
 * Checks if a trading pair is available and provides detailed status
 * @param {string} sourceCurrency - Source currency code
 * @param {string} targetCurrency - Target currency code
 * @returns {Promise<object>} - Service response with availability details
 */
async function isPairAvailable(sourceCurrency, targetCurrency) {
  try {
    const pairName = `${sourceCurrency}-${targetCurrency}`;
    console.log(`Checking availability for trading pair: ${pairName}`);
    
    const result = await findPair(sourceCurrency, targetCurrency);
    
    if (!result.success) {
      return createResponse(
        true, 
        {
          available: false,
          active: false,
          tradeable: false,
          buyable: false,
          sellable: false,
          reason: result.message || 'Pair not found'
        }, 
        `Availability check completed for ${pairName}`
      );
    }
    
    const pair = result.data;
    const availability = {
      available: true,
      active: Boolean(pair.active),
      tradeable: Boolean(pair.active && (pair.isBuyable || pair.isSellable)),
      buyable: Boolean(pair.active && pair.isBuyable),
      sellable: Boolean(pair.active && pair.isSellable),
      leverage: Boolean(pair.isLeverage),
      pairInfo: {
        id: pair.id,
        sourceCode: pair.source?.code,
        targetCode: pair.target?.code,
        sourceName: pair.source?.name,
        targetName: pair.target?.name
      }
    };
    
    console.log(`Pair ${pairName} availability:`, {
      active: availability.active,
      tradeable: availability.tradeable,
      buyable: availability.buyable,
      sellable: availability.sellable
    });
    
    return createResponse(
      true, 
      availability, 
      `Availability checked successfully for ${pairName}`
    );
    
  } catch (error) {
    return handleServiceError(`check availability for pair ${sourceCurrency}-${targetCurrency}`, error);
  }
}

/**
 * Gets only buyable trading pairs
 * @returns {Promise<object>} - Service response with buyable pairs
 */
async function getBuyablePairs() {
  try {
    console.log('Fetching buyable trading pairs...');
    
    const result = await getActivePairs();
    
    if (!result.success) {
      return result;
    }
    
    const buyablePairs = result.data.filter(pair => pair.isBuyable === true);
    
    console.log(`Found ${buyablePairs.length} buyable pairs`);
    
    return createResponse(
      true, 
      buyablePairs, 
      'Buyable trading pairs retrieved successfully', 
      buyablePairs.length
    );
    
  } catch (error) {
    return handleServiceError('fetch buyable trading pairs', error);
  }
}

/**
 * Gets only sellable trading pairs
 * @returns {Promise<object>} - Service response with sellable pairs
 */
async function getSellablePairs() {
  try {
    console.log('Fetching sellable trading pairs...');
    
    const result = await getActivePairs();
    
    if (!result.success) {
      return result;
    }
    
    const sellablePairs = result.data.filter(pair => pair.isSellable === true);
    
    console.log(`Found ${sellablePairs.length} sellable pairs`);
    
    return createResponse(
      true, 
      sellablePairs, 
      'Sellable trading pairs retrieved successfully', 
      sellablePairs.length
    );
    
  } catch (error) {
    return handleServiceError('fetch sellable trading pairs', error);
  }
}

/**
 * Gets summary statistics for trading pairs
 * @returns {Promise<object>} - Service response with pair statistics
 */
async function getPairsStatistics() {
  try {
    console.log('Calculating trading pairs statistics...');
    
    const result = await getAllPairs();
    
    if (!result.success) {
      return result;
    }
    
    const pairs = result.data;
    const stats = {
      total: pairs.length,
      active: pairs.filter(p => p.active).length,
      inactive: pairs.filter(p => !p.active).length,
      buyable: pairs.filter(p => p.isBuyable).length,
      sellable: pairs.filter(p => p.isSellable).length,
      leverage: pairs.filter(p => p.isLeverage).length,
      currencyBreakdown: {
        crypto: pairs.filter(p => p.source?.type === 'CRYPTO' || p.target?.type === 'CRYPTO').length,
        stable: pairs.filter(p => p.source?.type === 'STABLE' || p.target?.type === 'STABLE').length,
        fiat: pairs.filter(p => p.source?.type === 'FIAT' || p.target?.type === 'FIAT').length
      }
    };
    
    console.log('Trading pairs statistics:', stats);
    
    return createResponse(
      true, 
      stats, 
      'Trading pairs statistics calculated successfully'
    );
    
  } catch (error) {
    return handleServiceError('calculate trading pairs statistics', error);
  }
}

module.exports = {
  getAllPairs,
  getActivePairs,
  getFormattedPairs,
  getPairsBySource,
  getPairsByTarget,
  findPair,
  getBuyablePairs,
  getSellablePairs,
  isPairAvailable,
  getPairsStatistics,
  isValidCurrencyCode,
  createResponse
};