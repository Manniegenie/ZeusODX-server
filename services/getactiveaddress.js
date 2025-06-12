const axios = require('axios');
const config = require('../routes/config'); // Adjust path to your config.js file
const logger = require('../utils/logger'); // Adjust path if needed

const BASE_URL = config.obiex.baseURL;

/**
 * Fetches all active tokens and their networks from Obiex
 * @returns {object|null} An object with token keys and array of networks, or null on failure
 */
async function fetchAvailableNetworks() {
  try {
    const response = await axios.get(`${BASE_URL}/currencies/networks/active`);

    if (response.data?.message !== 'Ok') {
      logger.warn('Unexpected response from Obiex:', response.data);
      return null;
    }

    const rawData = response.data.data;
    const formatted = {};

    for (const token in rawData) {
      const networks = rawData[token].networks || [];
      formatted[token] = networks.map(net => net.networkCode);
    }

    logger.info('Fetched active token networks from Obiex');
    return formatted;

  } catch (error) {
    logger.error(`Error fetching available networks: ${error.message}`);
    return null;
  }
}

module.exports = {
  fetchAvailableNetworks
};
