const obiexService = require('../services/createwalletaddress');
const logger = require('../utils/logger');
const { validateObiexConfig } = require('../utils/obiexAuth');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000; // 3 second

// Retry wrapper with exponential backoff and jitter
const retryWithBackoff = async (fn, retries = MAX_RETRIES, delay = RETRY_DELAY_MS) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = error.response?.status;
      const isRetryable = !status || [429, 500, 502, 503, 504].includes(status);
      const isLastAttempt = attempt === retries;

      if (!isRetryable || isLastAttempt) throw error;

      logger.warn(`Retry attempt ${attempt} failed: ${error.message}. Retrying...`);

      const backoff = delay * 2 ** (attempt - 1) + Math.random() * 500;
      await new Promise(res => setTimeout(res, backoff));
    }
  }
};

// Function to generate a single wallet for a specific currency/network
const generateSingleWallet = async (email, userId, currency, network) => {
  validateObiexConfig();
  logger.info(`Starting single wallet generation for ${email}`, { 
    userId, 
    currency, 
    network 
  });

  // Ensure purpose is alphanumeric and uses only hyphens
  const cleanedPurpose = String(userId).replace(/[^a-zA-Z0-9-]/g, '-');
  
  const payload = {
    purpose: cleanedPurpose,
    currency,
    network,
  };

  const key = `${currency}_${network}`;

  try {
    logger.info(`Creating single wallet: ${key}`, { currency, network, userId });
    const response = await retryWithBackoff(() => obiexService.createDepositAddress(payload));
    
    // Extract all possible response fields
    const address = response?.value || response?.data?.value || null;
    const addressId = response?.id || response?.data?.id || null;
    const referenceId = response?.reference || response?.data?.reference || null;

    if (!address) {
      throw new Error(`No address returned for ${currency}/${network}`);
    }

    const walletData = {
      address,
      addressId,
      referenceId, // This will be saved as walletReferenceId in the user model
      network,
      currency,
      status: 'success',
    };

    logger.info(`Single wallet created successfully: ${key}`, { 
      address: address || 'Not returned', 
      addressId, 
      referenceId,
      userId,
      email 
    });

    return {
      success: true,
      wallet: walletData,
      key: key
    };

  } catch (err) {
    const errorData = err.response?.data || {};
    logger.error('Single wallet creation failed', {
      key,
      email,
      userId,
      network,
      currency,
      error: errorData,
      message: errorData?.message || err.message,
      status: err.response?.status,
    });

    throw new Error(`Failed to generate wallet for ${currency}/${network}: ${errorData?.message || err.message}`);
  }
};

// Mapping for currency/network to schema keys (updated with TRX_TRX)
const CURRENCY_NETWORK_TO_SCHEMA = {
  // Bitcoin variants
  'BTC_BTC': 'BTC_BTC',           // Bitcoin mainnet
  'BTC_BSC': 'BTC_BSC',           // Bitcoin on BSC (BEP20)
  
  // Ethereum variants
  'ETH_ETH': 'ETH_ETH',           // Ethereum mainnet
  'ETH_ARBITRUM': 'ETH_ARBITRUM', // Ethereum on Arbitrum One
  'ETH_BASE': 'ETH_BASE',         // Ethereum on Base
  'ETH_BSC': 'ETH_BSC',           // Ethereum on BSC (BEP20)
  
  // Solana
  'SOL_SOL': 'SOL_SOL',
  
  // USDT variants
  'USDT_ETH': 'USDT_ETH',
  'USDT_TRX': 'USDT_TRX',
  'USDT_BSC': 'USDT_BSC',
  'USDT_ARBITRUM': 'USDT_ARBITRUM', // USDT on Arbitrum
  'USDT_BASE': 'USDT_BASE',         // USDT on Base
  
  // USDC variants
  'USDC_ETH': 'USDC_ETH',           // USDC on Ethereum
  'USDC_TRX': 'USDC_TRX',           // USDC on Tron (TRC20)
  'USDC_BSC': 'USDC_BSC',           // USDC on BSC
  'USDC_ARBITRUM': 'USDC_ARBITRUM', // USDC on Arbitrum
  'USDC_BASE': 'USDC_BASE',         // USDC on Base
  'USDC_POLYGON': 'USDC_POLYGON',   // USDC on Polygon (MATIC)
  'USDC_SOL': 'USDC_SOL',           // USDC on Solana
  
  // BNB variants
  'BNB_ETH': 'BNB_ETH',
  'BNB_BSC': 'BNB_BSC',
  
  // Polygon (MATIC)
  'POL_ETH': 'POL_ETH',
  'POL_ARBITRUM': 'POL_ARBITRUM',
  'POL_BSC': 'POL_BSC',
  
  // Tron
  'TRX_TRX': 'TRX_TRX',             // TRX on Tron network
};

// Function to get the correct currency/network for obiex from schema key
const getCurrencyNetworkFromSchema = (schemaKey) => {
  // Find the entry where the value matches the schemaKey
  const entry = Object.entries(CURRENCY_NETWORK_TO_SCHEMA).find(([key, value]) => value === schemaKey);
  
  if (!entry) {
    throw new Error(`No currency/network mapping found for schema key: ${schemaKey}`);
  }
  
  const [currencyNetwork] = entry;
  const [currency, network] = currencyNetwork.split('_');
  
  return { currency, network };
};

// Helper function to get schema key from network ID (for frontend integration)
const getSchemaKeyFromNetworkId = (currency, networkId) => {
  const networkMap = {
    'ethereum': 'ETH',
    'arbitrum': 'ARBITRUM', 
    'base': 'BASE',
    'bsc': 'BSC',
    'polygon': 'POLYGON',
    'solana': 'SOL',
    'tron': 'TRX',      // Tron network
    'trx': 'TRX'        // Alternative mapping for Tron
  };
  
  const network = networkMap[networkId.toLowerCase()] || networkId.toUpperCase();
  const schemaKey = `${currency.toUpperCase()}_${network}`;
  
  if (!CURRENCY_NETWORK_TO_SCHEMA[schemaKey]) {
    throw new Error(`Unsupported network: ${networkId} for currency: ${currency}`);
  }
  
  return CURRENCY_NETWORK_TO_SCHEMA[schemaKey];
};

// Function to get available networks for a currency
const getAvailableNetworks = (currency) => {
  const currencyUpper = currency.toUpperCase();
  const availableNetworks = [];
  
  Object.keys(CURRENCY_NETWORK_TO_SCHEMA).forEach(key => {
    const [curr, network] = key.split('_');
    if (curr === currencyUpper) {
      availableNetworks.push({
        currency: curr,
        network: network,
        schemaKey: CURRENCY_NETWORK_TO_SCHEMA[key]
      });
    }
  });
  
  return availableNetworks;
};

// Main function to generate wallet by schema key (for use in deposit route)
const generateWalletBySchemaKey = async (email, userId, schemaKey) => {
  try {
    const { currency, network } = getCurrencyNetworkFromSchema(schemaKey);
    const result = await generateSingleWallet(email, userId, currency, network);
    
    // Return in format expected by the deposit route
    return {
      address: result.wallet.address,
      network: result.wallet.network,
      walletReferenceId: result.wallet.referenceId || null,
    };
    
  } catch (error) {
    logger.error('Error generating wallet by schema key', {
      schemaKey,
      email,
      userId,
      error: error.message
    });
    throw error;
  }
};

// Function to generate wallet by network ID (for frontend routes like /deposits/eth-arbitrum)
const generateWalletByNetworkId = async (email, userId, currency, networkId) => {
  try {
    const schemaKey = getSchemaKeyFromNetworkId(currency, networkId);
    return await generateWalletBySchemaKey(email, userId, schemaKey);
  } catch (error) {
    logger.error('Error generating wallet by network ID', {
      currency,
      networkId,
      email,
      userId,
      error: error.message
    });
    throw error;
  }
};

module.exports = {
  generateSingleWallet,
  generateWalletBySchemaKey,
  generateWalletByNetworkId,
  getCurrencyNetworkFromSchema,
  getSchemaKeyFromNetworkId,
  getAvailableNetworks,
  CURRENCY_NETWORK_TO_SCHEMA
};