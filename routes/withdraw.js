const express = require('express');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const router = express.Router();

const User = require('../models/user');
const Transaction = require('../models/transaction');
const CryptoFeeMarkup = require('../models/cryptofee');
const { validateObiexConfig, attachObiexAuth } = require('../utils/obiexAuth');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { getOriginalPricesWithCache } = require('../services/portfolio');
const logger = require('../utils/logger');
const config = require('./config');

// Configure Obiex axios instance
const obiexAxios = axios.create({
  baseURL: config.obiex.baseURL.replace(/\/+$/, ''),
  timeout: 30000, // 30 second timeout
});
obiexAxios.interceptors.request.use(attachObiexAuth);

// Obiex API fees (in network currency)
const OBIEX_FEES = {
  USDT: {
    'TRX': { min: 1, max: 15, fee: 2 }, // 2 TRX fee for USDT on TRX network
    'ETH': { min: 1, max: 20, fee: 3 }, // 3 ETH fee for USDT on ETH network
    'BSC': { min: 1, max: 10.50, fee: 0.50 }, // 0.50 BNB fee for USDT on BSC network
    'MATIC': { min: 1, max: 10.50, fee: 1 }, // 1 MATIC fee for USDT on MATIC network
    'ARBITRUM': { min: 1, max: 10.50, fee: 0.65 }, // 0.65 ARB fee for USDT on ARBITRUM network
    'AVAXC': { min: 1, max: 2, fee: 0.50 }, // 0.50 AVAX fee for USDT on AVAXC network
    'SOL': { min: 1, max: 12, fee: 1 } // 1 SOL fee for USDT on SOL network
  },
  USDC: {
    'BSC': { min: 1, max: 10, fee: 0.50 }, // BSC (BEP20)
    'MATIC': { min: 1, max: 10, fee: 1 }, // Polygon (MATIC)
    'AVAXC': { min: 1, max: 0.40, fee: 0.20 }, // Avax C-Chain
    'ARBITRUM': { min: 1, max: 1, fee: 0.50 }, // Arbitrum One
    'SOL': { min: 1, max: 10, fee: 3 }, // Solana
    'ETH': { min: 1, max: 25, fee: 3 }, // Ethereum (ERC20)
    'BASE': { min: 0.10, max: 11, fee: 1.20 } // Base
  },
  BTC: {
    'BSC': { min: 0, max: 0.0001, fee: 0.00005 }, // BSC (BEP20)
    'BTC': { min: 0.00005, max: 0.0003, fee: 0.0001 } // Bitcoin
  },
  ETH: {
    'ETH': { min: 0, max: 0.014, fee: 0.005 }, // Ethereum (ERC20)
    'BASE': { min: 0, max: 0, fee: 0 }, // Base
    'ARBITRUM': { min: 0, max: 0.001, fee: 0.0004 }, // Arbitrum One
    'BSC': { min: 0, max: 0.00013, fee: 0.00035 } // BSC (BEP20)
  },
  SOL: {
    'SOL': { min: 0.01, max: 0.10, fee: 0.015 }, // Solana
    'BSC': { min: 0, max: 0.00018, fee: 0.10 } // BSC (BEP20)
  },
  BNB: {
    'ETH': { min: 0, max: 0.012, fee: 0.002 }, // Ethereum (ERC20)
    'BSC': { min: 0, max: 0.01, fee: 0.001 } // BSC (BEP20)
  },
  MATIC: {
    'BSC': { min: 0, max: 0.20, fee: 1.40 }, // BSC (BEP20)
    'ETH': { min: 0, max: 20, fee: 12 }, // Ethereum (ERC20)
    'MATIC': { min: 0, max: 21, fee: 0.40 } // Polygon (MATIC)
  },
  TRX: {
    'TRX': { min: 5, max: 35, fee: 5 } // Tron (TRC20)
  }
};

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

// Token field mapping for balance operations
const TOKEN_FIELD_MAPPING = {
  BTC: 'btc',
  ETH: 'eth', 
  SOL: 'sol',
  USDT: 'usdt',
  USDC: 'usdc',
  BNB: 'bnb',
  MATIC: 'matic',
  TRX: 'trx',
  NGNB: 'ngnb'
};

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
    MATIC: 15,
    TRX: 1,
    NGNB: 1,
  },
};

/**
 * Get balance field name for currency
 * @param {string} currency - Currency code
 * @returns {string} Balance field name
 */
function getBalanceFieldName(currency) {
  const fieldMap = {
    'BTC': 'btcBalance',
    'ETH': 'ethBalance',
    'SOL': 'solBalance',
    'USDT': 'usdtBalance',
    'USDC': 'usdcBalance',
    'BNB': 'bnbBalance',
    'MATIC': 'maticBalance',
    'TRX': 'trxBalance',
    'NGNB': 'ngnbBalance'
  };
  return fieldMap[currency.toUpperCase()];
}

/**
 * Get pending balance field name for currency
 * @param {string} currency - Currency code
 * @returns {string} Pending balance field name
 */
function getPendingBalanceFieldName(currency) {
  const fieldMap = {
    'BTC': 'btcPendingBalance',
    'ETH': 'ethPendingBalance',
    'SOL': 'solPendingBalance',
    'USDT': 'usdtPendingBalance',
    'USDC': 'usdcPendingBalance',
    'BNB': 'bnbPendingBalance',
    'MATIC': 'maticPendingBalance',
    'TRX': 'trxPendingBalance',
    'NGNB': 'ngnbPendingBalance'
  };
  return fieldMap[currency.toUpperCase()];
}

/**
 * Get current crypto price using portfolio service
 * @param {string} currency - Currency code
 * @returns {Promise<number>} Price in USD
 */
async function getCryptoPriceInternal(currency) {
  try {
    const upperCurrency = currency.toUpperCase();
    const prices = await getOriginalPricesWithCache([upperCurrency]);
    const price = prices[upperCurrency] || 0;
    
    logger.debug(`Retrieved price for ${upperCurrency}: ${price}`);
    return price;
  } catch (error) {
    logger.error(`Failed to get price for ${currency}:`, error.message);
    return 0;
  }
}

/**
 * Validate user balance directly from User model
 * @param {string} userId - User ID
 * @param {string} currency - Currency code
 * @param {number} amount - Amount to validate
 * @returns {Promise<Object>} Validation result
 */
async function validateUserBalanceInternal(userId, currency, amount) {
  try {
    const balanceField = getBalanceFieldName(currency);
    if (!balanceField) {
      return {
        success: false,
        message: `Unsupported currency: ${currency}`,
        availableBalance: 0
      };
    }

    const user = await User.findById(userId).select(balanceField);
    if (!user) {
      return {
        success: false,
        message: 'User not found',
        availableBalance: 0
      };
    }

    const availableBalance = user[balanceField] || 0;
    
    if (availableBalance < amount) {
      return {
        success: false,
        message: `Insufficient ${currency} balance. Available: ${availableBalance}, Required: ${amount}`,
        availableBalance
      };
    }

    return {
      success: true,
      message: 'Sufficient balance available',
      availableBalance
    };
  } catch (error) {
    logger.error('Error validating user balance', { userId, currency, amount, error: error.message });
    return {
      success: false,
      message: 'Failed to validate balance',
      availableBalance: 0
    };
  }
}

/**
 * Reserve user balance by moving amount to pending
 * @param {string} userId - User ID
 * @param {string} currency - Currency code
 * @param {number} amount - Amount to reserve
 * @returns {Promise<Object>} Reservation result
 */
async function reserveUserBalanceInternal(userId, currency, amount) {
  try {
    const balanceField = getBalanceFieldName(currency);
    const pendingBalanceField = getPendingBalanceFieldName(currency);
    
    if (!balanceField || !pendingBalanceField) {
      throw new Error(`Unsupported currency: ${currency}`);
    }

    const result = await User.updateOne(
      { 
        _id: userId,
        [balanceField]: { $gte: amount }
      },
      {
        $inc: {
          [balanceField]: -amount,
          [pendingBalanceField]: amount
        },
        $set: { lastBalanceUpdate: new Date() }
      }
    );

    if (result.matchedCount === 0) {
      return {
        success: false,
        message: 'Insufficient balance or user not found'
      };
    }

    logger.info('Balance reserved successfully', { userId, currency, amount });
    return { success: true };
  } catch (error) {
    logger.error('Failed to reserve balance', { userId, currency, amount, error: error.message });
    return {
      success: false,
      message: 'Failed to reserve balance: ' + error.message
    };
  }
}

/**
 * Release reserved balance back to available balance
 * @param {string} userId - User ID
 * @param {string} currency - Currency code
 * @param {number} amount - Amount to release
 * @returns {Promise<Object>} Release result
 */
async function releaseReservedBalanceInternal(userId, currency, amount) {
  try {
    const balanceField = getBalanceFieldName(currency);
    const pendingBalanceField = getPendingBalanceFieldName(currency);
    
    if (!balanceField || !pendingBalanceField) {
      throw new Error(`Unsupported currency: ${currency}`);
    }

    const result = await User.updateOne(
      { 
        _id: userId,
        [pendingBalanceField]: { $gte: amount }
      },
      {
        $inc: {
          [balanceField]: amount,
          [pendingBalanceField]: -amount
        },
        $set: { lastBalanceUpdate: new Date() }
      }
    );

    if (result.matchedCount === 0) {
      logger.warn('Failed to release reserved balance - insufficient pending balance or user not found', {
        userId, currency, amount
      });
      return {
        success: false,
        message: 'Insufficient pending balance or user not found'
      };
    }

    logger.info('Reserved balance released successfully', { userId, currency, amount });
    return { success: true };
  } catch (error) {
    logger.error('Failed to release reserved balance', { userId, currency, amount, error: error.message });
    return {
      success: false,
      message: 'Failed to release reserved balance: ' + error.message
    };
  }
}

/**
 * Compare password pin with user's hashed password pin
 * @param {string} candidatePasswordPin - Plain text password pin to compare
 * @param {string} hashedPasswordPin - Hashed password pin from database
 * @returns {Promise<boolean>} - True if password pin matches
 */
async function comparePasswordPin(candidatePasswordPin, hashedPasswordPin) {
  if (!candidatePasswordPin || !hashedPasswordPin) {
    return false;
  }
  try {
    return await bcrypt.compare(candidatePasswordPin, hashedPasswordPin);
  } catch (error) {
    logger.error('Password pin comparison failed:', error);
    return false;
  }
}

/**
 * Validates withdrawal request parameters including Password PIN
 * @param {Object} body - Request body
 * @returns {Object} Validation result
 */
function validateWithdrawalRequest(body) {
  const { destination = {}, amount, currency, twoFactorCode, passwordpin } = body;
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
  
  // Password PIN validation
  if (!passwordpin?.trim()) {
    errors.push('Password PIN is required');
  } else {
    const pinStr = String(passwordpin).trim();
    if (!/^\d{6}$/.test(pinStr)) {
      errors.push('Password PIN must be exactly 6 numbers');
    }
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
  
  // For TRX currency, allow both TRX and TRC20 networks (TRC20 will be mapped to TRX)
  if (upperCurrency === 'TRX' && network && !['TRX', 'TRC20'].includes(network.toUpperCase())) {
    errors.push('Invalid network for TRX. Supported networks: TRX, TRC20');
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
      twoFactorCode: twoFactorCode.trim(),
      passwordpin: String(passwordpin).trim()
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
 * Get Obiex fee for a specific currency and network
 * @param {string} currency - Currency symbol
 * @param {string} network - Network identifier
 * @returns {number} Obiex fee amount
 */
function getObiexFee(currency, network) {
  const upperCurrency = currency.toUpperCase();
  const upperNetwork = network ? network.toUpperCase() : null;
  
  // Map network names to Obiex fee keys
  const networkMapping = {
    'TRC20': 'TRX',
    'TRON': 'TRX',
    'BSC': 'BSC',
    'BEP20': 'BSC',
    'ETH': 'ETH',
    'ERC20': 'ETH',
    'MATIC': 'MATIC',
    'POLYGON': 'MATIC',
    'SOL': 'SOL',
    'SOLANA': 'SOL',
    'ARBITRUM': 'ARBITRUM',
    'AVAXC': 'AVAXC',
    'BASE': 'BASE',
    'BTC': 'BTC',
    'BITCOIN': 'BTC'
  };
  
  const obiexNetworkKey = networkMapping[upperNetwork] || upperNetwork;
  
  // Check if we have Obiex fee data for this currency/network combination
  if (obiexNetworkKey && OBIEX_FEES[upperCurrency] && OBIEX_FEES[upperCurrency][obiexNetworkKey]) {
    const fee = OBIEX_FEES[upperCurrency][obiexNetworkKey].fee;
    logger.info('Obiex fee found', { 
      currency: upperCurrency, 
      originalNetwork: upperNetwork, 
      mappedNetwork: obiexNetworkKey, 
      fee 
    });
    return fee;
  }
  
  // Default to 0 if no Obiex fee data available
  logger.warn('No Obiex fee data found', { 
    currency: upperCurrency, 
    originalNetwork: upperNetwork, 
    mappedNetwork: obiexNetworkKey,
    availableNetworks: OBIEX_FEES[upperCurrency] ? Object.keys(OBIEX_FEES[upperCurrency]) : []
  });
  return 0;
}

/**
 * Gets withdrawal fee configuration - converts network fee to withdrawal currency equivalent
 * @param {string} currency - Currency symbol being withdrawn
 * @param {string} network - Network (optional, for matching specific network fees)
 * @returns {Promise<Object>} Fee information
 */
async function getWithdrawalFee(currency, network = null) {
  try {
    // Build query to find fee configuration
    const query = { currency: currency.toUpperCase() };
    if (network) {
      query.network = network.toUpperCase();
    }

    const feeDoc = await CryptoFeeMarkup.findOne(query);
    
    if (!feeDoc) {
      throw new Error(`Fee configuration missing for ${currency.toUpperCase()}${network ? ` on ${network}` : ''}`);
    }

    const networkFee = feeDoc.networkFee;
    
    logger.info('Database fee configuration found', {
      currency: currency.toUpperCase(),
      network: network?.toUpperCase(),
      networkFee: networkFee,
      feeDoc: {
        _id: feeDoc._id,
        currency: feeDoc.currency,
        network: feeDoc.network,
        networkFee: feeDoc.networkFee,
        networkName: feeDoc.networkName
      }
    });
    
    // Check if the database fee is too high
    if (networkFee > 2) {
      logger.warn('High network fee detected', {
        currency: currency.toUpperCase(),
        network: network?.toUpperCase(),
        networkFee: networkFee,
        expectedRange: '0.5-1.5 USDT'
      });
    }
    
    if (!networkFee || networkFee < 0) {
      throw new Error(`Invalid fee configuration for ${currency.toUpperCase()}`);
    }

    // Get Obiex fee for this currency/network combination
    const obiexFee = getObiexFee(currency, network);
    
    // Calculate total fee: our network fee + Obiex fee
    // Note: Obiex fee is already in the withdrawal currency (USDT), so we add it directly
    const totalFee = networkFee + obiexFee;
    
    logger.info('Fee calculation with Obiex fees', {
      currency: currency.toUpperCase(),
      network: network?.toUpperCase(),
      ourNetworkFee: networkFee,
      obiexFee: obiexFee,
      totalFee: totalFee,
      obiexFeeLookup: OBIEX_FEES[currency.toUpperCase()]?.[network?.toUpperCase()],
      feeDoc: {
        networkFee: feeDoc.networkFee,
        networkName: feeDoc.networkName,
        currency: feeDoc.currency,
        network: feeDoc.network
      },
      breakdown: {
        step1: `Database network fee: ${networkFee} USDT`,
        step2: `Obiex fee: ${obiexFee} TRX`,
        step3: `Total fee before conversion: ${totalFee} TRX`,
        step4: `This will be converted to USDT based on TRX price`
      }
    });

    // Determine the network's native currency for fee conversion
    const networkCurrency = getNetworkNativeCurrency(network);
    const withdrawalCurrency = currency.toUpperCase();

    let feeInWithdrawalCurrency;
    let feeUsd;

    if (networkCurrency === withdrawalCurrency) {
      // Same currency - no conversion needed
      feeInWithdrawalCurrency = totalFee;
      const cryptoPrice = await getCryptoPriceInternal(withdrawalCurrency);
      feeUsd = totalFee * cryptoPrice;
      
      logger.info('USD conversion calculation', {
        currency: withdrawalCurrency,
        totalFee: totalFee,
        cryptoPrice: cryptoPrice,
        feeUsd: feeUsd
      });
    } else {
      // Different currencies - convert network fee to withdrawal currency equivalent
      const prices = await getOriginalPricesWithCache([networkCurrency, withdrawalCurrency]);
      const networkPrice = prices[networkCurrency] || 0;
      const withdrawalPrice = prices[withdrawalCurrency] || 0;

      if (networkPrice <= 0 || withdrawalPrice <= 0) {
        throw new Error(`Unable to get prices for fee conversion: ${networkCurrency} = ${networkPrice}, ${withdrawalCurrency} = ${withdrawalPrice}`);
      }

      // Convert total fee to USD, then to withdrawal currency equivalent
      const feeValueUsd = totalFee * networkPrice;
      feeInWithdrawalCurrency = feeValueUsd / withdrawalPrice;
      feeUsd = feeValueUsd;

      logger.info('Converted cross-currency fee with Obiex', {
        originalFee: `${networkFee} ${networkCurrency}`,
        obiexFee: `${obiexFee} ${networkCurrency}`,
        totalFee: `${totalFee} ${networkCurrency}`,
        convertedFee: `${feeInWithdrawalCurrency} ${withdrawalCurrency}`,
        feeUsd: `${feeUsd}`,
        networkPrice: `${networkPrice}`,
        withdrawalPrice: `${withdrawalPrice}`
      });
    }

    return {
      success: true,
      networkFee: parseFloat(feeInWithdrawalCurrency.toFixed(WITHDRAWAL_CONFIG.AMOUNT_PRECISION)),
      feeUsd: parseFloat(feeUsd.toFixed(2)),
      originalNetworkFee: networkFee,
      obiexFee: obiexFee,
      totalFee: totalFee,
      networkCurrency,
      networkName: feeDoc.networkName
    };
  } catch (error) {
    logger.error('Error getting withdrawal fee', { currency, network, error: error.message });
    return {
      success: false,
      message: error.message
    };
  }
}

/**
 * Get network's native currency for fee calculations
 * @param {string} network - Network identifier
 * @returns {string} Native currency symbol
 */
function getNetworkNativeCurrency(network) {
  const networkMap = {
    'BSC': 'BNB',
    'BEP20': 'BNB',
    'ETH': 'ETH',
    'ERC20': 'ETH',
    'ETHEREUM': 'ETH',
    'MATIC': 'MATIC',
    'POLYGON': 'MATIC',
    'SOL': 'SOL',
    'SOLANA': 'SOL',
    'BTC': 'BTC',
    'BITCOIN': 'BTC',
    'TRC20': 'TRX',
    'TRON': 'TRX',
  };
  
  return networkMap[network?.toUpperCase()] || network?.toUpperCase() || 'ETH'; // Default to ETH if unknown
}

/**
 * Initiates withdrawal through Obiex API
 * @param {Object} withdrawalData - Withdrawal parameters
 * @returns {Promise<Object>} Obiex API response
 */
async function initiateObiexWithdrawal(withdrawalData) {
  const { amount, address, currency, network, memo, narration } = withdrawalData;
  
  // Build destination object OUTSIDE try block
  const destination = {
    address
  };
  
  // Add optional destination fields
  if (network) {
    const originalNetwork = network.toUpperCase();
    let mappedNetwork = originalNetwork;
    
    // Force TRX network for Obiex API when dealing with Tron-based networks
    // This ensures that both TRC20 and TRX requests use TRX network for Obiex API
    if (originalNetwork === 'TRC20' || originalNetwork === 'TRX') {
      mappedNetwork = 'TRX';
    }
    
    destination.network = mappedNetwork;
    
    logger.info('Network mapping for Obiex API', {
      originalNetwork,
      mappedNetwork,
      currency,
      address: address.substring(0, 10) + '...',
      reason: originalNetwork === 'TRC20' ? 'TRC20 mapped to TRX for Obiex' : 'Network used as-is'
    });
  }
  if (memo?.trim()) destination.memo = memo.trim();

  // Build payload OUTSIDE try block so it's accessible in catch
  const payload = {
    destination,
    amount: Number(amount),
    currency: currency.toUpperCase(),
    narration: narration || `Crypto withdrawal - ${currency}`
  };
  
  try {
    logger.info('Initiating Obiex withdrawal', { 
      currency, 
      amount, 
      address: address.substring(0, 10) + '...',
      payload: JSON.stringify(payload)
    });

    const response = await obiexAxios.post('/wallets/ext/debit/crypto', payload);
    
    // Obiex returns data in response.data.data format
    if (!response.data?.data?.id) {
      throw new Error('Invalid response from Obiex: missing transaction ID');
    }

    return {
      success: true,
      data: {
        transactionId: response.data.data.id,
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
      requestPayload: JSON.stringify(payload)
    });
    
    return {
      success: false,
      message: error.response?.data?.message || 'Withdrawal service temporarily unavailable',
      statusCode: error.response?.status || 500
    };
  }
}

/**
 * Creates withdrawal transaction record with security validation tracking
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
    narration,
    user
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
      reference: obiexReference,
      narration,
      metadata: {
        initiatedAt: new Date(),
        expectedConfirmations: WITHDRAWAL_CONFIG.MIN_CONFIRMATION_BLOCKS[currency.toUpperCase()] || 1,
        twofa_validated: true,
        passwordpin_validated: true,
        kyc_validated: false,
        kyc_level: user?.kycLevel,
        security_validations: {
          twofa: true,
          passwordpin: true,
          kyc: false,
          duplicate_check: true
        },
        balance_updated_directly: true
      }
    });

    logger.info('Withdrawal transaction created with security validations', {
      transactionId: transaction._id,
      userId,
      currency,
      amount,
      obiexTransactionId,
      security_status: '2FA + PIN validated'
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
 * Main crypto withdrawal endpoint with all functions handled internally
 */
router.post('/crypto', async (req, res) => {
  const startTime = Date.now();
  let reservationMade = false;
  let transactionCreated = false;
  let reservedAmount = 0;
  let reservedCurrency = '';

  try {
    // Validate Obiex configuration
    validateObiexConfig();

    const userId = req.user.id;
    
    logger.info(`Crypto withdrawal request from user ${userId}:`, {
      ...req.body,
      passwordpin: '[REDACTED]',
      destination: {
        ...req.body.destination,
        address: req.body.destination?.address ? req.body.destination.address.substring(0, 10) + '...' : undefined
      }
    });
    
    // Validate request parameters
    const validation = validateWithdrawalRequest(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: validation.message,
        errors: validation.errors
      });
    }

    const { address, amount, currency, network, twoFactorCode, passwordpin } = validation.validatedData;
    const { memo, narration } = req.body;

    logger.info('Processing crypto withdrawal request', {
      userId,
      currency,
      amount,
      network,
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
      logger.warn('Invalid 2FA attempt for crypto withdrawal', { userId });
      return res.status(401).json({
        success: false,
        message: 'Invalid two-factor authentication code'
      });
    }

    logger.info('2FA validation successful for crypto withdrawal', { 
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
      userId 
    });

    // Validate password pin
    if (!user.passwordpin) {
      return res.status(400).json({
        success: false,
        message: 'Password PIN is not set up for your account. Please set up your password PIN first.'
      });
    }

    const isPasswordPinValid = await comparePasswordPin(passwordpin, user.passwordpin);
    if (!isPasswordPinValid) {
      logger.warn('Invalid password PIN attempt for crypto withdrawal', { 
        userId,
        currency,
        timestamp: new Date().toISOString().slice(0, 19).replace('T', ' ')
      });
      return res.status(401).json({
        success: false,
        message: 'Invalid password PIN'
      });
    }

    logger.info('Password PIN validation successful for crypto withdrawal', { 
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
      userId,
      currency
    });

    // Check for duplicate withdrawals
    const duplicateCheck = await checkDuplicateWithdrawal(userId, currency, amount, address);
    if (duplicateCheck.isDuplicate) {
      return res.status(400).json({
        success: false,
        error: 'DUPLICATE_WITHDRAWAL',
        message: duplicateCheck.message
      });
    }

    // Get withdrawal fee
    const feeInfo = await getWithdrawalFee(currency, network);
    if (!feeInfo.success) {
      return res.status(400).json({
        success: false,
        error: 'FEE_CALCULATION_ERROR',
        message: feeInfo.message
      });
    }

    const { networkFee, feeUsd, obiexFee } = feeInfo;
    const totalAmount = amount;
    
    // Calculate total fees (your fee + Obiex fee)
    const totalFees = networkFee + obiexFee;
    
    // Receiver gets: amount - total fees (your fee + Obiex fee)
    const receiverAmount = amount - totalFees;
    
    // Calculate the amount to send to Obiex (user amount minus our fee, but Obiex will deduct their fee)
    const obiexAmount = amount - networkFee;

    // Validate that receiver will get a positive amount after fee deduction
    if (receiverAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'AMOUNT_TOO_LOW',
        message: `Withdrawal amount too low. Total fees (${totalFees} ${currency}) exceed requested amount (${amount} ${currency}).`,
        details: {
          requestedAmount: amount,
          yourFee: networkFee,
          obiexFee: obiexFee,
          totalFees: totalFees,
          wouldReceive: receiverAmount,
          currency: currency
        }
      });
    }

    // Store for cleanup
    reservedAmount = totalAmount;
    reservedCurrency = currency;

    // Validate user balance
    const balanceValidation = await validateUserBalanceInternal(userId, currency, totalAmount);
    
    if (!balanceValidation.success) {
      return res.status(400).json({
        success: false,
        error: 'INSUFFICIENT_BALANCE',
        message: balanceValidation.message,
        details: {
          availableBalance: balanceValidation.availableBalance,
          requiredAmount: totalAmount,
          withdrawalAmount: amount,
          receiverAmount: receiverAmount,
          fee: networkFee,
          currency: currency
        }
      });
    }

    logger.info('All validations passed for crypto withdrawal', {
      userId,
      currency,
      amount,
      totalAmount,
      address: address.substring(0, 10) + '...',
      yourFee: networkFee,
      obiexFee: obiexFee,
      totalFees: totalFees,
      receiverAmount: receiverAmount,
      obiexAmount: obiexAmount,
      security_status: '2FA + PIN + Balance validated'
    });

    // Initiate Obiex withdrawal
    const obiexResult = await initiateObiexWithdrawal({
      amount: obiexAmount,
      address,
      currency,
      network,
      memo,
      narration
    });

    if (!obiexResult.success) {
      logger.error('API withdrawal failed', {
        userId,
        currency,
        amount,
        error: obiexResult.message,
        statusCode: obiexResult.statusCode
      });
      
      return res.status(obiexResult.statusCode || 500).json({
        success: false,
        error: 'OBIEX_API_ERROR',
        message: obiexResult.message
      });
    }

    // Create transaction record
    const transaction = await createWithdrawalTransaction({
      userId,
      currency,
      amount: receiverAmount,
      address,
      network,
      memo,
      fee: networkFee,
      obiexTransactionId: obiexResult.data.transactionId,
      obiexReference: obiexResult.data.reference,
      narration,
      user
    });
    transactionCreated = true;

    // Reserve user balance
    const reservationResult = await reserveUserBalanceInternal(userId, currency, totalAmount);
    if (!reservationResult.success) {
      logger.error('Failed to reserve balance for withdrawal', {
        userId,
        currency,
        totalAmount,
        error: reservationResult.message
      });
      
      return res.status(500).json({
        success: false,
        error: 'BALANCE_RESERVATION_ERROR',
        message: 'Failed to reserve balance for withdrawal'
      });
    }
    reservationMade = true;

    const processingTime = Date.now() - startTime;
    logger.info('✅ Crypto withdrawal processed successfully', {
      userId,
      currency,
      amount,
      totalAmount,
      transactionId: transaction._id,
      obiexTransactionId: obiexResult.data.transactionId,
      processingTime,
      security_validations: 'All passed (2FA + PIN + Balance)',
      balance_update_method: 'internal_direct'
    });

    res.status(200).json({
      success: true,
      message: 'Crypto withdrawal initiated successfully',
      data: {
        transactionId: transaction._id,
        obiexTransactionId: obiexResult.data.transactionId,
        obiexReference: obiexResult.data.reference,
        obiexStatus: obiexResult.data.status,
        currency,
        requestedAmount: amount,
        receiverAmount: receiverAmount,
        fee: totalFees, // Show total fees as the network fee
        feeUsd,
        totalAmount,
        estimatedConfirmationTime: `${WITHDRAWAL_CONFIG.MIN_CONFIRMATION_BLOCKS[currency] || 1} blocks`,
        security_info: {
          twofa_validated: true,
          passwordpin_validated: true,
          kyc_validated: false,
          kyc_level: user.kycLevel,
          duplicate_check_passed: true,
          balance_updated_directly: true
        }
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error('❌ Crypto withdrawal processing failed', {
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      processingTime,
      reservationMade,
      transactionCreated
    });

    // Cleanup: Release reserved balance if reservation was made
    if (reservationMade && reservedAmount > 0 && reservedCurrency) {
      try {
        await releaseReservedBalanceInternal(req.user?.id, reservedCurrency, reservedAmount);
        logger.info('🔄 Released reserved balance due to withdrawal failure', { 
          userId: req.user?.id, 
          currency: reservedCurrency, 
          amount: reservedAmount 
        });
      } catch (releaseError) {
        logger.error('❌ Failed to release reserved balance after withdrawal failure', {
          userId: req.user?.id,
          currency: reservedCurrency,
          amount: reservedAmount,
          error: releaseError.message
        });
      }
    }

    res.status(500).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
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
        error: 'TRANSACTION_NOT_FOUND',
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
        updatedAt: transaction.updatedAt,
        security_info: {
          twofa_validated: transaction.metadata?.twofa_validated,
          passwordpin_validated: transaction.metadata?.passwordpin_validated,
          kyc_validated: transaction.metadata?.kyc_validated,
          kyc_level: transaction.metadata?.kyc_level,
          balance_updated_directly: transaction.metadata?.balance_updated_directly
        }
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
      error: 'STATUS_FETCH_ERROR',
      message: 'Failed to fetch withdrawal status'
    });
  }
});

/**
 * Initiate withdrawal fee calculation
 */
router.post('/initiate', async (req, res) => {
  const { amount, currency, network } = req.body;

  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Invalid amount provided.',
    });
  }

  if (!SUPPORTED_TOKENS[currency]) {
    return res.status(400).json({
      success: false,
      message: `Unsupported currency: ${currency}`,
    });
  }

  try {
    const feeInfo = await getWithdrawalFee(currency, network);
    if (!feeInfo.success) {
      return res.status(400).json({
        success: false,
        message: feeInfo.message,
      });
    }

    const { networkFee, feeUsd, obiexFee } = feeInfo;
    const totalAmount = amount;
    
    // Calculate total fees (your fee + Obiex fee)
    const totalFees = networkFee + obiexFee;
    
    // Receiver gets: amount - total fees (your fee + Obiex fee)
    const receiverAmount = amount - totalFees;
    
    logger.info('Fee calculation endpoint response', {
      currency,
      network,
      amount,
      networkFee,
      obiexFee,
      totalFees,
      receiverAmount,
      feeUsd,
      feeInfo: {
        networkFee: feeInfo.networkFee,
        feeUsd: feeInfo.feeUsd,
        obiexFee: feeInfo.obiexFee,
        totalFee: feeInfo.totalFee
      }
    });

    const response = {
      success: true,
      data: {
        amount,
        currency,
        fee: totalFees, // Show total fees as the network fee
        feeUsd,
        receiverAmount,
        totalAmount
      }
    };

    res.status(200).json(response);
  } catch (error) {
    logger.error('Error in initiating fee calculation', {
      error: error.message,
    });

    res.status(500).json({
      success: false,
      message: 'Internal server error during fee calculation.',
    });
  }
});

/**
 * Get supported currencies
 */
router.get('/currencies', async (req, res) => {
  try {
    const currencies = Object.keys(SUPPORTED_TOKENS).map(currency => ({
      symbol: currency,
      name: SUPPORTED_TOKENS[currency].name || currency,
      minConfirmations: WITHDRAWAL_CONFIG.MIN_CONFIRMATION_BLOCKS[currency] || 1,
      isStablecoin: SUPPORTED_TOKENS[currency].isStablecoin || false
    }));
    
    res.status(200).json({
      success: true,
      data: {
        currencies,
        total: currencies.length
      }
    });
    
  } catch (error) {
    logger.error('Error fetching supported currencies:', error);
    res.status(500).json({
      success: false,
      error: 'CURRENCIES_FETCH_ERROR',
      message: 'Failed to retrieve supported currencies'
    });
  }
});

module.exports = router;