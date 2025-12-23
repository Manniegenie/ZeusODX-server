const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const router = express.Router();

const { validateObiexConfig, attachObiexAuth } = require('../utils/obiexAuth');
const logger = require('../utils/logger');
const config = require('./config');

/**
 * Axios instance
 */
const obiexAxios = axios.create({
  baseURL: config.obiex.baseURL.replace(/\/+$/, ''),
  timeout: 30000
});

obiexAxios.interceptors.request.use(attachObiexAuth);

/**
 * Fetch ALL currencies
 */
async function fetchCurrencies() {
  const res = await obiexAxios.get('/currencies');
  return res.data?.data || [];
}

/**
 * Fetch wallets (networks) for ONE currency
 */
async function fetchNetworksForCurrency(currencyCode) {
  try {
    const res = await obiexAxios.get(`/wallets/${currencyCode}`);

    return {
      success: true,
      networks: res.data?.data || []
    };
  } catch (err) {
    logger.warn(`Failed fetching networks for ${currencyCode}`, {
      error: err.response?.data || err.message
    });

    return {
      success: false,
      networks: []
    };
  }
}

/**
 * Fetch currency → networks map
 */
async function fetchCurrencyNetworkMap() {
  validateObiexConfig();

  logger.info('Fetching currencies from Obiex');
  const currencies = await fetchCurrencies();

  const result = {};

  for (const currency of currencies) {
    const code = currency.code;

    logger.info(`Fetching networks for ${code}`);

    const networkResult = await fetchNetworksForCurrency(code);

    result[code] = {
      currency: currency,
      networks: networkResult.networks
    };
  }

  return result;
}

/**
 * Save JSON file
 */
async function saveJson(data, filename) {
  const filePath = path.join(__dirname, '..', filename);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

/**
 * GET /fetchnetworktest/fetch-obiex-networks
 */
router.get('/fetch-obiex-networks', async (req, res) => {
  try {
    const data = await fetchCurrencyNetworkMap();
    const filePath = await saveJson(data, 'obiex_currency_networks.json');

    return res.json({
      success: true,
      message: 'Currencies and networks fetched successfully',
      filePath,
      totalCurrencies: Object.keys(data).length
    });

  } catch (err) {
    logger.error('Failed fetching Obiex networks', {
      error: err.message,
      stack: err.stack
    });

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch currency networks',
      error: err.message
    });
  }
});

module.exports = router;
