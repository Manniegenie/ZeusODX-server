const express = require('express');
const router = express.Router();
const User = require('../models/user');

router.post('/wallets/fetch', async (req, res) => {
  try {
    const { email, tokens } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const allWallets = user.wallets || {};
    let filteredWallets = allWallets;

    if (Array.isArray(tokens) && tokens.length > 0) {
      filteredWallets = {};
      for (const token of tokens) {
        if (allWallets[token]) {
          filteredWallets[token] = allWallets[token];
        }
      }
    }

    // Include wallet balances from the schema
    const walletBalances = {
      solBalance: user.solBalance,
      solBalanceUSD: user.solBalanceUSD,
      solPendingBalance: user.solPendingBalance,
      btcBalance: user.btcBalance,
      btcBalanceUSD: user.btcBalanceUSD,
      btcPendingBalance: user.btcPendingBalance,
      usdtBalance: user.usdtBalance,
      usdtBalanceUSD: user.usdtBalanceUSD,
      usdtPendingBalance: user.usdtPendingBalance,
      usdcBalance: user.usdcBalance,
      usdcBalanceUSD: user.usdcBalanceUSD,
      usdcPendingBalance: user.usdcPendingBalance,
      ethBalance: user.ethBalance,
      ethBalanceUSD: user.ethBalanceUSD,
      ethPendingBalance: user.ethPendingBalance,
      totalPortfolioBalance: user.totalPortfolioBalance,
    };

    return res.json({
      email: user.email,
      wallets: filteredWallets,
      balances: walletBalances,
    });

  } catch (err) {
    console.error('Error fetching wallets:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;