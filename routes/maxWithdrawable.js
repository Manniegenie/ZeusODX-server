const express = require('express');
const router = express.Router();
const User = require('../models/user');

/**
 * Supported withdrawal tokens and their User model balance field names.
 * Used for both NGNZ withdrawal (to bank) and external crypto withdrawal.
 */
const CURRENCY_TO_BALANCE_FIELD = {
  NGNZ: 'ngnzBalance',
  BTC: 'btcBalance',
  ETH: 'ethBalance',
  SOL: 'solBalance',
  USDT: 'usdtBalance',
  USDC: 'usdcBalance',
  BNB: 'bnbBalance',
  MATIC: 'maticBalance',
  TRX: 'trxBalance',
};

/**
 * GET /max-amount?currency=NGNZ
 * Returns the max withdrawable amount for the given token (source of truth from DB).
 * Used by frontend for NGNZ withdrawal and external crypto withdrawal "Max" button.
 *
 * Query: currency (required) - e.g. NGNZ, BTC, USDT
 * Response: { success: true, data: { currency, maxAmount } }
 *           maxAmount is a number (raw balance; no fee deduction).
 */
router.get('/max-amount', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const rawCurrency = req.query.currency;
    if (!rawCurrency || typeof rawCurrency !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid query parameter: currency',
      });
    }

    const currency = String(rawCurrency).trim().toUpperCase();
    const balanceField = CURRENCY_TO_BALANCE_FIELD[currency];
    if (!balanceField) {
      return res.status(400).json({
        success: false,
        error: `Unsupported currency: ${currency}`,
      });
    }

    const user = await User.findById(userId).select(balanceField).lean();
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const maxAmount = Number(user[balanceField]) || 0;

    res.json({
      success: true,
      data: {
        currency,
        maxAmount,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get max withdrawable amount',
    });
  }
});

module.exports = router;
