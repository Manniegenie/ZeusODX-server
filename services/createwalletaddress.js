require('dotenv').config();
const axios = require('axios');
const config = require('../routes/config');
const { validateObiexConfig, attachObiexAuth } = require('../utils/obiexAuth');
const logger = require('../utils/logger');

class ObiexService {
  constructor() {
    validateObiexConfig();

    this.axiosClient = axios.create({
      baseURL: config.obiex.baseURL, // e.g., https://staging.api.obiex.finance
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': config.obiex.baseURL,
        'Referer': config.obiex.baseURL + '/',
      },
      timeout: 30000, // Increased timeout for Cloudflare challenges
    });

    // 🔐 Attach request interceptor to sign every request
    this.axiosClient.interceptors.request.use(
      attachObiexAuth,
      (error) => Promise.reject(error)
    );
  }

  async createDepositAddress(payload) {
    const path = '/addresses/broker';

    try {
      logger.info('Creating deposit address:', payload);

      const response = await this.axiosClient.post(path, payload);

      const address = response.data?.data?.value;

      logger.info('Deposit address created successfully:', {
        currency: payload.currency,
        network: payload.network,
        address,
      });

      return response.data?.data || response.data;
    } catch (error) {
      const status = error.response?.status;
      const headers = error.response?.headers;
      const rawData = error.response?.data;
      const message = (typeof rawData === 'string') ? rawData : JSON.stringify(rawData, null, 2);

      logger.error('❌ Obiex API request failed', {
        status,
        headers,
        payload,
        body: message
      });

      throw error;
    }
  }

  async getBrokerAddresses(queryParams = {}) {
    const path = '/addresses/me/broker';

    try {
      const response = await this.axiosClient.get(path, {
        params: queryParams,
      });

      return response.data;
    } catch (error) {
      logger.error('Failed to get broker addresses:', {
        queryParams,
        error: error.response?.data || error.message,
        status: error.response?.status,
      });
      throw error;
    }
  }
}

module.exports = new ObiexService();
