// routes/deductBalance.js

const express = require('express');
const router = express.Router();
const User = require('../models/user');  // Adjust path if needed

// POST /deduct - Deduct from user's balance
router.post('/deduct', async (req, res) => {
  try {
    const { email, currency, amount } = req.body;

    if (!email || !currency || amount === undefined || amount === null) {
      return res.status(400).json({ error: 'Email, currency, and amount are required' });
    }

    const deductAmount = parseFloat(amount);
    if (isNaN(deductAmount) || deductAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }

    const normalizedCurrency = currency.trim().toUpperCase();

    // Find user by email
    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Map currency to balance field
    const currencyKey = normalizedCurrency.toLowerCase();

    let balanceField;

    if (currencyKey.startsWith('usdt')) {
      balanceField = 'usdtBalance';
    } else if (currencyKey.startsWith('usdc')) {
      balanceField = 'usdcBalance';
    } else if (currencyKey.startsWith('btc')) {
      balanceField = 'btcBalance';
    } else if (currencyKey.startsWith('sol')) {
      balanceField = 'solBalance';
    } else if (currencyKey.startsWith('eth')) {
      balanceField = 'ethBalance';
    } else if (currencyKey.startsWith('ngnz')) {
      balanceField = 'ngnzBalance';
    } else if (currencyKey.startsWith('bnb')) {
      balanceField = 'bnbBalance';
    } else if (currencyKey.startsWith('matic')) {
      balanceField = 'maticBalance';
    } else if (currencyKey.startsWith('trx')) {
      balanceField = 'trxBalance';
    } else {
      return res.status(400).json({ error: 'Unsupported currency for balance deduction' });
    }

    const currentBalance = user[balanceField] || 0;

    // Check if user has sufficient balance
    if (currentBalance < deductAmount) {
      return res.status(400).json({
        error: 'Insufficient balance',
        currentBalance: currentBalance,
        requestedDeduction: deductAmount
      });
    }

    // Deduct the amount
    user[balanceField] = currentBalance - deductAmount;

    await user.save();

    return res.status(200).json({
      success: true,
      message: `Successfully deducted ${deductAmount} ${normalizedCurrency} from user ${email}`,
      previousBalance: currentBalance,
      deductedAmount: deductAmount,
      newBalance: user[balanceField],
      currency: normalizedCurrency
    });
  } catch (error) {
    console.error('Error deducting balance:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
