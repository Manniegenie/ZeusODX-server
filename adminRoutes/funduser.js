// routes/fundUser.js
const express = require('express');
const router = express.Router();
const User = require('../models/user');

const currencyFieldMap = {
  BTC: 'btcBalance',
  ETH: 'ethBalance',
  SOL: 'solBalance',
  USDT: 'usdtBalance',
  USDC: 'usdcBalance',
  NGNB: 'ngnzBalance',
  TRX: 'trxBalance'
};

/**
 * POST /fund-user
 * Body: { email: string, amount: number, currency: string }
 * Note: Already protected by authenticateAdminToken and requireSuperAdmin in server.js
 */
router.post('/fund-user', async (req, res) => {
  try {
    const { email, amount, currency } = req.body;

    if (!email || amount == null || !currency) {
      return res.status(400).json({ success: false, message: 'Email, amount, and currency are required.' });
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be a positive number.' });
    }

    const fieldToUpdate = currencyFieldMap[currency];
    if (!fieldToUpdate) {
      return res.status(400).json({ success: false, message: `Unsupported currency: ${currency}` });
    }

    // Build update object with $inc for atomic increment
    const update = { $inc: {} };
    update.$inc[fieldToUpdate] = numericAmount;

    // Optionally update totalPortfolioBalance as well (remove if you don't keep this field)
    update.$inc.totalPortfolioBalance = numericAmount;

    // Find user and increment balance atomically
    const updatedUser = await User.findOneAndUpdate(
      { email },
      update,
      { new: true, runValidators: true }
    ).select('+email +trxBalance +btcBalance +ethBalance +solBalance +usdtBalance +usdcBalance +ngnzBalance +totalPortfolioBalance');

    if (!updatedUser) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Prepare the response value for the specific currency field
    const newBalance = updatedUser[fieldToUpdate] ?? 0;

    return res.status(200).json({
      success: true,
      message: `Funded ${numericAmount} ${currency} to ${email}`,
      email: updatedUser.email,
      currency,
      amount: numericAmount,
      newBalance,
      totalPortfolioBalance: updatedUser.totalPortfolioBalance ?? null
    });
  } catch (err) {
    console.error('Error in /fund-user:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;