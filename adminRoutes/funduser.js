// routes/fundUser.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/user');

const currencyFieldMap = {
  BTC: 'btcBalance',
  ETH: 'ethBalance',
  SOL: 'solBalance',
  USDT: 'usdtBalance',
  USDC: 'usdcBalance',
  NGNB: 'ngnzBalance',   // note: your model has ngnzBalance
  TRX: 'trxBalance'
};

// Middleware: verify token and ensure admin privileges
function verifyAdmin(req, res, next) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Missing Authorization header' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ success: false, message: 'Server misconfiguration: missing JWT secret' });

    const decoded = jwt.verify(token, secret);

    // allow if role is admin OR permissions indicate admin capability
    const isAdmin = decoded && (decoded.role === 'admin' || (decoded.permissions && decoded.permissions.canManageAdmins));
    if (!isAdmin) {
      return res.status(403).json({ success: false, message: 'Forbidden: admin privileges required' });
    }

    // attach decoded to request for auditing if needed
    req.userToken = decoded;
    next();
  } catch (err) {
    console.error('JWT verify error:', err);
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

/**
 * POST /fund-user
 * Body: { email: string, amount: number, currency: string }
 * Requires: Authorization: Bearer <admin-token>
 */
router.post('/fund-user', verifyAdmin, async (req, res) => {
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
