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

// Import idempotency middleware
const { idempotencyMiddleware } = require('../utils/Idempotency');

// SECURITY FIX: Import distributed lock and security service
const { withLock } = require('../utils/redisLock');
const securityService = require('../services/securityService');

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

// Network-specific minimum withdrawal amounts (prevents unprofitable micro-withdrawals)
const NETWORK_MINIMUM_WITHDRAWALS = {
  'BTC-BITCOIN': { min: 0.0001, max: 10 },
  'ETH-ETHEREUM': { min: 0.005, max: 100 },
  'SOL-SOLANA': { min: 0.01, max: 10000 },
  'USDT-TRC20': { min: 5, max: 100000 },
  'USDT-ERC20': { min: 10, max: 100000 },
  'USDT-POLYGON': { min: 5, max: 100000 },
  'USDT-BEP20': { min: 5, max: 100000 },
  'USDC-ERC20': { min: 10, max: 100000 },
  'USDC-POLYGON': { min: 5, max: 100000 },
  'USDC-TRC20': { min: 5, max: 100000 },
  'BNB-BEP20': { min: 0.01, max: 1000 },
  'MATIC-POLYGON': { min: 1, max: 100000 },
  'TRX-TRC20': { min: 10, max: 1000000 }
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

    if (upperCurrency === 'MATIC') upperCurrency = 'POL';
    if (upperNetwork === 'POL' || upperNetwork === 'POLYGON') upperNetwork = 'MATIC';

    const asset = OBIEX_NETWORK_DATA[upperCurrency];
    if (!asset) throw new Error(`Currency ${upperCurrency} not found in configuration`);

    const obiexNet = asset.networks.find(n => n.code === upperNetwork);
    if (!obiexNet) throw new Error(`Network ${upperNetwork} not found for ${upperCurrency}`);

    const dbCurrency = upperCurrency === 'POL' ? 'MATIC' : upperCurrency;
    const feeDoc = await CryptoFeeMarkup.findOne({ currency: dbCurrency, network: upperNetwork });
    
    if (!feeDoc) throw new Error(`Markup missing in DB for ${dbCurrency} on ${upperNetwork}`);

    const totalFee = obiexNet.fee + feeDoc.networkFee;
    const prices = await getOriginalPricesWithCache([dbCurrency]);
    const feeUsd = totalFee * (prices[dbCurrency] || 0);

    return {
      success: true,
      networkFee: parseFloat(totalFee.toFixed(8)), // Total displayed to user
      feeUsd: parseFloat(feeUsd.toFixed(2)),
      originalNetworkFee: feeDoc.networkFee,       // This is YOUR markup
      obiexFee: obiexNet.fee                      // This is Obiex's fee
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
    } else {
      // Address format validation
      if (validNetwork.addressRegex) {
        if (!new RegExp(validNetwork.addressRegex).test(address.trim())) {
          errors.push(`Invalid address format for ${validNetwork.name}`);
        }
      }

      // SECURITY FIX: Network-specific minimum/maximum validation
      const networkKey = `${upperCurrency}-${upperNetwork}`;
      const limits = NETWORK_MINIMUM_WITHDRAWALS[networkKey];
      if (limits) {
        if (Number(amount) < limits.min) {
          errors.push(`Minimum withdrawal for ${upperCurrency} on ${upperNetwork} is ${limits.min} ${upperCurrency}`);
        }
        if (Number(amount) > limits.max) {
          errors.push(`Maximum withdrawal for ${upperCurrency} on ${upperNetwork} is ${limits.max} ${upperCurrency}`);
        }
      }
    }
  }

  return errors.length > 0
    ? { success: false, message: errors.join('; ') }
    : { success: true, validatedData: { address, amount: Number(amount), currency: upperCurrency, network: upperNetwork, twoFactorCode, passwordpin } };
}

/**
 * WITHDRAWAL EXECUTION
 * NOTE: idempotencyMiddleware is applied here to prevent duplicate withdrawals
 */
router.post('/crypto', idempotencyMiddleware, async (req, res) => {
  let reservationMade = false;
  let finalAmount;
  let finalCurrency;
  let internalCurrency; 
  let internalNetwork;  

  try {
    const validation = validateWithdrawalRequest(req.body);
    if (!validation.success) return res.status(400).json(validation);

    const { address, amount, currency, network, twoFactorCode, passwordpin } = validation.validatedData;
    
    internalCurrency = currency.toUpperCase() === 'POL' ? 'MATIC' : currency.toUpperCase();
    internalNetwork = (network.toUpperCase() === 'POL' || network.toUpperCase() === 'POLYGON') ? 'MATIC' : network.toUpperCase();
    
    finalAmount = amount;
    finalCurrency = internalCurrency; 
    const { memo, narration } = req.body;

    const user = await User.findById(req.user.id);
    if (!user) return res.status(401).json({ success: false, message: 'Authentication required' });

    // --- SECURITY CHECKS ---
    // SECURITY FIX: Enforce 2FA must be enabled for withdrawals
    if (!user.is2FAEnabled) {
      logger.warn(`Withdrawal blocked: 2FA not enabled`, { userId: user._id, ip: req.ip });
      return res.status(403).json({
        success: false,
        message: 'Two-factor authentication must be enabled to perform withdrawals. Please enable 2FA in your security settings.'
      });
    }

    // SECURITY FIX: Check 2FA attempt rate limiting
    const twoFACheck = await securityService.check2FAAttempts(user._id.toString());
    if (!twoFACheck.allowed) {
      return res.status(429).json({
        success: false,
        message: twoFACheck.message,
        lockUntil: twoFACheck.lockUntil
      });
    }

    // SECURITY FIX: Check for 2FA code replay attack
    const isReplay = await securityService.check2FACodeReplay(user._id.toString(), twoFactorCode);
    if (isReplay) {
      logger.warn(`2FA replay attack detected`, { userId: user._id, ip: req.ip });
      return res.status(401).json({
        success: false,
        message: 'This 2FA code has already been used. Please wait for a new code.'
      });
    }

    const is2faValid = validateTwoFactorAuth(user, twoFactorCode);
    if (!is2faValid) {
      await securityService.record2FAFailure(user._id.toString());
      const remainingAttempts = twoFACheck.attemptsRemaining - 1;

      logger.warn(`Withdrawal blocked: Invalid 2FA code`, {
        userId: user._id,
        ip: req.ip,
        attemptsRemaining: remainingAttempts
      });

      return res.status(401).json({
        success: false,
        message: remainingAttempts > 0
          ? `Invalid 2FA code. ${remainingAttempts} attempt(s) remaining.`
          : 'Invalid 2FA code.'
      });
    }

    // Reset 2FA attempts on success and mark code as used
    await securityService.reset2FAAttempts(user._id.toString());
    await securityService.mark2FACodeUsed(user._id.toString(), twoFactorCode);

    // SECURITY FIX: Check PIN attempt rate limiting
    const pinCheck = await securityService.checkPINAttempts(user._id.toString());
    if (!pinCheck.allowed) {
      return res.status(423).json({
        success: false,
        message: pinCheck.message,
        accountLocked: true,
        lockUntil: pinCheck.lockUntil
      });
    }

    const isPinValid = await comparePasswordPin(passwordpin, user.passwordpin);
    if (!isPinValid) {
      const attempts = await securityService.recordPINFailure(user._id.toString());
      const remainingAttempts = Math.max(0, 5 - attempts);

      logger.warn(`Withdrawal blocked: Invalid PIN`, {
        userId: user._id,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        amount,
        currency: internalCurrency,
        attemptsRemaining: remainingAttempts
      });

      return res.status(401).json({
        success: false,
        message: remainingAttempts > 0
          ? `Invalid PIN. ${remainingAttempts} attempt(s) remaining before account lock.`
          : 'Invalid credentials.'
      });
    }

    // Reset PIN attempts on success
    await securityService.resetPINAttempts(user._id.toString());

    // --- 3. KYC / TRANSACTION LIMIT CHECK ---
    const kycCheck = await validateTransactionLimit(user._id, amount, internalCurrency, 'WITHDRAWAL');
    if (!kycCheck.allowed) {
      logger.warn(`KYC Limit Block: User ${user._id} attempted ${amount} ${internalCurrency}. Reason: ${kycCheck.message}`);
      return res.status(403).json({ success: false, message: 'Transaction exceeds your current KYC limit.' });
    }

    // --- 4. FEE CALCULATION ---
    const feeInfo = await getWithdrawalFee(currency, network); 
    if (!feeInfo.success) return res.status(400).json(feeInfo);

    /**
     * Logic: 
     * totalFees = Obiex Fee + Your Markup.
     * We subtract only YOUR markup (originalNetworkFee) from the amount we send to Obiex.
     * Obiex will then subtract its own fee (obiexFee) from the remaining balance.
     */
    const totalFees = feeInfo.networkFee;
    const obiexSendAmount = amount - feeInfo.originalNetworkFee;

    if (obiexSendAmount <= 0) return res.status(400).json({ success: false, message: "Amount too low to cover fees" });

    // --- 5. BALANCE VALIDATION & LOCKING WITH DISTRIBUTED LOCK ---
    // SECURITY FIX: Use distributed lock to prevent race conditions
    const lockKey = `withdrawal:${user._id}:${internalCurrency}`;

    const lockResult = await withLock(
      lockKey,
      async () => {
        // Atomic check and reserve within lock
        const balCheck = await validateUserBalanceInternal(user._id, internalCurrency, amount);
        if (!balCheck.success) {
          throw new Error("Insufficient balance");
        }

        const reserveRes = await reserveUserBalanceInternal(user._id, internalCurrency, amount);
        if (!reserveRes.success) {
          throw new Error("Balance locking failed - race condition detected");
        }

        return { success: true };
      },
      {
        ttl: 10000,        // Lock timeout: 10 seconds
        maxWaitTime: 5000, // Wait up to 5 seconds for lock
        retryInterval: 50  // Check every 50ms
      }
    ).catch(error => {
      logger.error(`Failed to acquire withdrawal lock for user ${user._id}:`, error.message);
      return { success: false, error: error.message };
    });

    if (!lockResult.success) {
      return res.status(409).json({
        success: false,
        message: lockResult.error === "Insufficient balance"
          ? "Insufficient balance"
          : "Another withdrawal is in progress. Please wait and try again."
      });
    }

    reservationMade = true;

    // --- 6. EXTERNAL PROVIDER CALL (Obiex) ---
    const payload = {
      destination: { address, network: internalNetwork, memo: memo?.trim() },
      amount: Number(obiexSendAmount.toFixed(8)), // We send amount minus our markup
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
      amount: -amount, // Negative for withdrawals (matches convention: withdrawals are negative)
      address, 
      network: internalNetwork, 
      status: 'PENDING', 
      fee: totalFees, // Total fee (Yours + Obiex)
      obiexTransactionId: obiexData.id, 
      reference: obiexData.reference
    });

    if (user.email) sendWithdrawalEmail(user.email, user.username, amount, internalCurrency, transaction._id);

    // Enhanced security logging
    logger.info(`Crypto withdrawal initiated`, {
      userId: user._id,
      transactionId: transaction._id,
      amount,
      currency: internalCurrency,
      network: internalNetwork,
      destination: `${address.substring(0, 10)}...${address.substring(address.length - 6)}`,
      fee: totalFees,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      country: req.get('CF-IPCountry') || 'unknown'
    });

    return res.json({
      success: true,
      message: 'Withdrawal initiated successfully',
      data: {
        transactionId: transaction._id,
        amount: amount,
        fee: totalFees
      }
    });

  } catch (error) {
    if (reservationMade) {
      await releaseReservedBalanceInternal(req.user.id, finalCurrency, finalAmount);
    }
    const errorMsg = error.response?.data?.message || error.message;
    logger.error(`Withdrawal Error: ${errorMsg}`);
    return res.status(500).json({ success: false, message: errorMsg });
  }
});

// These routes don't need idempotency protection as they don't modify state
router.post('/initiate', async (req, res) => {
  const { amount, currency, network } = req.body;
  const feeInfo = await getWithdrawalFee(currency, network);
  if (!feeInfo.success) return res.status(400).json(feeInfo);
  
  res.json({
    success: true,
    data: { 
      amount: Number(amount), 
      currency, 
      fee: feeInfo.networkFee, 
      feeUsd: feeInfo.feeUsd, 
      receiverAmount: Number(amount) - feeInfo.networkFee, 
      totalAmount: Number(amount) 
    }
  });
});

router.get('/currencies', async (req, res) => {
  const currencies = Object.keys(SUPPORTED_TOKENS).map(c => ({ symbol: c, name: SUPPORTED_TOKENS[c].name }));
  res.json({ success: true, data: { currencies } });
});

module.exports = router;