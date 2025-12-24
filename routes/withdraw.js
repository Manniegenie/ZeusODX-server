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

// 1. Load the dynamic network mapping
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

// Supported tokens metadata
const SUPPORTED_TOKENS = {
  BTC: { name: 'Bitcoin', symbol: 'BTC' },
  ETH: { name: 'Ethereum', symbol: 'ETH' }, 
  SOL: { name: 'Solana', symbol: 'SOL' },
  USDT: { name: 'Tether', symbol: 'USDT' },
  USDC: { name: 'USD Coin', symbol: 'USDC' },
  BNB: { name: 'Binance Coin', symbol: 'BNB' },
  MATIC: { name: 'Polygon', symbol: 'MATIC' },
  TRX: { name: 'Tron', symbol: 'TRX' }
};

/**
 * HELPER FUNCTIONS
 */
function getBalanceFieldName(currency) {
  const fieldMap = {
    'BTC': 'btcBalance', 'ETH': 'ethBalance', 'SOL': 'solBalance', 'USDT': 'usdtBalance',
    'USDC': 'usdcBalance', 'BNB': 'bnbBalance', 'MATIC': 'maticBalance', 'TRX': 'trxBalance'
  };
  return fieldMap[currency.toUpperCase()];
}

function getPendingBalanceFieldName(currency) {
  const fieldMap = {
    'BTC': 'btcPendingBalance', 'ETH': 'ethPendingBalance', 'SOL': 'solPendingBalance', 'USDT': 'usdtPendingBalance',
    'USDC': 'usdcPendingBalance', 'BNB': 'bnbPendingBalance', 'MATIC': 'maticPendingBalance', 'TRX': 'trxPendingBalance'
  };
  return fieldMap[currency.toUpperCase()];
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

async function getWithdrawalFee(currency, network) {
  try {
    let upperCurrency = currency?.toUpperCase();
    let upperNetwork = network?.toUpperCase();

    // 1. FORCE TO "POL" to match your JSON's top-level key
    if (upperCurrency === 'MATIC') upperCurrency = 'POL';

    // 2. FORCE NETWORK TO "MATIC" to match the network code inside your JSON
    if (upperNetwork === 'POL' || upperNetwork === 'POLYGON') upperNetwork = 'MATIC';

    const asset = OBIEX_NETWORK_DATA[upperCurrency];
    if (!asset) throw new Error(`Currency ${upperCurrency} not found in configuration`);

    const obiexNet = asset.networks.find(n => n.code === upperNetwork);
    if (!obiexNet) throw new Error(`Network ${upperNetwork} not found for ${upperCurrency}`);

    // 3. DATABASE CHECK: Your DB likely still uses "MATIC" for markups
    // We search the DB using MATIC, even though we used POL for the JSON
    const dbCurrency = upperCurrency === 'POL' ? 'MATIC' : upperCurrency;
    const feeDoc = await CryptoFeeMarkup.findOne({ currency: dbCurrency, network: upperNetwork });
    
    if (!feeDoc) throw new Error(`Markup missing in DB for ${dbCurrency} on ${upperNetwork}`);

    const totalFee = obiexNet.fee + feeDoc.networkFee;
    
    // 4. PRICE CHECK: Your portfolio service uses "MATIC"
    const prices = await getOriginalPricesWithCache([dbCurrency]);
    const feeUsd = totalFee * (prices[dbCurrency] || 0);

    return {
      success: true,
      networkFee: parseFloat(totalFee.toFixed(8)),
      feeUsd: parseFloat(feeUsd.toFixed(2)),
      originalNetworkFee: feeDoc.networkFee, 
      obiexFee: obiexNet.fee 
    };
  } catch (err) {
    logger.error(`Withdrawal Fee Error: ${err.message}`);
    return { success: false, message: err.message };
  }
}

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
        errors.push(`Invalid address format for ${validNetwork.name}`);
      }
    }
  }

  return errors.length > 0 
    ? { success: false, message: errors.join('; ') }
    : { success: true, validatedData: { address, amount: Number(amount), currency: upperCurrency, network: upperNetwork, twoFactorCode, passwordpin } };
}

/**
 * WITHDRAWAL EXECUTION
 */
router.post('/crypto', async (req, res) => {
  let reservationMade = false;
  let finalAmount;
  let finalCurrency;
  let internalCurrency; // The name used in our DB (MATIC)
  let internalNetwork;  // The name used in our DB/JSON code (MATIC)

  try {
    const validation = validateWithdrawalRequest(req.body);
    if (!validation.success) return res.status(400).json(validation);

    const { address, amount, currency, network, twoFactorCode, passwordpin } = validation.validatedData;
    
    // --- 1. NORMALIZATION LAYER (POL/MATIC Fix) ---
    // We use "MATIC" for our Database, Portfolio Service, and KYC Service
    // We use "POL" specifically for looking up the top-level key in the JSON
    internalCurrency = currency.toUpperCase() === 'POL' ? 'MATIC' : currency.toUpperCase();
    internalNetwork = (network.toUpperCase() === 'POL' || network.toUpperCase() === 'POLYGON') ? 'MATIC' : network.toUpperCase();
    
    finalAmount = amount;
    finalCurrency = internalCurrency; 
    const { memo, narration } = req.body;

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // --- 2. SECURITY CHECKS (2FA & PIN) ---
    const is2faValid = validateTwoFactorAuth(user, twoFactorCode);
    if (!is2faValid) {
      logger.warn(`2FA Validation Failed for user ${user._id}`);
      return res.status(401).json({ success: false, message: 'Invalid 2FA code' });
    }

    const isPinValid = await comparePasswordPin(passwordpin, user.passwordpin);
    if (!isPinValid) {
      logger.warn(`PIN Validation Failed for user ${user._id}`);
      return res.status(401).json({ success: false, message: 'Invalid Password PIN' });
    }

    // --- 3. KYC / TRANSACTION LIMIT CHECK (New) ---
    // This calls your imported kyccheckservice
    const kycCheck = await validateTransactionLimit(user, amount, internalCurrency);
    if (!kycCheck.success) {
      logger.warn(`KYC Limit Block: User ${user._id} attempted ${amount} ${internalCurrency}`);
      return res.status(403).json({ 
        success: false, 
        message: kycCheck.message || 'Transaction exceeds your current KYC limit.' 
      });
    }

    // --- 4. FEE CALCULATION ---
    // This function now uses the mapped internal names
    const feeInfo = await getWithdrawalFee(currency, network); 
    if (!feeInfo.success) return res.status(400).json(feeInfo);

    const totalFees = feeInfo.networkFee;
    const receiverAmount = amount - totalFees;
    const obiexSendAmount = amount - feeInfo.originalNetworkFee;

    if (receiverAmount <= 0) return res.status(400).json({ success: false, message: "Amount too low to cover fees" });

    // --- 5. BALANCE VALIDATION & LOCKING ---
    const balCheck = await validateUserBalanceInternal(user._id, internalCurrency, amount);
    if (!balCheck.success) return res.status(400).json({ success: false, message: "Insufficient balance" });

    const reserveRes = await reserveUserBalanceInternal(user._id, internalCurrency, amount);
    if (!reserveRes.success) throw new Error("Balance locking failed");
    reservationMade = true;

    // --- 6. EXTERNAL PROVIDER CALL (Obiex) ---
    const payload = {
      destination: { address, network: internalNetwork, memo: memo?.trim() },
      amount: Number(obiexSendAmount.toFixed(8)),
      // If Obiex strictly expects 'POL' at the API level, use the original input:
      currency: currency.toUpperCase(), 
      narration: narration || `Withdrawal`
    };

    const obiexRes = await obiexAxios.post('/wallets/ext/debit/crypto', payload);
    const obiexData = obiexRes.data.data;

    // --- 7. RECORD TRANSACTION ---
    const transaction = await Transaction.create({
      userId: user._id, 
      type: 'WITHDRAWAL', 
      currency: internalCurrency, 
      amount: receiverAmount, 
      address, 
      network: internalNetwork, 
      status: 'PENDING', 
      fee: totalFees,
      obiexTransactionId: obiexData.id, 
      reference: obiexData.reference
    });

    if (user.email) sendWithdrawalEmail(user.email, user.username, amount, internalCurrency, transaction._id);

    return res.json({
      success: true,
      message: 'Withdrawal initiated successfully',
      data: { transactionId: transaction._id, receiverAmount: receiverAmount, fee: totalFees }
    });

  } catch (error) {
    // Safety: Refund the user if the process failed after locking funds
    if (reservationMade) {
      await releaseReservedBalanceInternal(req.user.id, finalCurrency, finalAmount);
      logger.info(`REFUND: Returned ${finalAmount} ${finalCurrency} to user ${req.user.id}`);
    }
    const errorMsg = error.response?.data?.message || error.message;
    logger.error(`Withdrawal Error: ${errorMsg}`);
    return res.status(500).json({ success: false, message: errorMsg });
  }
});

router.post('/initiate', async (req, res) => {
  const { amount, currency, network } = req.body;
  const feeInfo = await getWithdrawalFee(currency, network);
  if (!feeInfo.success) return res.status(400).json(feeInfo);
  res.json({
    success: true,
    data: { amount, currency, fee: feeInfo.networkFee, feeUsd: feeInfo.feeUsd, receiverAmount: amount - feeInfo.networkFee, totalAmount: amount }
  });
});

router.get('/currencies', async (req, res) => {
  const currencies = Object.keys(SUPPORTED_TOKENS).map(c => ({ symbol: c, name: SUPPORTED_TOKENS[c].name }));
  res.json({ success: true, data: { currencies } });
});

module.exports = router;