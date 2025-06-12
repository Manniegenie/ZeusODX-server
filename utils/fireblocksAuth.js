const fs = require('fs');
const { FireblocksSDK } = require('fireblocks-sdk');
const logger = require('./logger');
require('dotenv').config({ path: '/Users/mac/Projects/Bramp-Server/.env' });

const apiKey = process.env.FIREBLOCKS_API_KEY;
const privateKeyPath = process.env.FIREBLOCKS_KEY_PATH;

logger.info('Initializing Fireblocks SDK', {
  apiKey: apiKey ? 'Present' : 'Missing',
  privateKeyPath: privateKeyPath || 'Missing',
  apiKeyPrefix: apiKey ? apiKey.slice(0, 8) : 'N/A',
  vaultAccountId: process.env.VAULT_ACCOUNT_ID || 'Missing', // Log to confirm
});

if (!apiKey) {
  throw new Error('Missing FIREBLOCKS_API_KEY in .env');
}

if (!privateKeyPath || !fs.existsSync(privateKeyPath)) {
  throw new Error(`Private key file does not exist at ${privateKeyPath}`);
}

const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
logger.info('Private key loaded successfully', { privateKeyLength: privateKey.length });

const fireblocks = new FireblocksSDK(
  privateKey,
  apiKey,
  'https://sandbox-api.fireblocks.io' // Sandbox API
);

logger.info('Fireblocks SDK initialized for Sandbox');
module.exports = fireblocks;