const express = require('express');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const User = require('../models/user');
const Transaction = require('../models/transaction');
const CryptoFeeMarkup = require('../models/cryptofee');
const { validateObiexConfig, attachObiexAuth } = require('../utils/obiexAuth');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { validateTransactionLimit } = require('../services/kyccheckservice');
const { getOriginalPricesWithCache } = require('../services/portfolio');
const logger = require('../utils/logger');
const config = require('./config');
const { sendWithdrawalEmail } = require('../services/EmailService');

// Load the dynamically generated network mapping
const NETWORK_MAP_PATH = path.join(__dirname, '..', 'obiex_currency_networks.json');
let OBIEX_NETWORK_DATA = {};

try {
  const fileContent = fs.readFileSync(NETWORK_MAP_PATH, 'utf-8');
  OBIEX_NETWORK_DATA = JSON.parse(fileContent);
} catch (err) {
  logger.error('Failed to load obiex_currency_networks.json. Withdrawal validation may fail.', { error: err.message });
}

// Configure Obiex axios instance
const obiexAxios = axios.create({
  baseURL: config.obiex.baseURL.replace(/\/+$/, ''),
  timeout: 30000,
});
obiexAxios.interceptors.request.use(attachObiexAuth);

// Supported tokens configuration
const SUPPORTED_TOKENS = {
  BTC: { name: 'Bitcoin', symbol: 'BTC', decimals: 8, isStablecoin: false },
  ETH: { name: 'Ethereum', symbol: 'ETH', decimals: 18, isStablecoin: false }, 
  SOL: { name: 'Solana', symbol: 'SOL', decimals: 9, isStablecoin: false },
  USDT: { name: 'Tether', symbol: 'USDT', decimals: 6, isStablecoin: true },
  USDC: { name: 'USD Coin', symbol: 'USDC', decimals: 6, isStablecoin: true },
  BNB: { name: 'Binance Coin', symbol: 'BNB', decimals: 18, isStablecoin: false },
  MATIC: { name: 'Polygon', symbol: 'MATIC', decimals: 18, isStablecoin: false },
  TRX: { name: 'Tron', symbol: 'TRX', decimals: 6, isStablecoin: false },
  NGNB: { name: 'NGNB Token', symbol: 'NGNB', decimals: 2, isStablecoin: true, isNairaPegged: true }
};

// Withdrawal configuration constants
const WITHDRAWAL_CONFIG = {
  MAX_PENDING_WITHDRAWALS: 5,
  DUPLICATE_CHECK_WINDOW: 30 * 60 * 1000, 
  AMOUNT_PRECISION: 9,
  MIN_CONFIRMATION_BLOCKS: {
    BTC: 1, ETH: 12, SOL: 32, USDT: 12, USDC: 12, BNB: 15, MATIC: 15, TRX: 1, NGNB: 1,
  },
};

/**
 * Helper Functions
 */
function getBalanceFieldName(currency) {
  const fieldMap = {
    'BTC': 'btcBalance', 'ETH': 'ethBalance', 'SOL': 'solBalance', 'USDT': 'usdtBalance',
    'USDC': 'usdcBalance', 'BNB': 'bnbBalance', 'MATIC': 'maticBalance', 'TRX': 'trxBalance', 'NGNB': 'ngnbBalance'
  };
  return fieldMap[currency.toUpperCase()];
}

function getPendingBalanceFieldName(currency) {
  const fieldMap = {
    'BTC': 'btcPendingBalance', 'ETH': 'ethPendingBalance', 'SOL': 'solPendingBalance', 'USDT': 'usdtPendingBalance',
    'USDC': 'usdcPendingBalance', 'BNB': 'bnbPendingBalance', 'MATIC': 'maticPendingBalance', 'TRX': 'trxPendingBalance', 'NGNB': 'ngnbPendingBalance'
  };
  return fieldMap[currency.toUpperCase()];
}

async function getCryptoPriceInternal(currency) {
  try {
    const upperCurrency = currency.toUpperCase();
    const prices = await getOriginalPricesWithCache([upperCurrency]);
    return prices[upperCurrency] || 0;
  } catch (error) {
    logger.error(`Failed to get price for ${currency}:`, error.message);
    return 0;
  }
}

async function validateUserBalanceInternal(userId, currency, amount) {
  const balanceField = getBalanceFieldName(currency);
  if (!balanceField) return { success: false, message: `Unsupported currency: ${currency}` };

  const user = await User.findById(userId).select(balanceField);
  if (!user) return { success: false, message: 'User not found' };

  const availableBalance = user[balanceField] || 0;
  if (availableBalance < amount) {
    return { success: false, message: `Insufficient ${currency} balance.`, availableBalance };
  }
  return { success: true, availableBalance };
}

async function reserveUserBalanceInternal(userId, currency, amount) {
  const balanceField = getBalanceFieldName(currency);
  const pendingField = getPendingBalanceFieldName(currency);
  const result = await User.updateOne(
    { _id: userId, [balanceField]: { $gte: amount } },
    { $inc: { [balanceField]: -amount, [pendingField]: amount }, $set: { lastBalanceUpdate: new Date() } }
  );
  return result.matchedCount > 0 ? { success: true } : { success: false };
}

async function releaseReservedBalanceInternal(userId, currency, amount) {
  const balanceField = getBalanceFieldName(currency);
  const pendingField = getPendingBalanceFieldName(currency);
  const result = await User.updateOne(
    { _id: userId, [pendingField]: { $gte: amount } },
    { $inc: { [balanceField]: amount, [pendingField]: -amount }, $set: { lastBalanceUpdate: new Date() } }
  );
  return result.matchedCount > 0 ? { success: true } : { success: false };
}

async function comparePasswordPin(candidate, hashed) {
  if (!candidate || !hashed) return false;
  return await bcrypt.compare(candidate, hashed);
}

/**
 * UPDATED: Dynamic Network Validation logic
 */
function validateWithdrawalRequest(body) {
  const { destination = {}, amount, currency, twoFactorCode, passwordpin } = body;
  const { address, network } = destination;
  const errors = [];

  if (!address?.trim()) errors.push('Withdrawal address is required');
  if (!amount) errors.push('Withdrawal amount is required');
  if (!currency?.trim()) errors.push('Currency is required');
  if (!twoFactorCode?.trim()) errors.push('2FA code is required');
  if (!passwordpin?.trim()) errors.push('Password PIN is required');

  const numericAmount = Number(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) errors.push('Invalid amount');

  const upperCurrency = currency?.toUpperCase();
  const upperNetwork = network?.toUpperCase();

  // 1. Check if Currency is supported in our metadata
  const assetData = OBIEX_NETWORK_DATA[upperCurrency];
  if (!assetData) {
    errors.push(`Currency ${upperCurrency} is not currently supported for automated withdrawals.`);
  } else {
    // 2. Check if selected Network Code exists for this Currency
    const validNetwork = assetData.networks.find(n => n.code === upperNetwork);
    if (!validNetwork) {
      const available = assetData.networks.map(n => n.code).join(', ');
      errors.push(`Invalid network '${upperNetwork}' for ${upperCurrency}. Available: ${available}`);
    } else {
      // 3. Validate Address Regex (using dynamic regex from Obiex JSON)
      if (validNetwork.addressRegex) {
        const regex = new RegExp(validNetwork.addressRegex);
        if (!regex.test(address.trim())) {
          errors.push(`Invalid ${validNetwork.name} address format.`);
        }
      }
    }
  }

  if (errors.length > 0) return { success: false, message: errors.join('; '), errors };

  return {
    success: true,
    validatedData: {
      address: address.trim(), amount: numericAmount, currency: upperCurrency,
      network: upperNetwork, twoFactorCode: twoFactorCode.trim(), passwordpin: String(passwordpin).trim()
    }
  };
}

async function checkDuplicateWithdrawal(userId, currency, amount, address) {
  const checkTime = new Date(Date.now() - WITHDRAWAL_CONFIG.DUPLICATE_CHECK_WINDOW);
  const existing = await Transaction.findOne({
    userId, type: 'WITHDRAWAL', currency: currency.toUpperCase(),
    amount, address, status: { $in: ['PENDING', 'PROCESSING'] }, createdAt: { $gte: checkTime }
  });
  if (existing) return { isDuplicate: true, message: "Duplicate request pending." };
  return { isDuplicate: false };
}

/**
 * UPDATED: Fetches fee directly from our sync JSON
 */
function getObiexFee(currency, network) {
  const asset = OBIEX_NETWORK_DATA[currency.toUpperCase()];
  if (!asset) return 0;
  const net = asset.networks.find(n => n.code === network.toUpperCase());
  return net ? net.fee : 0;
}

async function getWithdrawalFee(currency, network = null) {
  try {
    const upperCurrency = currency.toUpperCase();
    const upperNetwork = network?.toUpperCase();
    
    // 1. Get our markup fee from DB
    const feeDoc = await CryptoFeeMarkup.findOne({ currency: upperCurrency, network: upperNetwork });
    if (!feeDoc) throw new Error(`Fee configuration missing for ${upperCurrency} on ${upperNetwork}`);

    // 2. Get Obiex technical fee from JSON
    const obiexFee = getObiexFee(upperCurrency, upperNetwork);
    const networkFee = feeDoc.networkFee;
    const totalFee = networkFee + obiexFee;

    const networkCurrency = getNetworkNativeCurrency(upperNetwork);
    const prices = await getOriginalPricesWithCache([networkCurrency, upperCurrency]);
    
    const networkPrice = prices[networkCurrency] || 0;
    const withdrawalPrice = prices[upperCurrency] || 0;

    const feeUsd = totalFee * networkPrice;
    const feeInWithdrawalCurrency = feeUsd / (withdrawalPrice || 1);

    return {
      success: true,
      networkFee: parseFloat(feeInWithdrawalCurrency.toFixed(WITHDRAWAL_CONFIG.AMOUNT_PRECISION)),
      feeUsd: parseFloat(feeUsd.toFixed(2)),
      originalNetworkFee: networkFee,
      obiexFee: obiexFee,
      totalFee: totalFee,
      networkName: feeDoc.networkName
    };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

function getNetworkNativeCurrency(network) {
  const map = { 'BSC': 'BNB', 'BEP20': 'BNB', 'ETH': 'ETH', 'ERC20': 'ETH', 'MATIC': 'MATIC', 'TRX': 'TRX', 'SOL': 'SOL', 'BTC': 'BTC' };
  return map[network?.toUpperCase()] || 'ETH';
}

/**
 * Withdrawal Execution
 */
async function initiateObiexWithdrawal(withdrawalData) {
  const { amount, address, currency, network, memo, narration } = withdrawalData;
  const payload = {
    destination: { address, network: network.toUpperCase(), memo: memo?.trim() },
    amount: Number(amount),
    currency: currency.toUpperCase(),
    narration: narration || `Withdrawal ${currency}`
  };

  try {
    const response = await obiexAxios.post('/wallets/ext/debit/crypto', payload);
    return { success: true, data: { transactionId: response.data.data.id, reference: response.data.data.reference, status: 'PENDING' } };
  } catch (error) {
    return { success: false, message: error.response?.data?.message || 'Obiex service error', statusCode: error.response?.status || 500 };
  }
}

async function createWithdrawalTransaction(data) {
  return await Transaction.create({
    userId: data.userId, type: 'WITHDRAWAL', currency: data.currency, amount: data.amount,
    address: data.address, network: data.network, status: 'PENDING', fee: data.fee,
    obiexTransactionId: data.obiexTransactionId, reference: data.obiexReference,
    metadata: { initiatedAt: new Date(), security_validations: { twofa: true, passwordpin: true, kyc: true } }
  });
}

/**
 * ROUTES
 */

router.post('/crypto', async (req, res) => {
  const startTime = Date.now();
  let reservationMade = false;
  let reservedAmount = 0;
  let reservedCurrency = '';

  try {
    validateObiexConfig();
    const userId = req.user.id;
    const validation = validateWithdrawalRequest(req.body);
    
    if (!validation.success) return res.status(400).json(validation);

    const { address, amount, currency, network, twoFactorCode, passwordpin } = validation.validatedData;
    const { memo, narration } = req.body;

    // Security Checks
    const kycCheck = await validateTransactionLimit(userId, amount, currency, 'WITHDRAWAL');
    if (!kycCheck.allowed) return res.status(400).json({ success: false, message: kycCheck.message });

    const user = await User.findById(userId);
    if (!validateTwoFactorAuth(user, twoFactorCode)) return res.status(401).json({ success: false, message: 'Invalid 2FA' });
    if (!(await comparePasswordPin(passwordpin, user.passwordpin))) return res.status(401).json({ success: false, message: 'Invalid PIN' });

    // Fee & Balance
    const feeInfo = await getWithdrawalFee(currency, network);
    if (!feeInfo.success) return res.status(400).json({ success: false, message: feeInfo.message });

    const totalFees = feeInfo.networkFee;
    const receiverAmount = amount - totalFees;
    const obiexAmount = amount - feeInfo.originalNetworkFee;

    if (receiverAmount <= 0) return res.status(400).json({ success: false, message: "Amount too low to cover fees" });

    const balanceVal = await validateUserBalanceInternal(userId, currency, amount);
    if (!balanceVal.success) return res.status(400).json({ success: false, message: balanceVal.message });

    // Execution
    const obiexResult = await initiateObiexWithdrawal({ amount: obiexAmount, address, currency, network, memo, narration });
    if (!obiexResult.success) return res.status(obiexResult.statusCode).json(obiexResult);

    const transaction = await createWithdrawalTransaction({
      userId, currency, amount: receiverAmount, address, network, fee: totalFees,
      obiexTransactionId: obiexResult.data.transactionId, obiexReference: obiexResult.data.reference
    });

    await reserveUserBalanceInternal(userId, currency, amount);
    reservationMade = true;
    reservedAmount = amount;
    reservedCurrency = currency;

    if (user.email) sendWithdrawalEmail(user.email, user.username, amount, currency, transaction._id);

    return res.status(200).json({ success: true, message: 'Withdrawal initiated', data: { transactionId: transaction._id, receiverAmount, fee: totalFees } });

  } catch (error) {
    if (reservationMade) await releaseReservedBalanceInternal(req.user.id, reservedCurrency, reservedAmount);
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/initiate', async (req, res) => {
  const { amount, currency, network } = req.body;
  const feeInfo = await getWithdrawalFee(currency, network);
  if (!feeInfo.success) return res.status(400).json(feeInfo);

  res.json({ success: true, data: { amount, currency, fee: feeInfo.networkFee, receiverAmount: amount - feeInfo.networkFee } });
});

router.get('/currencies', async (req, res) => {
  const currencies = Object.keys(SUPPORTED_TOKENS).map(c => ({ symbol: c, name: SUPPORTED_TOKENS[c].name }));
  res.json({ success: true, data: { currencies } });
});

module.exports = router;