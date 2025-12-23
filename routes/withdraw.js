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
 * UPDATED FEE CALCULATION
 */
async function getWithdrawalFee(currency, network) {
  try {
    const upperCurrency = currency.toUpperCase();
    const upperNetwork = network.toUpperCase();

    // 1. Get Obiex cost from JSON
    const asset = OBIEX_NETWORK_DATA[upperCurrency];
    const obiexNet = asset?.networks.find(n => n.code === upperNetwork);
    if (!obiexNet) throw new Error(`Network ${upperNetwork} not found for ${upperCurrency}`);

    // 2. Get Your Markup from MongoDB
    const feeDoc = await CryptoFeeMarkup.findOne({ currency: upperCurrency, network: upperNetwork });
    if (!feeDoc) throw new Error(`Markup missing for ${upperCurrency} on ${upperNetwork}`);

    // 3. Conversion logic
    const nativeCurrency = getNetworkNativeCurrency(upperNetwork);
    const prices = await getOriginalPricesWithCache([nativeCurrency, upperCurrency]);
    const nativePrice = prices[nativeCurrency] || 0;
    const withdrawalPrice = prices[upperCurrency] || 1;

    // The combined native fee (Obiex Cost + Your Markup)
    const obiexFee = obiexNet.fee;
    const originalNetworkFee = feeDoc.networkFee;
    const totalNativeFee = obiexFee + originalNetworkFee;

    const feeUsd = totalNativeFee * nativePrice;
    const networkFeeInWithdrawalCurrency = feeUsd / withdrawalPrice;

    return {
      success: true,
      // Field names preserved for your frontend
      networkFee: parseFloat(networkFeeInWithdrawalCurrency.toFixed(8)), // Total combined fee
      feeUsd: parseFloat(feeUsd.toFixed(2)),
      originalNetworkFee: originalNetworkFee, // Your markup only
      obiexFee: obiexFee, // Obiex fee only
      totalFeeInWithdrawalCurrency: networkFeeInWithdrawalCurrency
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * VALIDATION
 */
function validateWithdrawalRequest(body) {
  const { destination = {}, amount, currency, twoFactorCode, passwordpin } = body;
  const { address, network } = destination;
  const errors = [];

  const upperCurrency = currency?.toUpperCase();
  const upperNetwork = network?.toUpperCase();

  if (!address?.trim()) errors.push('Withdrawal address is required');
  if (!amount || Number(amount) <= 0) errors.push('Invalid amount');
  if (!twoFactorCode?.trim()) errors.push('2FA code is required');
  if (!passwordpin?.trim()) errors.push('PIN is required');

  const assetData = OBIEX_NETWORK_DATA[upperCurrency];
  if (!assetData) {
    errors.push(`Currency ${upperCurrency} not supported`);
  } else {
    const validNetwork = assetData.networks.find(n => n.code === upperNetwork);
    if (!validNetwork) {
      errors.push(`Invalid network. Available: ${assetData.networks.map(n => n.code).join(', ')}`);
    } else if (validNetwork.addressRegex) {
      if (!new RegExp(validNetwork.addressRegex).test(address.trim())) {
        errors.push(`Invalid ${validNetwork.name} address format.`);
      }
    }
  }

  return errors.length > 0 
    ? { success: false, message: errors.join('; ') }
    : { success: true, validatedData: { address, amount: Number(amount), currency: upperCurrency, network: upperNetwork, twoFactorCode, passwordpin } };
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
    
    // Obiex gets user amount minus your markup (converted)
    const nativeCurrency = getNetworkNativeCurrency(network);
    const prices = await getOriginalPricesWithCache([nativeCurrency, currency]);
    const markupInWithdrawalCurrency = (feeInfo.originalNetworkFee * prices[nativeCurrency]) / (prices[currency] || 1);
    const obiexSendAmount = amount - markupInWithdrawalCurrency;

    if (receiverAmount <= 0) return res.status(400).json({ success: false, message: "Amount too low to cover fees" });

    const balCheck = await validateUserBalanceInternal(user._id, currency, amount);
    if (!balCheck.success) return res.status(400).json({ success: false, message: "Insufficient balance" });

    const payload = {
      destination: { address, network: network.toUpperCase(), memo: memo?.trim() },
      amount: Number(obiexSendAmount),
      currency: currency.toUpperCase(),
      narration: narration || `Crypto withdrawal`
    };

    const obiexRes = await obiexAxios.post('/wallets/ext/debit/crypto', payload);
    const obiexData = obiexRes.data.data;

    const transaction = await Transaction.create({
      userId: user._id, type: 'WITHDRAWAL', currency, amount: receiverAmount, address, network, status: 'PENDING', fee: totalFees,
      obiexTransactionId: obiexData.id, reference: obiexData.reference
    });

    await reserveUserBalanceInternal(user._id, currency, amount);
    reservationMade = true;

    if (user.email) sendWithdrawalEmail(user.email, user.username, amount, currency, transaction._id);

    return res.json({
      success: true,
      message: 'Withdrawal initiated successfully',
      data: {
        transactionId: transaction._id,
        receiverAmount: receiverAmount,
        fee: totalFees
      }
    });

  } catch (error) {
    if (reservationMade) await releaseReservedBalanceInternal(req.user.id, reqCurrency, requestedAmount);
    return res.status(500).json({ success: false, message: error.response?.data?.message || error.message });
  }
});

router.post('/initiate', async (req, res) => {
  const { amount, currency, network } = req.body;
  const feeInfo = await getWithdrawalFee(currency, network);
  if (!feeInfo.success) return res.status(400).json(feeInfo);

  // PRESERVED FIELD NAMES FOR FRONTEND
  res.json({
    success: true,
    data: {
      amount,
      currency,
      fee: feeInfo.networkFee, // Combined fee
      feeUsd: feeInfo.feeUsd,
      receiverAmount: amount - feeInfo.networkFee,
      totalAmount: amount
    }
  });
});

router.get('/currencies', async (req, res) => {
  const currencies = Object.keys(SUPPORTED_TOKENS).map(c => ({ symbol: c, name: SUPPORTED_TOKENS[c].name }));
  res.json({ success: true, data: { currencies } });
});

module.exports = router;