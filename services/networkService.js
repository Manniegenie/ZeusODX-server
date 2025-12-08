const axios = require('axios');
const config = require('../routes/config');
const { attachObiexAuth } = require('../utils/obiexAuth');

const obiexAxios = axios.create({
  baseURL: config.obiex.baseURL.replace(/\/+$/, ''),
});
obiexAxios.interceptors.request.use(attachObiexAuth);

/**
 * Get available networks for a currency
 * MAINNET ONLY - All testnet/devnet networks are filtered out
 * @param {string} currency - Currency symbol (e.g., 'ETH', 'BTC', 'SOL')
 * @returns {Promise<string[]>} Array of mainnet network names
 */
async function getAvailableNetworks(currency) {
  const response = await obiexAxios.get(`/currencies/${currency.toUpperCase()}/networks`);
  
  // Filter out testnet/devnet networks - MAINNET ONLY
  // This ensures users can only select mainnet networks, no testnet or devnet options
  const mainnetOnly = response.data
    .map(n => n.network)
    .filter(network => {
      const networkLower = network.toLowerCase();
      // Exclude testnet, devnet, test, goerli, sepolia, etc.
      return !networkLower.includes('test') && 
             !networkLower.includes('dev') && 
             !networkLower.includes('goerli') && 
             !networkLower.includes('sepolia') &&
             !networkLower.includes('ropsten') &&
             !networkLower.includes('rinkeby') &&
             !networkLower.includes('kovan') &&
             !networkLower.includes('mumbai') &&
             !networkLower.includes('amoy');
    });
  
  return mainnetOnly;
}

module.exports = { getAvailableNetworks };
