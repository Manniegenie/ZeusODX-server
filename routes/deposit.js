const express = require('express');
const router = express.Router();
const User = require('../models/user');

const { fetchAvailableNetworks } = require('../services/getactiveaddress');

router.get('/:tokenSymbol', async (req, res) => {
  const { tokenSymbol } = req.params; // e.g. 'USDT'
  const { network } = req.query;      // e.g. 'BEP20'
  const userId = req.user.id;

  try {
    // 1. Fetch user
    const user = await User.findById(userId).select('wallets');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // 2. Fetch all active token networks from Obiex
    const availableNetworks = await fetchAvailableNetworks();

    if (!availableNetworks || !availableNetworks[tokenSymbol]) {
      return res.status(400).json({ message: 'This token is not supported for deposit' });
    }

    const validNetworks = availableNetworks[tokenSymbol];

    if (!validNetworks.includes(network)) {
      return res.status(400).json({ message: 'This network is not available for deposit' });
    }

    // 3. Get the wallet key in the format used in the DB (e.g. USDT_BEP20)
    const walletKey = network === tokenSymbol ? tokenSymbol : `${tokenSymbol}_${network}`;
    const wallet = user.wallets[walletKey];

    if (!wallet || !wallet.address) {
      return res.status(404).json({ message: `Wallet address for ${walletKey} not found` });
    }

    // 4. Return deposit address info
    return res.status(200).json({
      token: tokenSymbol,
      network: wallet.network,
      address: wallet.address
    });

  } catch (err) {
    console.error('Error fetching deposit address:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
