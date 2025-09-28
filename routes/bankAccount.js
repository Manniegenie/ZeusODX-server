// routes/bankAccount.js
const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');

// NOTE: Make sure your main app enables JSON parsing:
// app.use(express.json());
// app.use(express.urlencoded({ extended: true }));

// GET: /api/user/bank-accounts - Get user's bank accounts
router.get('/bank-accounts', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) {
      logger.warn('No user ID found in token', { source: 'get-bank-accounts' });
      return res.status(401).json({ message: 'Unauthenticated' });
    }

    const user = await User.findById(userId).select('bankAccounts');
    if (!user) {
      logger.warn('User not found', { userId, source: 'get-bank-accounts' });
      return res.status(404).json({ message: 'User not found' });
    }

    const activeBankAccounts = user.getActiveBankAccounts();
    const totalCount = user.getBankAccountsCount();
    const canAddMore = user.canAddBankAccount();

    logger.info('Bank accounts fetched successfully', { userId, accountCount: totalCount, source: 'get-bank-accounts' });

    return res.json({
      success: true,
      data: {
        bankAccounts: activeBankAccounts.map(account => ({
          id: account._id,
          accountName: account.accountName,
          bankName: account.bankName,
          bankCode: account.bankCode,
          accountNumber: account.accountNumber,
          addedAt: account.addedAt,
          isVerified: account.isVerified,
          isActive: account.isActive
        })),
        summary: {
          totalAccounts: totalCount,
          maxAllowed: 10,
          canAddMore,
          remainingSlots: canAddMore ? (10 - totalCount) : 0
        }
      }
    });
  } catch (error) {
    logger.error('Error fetching bank accounts', { error: error.message, stack: error.stack, userId: req.user?.id, source: 'get-bank-accounts' });
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST: /api/user/add-bank - Add a new bank account
router.post('/add-bank', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    const { accountNumber, bankName, accountName, bankCode } = req.body;

    if (!userId) {
      logger.warn('No user ID found in token', { source: 'add-bank-account' });
      return res.status(401).json({ message: 'Unauthenticated' });
    }

    if (!accountNumber || !bankName || !accountName || !bankCode) {
      logger.warn('Missing required fields', {
        userId,
        providedFields: {
          accountNumber: !!accountNumber,
          bankName: !!bankName,
          accountName: !!accountName,
          bankCode: !!bankCode
        },
        source: 'add-bank-account'
      });
      return res.status(400).json({ message: 'Account number, bank name, account name, and bank code are required' });
    }

    const cleanAccountNumber = accountNumber.toString().replace(/\s+/g, '');
    if (cleanAccountNumber.length < 8 || cleanAccountNumber.length > 20) {
      logger.warn('Invalid account number length', { userId, accountNumberLength: cleanAccountNumber.length, source: 'add-bank-account' });
      return res.status(400).json({ message: 'Account number must be between 8 and 20 characters' });
    }

    const cleanBankCode = bankCode.toString().trim();
    if (cleanBankCode.length < 2 || cleanBankCode.length > 10) {
      logger.warn('Invalid bank code length', { userId, bankCodeLength: cleanBankCode.length, source: 'add-bank-account' });
      return res.status(400).json({ message: 'Bank code must be between 2 and 10 characters' });
    }

    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found', { userId, source: 'add-bank-account' });
      return res.status(404).json({ message: 'User not found' });
    }

    if (!user.canAddBankAccount()) {
      const currentCount = user.getBankAccountsCount();
      logger.warn('Maximum bank accounts limit reached', { userId, currentCount, maxAllowed: 10, source: 'add-bank-account' });
      return res.status(400).json({ message: 'Maximum number of bank accounts (10) already reached' });
    }

    const existingAccount = user.bankAccounts.find(acc => acc.accountNumber === cleanAccountNumber && acc.isActive);
    if (existingAccount) {
      logger.warn('Duplicate account number', { userId, accountNumber: cleanAccountNumber, source: 'add-bank-account' });
      return res.status(400).json({ message: 'Account number already exists' });
    }

    const newBankAccount = {
      accountNumber: cleanAccountNumber,
      bankName: bankName.trim(),
      accountName: accountName.trim(),
      bankCode: cleanBankCode,
      addedAt: new Date(),
      isVerified: false,
      isActive: true
    };

    try {
      await user.addBankAccount(newBankAccount);
      const addedAccount = user.bankAccounts[user.bankAccounts.length - 1];

      logger.info('Bank account added successfully', {
        userId,
        accountId: addedAccount._id,
        bankName: newBankAccount.bankName,
        bankCode: newBankAccount.bankCode,
        accountName: newBankAccount.accountName,
        source: 'add-bank-account'
      });

      return res.status(201).json({
        success: true,
        message: 'Bank account added successfully',
        data: {
          bankAccount: {
            id: addedAccount._id,
            accountName: addedAccount.accountName,
            bankName: addedAccount.bankName,
            bankCode: addedAccount.bankCode,
            accountNumber: addedAccount.accountNumber,
            addedAt: addedAccount.addedAt,
            isVerified: addedAccount.isVerified,
            isActive: addedAccount.isActive
          }
        }
      });
    } catch (addError) {
      logger.error('Error during bank account addition', { error: addError.message, userId, bankName: newBankAccount.bankName, bankCode: newBankAccount.bankCode, source: 'add-bank-account' });
      return res.status(500).json({ message: 'Failed to add bank account' });
    }
  } catch (error) {
    logger.error('Error adding bank account', { error: error.message, stack: error.stack, userId: req.user?.id, source: 'add-bank-account' });
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE: /api/user/delete-bank - Delete a bank account using accountNumber from body or query
router.delete('/delete-bank', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    // Try both body and query parameter
    const { accountNumber } = req.body || {};
    const accountNumberFromQuery = req.query.accountNumber;
    const finalAccountNumber = accountNumber || accountNumberFromQuery;

    if (!userId) {
      logger.warn('No user ID found in token', { source: 'delete-bank-account' });
      return res.status(401).json({ message: 'Unauthenticated' });
    }

    if (!finalAccountNumber) {
      logger.warn('No account number provided', { userId, source: 'delete-bank-account' });
      return res.status(400).json({ message: 'Account number is required' });
    }

    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found', { userId, source: 'delete-bank-account' });
      return res.status(404).json({ message: 'User not found' });
    }

    const bankAccount = user.bankAccounts.find(acc => acc.accountNumber === finalAccountNumber && acc.isActive);
    if (!bankAccount) {
      logger.warn('Bank account not found', { userId, accountNumber: finalAccountNumber, source: 'delete-bank-account' });
      return res.status(404).json({ message: 'Bank account not found' });
    }

    const deletedAccountInfo = {
      accountName: bankAccount.accountName,
      bankName: bankAccount.bankName,
      bankCode: bankAccount.bankCode,
      accountNumber: bankAccount.accountNumber
    };

    try {
      // Modern Mongoose way - use pull() instead of remove()
      user.bankAccounts.pull(bankAccount._id);
      await user.save();
      
      logger.info('Bank account deleted successfully', { userId, deletedAccount: deletedAccountInfo, source: 'delete-bank-account' });

      return res.json({
        success: true,
        message: 'Bank account deleted successfully',
        deletedAccount: deletedAccountInfo
      });
    } catch (deleteError) {
      logger.error('Error during bank account deletion', { error: deleteError.message, userId, source: 'delete-bank-account' });
      return res.status(500).json({ message: 'Failed to delete bank account' });
    }
  } catch (error) {
    logger.error('Error deleting bank account', { error: error.message, stack: error.stack, userId: req.user?.id, source: 'delete-bank-account' });
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;