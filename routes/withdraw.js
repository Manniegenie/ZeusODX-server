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

// 1. Load the dynamically generated network mapping
const NETWORK_MAP_PATH = path.join(__dirname, '..', 'obiex_currency_networks.json');
let OBIEX_NETWORK_DATA = {};

try {
  const fileContent = fs.readFileSync(NETWORK_MAP_PATH, 'utf-8');
  OBIEX_NETWORK_DATA = JSON.parse(fileContent);
} catch (err) {
  logger.error('CRITICAL: Failed to load obiex_currency_networks.json.', { error: err.message });
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

const WITHDRAWAL_CONFIG = {
  MAX_PENDING_WITHDRAWALS: 5,
  DUPLICATE_CHECK_WINDOW: 30 * 60 * 1000, 
  AMOUNT_PRECISION: 8,
  MIN_CONFIRMATION_BLOCKS: { BTC: 1, ETH: 12, SOL: 32, USDT: 12, TRX: 1 },
};

/**
 * HELPER FUNCTIONS
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
    const prices = await getOriginalPricesWithCache([currency.toUpperCase()]);
    return prices[currency.toUpperCase()] || 0;
  } catch (error) {
    return 0;
  }
}

function getNetworkNativeCurrency(network) {
  const map = { 'BSC': 'BNB', 'ETH': 'ETH', 'MATIC': 'MATIC', 'TRX': 'TRX', 'SOL': 'SOL', 'BTC': 'BTC' };
  return map[network?.toUpperCase()] || 'ETH';
}

async function validateUserBalanceInternal(userId, currency, amount) {
  const balanceField = getBalanceFieldName(currency);
  const user = await User.findById(userId).select(balanceField);
  const available = user ? user[balanceField] : 0;
  return { success: available >= amount, availableBalance: available };
}

async function reserveUserBalanceInternal(userId, currency, amount) {
  const balanceField = getBalanceFieldName(currency);
  const pendingField = getPendingBalanceFieldName(currency);
  const result = await User.updateOne(
    { _id: userId, [balanceField]: { $gte: amount } },
    { $inc: { [balanceField]: -amount, [pendingField]: amount } }
  );
  return { success: result.matchedCount > 0 };
}

async function releaseReservedBalanceInternal(userId, currency, amount) {
  const balanceField = getBalanceFieldName(currency);
  const pendingField = getPendingBalanceFieldName(currency);
  const result = await User.updateOne(
    { _id: userId, [pendingField]: { $gte: amount } },
    { $inc: { [balanceField]: amount, [pendingField]: -amount } }
  );
  return { success: result.matchedCount > 0 };
}

async function comparePasswordPin(candidate, hashed) {
  return candidate && hashed ? await bcrypt.compare(candidate, hashed) : false;
}

/**
 * CORE VALIDATION & FEE LOGIC
 */
function validateWithdrawalRequest(body) {
  const { destination = {}, amount, currency, twoFactorCode, passwordpin } = body;
  const { address, network } = destination;
  const errors = [];

  const upperCurrency = currency?.toUpperCase();
  const upperNetwork = network?.toUpperCase();

  // 1. Basic Fields
  if (!address?.trim()) errors.push('Withdrawal address is required');
  if (!amount || Number(amount) <= 0) errors.push('Invalid withdrawal amount');
  if (!twoFactorCode?.trim()) errors.push('2FA code is required');
  if (!passwordpin?.trim()) errors.push('PIN is required');

  // 2. Dynamic Validation against JSON metadata
  const assetData = OBIEX_NETWORK_DATA[upperCurrency];
  if (!assetData) {
    errors.push(`Currency ${upperCurrency} not supported`);
  } else {
    const validNetwork = assetData.networks.find(n => n.code === upperNetwork);
    if (!validNetwork) {
      errors.push(`Invalid network '${upperNetwork}'. Choose from: ${assetData.networks.map(n => n.code).join(', ')}`);
    } else if (validNetwork.addressRegex) {
      if (!new RegExp(validNetwork.addressRegex).test(address.trim())) {
        errors.push(`Invalid address format for ${validNetwork.name}`);
      }
    }
  }

  return errors.length > 0 
    ? { success: false, message: errors.join('; ') }
    : { success: true, validatedData: { address, amount: Number(amount), currency: upperCurrency, network: upperNetwork, twoFactorCode, passwordpin } };
}

async function getWithdrawalFee(currency, network) {
  try {
    const upperCurrency = currency.toUpperCase();
    const upperNetwork = network.toUpperCase();

    // lookup Obiex cost from JSON
    const asset = OBIEX_NETWORK_DATA[upperCurrency];
    const obiexNet = asset?.networks.find(n => n.code === upperNetwork);
    if (!obiexNet) throw new Error(`Network ${upperNetwork} not found in Obiex metadata`);

    // lookup Markup from DB (DB must now use codes like TRX, BSC, ETH)
    const feeDoc = await CryptoFeeMarkup.findOne({ currency: upperCurrency, network: upperNetwork });
    if (!feeDoc) throw new Error(`Markup configuration missing for ${upperCurrency} on ${upperNetwork}`);

    const nativeCurrency = getNetworkNativeCurrency(upperNetwork);
    const prices = await getOriginalPricesWithCache([nativeCurrency, upperCurrency]);
    
    const nativePrice = prices[nativeCurrency] || 0;
    const withdrawalPrice = prices[upperCurrency] || 1;

    // obiexFee + ourMarkup are both in the native token of the network
    const totalNativeFee = obiexNet.fee + feeDoc.networkFee;
    const feeUsd = totalNativeFee * nativePrice;
    const feeInWithdrawalCurrency = feeUsd / withdrawalPrice;

    return {
      success: true,
      networkFee: parseFloat(feeInWithdrawalCurrency.toFixed(8)),
      feeUsd: parseFloat(feeUsd.toFixed(2)),
      originalMarkupNative: feeDoc.networkFee,
      obiexFeeNative: obiexNet.fee
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * EXECUTION
 */
async function initiateObiexWithdrawal(data) {
  const { amount, address, currency, network, memo, narration } = data;
  const payload = {
    destination: { address, network: network.toUpperCase(), memo: memo?.trim() },
    amount: Number(amount),
    currency: currency.toUpperCase(),
    narration: narration || `Crypto withdrawal`
  };
  try {
    const res = await obiexAxios.post('/wallets/ext/debit/crypto', payload);
    return { success: true, data: { transactionId: res.data.data.id, reference: res.data.data.reference } };
  } catch (err) {
    return { success: false, message: err.response?.data?.message || 'Obiex API Error', statusCode: err.response?.status || 500 };
  }
}

/**
 * ROUTES
 */
router.post('/crypto', async (req, res) => {
  let reservationMade = false;
  const { amount: requestedAmount, currency: reqCurrency } = req.body;

  try {
    const validation = validateWithdrawalRequest(req.body);
    if (!validation.success) return res.status(400).json(validation);

    const { address, amount, currency, network, twoFactorCode, passwordpin } = validation.validatedData;
    const { memo, narration } = req.body;

    const user = await User.findById(req.user.id);
    if (!validateTwoFactorAuth(user, twoFactorCode)) return res.status(401).json({ success: false, message: 'Invalid 2FA' });
    if (!(await comparePasswordPin(passwordpin, user.passwordpin))) return res.status(401).json({ success: false, message: 'Invalid PIN' });

    const feeInfo = await getWithdrawalFee(currency, network);
    if (!feeInfo.success) return res.status(400).json(feeInfo);

    const totalFees = feeInfo.networkFee;
    const receiverAmount = amount - totalFees;
    // Obiex gets user amount minus our markup (converted to native token)
    // For simplicity, Obiex usually handles their own fee deduction from the sent amount
    const obiexSendAmount = amount - (feeInfo.originalMarkupNative * (await getCryptoPriceInternal(getNetworkNativeCurrency(network)) / await getCryptoPriceInternal(currency)));

    if (receiverAmount <= 0) return res.status(400).json({ success: false, message: "Amount after fees must be positive" });

    const balCheck = await validateUserBalanceInternal(user._id, currency, amount);
    if (!balCheck.success) return res.status(400).json({ success: false, message: "Insufficient balance" });

    const obiexRes = await initiateObiexWithdrawal({ amount: obiexSendAmount, address, currency, network, memo, narration });
    if (!obiexRes.success) return res.status(obiexRes.statusCode).json(obiexRes);

    const transaction = await Transaction.create({
      userId: user._id, type: 'WITHDRAWAL', currency, amount: receiverAmount, address, network, status: 'PENDING', fee: totalFees,
      obiexTransactionId: obiexRes.data.transactionId, reference: obiexRes.data.reference
    });

    await reserveUserBalanceInternal(user._id, currency, amount);
    reservationMade = true;

    if (user.email) sendWithdrawalEmail(user.email, user.username, amount, currency, transaction._id);

    return res.json({ success: true, message: 'Withdrawal successful', data: { transactionId: transaction._id, receiverAmount, fee: totalFees } });

  } catch (error) {
    if (reservationMade) await releaseReservedBalanceInternal(req.user.id, reqCurrency, requestedAmount);
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

router.get('/status/:transactionId', async (req, res) => {
  const transaction = await Transaction.findOne({ _id: req.params.transactionId, userId: req.user.id });
  if (!transaction) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true, data: transaction });
});

module.exports = router;