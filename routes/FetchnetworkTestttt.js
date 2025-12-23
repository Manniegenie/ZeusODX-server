const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const router = express.Router();

const { validateObiexConfig, attachObiexAuth } = require('../utils/obiexAuth');
const logger = require('../utils/logger');
const config = require('./config');

/**
 * Axios instance configured for Obiex
 */
const obiexAxios = axios.create({
  baseURL: config.obiex.baseURL.replace(/\/+$/, ''),
  timeout: 30000
});

obiexAxios.interceptors.request.use(attachObiexAuth);

/**
 * 1. Fetch ALL base currencies to get their IDs
 */
async function fetchCurrencies() {
  const res = await obiexAxios.get('/currencies');
  return res.data?.data || [];
}

/**
 * 2. Fetch ACTUAL blockchain networks for a specific currency ID
 * Endpoint: /currencies/:id/networks
 */
async function fetchNetworksForCurrencyId(currencyId, code) {
  try {
    const res = await obiexAxios.get(`/currencies/${currencyId}/networks`);

    return {
      success: true,
      networks: res.data?.data || []
    };
  } catch (err) {
    logger.warn(`Failed fetching networks for ${code} (ID: ${currencyId})`, {
      error: err.response?.data || err.message
    });

    return {
      success: false,
      networks: []
    };
  }
}

/**
 * 3. Core Logic: Maps currencies to their technical networks
 */
async function fetchCurrencyNetworkMap() {
  validateObiexConfig();

  logger.info('Initializing Obiex Currency & Network sync...');
  const currencies = await fetchCurrencies();

  // The specific coins we want to deep-crawl for network metadata
  const targetCodes = ['BTC', 'ETH', 'USDT', 'SOL', 'TRX', 'BNB', 'POL'];
  const result = {};

  for (const currency of currencies) {
    const code = currency.code;

    // Check if this coin is in our target list
    if (targetCodes.includes(code)) {
      logger.info(`Syncing technical networks for ${code}...`);
      
      const networkResult = await fetchNetworksForCurrencyId(currency.id, code);

      result[code] = {
        currency: currency,
        // This now contains actual network info (e.g. Tron, Ethereum, BSC)
        networks: networkResult.networks 
      };
    } else {
      // For non-target coins, we save the currency info but leave networks empty
      result[code] = {
        currency: currency,
        networks: []
      };
    }
  }

  return result;
}

/**
 * Helper to save the generated map to a JSON file
 */
async function saveJson(data, filename) {
  const filePath = path.join(__dirname, '..', filename);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

/**
 * ROUTE: GET /fetchnetworktest/fetch-obiex-networks
 * Triggers the full sync and saves to obiex_currency_networks.json
 */
router.get('/fetch-obiex-networks', async (req, res) => {
  try {
    const data = await fetchCurrencyNetworkMap();
    const filePath = await saveJson(data, 'obiex_currency_networks.json');

    return res.json({
      success: true,
      message: 'Network metadata synced successfully for target coins',
      stats: {
        totalCurrencies: Object.keys(data).length,
        targetsSynced: ['BTC', 'ETH', 'USDT', 'SOL', 'TRX', 'BNB', 'POL'],
        filePath
      }
    });

  } catch (err) {
    logger.error('Critical failure in fetch-obiex-networks route', {
      error: err.message,
      stack: err.stack
    });

    return res.status(500).json({
      success: false,
      message: 'Failed to sync currency networks',
      error: err.message
    });
  }
});

module.exports = router;