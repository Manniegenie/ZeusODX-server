const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');

// GET: /api/user/bank-accounts - Get user's bank accounts
router.get('/bank-accounts', async (req, res) => {
  try {
    const userId = req.user.id; // From global JWT middleware

    if (!userId) {
      logger.warn('No user ID found in token', { source: 'get-bank-accounts' });
      return res.status(400).json({ message: 'Invalid token payload' });
    }

    // Fetch user from database with only bank accounts field
    const user = await User.findById(userId).select('bankAccounts');

    if (!user) {
      logger.warn('User not found', { userId, source: 'get-bank-accounts' });
      return res.status(404).json({ message: 'User not found' });
    }

    // Get active bank accounts only
    const activeBankAccounts = user.getActiveBankAccounts();
    const totalCount = user.getBankAccountsCount();
    const canAddMore = user.canAddBankAccount();

    logger.info('Bank accounts fetched successfully', { 
      userId, 
      accountCount: totalCount,
      source: 'get-bank-accounts' 
    });

    // Return bank accounts information - UPDATED to include bankCode
    res.json({
      success: true,
      data: {
        bankAccounts: activeBankAccounts.map(account => ({
          id: account._id,
          accountName: account.accountName,
          bankName: account.bankName,
          bankCode: account.bankCode, // NEW: Include bank code in response
          accountNumber: account.accountNumber,
          addedAt: account.addedAt,
          isVerified: account.isVerified,
          isActive: account.isActive
        })),
        summary: {
          totalAccounts: totalCount,
          maxAllowed: 10,
          canAddMore: canAddMore,
          remainingSlots: canAddMore ? (10 - totalCount) : 0
        }
      }
    });

  } catch (error) {
    logger.error('Error fetching bank accounts', { 
      error: error.message, 
      stack: error.stack,
      userId: req.user?.id,
      source: 'get-bank-accounts' 
    });
    res.status(500).json({ message: 'Server error' });
  }
});

// POST: /api/user/bank-accounts - Add a new bank account
router.post('/add-bank', async (req, res) => {
  try {
    const userId = req.user.id; // From global JWT middleware
    const { accountNumber, bankName, accountName, bankCode } = req.body; // UPDATED: Added bankCode

    if (!userId) {
      logger.warn('No user ID found in token', { source: 'add-bank-account' });
      return res.status(400).json({ message: 'Invalid token payload' });
    }

    // Validate required fields - UPDATED to include bankCode
    if (!accountNumber || !bankName || !accountName || !bankCode) {
      logger.warn('Missing required fields', { 
        userId, 
        providedFields: { 
          accountNumber: !!accountNumber, 
          bankName: !!bankName, 
          accountName: !!accountName,
          bankCode: !!bankCode // NEW: Include in validation logging
        },
        source: 'add-bank-account' 
      });
      return res.status(400).json({ 
        message: 'Account number, bank name, account name, and bank code are required' // UPDATED message
      });
    }

    // Basic validation for account number (remove spaces and check if it's alphanumeric)
    const cleanAccountNumber = accountNumber.toString().replace(/\s+/g, '');
    if (cleanAccountNumber.length < 8 || cleanAccountNumber.length > 20) {
      logger.warn('Invalid account number length', { 
        userId, 
        accountNumberLength: cleanAccountNumber.length,
        source: 'add-bank-account' 
      });
      return res.status(400).json({ 
        message: 'Account number must be between 8 and 20 characters' 
      });
    }

    // Basic validation for bank code (ensure it's not empty and reasonable length)
    const cleanBankCode = bankCode.toString().trim();
    if (cleanBankCode.length < 2 || cleanBankCode.length > 10) {
      logger.warn('Invalid bank code length', { 
        userId, 
        bankCodeLength: cleanBankCode.length,
        source: 'add-bank-account' 
      });
      return res.status(400).json({ 
        message: 'Bank code must be between 2 and 10 characters' 
      });
    }

    // Fetch user from database
    const user = await User.findById(userId);

    if (!user) {
      logger.warn('User not found', { userId, source: 'add-bank-account' });
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if user can add more bank accounts
    if (!user.canAddBankAccount()) {
      const currentCount = user.getBankAccountsCount();
      logger.warn('Maximum bank accounts limit reached', { 
        userId, 
        currentCount,
        maxAllowed: 10,
        source: 'add-bank-account' 
      });
      return res.status(400).json({ 
        message: 'Maximum number of bank accounts (10) already reached' 
      });
    }

    // Check for duplicate account numbers for this user
    const existingAccount = user.bankAccounts.find(
      account => account.accountNumber === cleanAccountNumber && account.isActive
    );

    if (existingAccount) {
      logger.warn('Duplicate account number', { 
        userId, 
        accountNumber: cleanAccountNumber,
        source: 'add-bank-account' 
      });
      return res.status(400).json({ 
        message: 'Account number already exists' 
      });
    }

    // Prepare new bank account data - UPDATED to include bankCode
    const newBankAccount = {
      accountNumber: cleanAccountNumber,
      bankName: bankName.trim(),
      accountName: accountName.trim(),
      bankCode: cleanBankCode, // NEW: Include bank code
      addedAt: new Date(),
      isVerified: false,
      isActive: true
    };

    // Add the bank account
    try {
      await user.addBankAccount(newBankAccount);
      
      // Get the newly added account (it will be the last one)
      const addedAccount = user.bankAccounts[user.bankAccounts.length - 1];
      
      logger.info('Bank account added successfully', { 
        userId, 
        accountId: addedAccount._id,
        bankName: newBankAccount.bankName,
        bankCode: newBankAccount.bankCode, // NEW: Include in logging
        accountName: newBankAccount.accountName,
        source: 'add-bank-account' 
      });

      // Return success response with the new account data - UPDATED to include bankCode
      res.status(201).json({
        success: true,
        message: 'Bank account added successfully',
        data: {
          bankAccount: {
            id: addedAccount._id,
            accountName: addedAccount.accountName,
            bankName: addedAccount.bankName,
            bankCode: addedAccount.bankCode, // NEW: Include bank code in response
            accountNumber: addedAccount.accountNumber,
            addedAt: addedAccount.addedAt,
            isVerified: addedAccount.isVerified,
            isActive: addedAccount.isActive
          }
        }
      });

    } catch (addError) {
      logger.error('Error during bank account addition', { 
        error: addError.message, 
        userId, 
        bankName: newBankAccount.bankName,
        bankCode: newBankAccount.bankCode, // NEW: Include in error logging
        source: 'add-bank-account' 
      });
      return res.status(500).json({ message: 'Failed to add bank account' });
    }

  } catch (error) {
    logger.error('Error adding bank account', { 
      error: error.message, 
      stack: error.stack,
      userId: req.user?.id,
      source: 'add-bank-account' 
    });
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE: /api/user/bank-accounts - Delete a bank account (using JSON body)
router.delete('/delete-bank', async (req, res) => {
  try {
    const userId = req.user.id; // From global JWT middleware
    const { accountId } = req.body; // Changed from req.params to req.body

    if (!userId) {
      logger.warn('No user ID found in token', { source: 'delete-bank-account' });
      return res.status(400).json({ message: 'Invalid token payload' });
    }

    if (!accountId) {
      logger.warn('No account ID provided', { userId, source: 'delete-bank-account' });
      return res.status(400).json({ message: 'Account ID is required' });
    }

    // Fetch user from database
    const user = await User.findById(userId);

    if (!user) {
      logger.warn('User not found', { userId, source: 'delete-bank-account' });
      return res.status(404).json({ message: 'User not found' });
    }

    // Find the bank account to delete
    const bankAccount = user.bankAccounts.id(accountId);

    if (!bankAccount) {
      logger.warn('Bank account not found', { 
        userId, 
        accountId, 
        source: 'delete-bank-account' 
      });
      return res.status(404).json({ message: 'Bank account not found' });
    }

    // Store account info for logging before deletion - UPDATED to include bankCode
    const deletedAccountInfo = {
      accountName: bankAccount.accountName,
      bankName: bankAccount.bankName,
      bankCode: bankAccount.bankCode, // NEW: Include bank code
      accountNumber: bankAccount.accountNumber
    };

    // Remove the bank account
    try {
      await user.removeBankAccount(accountId);
      
      logger.info('Bank account deleted successfully', { 
        userId, 
        accountId,
        deletedAccount: deletedAccountInfo,
        source: 'delete-bank-account' 
      });

      // Return success response - UPDATED to include bankCode
      res.json({
        success: true,
        message: 'Bank account deleted successfully',
        deletedAccount: {
          id: accountId,
          accountName: deletedAccountInfo.accountName,
          bankName: deletedAccountInfo.bankName,
          bankCode: deletedAccountInfo.bankCode, // NEW: Include bank code in response
          accountNumber: deletedAccountInfo.accountNumber
        }
      });

    } catch (deleteError) {
      logger.error('Error during bank account deletion', { 
        error: deleteError.message, 
        userId, 
        accountId,
        source: 'delete-bank-account' 
      });
      return res.status(500).json({ message: 'Failed to delete bank account' });
    }

  } catch (error) {
    logger.error('Error deleting bank account', { 
      error: error.message, 
      stack: error.stack,
      userId: req.user?.id,
      accountId: req.body?.accountId,
      source: 'delete-bank-account' 
    });
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;