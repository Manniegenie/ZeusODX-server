const fireblocks = require('../utils/fireblocksAuth');
const { VAULT_ACCOUNT_ID } = require('../routes/config');
const logger = require('../utils/logger');

class FireblocksService {
  constructor() {
    this.vaultId = Number(VAULT_ACCOUNT_ID);
    logger.info('FireblocksService initialized', { vaultId: this.vaultId });
  }

  async generateAddress(assetId) {
    try {
      logger.info(`Requesting Fireblocks address for asset: ${assetId}`, { vaultId: this.vaultId });
      const response = await fireblocks.generateNewAddress(this.vaultId, assetId);
      logger.info(`Fireblocks response for ${assetId}`, { response });
      return {
        success: true,
        address: response?.address || null,
        raw: response,
      };
    } catch (error) {
      logger.error(`Fireblocks address generation failed for ${assetId}`, {
        error: error.response?.data || error.message,
        status: error.response?.status,
        vaultId: this.vaultId,
        stack: error.stack,
      });
      throw error;
    }
  }
}

module.exports = new FireblocksService();