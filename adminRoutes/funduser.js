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




router.post('/deduct-user', async (req, res) => {
  try {
    const { email, amount, currency } = req.body;

    if (!email || amount == null || !currency) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email, amount, and currency are required.' 
      });
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Amount must be a positive number.' 
      });
    }

    const fieldToUpdate = currencyFieldMap[currency];
    if (!fieldToUpdate) {
      return res.status(400).json({ 
        success: false, 
        message: `Unsupported currency: ${currency}` 
      });
    }

    // Deduct (negative increment)
    const update = { 
      $inc: {
        [fieldToUpdate]: -numericAmount  // Negative to deduct
      }
    };

    const updatedUser = await User.findOneAndUpdate(
      { email },
      update,
      { new: true, runValidators: true }
    ).select('email trxBalance btcBalance ethBalance solBalance usdtBalance usdcBalance ngnzBalance');

    if (!updatedUser) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found.' 
      });
    }

    const newBalance = updatedUser[fieldToUpdate] ?? 0;

    console.log(`✅ Deducted from user: ${email} | ${currency}: ${numericAmount} | New Balance: ${newBalance}`);

    return res.status(200).json({
      success: true,
      message: `Successfully deducted ${numericAmount} ${currency} from ${email}`,
      data: {
        email: updatedUser.email,
        currency,
        amountDeducted: numericAmount,
        newBalance
      }
    });
  } catch (err) {
    console.error('❌ Error in /deduct-user:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      error: err.message 
    });
  }
});



router.post('/fund-user', async (req, res) => {
  try {
    const { email, amount, currency } = req.body;

    if (!email || amount == null || !currency) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email, amount, and currency are required.' 
      });
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Amount must be a positive number.' 
      });
    }

    const fieldToUpdate = currencyFieldMap[currency];
    if (!fieldToUpdate) {
      return res.status(400).json({ 
        success: false, 
        message: `Unsupported currency: ${currency}. Supported: BTC, ETH, SOL, USDT, USDC, NGNB, TRX` 
      });
    }

    // Build update object with $inc for atomic increment - ONLY update the specific currency balance
    const update = { 
      $inc: {
        [fieldToUpdate]: numericAmount
      }
    };

    // Find user and increment balance atomically
    const updatedUser = await User.findOneAndUpdate(
      { email },
      update,
      { new: true, runValidators: true }
    ).select('email trxBalance btcBalance ethBalance solBalance usdtBalance usdcBalance ngnzBalance bnbBalance maticBalance');

    if (!updatedUser) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found.' 
      });
    }

    // Get the new balance for the specific currency field
    const newBalance = updatedUser[fieldToUpdate] ?? 0;

    console.log(`✅ Funded user: ${email} | ${currency}: ${numericAmount} | New Balance: ${newBalance}`);

    return res.status(200).json({
      success: true,
      message: `Successfully funded ${numericAmount} ${currency} to ${email}`,
      data: {
        email: updatedUser.email,
        currency,
        amountFunded: numericAmount,
        newBalance,
        balances: {
          BTC: updatedUser.btcBalance,
          ETH: updatedUser.ethBalance,
          SOL: updatedUser.solBalance,
          USDT: updatedUser.usdtBalance,
          USDC: updatedUser.usdcBalance,
          TRX: updatedUser.trxBalance,
          NGNZ: updatedUser.ngnzBalance,
          BNB: updatedUser.bnbBalance,
          MATIC: updatedUser.maticBalance
        }
      }
    });
  } catch (err) {
    console.error('❌ Error in /fund-user:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      error: err.message 
    });
  }
});

module.exports = router;