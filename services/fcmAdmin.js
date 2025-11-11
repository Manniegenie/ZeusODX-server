const admin = require('firebase-admin');
const logger = require('../utils/logger');

let initialized = false;

function initFirebase() {
  if (initialized) return admin;
  try {
    // Option 1: Use base64-encoded service account JSON from env
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64?.trim();
    if (b64) {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      const json = JSON.parse(decoded);
      admin.initializeApp({
        credential: admin.credential.cert(json),
      });
      initialized = true;
      logger.info('Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT_B64');
      return admin;
    }

    const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (rawJson) {
      const json = JSON.parse(rawJson);
      admin.initializeApp({
        credential: admin.credential.cert(json),
      });
      initialized = true;
      logger.info('Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT_JSON');
      return admin;
    }

    // Option 2: Use GOOGLE_APPLICATION_CREDENTIALS path
    if (!admin.apps.length) {
      admin.initializeApp();
    }
    initialized = true;
    logger.info('Firebase Admin initialized using GOOGLE_APPLICATION_CREDENTIALS');
    return admin;
  } catch (err) {
    logger.error('Failed to initialize Firebase Admin', { error: err.message });
    throw err;
  }
}

module.exports = { initFirebase };






