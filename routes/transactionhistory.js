const express = require('express');
const router = express.Router();
const Transaction = require('../models/transaction');
const BillTransaction = require('../models/billstransaction');
const logger = require('../utils/logger');

// Helper function to build date range filter
function buildDateRangeFilter(dateFrom, dateTo) {
  const filter = {};
  
  if (dateFrom || dateTo) {
    filter.createdAt = {};
    
    if (dateFrom) {
      filter.createdAt.$gte = new Date(dateFrom);
    }
    
    if (dateTo) {
      const endDate = new Date(dateTo);
      endDate.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = endDate;
    }
  }
  
  return filter;
}

// Helper function to get default date range (current month)
function getDefaultDateRange() {
  const now = new Date();
  const dateTo = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const dateFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  
  return {
    dateFrom: dateFrom.toISOString().split('T')[0],
    dateTo: dateTo.toISOString().split('T')[0]
  };
}

// Helper functions for formatting
function formatTransactionType(type) {
  const typeMap = {
    'DEPOSIT': 'Deposit',
    'WITHDRAWAL': 'Withdrawal', 
    'INTERNAL_TRANSFER_SENT': 'Withdrawal',
    'INTERNAL_TRANSFER_RECEIVED': 'Deposit',
    'SWAP': 'Swap'
  };
  return typeMap[type] || type;
}

function formatBillType(billType) {
  const billTypeMap = {
    'airtime': 'Airtime',
    'data': 'Data',
    'electricity': 'Electricity',
    'cable_tv': 'Cable TV',
    'internet': 'Internet',
    'betting': 'Betting',
    'education': 'Education',
    'other': 'Other'
  };
  return billTypeMap[billType] || billType;
}

function formatStatus(status, type = 'token') {
  if (type === 'bill') {
    switch (status) {
      case 'completed-api': return 'Successful';
      case 'failed': return 'Failed';
      case 'initiated-api':
      case 'processing-api': return 'Pending';
      case 'refunded': return 'Refunded';
      default: return 'Pending';
    }
  } else {
    switch (status) {
      case 'SUCCESSFUL':
      case 'COMPLETED':
      case 'CONFIRMED': return 'Successful';
      case 'FAILED':
      case 'REJECTED': return 'Failed';
      case 'PENDING':
      case 'PROCESSING':
      case 'APPROVED': return 'Pending';
      default: return 'Pending';
    }
  }
}

function formatAmount(amount, currency, type = '', isNegative = false) {
  const sign = isNegative ? '-' : '+';
  if (currency === 'NGNB') {
    return `${sign}₦${amount.toLocaleString()}`;
  }
  return `${sign}${amount} ${currency}`;
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

// POST /api/transactions/token-specific - Get transactions for specific currency
router.post('/token-specific', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    // Simple validation with defaults
    const body = req.body || {};
    const {
      currency,
      type,
      status,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = body;

    if (!currency) {
      return res.status(400).json({
        success: false,
        message: 'Currency is required'
      });
    }

    // Get date range
    const defaultRange = getDefaultDateRange();
    const dateFrom = body.dateFrom || defaultRange.dateFrom;
    const dateTo = body.dateTo || defaultRange.dateTo;

    // Build filter
    const filter = {
      userId: userId,
      currency: currency.toUpperCase()
    };

    // Add date range filter
    Object.assign(filter, buildDateRangeFilter(dateFrom, dateTo));

    if (type) {
      switch (type.toUpperCase()) {
        case 'DEPOSIT':
          filter.type = { $in: ['DEPOSIT', 'INTERNAL_TRANSFER_RECEIVED'] };
          break;
        case 'WITHDRAWAL':
          filter.type = { $in: ['WITHDRAWAL', 'INTERNAL_TRANSFER_SENT'] };
          break;
        case 'SWAP':
          filter.type = 'SWAP';
          break;
      }
    }
    
    if (status) {
      switch (status.toLowerCase()) {
        case 'successful':
          filter.status = { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] };
          break;
        case 'failed':
          filter.status = { $in: ['FAILED', 'REJECTED'] };
          break;
        case 'pending':
          filter.status = { $in: ['PENDING', 'PROCESSING', 'APPROVED'] };
          break;
      }
    }

    // Pagination
    const skip = (page - 1) * limit;
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Get transactions
    const [transactions, totalCount] = await Promise.all([
      Transaction.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Transaction.countDocuments(filter)
    ]);

    // Format transactions
    const formattedTokenTransactions = transactions.map(tx => {
      const isNegative = tx.type === 'WITHDRAWAL' || tx.type === 'INTERNAL_TRANSFER_SENT';
      
      return {
        id: tx._id,
        type: formatTransactionType(tx.type),
        status: formatStatus(tx.status),
        amount: formatAmount(tx.amount, tx.currency, tx.type, isNegative),
        date: formatDate(tx.createdAt),
        details: {
          transactionId: tx.transactionId || tx._id,
          currency: tx.currency,
          network: tx.network,
          address: tx.address,
          hash: tx.hash,
          fee: tx.fee,
          narration: tx.narration
        }
      };
    });

    return res.status(200).json({
      success: true,
      message: `${currency.toUpperCase()} transaction history retrieved successfully`,
      data: {
        transactions: formattedTokenTransactions,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalCount / limit),
          totalCount,
          limit: parseInt(limit)
        },
        dateRange: {
          dateFrom,
          dateTo
        }
      }
    });

  } catch (error) {
    logger.error('Error fetching token-specific transactions', {
      userId: req.user?.id,
      currency: req.body?.currency,
      error: error.message
    });

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// POST /api/transactions/all-tokens - Get ALL token transactions
router.post('/all-tokens', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    // Simple validation with defaults
    const body = req.body || {};
    const {
      type,
      status,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = body;

    // Get date range
    const defaultRange = getDefaultDateRange();
    const dateFrom = body.dateFrom || defaultRange.dateFrom;
    const dateTo = body.dateTo || defaultRange.dateTo;

    // Build filter
    const filter = { userId: userId };
    
    // Add date range filter
    Object.assign(filter, buildDateRangeFilter(dateFrom, dateTo));

    if (type) {
      switch (type.toUpperCase()) {
        case 'DEPOSIT':
          filter.type = { $in: ['DEPOSIT', 'INTERNAL_TRANSFER_RECEIVED'] };
          break;
        case 'WITHDRAWAL':
          filter.type = { $in: ['WITHDRAWAL', 'INTERNAL_TRANSFER_SENT'] };
          break;
        case 'SWAP':
          filter.type = 'SWAP';
          break;
      }
    }
    
    if (status) {
      switch (status.toLowerCase()) {
        case 'successful':
          filter.status = { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] };
          break;
        case 'failed':
          filter.status = { $in: ['FAILED', 'REJECTED'] };
          break;
        case 'pending':
          filter.status = { $in: ['PENDING', 'PROCESSING', 'APPROVED'] };
          break;
      }
    }

    // Pagination
    const skip = (page - 1) * limit;
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Get transactions
    const [transactions, totalCount] = await Promise.all([
      Transaction.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Transaction.countDocuments(filter)
    ]);

    // Format transactions
    const formattedAllTokens = transactions.map(tx => {
      const isNegative = tx.type === 'WITHDRAWAL' || tx.type === 'INTERNAL_TRANSFER_SENT';
      
      return {
        id: tx._id,
        type: formatTransactionType(tx.type),
        status: formatStatus(tx.status),
        amount: formatAmount(tx.amount, tx.currency, tx.type, isNegative),
        date: formatDate(tx.createdAt),
        details: {
          transactionId: tx.transactionId || tx._id,
          currency: tx.currency,
          network: tx.network,
          address: tx.address,
          hash: tx.hash,
          fee: tx.fee,
          narration: tx.narration
        }
      };
    });

    return res.status(200).json({
      success: true,
      message: 'All token transaction history retrieved successfully',
      data: {
        transactions: formattedAllTokens,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalCount / limit),
          totalCount,
          limit: parseInt(limit)
        },
        dateRange: {
          dateFrom,
          dateTo
        }
      }
    });

  } catch (error) {
    logger.error('Error fetching all token transactions', {
      userId: req.user?.id,
      error: error.message
    });

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// POST /api/transactions/all-utilities - Get ALL utility transactions
router.post('/all-utilities', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    // Simple validation with defaults
    const body = req.body || {};
    const {
      utilityType,
      status,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = body;

    // Get date range
    const defaultRange = getDefaultDateRange();
    const dateFrom = body.dateFrom || defaultRange.dateFrom;
    const dateTo = body.dateTo || defaultRange.dateTo;

    // Build filter
    const filter = { userId: userId };
    
    // Add date range filter
    Object.assign(filter, buildDateRangeFilter(dateFrom, dateTo));

    // Add utility type filter if specified
    if (utilityType) {
      filter.billType = utilityType.toLowerCase();
    }

    // Map status to bill transaction statuses
    if (status) {
      switch (status.toLowerCase()) {
        case 'successful':
          filter.status = 'completed-api';
          break;
        case 'failed':
          filter.status = 'failed';
          break;
        case 'pending':
          filter.status = { $in: ['initiated-api', 'processing-api'] };
          break;
      }
    }

    // Pagination
    const skip = (page - 1) * limit;
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Get transactions
    const [transactions, totalCount] = await Promise.all([
      BillTransaction.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      BillTransaction.countDocuments(filter)
    ]);

    // Format transactions
    const formattedUtilities = transactions.map(tx => {
      const amount = tx.amountNGNB || tx.amountNaira;
      
      return {
        id: tx._id,
        type: formatBillType(tx.billType),
        utilityType: tx.billType,
        status: formatStatus(tx.status, 'bill'),
        amount: `₦${amount.toLocaleString()}`,
        date: formatDate(tx.createdAt),
        details: {
          orderId: tx.orderId,
          requestId: tx.requestId,
          productName: tx.productName,
          quantity: tx.quantity,
          network: tx.network,
          customerInfo: tx.customerInfo?.phone || tx.customerPhone,
          billType: tx.billType,
          paymentCurrency: tx.paymentCurrency
        }
      };
    });

    return res.status(200).json({
      success: true,
      message: 'All utility transaction history retrieved successfully',
      data: {
        transactions: formattedUtilities,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalCount / limit),
          totalCount,
          limit: parseInt(limit)
        },
        dateRange: {
          dateFrom,
          dateTo
        }
      }
    });

  } catch (error) {
    logger.error('Error fetching all utility transactions', {
      userId: req.user?.id,
      error: error.message
    });

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// POST /api/transactions/complete-history - Get ALL transactions (tokens + utilities combined)
router.post('/complete-history', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    // Simple validation with defaults
    const body = req.body || {};
    const {
      transactionType = 'all',
      status,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = body;

    // Get date range
    const defaultRange = getDefaultDateRange();
    const dateFrom = body.dateFrom || defaultRange.dateFrom;
    const dateTo = body.dateTo || defaultRange.dateTo;

    let allTransactions = [];
    let totalCount = 0;

    // Build date range filter
    const dateRangeFilter = buildDateRangeFilter(dateFrom, dateTo);

    // Build queries for both transaction types
    const tokenFilter = { userId: userId, ...dateRangeFilter };
    const billFilter = { userId: userId, ...dateRangeFilter };

    // Apply status filters
    if (status) {
      switch (status.toLowerCase()) {
        case 'successful':
          tokenFilter.status = { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] };
          billFilter.status = 'completed-api';
          break;
        case 'failed':
          tokenFilter.status = { $in: ['FAILED', 'REJECTED'] };
          billFilter.status = 'failed';
          break;
        case 'pending':
          tokenFilter.status = { $in: ['PENDING', 'PROCESSING', 'APPROVED'] };
          billFilter.status = { $in: ['initiated-api', 'processing-api'] };
          break;
      }
    }

    // Fetch token transactions
    if (transactionType === 'all' || transactionType === 'token') {
      const [tokenTxs, tokenCount] = await Promise.all([
        Transaction.find(tokenFilter).lean(),
        Transaction.countDocuments(tokenFilter)
      ]);

      const formattedTokens = tokenTxs.map(tx => {
        const isNegative = tx.type === 'WITHDRAWAL' || tx.type === 'INTERNAL_TRANSFER_SENT';
        
        return {
          id: tx._id,
          type: formatTransactionType(tx.type),
          status: formatStatus(tx.status),
          amount: formatAmount(tx.amount, tx.currency, tx.type, isNegative),
          date: formatDate(tx.createdAt),
          createdAt: tx.createdAt,
          details: {
            transactionId: tx.transactionId || tx._id,
            category: 'token',
            currency: tx.currency,
            network: tx.network,
            address: tx.address,
            hash: tx.hash,
            fee: tx.fee,
            narration: tx.narration
          }
        };
      });

      allTransactions = [...allTransactions, ...formattedTokens];
      totalCount += tokenCount;
    }

    // Fetch utility transactions
    if (transactionType === 'all' || transactionType === 'utility') {
      const [billTxs, billCount] = await Promise.all([
        BillTransaction.find(billFilter).lean(),
        BillTransaction.countDocuments(billFilter)
      ]);

      const formattedBills = billTxs.map(tx => {
        const amount = tx.amountNGNB || tx.amountNaira;
        
        return {
          id: tx._id,
          type: formatBillType(tx.billType),
          status: formatStatus(tx.status, 'bill'),
          amount: `₦${amount.toLocaleString()}`,
          date: formatDate(tx.createdAt),
          createdAt: tx.createdAt,
          details: {
            orderId: tx.orderId,
            category: 'utility',
            billType: tx.billType,
            productName: tx.productName,
            network: tx.network,
            customerInfo: tx.customerInfo?.phone || tx.customerPhone
          }
        };
      });

      allTransactions = [...allTransactions, ...formattedBills];
      totalCount += billCount;
    }

    // Sort transactions
    allTransactions.sort((a, b) => {
      if (sortOrder === 'asc') {
        return new Date(a.createdAt) - new Date(b.createdAt);
      } else {
        return new Date(b.createdAt) - new Date(a.createdAt);
      }
    });

    // Apply pagination
    const skip = (page - 1) * limit;
    const paginatedTransactions = allTransactions.slice(skip, skip + limit);

    // Remove createdAt field from final response
    paginatedTransactions.forEach(tx => delete tx.createdAt);

    return res.status(200).json({
      success: true,
      message: 'Complete transaction history retrieved successfully',
      data: {
        transactions: paginatedTransactions,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalCount / limit),
          totalCount,
          limit: parseInt(limit)
        },
        dateRange: {
          dateFrom,
          dateTo
        }
      }
    });

  } catch (error) {
    logger.error('Error fetching complete transaction history', {
      userId: req.user?.id,
      error: error.message
    });

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;