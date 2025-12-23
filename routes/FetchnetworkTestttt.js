const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const router = express.Router();

const { validateObiexConfig, attachObiexAuth } = require('../utils/obiexAuth');
const logger = require('../utils/logger');
const config = require('./config');

// Configure Obiex axios instance
const obiexAxios = axios.create({
  baseURL: config.obiex.baseURL.replace(/\/+$/, ''),
  timeout: 30000,
});

// Attach Obiex auth headers
obiexAxios.interceptors.request.use(attachObiexAuth);

/**
 * Fetch currency + network data from Obiex API
 */
async function fetchObiexCurrencyNetworks() {
  try {
    validateObiexConfig();

    logger.info('Fetching currency-network data from Obiex API');

    // ✅ CORRECT ENDPOINT
    const response = await obiexAxios.get('/currencies');

    return {
      success: true,
      data: response.data,
    };
  } catch (error) {
    logger.error('Failed to fetch from Obiex API', {
      error: error.response?.data || error.message,
      status: error.response?.status,
    });

    return {
      success: false,
      message: error.response?.data?.message || error.message,
    };
  }
}

/**
 * Save data to JSON file
 */
async function saveToJsonFile(data, filename = 'obiex_currency_networks.json') {
  try {
    const filePath = path.join(__dirname, '..', filename);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));

    logger.info('Data saved to JSON file', { filePath });

    return {
      success: true,
      filePath,
    };
  } catch (error) {
    logger.error('Failed to save JSON file', { error: error.message });

    return {
      success: false,
      message: error.message,
    };
  }
}

/**
 * GET /fetchnetworktest/fetch-obiex-networks
 * Fetches currency-network data from Obiex and saves to JSON
 */
router.get('/fetch-obiex-networks', async (req, res) => {
  try {
    // Fetch from Obiex
    const obiexResult = await fetchObiexCurrencyNetworks();

    if (!obiexResult.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch from Obiex API',
        error: obiexResult.message,
      });
    }

    // Save to JSON file
    const saveResult = await saveToJsonFile(obiexResult.data);

    if (!saveResult.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to save data to file',
        error: saveResult.message,
        data: obiexResult.data,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Currency-network data fetched and saved successfully',
      filePath: saveResult.filePath,
      data: obiexResult.data,
    });
  } catch (error) {
    logger.error('Error in fetch-obiex-networks route', {
      error: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

module.exports = router;
