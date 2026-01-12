const express = require('express');
const router = express.Router();
const Transaction = require('../models/transaction');
const BillTransaction = require('../models/billstransaction');
const logger = require('../utils/logger');

// ----------------- helpers added (updated) -----------------
function firstTruthy(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && `${v}`.trim() !== '') return v;
  }
  return undefined;
}

function shapeTokenDetails(tx) {
  const network = firstTruthy(
    tx.network, tx.networkName, tx.network_code,
    tx.chain, tx.blockchain, tx.chainName, tx.chain_id, tx.chainId,
    tx?.metadata?.network, tx?.metadata?.chain
  );

  const address = firstTruthy(
    tx.address, tx.walletAddress,
    tx.to, tx.toAddress, tx.receivingAddress, tx.recipient, tx.recipientAddress, tx.destination, tx.destinationAddress,
    tx.from, tx.fromAddress, tx.source, tx.sourceAddress,
    tx?.metadata?.address
  );

  const hash = firstTruthy(
    tx.hash, tx.txHash, tx.transactionHash,
    tx.txid, tx.txId, tx.transaction_id, tx.transactionIdOnChain,
    tx?.metadata?.txHash, tx?.metadata?.hash
  );

  const fee = firstTruthy(tx.fee, tx.networkFee, tx.gasFee, tx.txFee, tx?.metadata?.fee, 0);
  const narration = firstTruthy(tx.narration, tx.note, tx.description, tx.memo, tx.reason);

  // Base details for all token transactions
  const baseDetails = {
    category: 'token',
    transactionId: firstTruthy(tx.transactionId, tx.obiexTransactionId, tx.reference, tx.externalId, tx.id, tx._id),
    currency: tx.currency,
    network,
    address,
    hash,
    fee,
    narration,
    createdAt: tx.createdAt,
  };

  // Add swap fields directly for SWAP transactions
  if (tx.type === 'SWAP') {
    baseDetails.fromAmount = tx.fromAmount;
    baseDetails.fromCurrency = tx.fromCurrency;
    baseDetails.toAmount = tx.toAmount;
    baseDetails.toCurrency = tx.toCurrency;
    baseDetails.exchangeRate = tx.exchangeRate;
  }

  // Enhanced details for NGNZ withdrawals
  if (tx.isNGNZWithdrawal && tx.type === 'WITHDRAWAL') {
    return {
      ...baseDetails,
      category: 'withdrawal',
      // Include receipt details if available
      ...(tx.receiptDetails && {
        receiptDetails: tx.receiptDetails,
        reference: tx.receiptDetails.reference || tx.reference,
        provider: tx.receiptDetails.provider,
        providerStatus: tx.receiptDetails.providerStatus,
        bankName: tx.receiptDetails.bankName,
        accountName: tx.receiptDetails.accountName,
        accountNumber: tx.receiptDetails.accountNumber, // ✅ Unmasked
        withdrawalFee: tx.receiptDetails.fee,
      }),
      // NGNZ withdrawal specific fields
      ...(tx.ngnzWithdrawal && {
        bankAmount: tx.bankAmount,
        withdrawalFee: tx.withdrawalFee,
        amountSentToBank: tx.ngnzWithdrawal.amountSentToBank,
        destination: tx.ngnzWithdrawal.destination,
        obiexDetails: tx.ngnzWithdrawal.obiex,
        withdrawalReference: tx.ngnzWithdrawal.withdrawalReference,
        payoutCurrency: tx.payoutCurrency || tx.ngnzWithdrawal.payoutCurrency,
      }),
      hasReceiptData: !!(tx.receiptDetails || tx.isNGNZWithdrawal),
      isNGNZWithdrawal: true,
    };
  }

  return baseDetails;
}

function shapeGiftCardDetails(tx) {
  // Extract giftcard-specific data if the giftCardId is populated
  const giftcard = tx.giftCardId;

  return {
    category: 'giftcard',
    giftCardId: giftcard?._id || tx.giftCardId,
    cardType: tx.cardType || giftcard?.cardType,
    cardFormat: tx.cardFormat || giftcard?.cardFormat,
    cardRange: tx.cardRange || giftcard?.cardRange,
    country: tx.country || giftcard?.country,
    description: tx.description || giftcard?.description,
    expectedRate: tx.expectedRate || giftcard?.expectedRate,
    expectedRateDisplay: tx.expectedRateDisplay || giftcard?.expectedRateDisplay,
    expectedAmountToReceive: tx.expectedAmountToReceive || giftcard?.expectedAmountToReceive,
    expectedSourceCurrency: tx.expectedSourceCurrency || giftcard?.expectedSourceCurrency,
    expectedTargetCurrency: tx.expectedTargetCurrency || giftcard?.expectedTargetCurrency,
    eCode: tx.eCode || giftcard?.eCode,
    totalImages: tx.totalImages || giftcard?.totalImages,
    imageUrls: tx.imageUrls || giftcard?.imageUrls,
    imagePublicIds: tx.imagePublicIds || giftcard?.imagePublicIds,
    transactionId: firstTruthy(tx.transactionId, tx.reference, tx.externalId, tx.id, tx._id),
    createdAt: tx.createdAt,
    // Include the actual giftcard status for reference
    giftcardStatus: giftcard?.status,
    rejectionReason: giftcard?.rejectionReason,
    reviewNotes: giftcard?.reviewNotes
  };
}

/**
 * Enhanced transaction formatter that includes receipt data for withdrawals
 */
function formatTransactionWithReceipt(tx, isNegative = false) {
  const createdAtISO = new Date(tx.createdAt).toISOString();
  
  const baseTransaction = {
    id: tx._id,
    type: formatTransactionType(tx.type),
    status: formatStatus(tx.status),
    amount: formatAmount(tx.amount, tx.currency, tx.type, isNegative),
    date: formatDate(tx.createdAt),
    createdAt: createdAtISO,
    details: shapeTokenDetails(tx)
  };

  // Add receipt data for NGNZ withdrawals if available
  if (tx.isNGNZWithdrawal && tx.type === 'WITHDRAWAL') {
    baseTransaction.receiptData = tx.getReceiptData ? tx.getReceiptData() : null;
    baseTransaction.currency = tx.currency;
    baseTransaction.isNGNZWithdrawal = true;
    
    if (tx.ngnzWithdrawal || tx.receiptDetails) {
      baseTransaction.bankName = tx.receiptDetails?.bankName || tx.ngnzWithdrawal?.destination?.bankName;
      // ✅ CHANGED: Use unmasked account number
      baseTransaction.accountNumber = tx.receiptDetails?.accountNumber || tx.ngnzWithdrawal?.destination?.accountNumber;
      baseTransaction.accountName = tx.receiptDetails?.accountName || tx.ngnzWithdrawal?.destination?.accountName;
      baseTransaction.withdrawalFee = tx.withdrawalFee || tx.ngnzWithdrawal?.withdrawalFee;
      baseTransaction.amountSentToBank = tx.bankAmount || tx.ngnzWithdrawal?.amountSentToBank;
    }
  }

  return baseTransaction;
}

// ------------------------------------------------------

// Helper function to build date range filter
function buildDateRangeFilter(dateFrom, dateTo) {
  const filter = {};
  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
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
    'SWAP': 'Swap',
    'GIFTCARD': 'Gift Card'
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
      case 'completed': return 'Successful';
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
  const sign = isNegative ? '-' : (type === 'SWAP' && amount > 0 ? '+' : '');
  const absAmount = Math.abs(amount);

  if (currency === 'NGNB' || currency === 'NGNZ') {
    return `${sign}₦${absAmount.toLocaleString()}`;
  }

  // For crypto, always use toFixed(8) to show full decimals without scientific notation
  const formattedAmount = absAmount.toFixed(8);
  return `${sign}${formattedAmount} ${currency}`;
}

function formatDate(date) {
  return new Date(date).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Africa/Lagos'
  });
}

// POST /api/transactions/token-specific - Get transactions for specific currency
router.post('/token-specific', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

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
      return res.status(400).json({ success: false, message: 'Currency is required' });
    }

    const defaultRange = getDefaultDateRange();
    const dateFrom = body.dateFrom || defaultRange.dateFrom;
    const dateTo = body.dateTo || defaultRange.dateTo;

    const filter = { 
      userId: userId, 
      currency: currency.toUpperCase(),
      type: { $ne: 'OBIEX_SWAP' }
    };
    Object.assign(filter, buildDateRangeFilter(dateFrom, dateTo));

    if (type) {
      switch (type.toUpperCase()) {
        case 'DEPOSIT': 
          filter.type = { $in: ['DEPOSIT', 'INTERNAL_TRANSFER_RECEIVED'], $ne: 'OBIEX_SWAP' }; 
          break;
        case 'WITHDRAWAL': 
          filter.type = { $in: ['WITHDRAWAL', 'INTERNAL_TRANSFER_SENT'], $ne: 'OBIEX_SWAP' }; 
          break;
        case 'SWAP': 
          filter.type = 'SWAP'; 
          break;
        case 'GIFTCARD':
          filter.type = 'GIFTCARD';
          break;
      }
    }
    if (status) {
      switch (status.toLowerCase()) {
        case 'successful': filter.status = { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] }; break;
        case 'failed': filter.status = { $in: ['FAILED', 'REJECTED'] }; break;
        case 'pending': filter.status = { $in: ['PENDING', 'PROCESSING', 'APPROVED'] }; break;
      }
    }

    const skip = (page - 1) * limit;
    const sort = {}; sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const [transactions, totalCount] = await Promise.all([
      Transaction.find(filter).sort(sort).skip(skip).limit(parseInt(limit)),
      Transaction.countDocuments(filter)
    ]);

    const formattedTokenTransactions = transactions.map(tx => {
      const isNegative = tx.type === 'WITHDRAWAL' || tx.type === 'INTERNAL_TRANSFER_SENT' || tx.type === 'GIFTCARD';
      const createdAtISO = new Date(tx.createdAt).toISOString();
      
      if (tx.type === 'GIFTCARD') {
        return {
          id: tx._id,
          type: formatTransactionType(tx.type),
          status: formatStatus(tx.status),
          amount: formatAmount(Math.abs(tx.amount), tx.currency, tx.type, true),
          date: formatDate(tx.createdAt),
          createdAt: createdAtISO,
          currency: tx.currency,
          cardType: tx.cardType,
          cardFormat: tx.cardFormat,
          cardRange: tx.cardRange,
          country: tx.country,
          details: shapeGiftCardDetails(tx.toObject())
        };
      }
      
      return formatTransactionWithReceipt(tx.toObject(), isNegative);
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
        dateRange: { dateFrom, dateTo }
      }
    });
  } catch (error) {
    logger.error('Error fetching token-specific transactions', {
      userId: req.user?.id,
      currency: req.body?.currency,
      error: error.message
    });
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/transactions/all-tokens - Get ALL token transactions
router.post('/all-tokens', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const body = req.body || {};
    const {
      type,
      status,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = body;

    const defaultRange = getDefaultDateRange();
    const dateFrom = body.dateFrom || defaultRange.dateFrom;
    const dateTo = body.dateTo || defaultRange.dateTo;

    const filter = { 
      userId: userId,
      type: { $ne: 'OBIEX_SWAP' }
    };
    Object.assign(filter, buildDateRangeFilter(dateFrom, dateTo));

    if (type) {
      switch (type.toUpperCase()) {
        case 'DEPOSIT': 
          filter.type = { $in: ['DEPOSIT', 'INTERNAL_TRANSFER_RECEIVED'], $ne: 'OBIEX_SWAP' }; 
          break;
        case 'WITHDRAWAL': 
          filter.type = { $in: ['WITHDRAWAL', 'INTERNAL_TRANSFER_SENT'], $ne: 'OBIEX_SWAP' }; 
          break;
        case 'SWAP': 
          filter.type = 'SWAP'; 
          break;
        case 'GIFTCARD':
          filter.type = 'GIFTCARD';
          break;
      }
    }
    if (status) {
      switch (status.toLowerCase()) {
        case 'successful': filter.status = { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] }; break;
        case 'failed': filter.status = { $in: ['FAILED', 'REJECTED'] }; break;
        case 'pending': filter.status = { $in: ['PENDING', 'PROCESSING', 'APPROVED'] }; break;
      }
    }

    const skip = (page - 1) * limit;
    const sort = {}; sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const [transactions, totalCount] = await Promise.all([
      Transaction.find(filter).sort(sort).skip(skip).limit(parseInt(limit)),
      Transaction.countDocuments(filter)
    ]);

    const formattedAllTokens = transactions.map(tx => {
      const isNegative = tx.type === 'WITHDRAWAL' || tx.type === 'INTERNAL_TRANSFER_SENT' || tx.type === 'GIFTCARD';
      const createdAtISO = new Date(tx.createdAt).toISOString();
      
      if (tx.type === 'GIFTCARD') {
        return {
          id: tx._id,
          type: formatTransactionType(tx.type),
          status: formatStatus(tx.status),
          amount: formatAmount(Math.abs(tx.amount), tx.currency, tx.type, true),
          date: formatDate(tx.createdAt),
          createdAt: createdAtISO,
          currency: tx.currency,
          cardType: tx.cardType,
          details: shapeGiftCardDetails(tx.toObject())
        };
      }
      
      return formatTransactionWithReceipt(tx.toObject(), isNegative);
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
        dateRange: { dateFrom, dateTo }
      }
    });
  } catch (error) {
    logger.error('Error fetching all token transactions', {
      userId: req.user?.id,
      error: error.message
    });
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/transactions/all-utilities - Get ALL utility transactions
router.post('/all-utilities', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const body = req.body || {};
    const {
      utilityType,
      status,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = body;

    const defaultRange = getDefaultDateRange();
    const dateFrom = body.dateFrom || defaultRange.dateFrom;
    const dateTo = body.dateTo || defaultRange.dateTo;

    const filter = { userId: userId };
    Object.assign(filter, buildDateRangeFilter(dateFrom, dateTo));

    if (utilityType) filter.billType = utilityType.toLowerCase();

    if (status) {
      switch (status.toLowerCase()) {
        case 'successful': filter.status = 'completed'; break;  // ✅ FIXED: Use 'completed' not 'completed-api'
        case 'failed': filter.status = 'failed'; break;
        case 'pending': filter.status = { $in: ['initiated-api', 'processing-api'] }; break;
      }
    }

    const skip = (page - 1) * limit;
    const sort = {}; sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const [transactions, totalCount] = await Promise.all([
      BillTransaction.find(filter).sort(sort).skip(skip).limit(parseInt(limit)).lean(),
      BillTransaction.countDocuments(filter)
    ]);

    const formattedUtilities = transactions.map(tx => {
      const amount = tx.amountNGNB || tx.amountNaira;
      const createdAtISO = new Date(tx.createdAt).toISOString();
      return {
        id: tx._id,
        type: formatBillType(tx.billType),
        utilityType: tx.billType,
        status: formatStatus(tx.status, 'bill'),
        amount: `₦${amount.toLocaleString()}`,
        date: formatDate(tx.createdAt),
        createdAt: createdAtISO,
        details: {
          orderId: tx.orderId,
          requestId: tx.requestId,
          productName: tx.productName,
          quantity: tx.quantity,
          network: tx.network,
          customerInfo: tx.customerInfo?.phone || tx.customerPhone,
          billType: tx.billType,
          paymentCurrency: tx.paymentCurrency,
          category: 'utility'
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
        dateRange: { dateFrom, dateTo }
      }
    });
  } catch (error) {
    logger.error('Error fetching all utility transactions', {
      userId: req.user?.id,
      error: error.message
    });
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/transactions/gift-cards - Get ALL gift card transactions
router.post('/gift-cards', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const body = req.body || {};
    const {
      status,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = body;

    const defaultRange = getDefaultDateRange();
    const dateFrom = body.dateFrom || defaultRange.dateFrom;
    const dateTo = body.dateTo || defaultRange.dateTo;

    const filter = { 
      userId: userId,
      type: 'GIFTCARD'
    };
    Object.assign(filter, buildDateRangeFilter(dateFrom, dateTo));

    if (status) {
      switch (status.toLowerCase()) {
        case 'successful': filter.status = { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] }; break;
        case 'failed': filter.status = { $in: ['FAILED', 'REJECTED'] }; break;
        case 'pending': filter.status = { $in: ['PENDING', 'PROCESSING', 'APPROVED'] }; break;
      }
    }

    const skip = (page - 1) * limit;
    const sort = {}; sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const [transactions, totalCount] = await Promise.all([
      Transaction.find(filter).populate('giftCardId').sort(sort).skip(skip).limit(parseInt(limit)).lean(),
      Transaction.countDocuments(filter)
    ]);

    const formattedGiftCards = transactions.map(tx => {
      const amount = Math.abs(tx.amount);
      const createdAtISO = new Date(tx.createdAt).toISOString();
      // Use the populated GiftCard status if available, otherwise fall back to transaction status
      const giftcardStatus = tx.giftCardId?.status || tx.status;

      return {
        id: tx._id,
        type: 'Gift Card',
        status: formatStatus(giftcardStatus),
        amount: formatAmount(amount, tx.currency, tx.type, true),
        date: formatDate(tx.createdAt),
        createdAt: createdAtISO,
        currency: tx.currency,
        cardType: tx.cardType,
        cardFormat: tx.cardFormat,
        cardRange: tx.cardRange,
        country: tx.country,
        giftcardStatus: giftcardStatus, // Include the actual giftcard status for debugging
        details: shapeGiftCardDetails(tx)
      };
    });

    return res.status(200).json({
      success: true,
      message: 'Gift card transaction history retrieved successfully',
      data: {
        transactions: formattedGiftCards,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalCount / limit),
          totalCount,
          limit: parseInt(limit)
        },
        dateRange: { dateFrom, dateTo }
      }
    });
  } catch (error) {
    logger.error('Error fetching gift card transactions', {
      userId: req.user?.id,
      error: error.message
    });
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/transactions/complete-history - Get ALL transactions (tokens + utilities + gift cards combined)
router.post('/complete-history', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const body = req.body || {};
    const {
      transactionType = 'all',
      type,
      status,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = body;

    const defaultRange = getDefaultDateRange();
    const dateFrom = body.dateFrom || defaultRange.dateFrom;
    const dateTo = body.dateTo || defaultRange.dateTo;

    let allTransactions = [];
    let totalCount = 0;

    const dateRangeFilter = buildDateRangeFilter(dateFrom, dateTo);
    const tokenFilter = { 
      userId: userId, 
      type: { $ne: 'OBIEX_SWAP' },
      ...dateRangeFilter 
    };
    const billFilter  = { userId: userId, ...dateRangeFilter };

    if (type) {
      switch (type.toUpperCase()) {
        case 'DEPOSIT': 
          tokenFilter.type = { $in: ['DEPOSIT', 'INTERNAL_TRANSFER_RECEIVED'], $ne: 'OBIEX_SWAP' }; 
          break;
        case 'WITHDRAWAL': 
          tokenFilter.type = { $in: ['WITHDRAWAL', 'INTERNAL_TRANSFER_SENT'], $ne: 'OBIEX_SWAP' }; 
          break;
        case 'SWAP': 
          tokenFilter.type = 'SWAP'; 
          break;
        case 'GIFTCARD':
          tokenFilter.type = 'GIFTCARD';
          break;
      }
    }

    if (status) {
      switch (status.toLowerCase()) {
        case 'successful':
          tokenFilter.status = { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] };
          billFilter.status = 'completed';
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

    const billCategories = ['AIRTIME', 'DATA', 'CABLE', 'ELECTRICITY'];
    const shouldFetchTokens = !type || ['DEPOSIT', 'WITHDRAWAL', 'SWAP', 'GIFTCARD'].includes(type.toUpperCase());
    const shouldFetchBills = !type || billCategories.includes(type.toUpperCase());

    if ((transactionType === 'all' || transactionType === 'token') && shouldFetchTokens) {
      const [tokenTxs, tokenCount] = await Promise.all([
        Transaction.find(tokenFilter).populate('giftCardId'),
        Transaction.countDocuments(tokenFilter)
      ]);
      const formattedTokens = tokenTxs.map(tx => {
        const isNegative = tx.type === 'WITHDRAWAL' || tx.type === 'INTERNAL_TRANSFER_SENT' || tx.type === 'GIFTCARD';
        const createdAtISO = new Date(tx.createdAt).toISOString();
        
        if (tx.type === 'GIFTCARD') {
          // Use the populated GiftCard status if available, otherwise fall back to transaction status
          const giftcardStatus = tx.giftCardId?.status || tx.status;

          return {
            id: tx._id,
            type: 'Gift Card',
            status: formatStatus(giftcardStatus),
            amount: formatAmount(Math.abs(tx.amount), tx.currency, tx.type, true),
            date: formatDate(tx.createdAt),
            createdAt: createdAtISO,
            currency: tx.currency,
            cardType: tx.cardType,
            giftcardStatus: giftcardStatus, // Include the actual giftcard status for debugging
            details: shapeGiftCardDetails(tx.toObject())
          };
        }
        
        return formatTransactionWithReceipt(tx.toObject(), isNegative);
      });
      allTransactions = [...allTransactions, ...formattedTokens];
      totalCount += tokenCount;
    }

    if ((transactionType === 'all' || transactionType === 'utility') && shouldFetchBills) {
      const [billTxs, billCount] = await Promise.all([
        BillTransaction.find(billFilter).lean(),
        BillTransaction.countDocuments(billFilter)
      ]);
      const formattedBills = billTxs.map(tx => {
        const amount = tx.amountNGNB || tx.amountNaira;
        const createdAtISO = new Date(tx.createdAt).toISOString();
        
        // Build details object
        const details = {
          orderId: tx.orderId,
          category: 'utility',
          billType: tx.billType,
          productName: tx.productName,
          network: tx.network,
          customerInfo: tx.customerInfo?.phone || tx.customerPhone
        };

        // Add electricity-specific details (token, units, band)
        if (tx.billType === 'electricity' && tx.metaData) {
          console.log('🔍 Electricity transaction metaData:', {
            transactionId: tx._id,
            billType: tx.billType,
            metaData: tx.metaData,
            hasToken: !!(tx.metaData.token),
            tokenValue: tx.metaData.token
          });
          if (tx.metaData.token) {
            details.token = tx.metaData.token;
          }
          if (tx.metaData.units) {
            details.units = tx.metaData.units;
          }
          if (tx.metaData.band) {
            details.band = tx.metaData.band;
          }
          if (tx.metaData.customer_name) {
            details.customerName = tx.metaData.customer_name;
          }
          if (tx.metaData.customer_address) {
            details.customerAddress = tx.metaData.customer_address;
          }
        }

        const formattedTx = {
          id: tx._id,
          type: formatBillType(tx.billType),
          status: formatStatus(tx.status, 'bill'),
          amount: `₦${amount.toLocaleString()}`,
          date: formatDate(tx.createdAt),
          createdAt: createdAtISO,
          details
        };

        // Debug: Log what's being sent to frontend for electricity transactions
        if (tx.billType === 'electricity') {
          console.log('🔍 Sending electricity transaction to frontend:', {
            transactionId: formattedTx.id,
            hasDetailsToken: !!(formattedTx.details?.token),
            detailsToken: formattedTx.details?.token,
            detailsKeys: Object.keys(formattedTx.details || {})
          });
        }

        return formattedTx;
      });
      allTransactions = [...allTransactions, ...formattedBills];
      totalCount += billCount;
    }

    allTransactions.sort((a, b) => {
      return sortOrder === 'asc'
        ? new Date(a.createdAt) - new Date(b.createdAt)
        : new Date(b.createdAt) - new Date(a.createdAt);
    });

    const skip = (page - 1) * limit;
    const paginatedTransactions = allTransactions.slice(skip, skip + limit);

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
        dateRange: { dateFrom, dateTo }
      }
    });
  } catch (error) {
    logger.error('Error fetching complete transaction history', {
      userId: req.user?.id,
      error: error.message
    });
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ✅ UPDATED: NGNZ withdrawals endpoint with full unmasked account numbers
router.post('/ngnz-withdrawals', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const body = req.body || {};
    const {
      status,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = body;

    const defaultRange = getDefaultDateRange();
    const dateFrom = body.dateFrom || defaultRange.dateFrom;
    const dateTo = body.dateTo || defaultRange.dateTo;

    const filter = { 
      userId: userId,
      currency: 'NGNZ',
      type: 'WITHDRAWAL',
      isNGNZWithdrawal: true
    };
    Object.assign(filter, buildDateRangeFilter(dateFrom, dateTo));

    if (status) {
      switch (status.toLowerCase()) {
        case 'successful': filter.status = { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] }; break;
        case 'failed': filter.status = { $in: ['FAILED', 'REJECTED'] }; break;
        case 'pending': filter.status = { $in: ['PENDING', 'PROCESSING', 'APPROVED'] }; break;
      }
    }

    const skip = (page - 1) * limit;
    const sort = {}; sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const [transactions, totalCount] = await Promise.all([
      Transaction.find(filter).sort(sort).skip(skip).limit(parseInt(limit)),
      Transaction.countDocuments(filter)
    ]);

    const formattedWithdrawals = transactions.map(tx => {
      const txObj = tx.toObject();
      const createdAtISO = new Date(tx.createdAt).toISOString();
      
      return {
        id: tx._id,
        type: 'Withdrawal',
        status: formatStatus(tx.status),
        amount: formatAmount(tx.amount, tx.currency, tx.type, true),
        date: formatDate(tx.createdAt),
        createdAt: createdAtISO,
        currency: tx.currency,
        
        // ✅ CHANGED: Use unmasked account number
        withdrawalReference: tx.reference || tx.ngnzWithdrawal?.withdrawalReference,
        bankName: tx.receiptDetails?.bankName || tx.ngnzWithdrawal?.destination?.bankName,
        accountName: tx.receiptDetails?.accountName || tx.ngnzWithdrawal?.destination?.accountName,
        accountNumber: tx.receiptDetails?.accountNumber || tx.ngnzWithdrawal?.destination?.accountNumber,
        amountSentToBank: tx.bankAmount || tx.ngnzWithdrawal?.amountSentToBank,
        withdrawalFee: tx.withdrawalFee || tx.ngnzWithdrawal?.withdrawalFee || 30,
        provider: tx.receiptDetails?.provider || tx.ngnzWithdrawal?.provider || 'OBIEX',
        providerStatus: tx.receiptDetails?.providerStatus || tx.ngnzWithdrawal?.obiex?.status,
        
        details: {
          ...shapeTokenDetails(txObj),
          category: 'withdrawal',
          isNGNZWithdrawal: true,
          hasReceiptData: true
        },
        
        receiptData: tx.getReceiptData ? tx.getReceiptData() : null,
        raw: txObj
      };
    });

    return res.status(200).json({
      success: true,
      message: 'NGNZ withdrawal history retrieved successfully',
      data: {
        transactions: formattedWithdrawals,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalCount / limit),
          totalCount,
          limit: parseInt(limit)
        },
        dateRange: { dateFrom, dateTo }
      }
    });
  } catch (error) {
    logger.error('Error fetching NGNZ withdrawal transactions', {
      userId: req.user?.id,
      error: error.message
    });
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;