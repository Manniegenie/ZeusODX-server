const express = require('express');
const axios = require('axios');
const router = express.Router();

const User = require('../models/user');
const Transaction = require('../models/transaction');
const { validateUserBalance } = require('../services/balance');
const CryptoFeeMarkup = require('../models/cryptofee');

const { reserveUserBalance, getPricesWithCache, SUPPORTED_TOKENS } = require('../services/portfolio');
const { validateObiexConfig, attachObiexAuth } = require('../utils/obiexAuth');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const logger = require('../utils/logger');
const config = require('./config');

// Configure Obiex axios instance
const obiexAxios = axios.create({
  baseURL: config.obiex.baseURL.replace(/\/+$/, ''),
  timeout: 30000, // 30 second timeout
});
obiexAxios.interceptors.request.use(attachObiexAuth);

// Withdrawal configuration constants
const WITHDRAWAL_CONFIG = {
  MAX_PENDING_WITHDRAWALS: 5,
  DUPLICATE_CHECK_WINDOW: 30 * 60 * 1000, // 30 minutes
  AMOUNT_PRECISION: 9,
  MIN_CONFIRMATION_BLOCKS: {
    BTC: 1,
    ETH: 12,
    SOL: 32,
    USDT: 12,
    USDC: 12,
    BNB: 15,
  },
};

/**
 * Validates withdrawal request parameters
 * @param {Object} body - Request body
 * @returns {Object} Validation result
 */
function validateWithdrawalRequest(body) {
  const { destination = {}, amount, currency, twoFactorCode } = body;
  const { address, network } = destination;

  const errors = [];

  // Required fields validation
  if (!address?.trim()) {
    errors.push('Withdrawal address is required');
  }
  if (!amount) {
    errors.push('Withdrawal amount is required');
  }
  if (!currency?.trim()) {
    errors.push('Currency is required');
  }
  if (!twoFactorCode?.trim()) {
    errors.push('Two-factor authentication code is required');
  }

  // Amount validation
  const numericAmount = Number(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) {
    errors.push('Invalid withdrawal amount. Amount must be a positive number.');
  }

  // Currency support validation
  const upperCurrency = currency?.toUpperCase();
  if (upperCurrency && !SUPPORTED_TOKENS[upperCurrency]) {
    errors.push(`Currency ${upperCurrency} is not supported. Supported currencies: ${Object.keys(SUPPORTED_TOKENS).join(', ')}`);
  }

  // Address format validation (basic)
  if (address && address.length < 10) {
    errors.push('Invalid withdrawal address format');
  }

  // Network validation for multi-network tokens
  if (upperCurrency === 'USDT' && network && !['ERC20', 'TRC20', 'BEP20'].includes(network.toUpperCase())) {
    errors.push('Invalid network for USDT. Supported networks: ERC20, TRC20, BEP20');
  }

  if (errors.length > 0) {
    return {
      success: false,
      errors,
      message: errors.join('; ')
    };
  }

  return {
    success: true,
    validatedData: {
      address: address.trim(),
      amount: numericAmount,
      currency: upperCurrency,
      network: network?.toUpperCase(),
      twoFactorCode: twoFactorCode.trim()
    }
  };
}

/**
 * Checks for duplicate pending withdrawals
 * @param {string} userId - User ID
 * @param {string} currency - Currency
 * @param {number} amount - Amount
 * @param {string} address - Withdrawal address
 * @returns {Promise<Object>} Check result
 */
async function checkDuplicateWithdrawal(userId, currency, amount, address) {
  try {
    const checkTime = new Date(Date.now() - WITHDRAWAL_CONFIG.DUPLICATE_CHECK_WINDOW);
    
    const existingTransaction = await Transaction.findOne({
      userId,
      type: 'WITHDRAWAL',
      currency: currency.toUpperCase(),
      amount: amount,
      address: address,
      status: { $in: ['PENDING', 'PROCESSING'] },
      createdAt: { $gte: checkTime }
    });

    if (existingTransaction) {
      return {
        isDuplicate: true,
        message: `A similar withdrawal request is already pending. Transaction ID: ${existingTransaction._id}`,
        existingTransactionId: existingTransaction._id
      };
    }

    // Check for too many pending withdrawals
    const pendingCount = await Transaction.countDocuments({
      userId,
      type: 'WITHDRAWAL',
      status: { $in: ['PENDING', 'PROCESSING'] }
    });

    if (pendingCount >= WITHDRAWAL_CONFIG.MAX_PENDING_WITHDRAWALS) {
      return {
        isDuplicate: true,
        message: `Too many pending withdrawals. Maximum allowed: ${WITHDRAWAL_CONFIG.MAX_PENDING_WITHDRAWALS}`,
        pendingCount
      };
    }

    return { isDuplicate: false };
  } catch (error) {
    logger.error('Error checking duplicate withdrawal', { userId, error: error.message });
    throw new Error('Failed to validate withdrawal request');
  }
}

/**
 * Gets withdrawal fee configuration and calculates fee in crypto
 * @param {string} currency - Currency symbol
 * @param {number} cryptoPrice - Current crypto price in USD
 * @returns {Promise<Object>} Fee information
 */
async function getWithdrawalFee(currency, cryptoPrice) {
  try {
    const feeDoc = await CryptoFeeMarkup.findOne({ currency: currency.toUpperCase() });
    
    if (!feeDoc) {
      throw new Error(`Fee configuration missing for ${currency.toUpperCase()}`);
    }

    const feeUsd = feeDoc.feeUsd;
    
    if (!feeUsd || feeUsd <= 0) {
      throw new Error(`Invalid fee configuration for ${currency.toUpperCase()}`);
    }

    // Calculate fee in crypto
    const feeInCrypto = feeUsd / cryptoPrice;
    
    return {
      success: true,
      feeUsd,
      feeInCrypto: parseFloat(feeInCrypto.toFixed(WITHDRAWAL_CONFIG.AMOUNT_PRECISION)),
      cryptoPrice
    };
  } catch (error) {
    logger.error('Error getting withdrawal fee', { currency, error: error.message });
    return {
      success: false,
      message: error.message
    };
  }
}

/**
 * Initiates withdrawal through Obiex API
 * @param {Object} withdrawalData - Withdrawal parameters
 * @returns {Promise<Object>} Obiex API response
 */
async function initiateObiexWithdrawal(withdrawalData) {
  const { amount, address, currency, network, memo, narration } = withdrawalData;
  
  try {
    // Build destination object
    const destination = {
      address
    };
    
    // Add optional destination fields
    if (network) destination.network = network;
    if (memo?.trim()) destination.memo = memo.trim();

    const payload = {
      amount: Number(amount), // Send as number, not string
      destination,
      currency: currency.toUpperCase(),
      narration: narration || `Crypto withdrawal - ${currency}`,
    };

    logger.info('Initiating Obiex withdrawal', { 
      currency, 
      amount, 
      address: address.substring(0, 10) + '...',
      payload: JSON.stringify(payload) // Log the exact payload being sent
    });

    const response = await obiexAxios.post('/wallets/ext/debit/crypto', payload);
    
    // Obiex returns data in response.data.data format
    if (!response.data?.data?.id) {
      throw new Error('Invalid response from Obiex: missing transaction ID');
    }

    return {
      success: true,
      data: {
        transactionId: response.data.data.id, // Use the correct field name
        reference: response.data.data.reference,
        status: response.data.data.payout?.status || 'PENDING',
        obiexResponse: response.data.data
      }
    };
  } catch (error) {
    logger.error('Obiex withdrawal failed', {
      currency,
      amount,
      error: error.response?.data || error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      headers: error.response?.headers,
      requestPayload: JSON.stringify(payload) // Log what we sent
    });
    
    return {
      success: false,
      message: error.response?.data?.message || 'Withdrawal service temporarily unavailable',
      statusCode: error.response?.status || 500
    };
  }
}

/**
 * Creates withdrawal transaction record
 * @param {Object} transactionData - Transaction parameters
 * @returns {Promise<Object>} Created transaction
 */
async function createWithdrawalTransaction(transactionData) {
  const {
    userId,
    currency,
    amount,
    address,
    network,
    memo,
    fee,
    obiexTransactionId,
    obiexReference,
    narration
  } = transactionData;

  try {
    const transaction = await Transaction.create({
      userId,
      type: 'WITHDRAWAL',
      currency: currency.toUpperCase(),
      amount,
      address,
      network,
      memo,
      status: 'PENDING',
      fee,
      obiexTransactionId,
      reference: obiexReference, // Store the Obiex reference
      narration,
      // Don't set transactionId field - let it be undefined/null to avoid conflicts
      metadata: {
        initiatedAt: new Date(),
        expectedConfirmations: WITHDRAWAL_CONFIG.MIN_CONFIRMATION_BLOCKS[currency.toUpperCase()] || 1,
      }
    });

    logger.info('Withdrawal transaction created', {
      transactionId: transaction._id,
      userId,
      currency,
      amount,
      obiexTransactionId
    });

    return transaction;
  } catch (error) {
    logger.error('Failed to create withdrawal transaction', {
      userId,
      currency,
      error: error.message
    });
    throw error;
  }
}

/**
 * Main withdrawal endpoint
 */
router.post('/crypto', async (req, res) => {
  const startTime = Date.now();
  let reservationMade = false;
  let transactionCreated = false;

  try {
    // Validate Obiex configuration
    validateObiexConfig();

    const userId = req.user.id;
    
    // Validate request parameters
    const validation = validateWithdrawalRequest(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: validation.message,
        errors: validation.errors
      });
    }

    const { address, amount, currency, network, twoFactorCode } = validation.validatedData;
    const { memo, narration } = req.body;

    logger.info('Processing withdrawal request', {
      userId,
      currency,
      amount,
      address: address.substring(0, 10) + '...'
    });

    // Validate user and 2FA
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!user.twoFASecret || !user.is2FAEnabled) {
      return res.status(400).json({
        success: false,
        message: 'Two-factor authentication is not set up or not enabled. Please enable 2FA first.'
      });
    }

    if (!validateTwoFactorAuth(user, twoFactorCode)) {
      logger.warn('Invalid 2FA attempt', { userId });
      return res.status(401).json({
        success: false,
        message: 'Invalid two-factor authentication code'
      });
    }

    // Check for duplicate withdrawals
    const duplicateCheck = await checkDuplicateWithdrawal(userId, currency, amount, address);
    if (duplicateCheck.isDuplicate) {
      return res.status(400).json({
        success: false,
        message: duplicateCheck.message
      });
    }

    // Get current crypto price
    const prices = await getPricesWithCache([currency]);
    const cryptoPrice = prices[currency];
    
    if (!cryptoPrice || cryptoPrice <= 0) {
      return res.status(500).json({
        success: false,
        message: 'Unable to fetch current price data. Please try again.'
      });
    }

    // Get withdrawal fee
    const feeInfo = await getWithdrawalFee(currency, cryptoPrice);
    if (!feeInfo.success) {
      return res.status(400).json({
        success: false,
        message: feeInfo.message
      });
    }

    const { feeInCrypto, feeUsd } = feeInfo;
    const totalAmount = amount + feeInCrypto;

    // Validate user balance (including fee)
    const balanceValidation = await validateUserBalance(userId, currency, totalAmount, {
      includeBalanceDetails: true
    });
    
    if (!balanceValidation.success) {
      return res.status(400).json({
        success: false,
        message: balanceValidation.message,
        availableBalance: balanceValidation.availableBalance
      });
    }

    // Initiate Obiex withdrawal
    const obiexResult = await initiateObiexWithdrawal({
      amount,
      address,
      currency,
      network,
      memo,
      narration
    });

    if (!obiexResult.success) {
      return res.status(obiexResult.statusCode || 500).json({
        success: false,
        message: obiexResult.message
      });
    }

    // Create transaction record BEFORE reserving balance
    const transaction = await createWithdrawalTransaction({
      userId,
      currency,
      amount,
      address,
      network,
      memo,
      fee: feeInCrypto,
      obiexTransactionId: obiexResult.data.transactionId,
      obiexReference: obiexResult.data.reference,
      narration
    });
    transactionCreated = true;

    // Reserve user balance AFTER successful transaction creation
    await reserveUserBalance(userId, currency, totalAmount);
    reservationMade = true;

    const processingTime = Date.now() - startTime;
    logger.info('Withdrawal processed successfully', {
      userId,
      transactionId: transaction._id,
      obiexTransactionId: obiexResult.data.transactionId,
      processingTime
    });

    res.status(200).json({
      success: true,
      message: 'Withdrawal initiated successfully',
      data: {
        transactionId: transaction._id,
        obiexTransactionId: obiexResult.data.transactionId,
        obiexReference: obiexResult.data.reference,
        obiexStatus: obiexResult.data.status,
        currency,
        amount,
        fee: feeInCrypto,
        feeUsd,
        totalAmount,
        estimatedConfirmationTime: `${WITHDRAWAL_CONFIG.MIN_CONFIRMATION_BLOCKS[currency] || 1} blocks`
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error('Withdrawal processing failed', {
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      processingTime,
      reservationMade,
      transactionCreated
    });

    // Cleanup: Release reserved balance if reservation was made but transaction creation failed
    if (reservationMade && !transactionCreated) {
      try {
        const { releaseReservedBalance } = require('../services/portfolio');
        await releaseReservedBalance(userId, currency, totalAmount || amount);
        logger.info('Released reserved balance due to withdrawal failure', { userId, currency, amount: totalAmount || amount });
      } catch (releaseError) {
        logger.error('Failed to release reserved balance after withdrawal failure', {
          userId,
          currency,
          amount: totalAmount || amount,
          error: releaseError.message
        });
      }
    }

    res.status(500).json({
      success: false,
      message: 'Internal server error during withdrawal processing. Please contact support if this persists.'
    });
  }
});

/**
 * Get withdrawal status endpoint
 */
router.get('/status/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const userId = req.user.id;

    const transaction = await Transaction.findOne({
      _id: transactionId,
      userId,
      type: 'WITHDRAWAL'
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Withdrawal transaction not found'
      });
    }

    res.json({
      success: true,
      data: {
        transactionId: transaction._id,
        status: transaction.status,
        currency: transaction.currency,
        amount: transaction.amount,
        fee: transaction.fee,
        address: transaction.address,
        obiexTransactionId: transaction.obiexTransactionId,
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt
      }
    });

  } catch (error) {
    logger.error('Error fetching withdrawal status', {
      userId: req.user?.id,
      transactionId: req.params.transactionId,
      error: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to fetch withdrawal status'
    });
  }
});

module.exports = router;