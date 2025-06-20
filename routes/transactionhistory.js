const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Transaction = require('../models/transaction');
const logger = require('../utils/logger');

// POST /api/transactions/currency - Get transactions for a specific currency via JSON
router.post('/currency', 
  [
    // Validate JSON request body
    body('currency')
      .trim()
      .notEmpty()
      .withMessage('Currency is required')
      .isLength({ min: 2, max: 10 })
      .withMessage('Currency must be between 2 and 10 characters')
      .toUpperCase(),
    
    // Optional filters
    body('type')
      .optional()
      .isIn(['DEPOSIT', 'WITHDRAWAL'])
      .withMessage('Type must be either DEPOSIT or WITHDRAWAL'),
    
    body('status')
      .optional()
      .isIn(['PENDING', 'APPROVED', 'PROCESSING', 'SUCCESSFUL', 'FAILED', 'REJECTED', 'CONFIRMED'])
      .withMessage('Invalid status value'),
    
    body('network')
      .optional()
      .trim()
      .isLength({ max: 20 })
      .withMessage('Network must be less than 20 characters'),
    
    // Pagination
    body('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Page must be a positive integer')
      .toInt(),
    
    body('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100')
      .toInt(),
    
    // Date filters
    body('startDate')
      .optional()
      .isISO8601()
      .withMessage('Start date must be a valid ISO 8601 date'),
    
    body('endDate')
      .optional()
      .isISO8601()
      .withMessage('End date must be a valid ISO 8601 date'),
    
    // Sort options
    body('sortBy')
      .optional()
      .isIn(['createdAt', 'amount', 'status', 'updatedAt'])
      .withMessage('Sort by must be createdAt, amount, status, or updatedAt'),
    
    body('sortOrder')
      .optional()
      .isIn(['asc', 'desc'])
      .withMessage('Sort order must be asc or desc')
  ],
  async (req, res) => {
    try {
      // Check validation errors
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errors.array()
        });
      }

      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Unauthorized - user ID required'
        });
      }

      // Extract parameters from JSON body
      const {
        currency,
        type,
        status,
        network,
        page = 1,
        limit = 20,
        startDate,
        endDate,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = req.body;

      // Build query filter
      const filter = {
        userId: userId,
        currency: currency.toUpperCase()
      };

      // Add optional filters
      if (type) filter.type = type;
      if (status) filter.status = status;
      if (network) filter.network = network;

      // Add date range filter
      if (startDate || endDate) {
        filter.createdAt = {};
        if (startDate) filter.createdAt.$gte = new Date(startDate);
        if (endDate) filter.createdAt.$lte = new Date(endDate);
      }

      // Calculate pagination
      const skip = (page - 1) * limit;

      // Build sort object
      const sort = {};
      sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

      // Execute query with pagination
      const [transactions, totalCount] = await Promise.all([
        Transaction.find(filter)
          .sort(sort)
          .skip(skip)
          .limit(limit)
          .lean(), // Use lean() for better performance
        Transaction.countDocuments(filter)
      ]);

      // Calculate pagination metadata
      const totalPages = Math.ceil(totalCount / limit);
      const hasNextPage = page < totalPages;
      const hasPrevPage = page > 1;

      // Calculate summary statistics for this currency
      const summaryStats = await Transaction.aggregate([
        { $match: { userId: userId, currency: currency.toUpperCase() } },
        {
          $group: {
            _id: '$type',
            totalAmount: { $sum: '$amount' },
            totalFees: { $sum: '$fee' },
            obiexFees: { $sum: '$obiexFee' },
            count: { $sum: 1 },
            avgAmount: { $avg: '$amount' }
          }
        }
      ]);

      // Get status breakdown
      const statusBreakdown = await Transaction.aggregate([
        { $match: { userId: userId, currency: currency.toUpperCase() } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalAmount: { $sum: '$amount' }
          }
        }
      ]);

      // Format summary for easier consumption
      const summary = {
        totalDeposits: 0,
        totalWithdrawals: 0,
        depositCount: 0,
        withdrawalCount: 0,
        totalFees: 0,
        totalObiexFees: 0,
        avgDepositAmount: 0,
        avgWithdrawalAmount: 0,
        statusBreakdown: {}
      };

      summaryStats.forEach(stat => {
        if (stat._id === 'DEPOSIT') {
          summary.totalDeposits = stat.totalAmount;
          summary.depositCount = stat.count;
          summary.avgDepositAmount = stat.avgAmount;
        } else if (stat._id === 'WITHDRAWAL') {
          summary.totalWithdrawals = stat.totalAmount;
          summary.withdrawalCount = stat.count;
          summary.avgWithdrawalAmount = stat.avgAmount;
        }
        summary.totalFees += stat.totalFees;
        summary.totalObiexFees += stat.obiexFees;
      });

      // Format status breakdown
      statusBreakdown.forEach(status => {
        summary.statusBreakdown[status._id] = {
          count: status.count,
          totalAmount: status.totalAmount
        };
      });

      const response = {
        success: true,
        message: `${currency.toUpperCase()} transactions retrieved successfully`,
        data: {
          transactions: transactions,
          pagination: {
            currentPage: page,
            totalPages: totalPages,
            totalCount: totalCount,
            limit: limit,
            hasNextPage: hasNextPage,
            hasPrevPage: hasPrevPage
          },
          filters: {
            currency: currency.toUpperCase(),
            type: type || 'all',
            status: status || 'all',
            network: network || 'all',
            dateRange: {
              start: startDate || null,
              end: endDate || null
            }
          },
          summary: summary
        }
      };

      logger.info('Currency transactions fetched', {
        userId,
        currency: currency.toUpperCase(),
        filters: { type, status, network },
        resultCount: transactions.length,
        totalCount
      });

      return res.status(200).json(response);

    } catch (error) {
      logger.error('Error fetching currency transactions', {
        userId: req.user?.id,
        currency: req.body?.currency,
        error: error.message,
        stack: error.stack
      });

      return res.status(500).json({
        success: false,
        message: 'Internal server error while fetching transactions',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Server error'
      });
    }
  }
);

// POST /api/transactions/multiple-currencies - Get transactions for multiple currencies
router.post('/multiple-currencies',
  [
    body('currencies')
      .isArray({ min: 1 })
      .withMessage('Currencies must be a non-empty array')
      .custom((currencies) => {
        if (!currencies.every(curr => typeof curr === 'string' && curr.length >= 2 && curr.length <= 10)) {
          throw new Error('Each currency must be a string between 2 and 10 characters');
        }
        return true;
      }),
    
    body('type')
      .optional()
      .isIn(['DEPOSIT', 'WITHDRAWAL'])
      .withMessage('Type must be either DEPOSIT or WITHDRAWAL'),
    
    body('status')
      .optional()
      .isIn(['PENDING', 'APPROVED', 'PROCESSING', 'SUCCESSFUL', 'FAILED', 'REJECTED', 'CONFIRMED'])
      .withMessage('Invalid status value'),
    
    body('page')
      .optional()
      .isInt({ min: 1 })
      .toInt(),
    
    body('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .toInt()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errors.array()
        });
      }

      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Unauthorized'
        });
      }

      const {
        currencies,
        type,
        status,
        network,
        page = 1,
        limit = 20,
        startDate,
        endDate,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = req.body;

      // Build filter
      const filter = {
        userId: userId,
        currency: { $in: currencies.map(c => c.toUpperCase()) }
      };

      if (type) filter.type = type;
      if (status) filter.status = status;
      if (network) filter.network = network;

      if (startDate || endDate) {
        filter.createdAt = {};
        if (startDate) filter.createdAt.$gte = new Date(startDate);
        if (endDate) filter.createdAt.$lte = new Date(endDate);
      }

      const skip = (page - 1) * limit;
      const sort = {};
      sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

      const [transactions, totalCount] = await Promise.all([
        Transaction.find(filter)
          .sort(sort)
          .skip(skip)
          .limit(limit)
          .lean(),
        Transaction.countDocuments(filter)
      ]);

      // Get summary by currency
      const currencySummary = await Transaction.aggregate([
        { $match: { userId: userId, currency: { $in: currencies.map(c => c.toUpperCase()) } } },
        {
          $group: {
            _id: { currency: '$currency', type: '$type' },
            totalAmount: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        }
      ]);

      // Format currency summary
      const summary = {};
      currencies.forEach(currency => {
        const currUpper = currency.toUpperCase();
        summary[currUpper] = {
          deposits: { amount: 0, count: 0 },
          withdrawals: { amount: 0, count: 0 }
        };
      });

      currencySummary.forEach(item => {
        const { currency, type } = item._id;
        if (type === 'DEPOSIT') {
          summary[currency].deposits = {
            amount: item.totalAmount,
            count: item.count
          };
        } else if (type === 'WITHDRAWAL') {
          summary[currency].withdrawals = {
            amount: item.totalAmount,
            count: item.count
          };
        }
      });

      return res.status(200).json({
        success: true,
        message: `Transactions for ${currencies.length} currencies retrieved successfully`,
        data: {
          transactions: transactions,
          pagination: {
            currentPage: page,
            totalPages: Math.ceil(totalCount / limit),
            totalCount: totalCount,
            limit: limit
          },
          filters: {
            currencies: currencies.map(c => c.toUpperCase()),
            type: type || 'all',
            status: status || 'all'
          },
          currencySummary: summary
        }
      });

    } catch (error) {
      logger.error('Error fetching multiple currency transactions', {
        userId: req.user?.id,
        error: error.message
      });

      return res.status(500).json({
        success: false,
        message: 'Server error',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
      });
    }
  }
);

module.exports = router;