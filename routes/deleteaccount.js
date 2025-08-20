const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');

// Function to check if user has funds in any wallet
function checkUserFunds(user) {
  try {
    const balanceFields = [
      'solBalance', 'solPendingBalance',
      'btcBalance', 'btcPendingBalance',
      'usdtBalance', 'usdtPendingBalance',
      'usdcBalance', 'usdcPendingBalance',
      'ethBalance', 'ethPendingBalance',
      'bnbBalance', 'bnbPendingBalance',
      'dogeBalance', 'dogePendingBalance',
      'maticBalance', 'maticPendingBalance',
      'avaxBalance', 'avaxPendingBalance',
      'ngnzBalance', 'ngnzPendingBalance'
    ];

    let totalFunds = 0;
    const fundDetails = {};

    for (const field of balanceFields) {
      const balance = user[field] || 0;
      if (balance > 0) {
        fundDetails[field] = balance;
        totalFunds += balance;
      }
    }

    const hasFunds = totalFunds > 0;
    logger.info('User funds check completed', {
      userId: user._id,
      hasFunds,
      totalFunds,
      fundsCount: Object.keys(fundDetails).length
    });

    return { hasFunds, totalFunds, fundDetails };
  } catch (error) {
    logger.error('Error checking user funds', {
      userId: user?._id,
      error: error.message
    });
    return { hasFunds: false, totalFunds: 0, fundDetails: {} };
  }
}

// POST: /initiate
router.post('/initiate', async (req, res) => {
  const userId = req.user.id;

  try {
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found for account deletion', { userId });
      return res.status(404).json({ message: 'User not found.' });
    }

    const fundsCheck = checkUserFunds(user);

    if (fundsCheck.hasFunds) {
      return res.status(400).json({
        message: 'Cannot delete account with remaining funds. Please withdraw all funds first.',
        fundsAvailable: true,
        fundDetails: fundsCheck.fundDetails
      });
    }

    // Schedule deletion directly (skip OTP + 2FA + email check)
    const deletionDate = new Date();
    deletionDate.setDate(deletionDate.getDate() + 30);

    user.accountDeletionScheduled = true;
    user.accountDeletionDate = deletionDate;
    await user.save();

    logger.info('Account scheduled for deletion', {
      userId,
      scheduledDeletionDate: deletionDate
    });

    return res.status(200).json({
      message: 'Account scheduled for deletion in 30 days.',
      scheduledDeletionDate: deletionDate,
      note: 'You can cancel this deletion by logging in before the scheduled date.'
    });
  } catch (err) {
    logger.error('Account deletion initiation error', {
      userId,
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ message: 'Server error while initiating account deletion.' });
  }
});

// POST: /delete
router.post('/delete', async (req, res) => {
  const userId = req.user.id;

  try {
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found for account deletion completion', { userId });
      return res.status(404).json({ message: 'User not found.' });
    }

    if (!user.accountDeletionScheduled) {
      return res.status(400).json({ message: 'No pending account deletion request found.' });
    }

    // Final funds check before deletion
    const fundsCheck = checkUserFunds(user);
    if (fundsCheck.hasFunds) {
      return res.status(400).json({
        message: 'Cannot delete account with remaining funds. Please withdraw all funds first.',
        fundsAvailable: true,
        fundDetails: fundsCheck.fundDetails
      });
    }

    const deletionDate = new Date();
    deletionDate.setDate(deletionDate.getDate() + 30);

    user.accountDeletionScheduled = true;
    user.accountDeletionDate = deletionDate;
    await user.save();

    logger.info('Account scheduled for deletion', {
      userId,
      scheduledDeletionDate: deletionDate
    });

    res.status(200).json({
      message: 'Account scheduled for deletion in 30 days.',
      scheduledDeletionDate: deletionDate,
      note: 'You can cancel this deletion by logging in before the scheduled date.'
    });
  } catch (err) {
    logger.error('Account deletion completion error', {
      userId,
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ message: 'Server error while deleting account.' });
  }
});

module.exports = router;
