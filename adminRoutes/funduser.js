const express = require('express');
const router = express.Router();
const User = require('../models/user');

// Map of accepted currency keys and their balance fields
const currencyFieldMap = {
  BTC: 'btcBalance',
  ETH: 'ethBalance',
  SOL: 'solBalance',
  USDT: 'usdtBalance',
  USDC: 'usdcBalance',
  NGNB: 'ngnbBalance'
};

router.post('/fund-user', async (req, res) => {
  try {
    const { email, amount, currency } = req.body;

    if (!email || !amount || !currency) {
      return res.status(400).json({ success: false, message: 'Email, amount, and currency are required.' });
    }

    if (!currencyFieldMap[currency]) {
      return res.status(400).json({ success: false, message: `Unsupported currency: ${currency}` });
    }

    const fieldToUpdate = currencyFieldMap[currency];
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    user[fieldToUpdate] += amount;
    user.totalPortfolioBalance += amount; // Adjust based on your portfolio logic

    await user.save();

    return res.status(200).json({
      success: true,
      message: `Funded ${amount} ${currency} to ${email}`,
      newBalance: user[fieldToUpdate],
      totalPortfolioBalance: user.totalPortfolioBalance
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
