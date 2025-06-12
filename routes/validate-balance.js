const express = require('express');
const router = express.Router();
const { validateUserBalance } = require('../services/balance');

// POST /api/wallets/validate-balance
router.post('/validate-balance', async (req, res) => {
  try {
    const userId = req.user.id;
    const { currency, amount } = req.body;

    if (!currency || !amount) {
      return res.status(400).json({ success: false, message: 'currency and amount are required' });
    }

    const validation = await validateUserBalance(userId, currency, parseFloat(amount));
    if (!validation.success) {
      return res.status(400).json({ success: false, message: validation.message });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Balance validation error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
