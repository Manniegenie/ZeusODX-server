const express = require('express');
const router = express.Router();
const User = require('../models/user');
const generateWallets = require('../utils/generatewallets');

router.patch('/regenerate', async (req, res) => {
  try {
    const { email, tokens } = req.body;

    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const result = await generateWallets(email, user._id);

    if (!result.success) {
      return res.status(500).json({
        error: 'Wallet regeneration failed.',
        result,
      });
    }

    const updatedWallets = {};
    for (const key of Object.keys(result.wallets)) {
      const wallet = result.wallets[key];
      if (wallet.status === 'success') {
        const { currency, network, address } = wallet;

        if (currency === 'BTC') updatedWallets.BTC = { address, network };
        else if (currency === 'ETH' && network === 'ETH') updatedWallets.ETH = { address, network };
        else if (currency === 'SOL') updatedWallets.SOL = { address, network };
        else if (currency === 'USDT') {
          if (network === 'TRX') updatedWallets.USDT_TRX = { address, network };
          else if (network === 'ETH') updatedWallets.USDT_ETH = { address, network };
          else if (network === 'BSC') updatedWallets.USDT_BSC = { address, network }; // ✅ changed from USDT_BEP20
        } else if (currency === 'USDC') {
          if (network === 'ETH') updatedWallets.USDC_ETH = { address, network };
          else if (network === 'BSC') updatedWallets.USDC_BSC = { address, network };
        }
      }
    }

    // If `tokens` are specified, only update those
    if (Array.isArray(tokens) && tokens.length > 0) {
      for (const key of Object.keys(user.wallets.toObject())) {
        if (!tokens.includes(key)) delete updatedWallets[key];
      }
    }

    user.wallets = {
      ...user.wallets.toObject(),
      ...updatedWallets,
    };

    await user.save();

    return res.json({
      message: 'Wallet(s) regenerated successfully.',
      updatedWallets,
      summary: result.summary,
    });
  } catch (err) {
    console.error('Wallet regeneration error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
