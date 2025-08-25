const express = require('express');
const router = express.Router();
const axios = require('axios');
const { attachObiexAuth } = require('../utils/obiexAuth'); // Adjust path as needed
const logger = require('../utils/logger');

router.get('/naira-accounts', async (req, res) => {
  logger.info('Get Naira Accounts - Request received');

  try {
    // Base configuration for Obiex API call
    let config = {
      method: 'get',
      maxBodyLength: Infinity,
      url: '/ngn-payments/banks',
      headers: {}
    };

    // Attach authentication headers using your auth service
    config = attachObiexAuth(config);
    
    // Add base URL (make sure this matches your environment variable)
    const baseURL = process.env.OBIEX_BASE_URL || 'https://api.obiex.finance';
    config.url = `${baseURL}${config.url}`;

    logger.info('Making request to Obiex API:', { url: config.url });

    // Make the API call
    const response = await axios(config);

    logger.info('Obiex API response received:', {
      status: response.status,
      dataLength: response.data?.data?.length || 0
    });

    // Validate response structure
    if (!response.data || !response.data.data) {
      logger.warn('Invalid response structure from Obiex API:', response.data);
      return res.status(502).json({ 
        error: 'Invalid response from payment provider'
      });
    }

    // Return successful response
    return res.status(200).json({
      success: true,
      data: response.data
    });

  } catch (error) {
    logger.error('Get Naira Accounts - Error occurred:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });

    return res.status(500).json({ 
      error: 'Internal server error' 
    });
  }
});

module.exports = router;