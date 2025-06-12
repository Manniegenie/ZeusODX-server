// routes/wallets.js
const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');
const tokenMap = require('../utils/tokenmap');

router.get('/wallets/:token', async (req, res) => {
  const userId = req.user.id; // from JWT middleware
  const tokenSlug = req.params.token.toLowerCase();
  const walletKey = tokenMap[tokenSlug];

  if (!walletKey) {
    logger.warn('Invalid token requested', { tokenSlug });
    return res.status(400).json({ message: 'Invalid token type' });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found when fetching wallet', { userId });
      return res.status(404).json({ message: 'User not found' });
    }

    const wallet = user.wallets[walletKey];
    if (!wallet || !wallet.address || !wallet.network) {
      logger.info('No wallet configured for token', { token: walletKey });
      return res.status(404).json({ message: `${walletKey} wallet not found` });
    }

    logger.info('Fetched wallet successfully', { userId, token: walletKey });
    res.status(200).json({
      token: walletKey,
      address: wallet.address,
      network: wallet.network
    });
  } catch (error) {
    logger.error('Error fetching wallet', { error: error.message });
    res.status(500).json({ message: 'Failed to fetch wallet info' });
  }
});

module.exports = router;
