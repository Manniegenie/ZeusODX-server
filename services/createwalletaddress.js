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
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
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
      logger.error('Failed to create deposit address:', {
        payload,
        error: error.response?.data || error.message,
        status: error.response?.status,
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
