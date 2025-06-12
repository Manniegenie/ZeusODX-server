// routes/userRoutes.js

const express = require('express');
const router = express.Router();
const User = require('../models/user');  // Adjust path if needed

// POST /wipe-pending-balance
router.post('/wipe', async (req, res) => {
  try {
    const { email, currency } = req.body;

    if (!email || !currency) {
      return res.status(400).json({ error: 'Email and currency are required' });
    }

    const normalizedCurrency = currency.trim().toUpperCase();

    // Find user by email
    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Map currency to pending balance field
    const currencyKey = normalizedCurrency.toLowerCase();

    let pendingBalanceField;

    if (currencyKey.startsWith('usdt')) {
      pendingBalanceField = 'usdtPendingBalance';
    } else if (currencyKey.startsWith('usdc')) {
      pendingBalanceField = 'usdcPendingBalance';
    } else if (currencyKey.startsWith('btc')) {
      pendingBalanceField = 'btcPendingBalance';
    } else if (currencyKey.startsWith('sol')) {
      pendingBalanceField = 'solPendingBalance';
    } else if (currencyKey.startsWith('eth')) {
      pendingBalanceField = 'ethPendingBalance';
    } else {
      return res.status(400).json({ error: 'Unsupported currency for pending balance reset' });
    }

    // Set the pending balance to zero
    user[pendingBalanceField] = 0;

    await user.save();

    return res.status(200).json({
      success: true,
      message: `Pending balance for ${normalizedCurrency} wiped for user ${email}`,
      [pendingBalanceField]: user[pendingBalanceField],
    });
  } catch (error) {
    console.error('Error wiping pending balance:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
