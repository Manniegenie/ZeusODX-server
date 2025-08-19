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

    // Return bank accounts information
    res.json({
      success: true,
      data: {
        bankAccounts: activeBankAccounts.map(account => ({
          id: account._id,
          accountName: account.accountName,
          bankName: account.bankName,
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
router.post('/bank-accounts', async (req, res) => {
  try {
    const userId = req.user.id; // From global JWT middleware
    const { accountNumber, bankName, accountName } = req.body;

    if (!userId) {
      logger.warn('No user ID found in token', { source: 'add-bank-account' });
      return res.status(400).json({ message: 'Invalid token payload' });
    }

    // Validate required fields
    if (!accountNumber || !bankName || !accountName) {
      logger.warn('Missing required fields', { 
        userId, 
        providedFields: { accountNumber: !!accountNumber, bankName: !!bankName, accountName: !!accountName },
        source: 'add-bank-account' 
      });
      return res.status(400).json({ 
        message: 'Account number, bank name, and account name are required' 
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

    // Prepare new bank account data
    const newBankAccount = {
      accountNumber: cleanAccountNumber,
      bankName: bankName.trim(),
      accountName: accountName.trim(),
      addedAt: new Date(),
      isVerified: false,
      isActive: true
    };

    // Add the bank account
    try {
      const addedAccount = await user.addBankAccount(newBankAccount);
      
      logger.info('Bank account added successfully', { 
        userId, 
        accountId: addedAccount._id,
        bankName: newBankAccount.bankName,
        accountName: newBankAccount.accountName,
        source: 'add-bank-account' 
      });

      // Return success response with the new account data
      res.status(201).json({
        success: true,
        message: 'Bank account added successfully',
        data: {
          bankAccount: {
            id: addedAccount._id,
            accountName: addedAccount.accountName,
            bankName: addedAccount.bankName,
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
router.delete('/bank-accounts', async (req, res) => {
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

    // Store account info for logging before deletion
    const deletedAccountInfo = {
      accountName: bankAccount.accountName,
      bankName: bankAccount.bankName,
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

      // Return success response
      res.json({
        success: true,
        message: 'Bank account deleted successfully',
        deletedAccount: {
          id: accountId,
          accountName: deletedAccountInfo.accountName,
          bankName: deletedAccountInfo.bankName,
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