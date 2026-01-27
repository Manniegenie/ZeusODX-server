const { payBetaAuth } = require('../services/PayBetaAuth');
const Wallet = require('../models/wallet');
const BillTransaction = require('../models/billstransaction');
const logger = require('../utils/logger');
const { verifyPin, verifyTwoFactor } = require('../services/security');
const { runKYCCheck } = require('../services/kyc');

/**
 * Explicit PayBeta service slug mapping
 * DO NOT infer, lowercase, or guess
 */
const PAYBETA_SERVICE_MAP = {
  betway: 'betway',
  bet9ja: 'bet9ja',
  betking: 'betking',
  bangbet: 'bangbet',
  '1xbet': '1xbet',
  nairabet: 'nairabet',
  sportybet: 'sportybet',
  supabet: 'supabet',
  mlotto: 'mlotto',
  westernlotto: 'westernlotto',
  greenlotto: 'greenlotto'
};

module.exports.fundBettingAccount = async (req, res) => {
  const requestId = `betting_fund_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  try {
    const {
      service_id,
      customer_id,
      amount,
      passwordpin,
      twoFactorCode
    } = req.body;

    const userId = req.user._id;

    logger.info('🎰 Betting funding request received', {
      requestId,
      userId,
      service_id,
      amount,
      customer_id: customer_id?.slice(0, 4) + '***'
    });

    /**
     * 1. Basic validation
     */
    if (!service_id || !customer_id || !amount) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_REQUEST',
        message: 'Invalid betting request'
      });
    }

    /**
     * 2. Resolve PayBeta service slug (FIX FOR PROBLEM 1)
     */
    const paybetaService = PAYBETA_SERVICE_MAP[service_id.toLowerCase()];
    if (!paybetaService) {
      logger.warn('❌ Unsupported betting service', { service_id, requestId });
      return res.status(400).json({
        success: false,
        error: 'UNSUPPORTED_SERVICE',
        message: 'Selected betting service is not supported'
      });
    }

    /**
     * 3. Security checks
     */
    await verifyPin(userId, passwordpin);
    await verifyTwoFactor(userId, twoFactorCode);

    /**
     * 4. KYC enforcement
     */
    const kycResult = await runKYCCheck(userId, amount, 'BILL_PAYMENT');
    if (!kycResult.allowed) {
      return res.status(403).json({
        success: false,
        error: kycResult.code,
        message: 'Transaction not permitted'
      });
    }

    /**
     * 5. Wallet balance check
     */
    const wallet = await Wallet.findOne({ user: userId });
    if (!wallet || wallet.balance < amount) {
      return res.status(400).json({
        success: false,
        error: 'INSUFFICIENT_FUNDS',
        message: 'Insufficient wallet balance'
      });
    }

    /**
     * 6. Prepare PayBeta payload
     */
    const reference = `bet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const paybetaPayload = {
      service: paybetaService,
      customerId: customer_id,
      customerName: req.body.customerName || 'Customer',
      amount,
      reference
    };

    logger.info('📡 PayBeta purchase request prepared', {
      requestId,
      service: paybetaService,
      reference
    });

    /**
     * 7. Call PayBeta
     */
    let paybetaResponse;
    try {
      paybetaResponse = await payBetaAuth.makeRequest(
        'POST',
        '/v2/gaming/purchase',
        paybetaPayload,
        { timeout: 90000 }
      );
    } catch (apiError) {
      // FIX FOR PROBLEM 4: No PayBeta leakage to frontend
      logger.error('💥 PayBeta gaming purchase failed', {
        requestId,
        reference,
        internalError: apiError.message,
        provider: 'PayBeta'
      });

      return res.status(502).json({
        success: false,
        error: 'BETTING_PROVIDER_UNAVAILABLE',
        message: 'Betting service is temporarily unavailable. Please try again.'
      });
    }

    /**
     * 8. Debit wallet (atomic)
     */
    await Wallet.updateOne(
      { user: userId },
      { $inc: { balance: -amount } }
    );

    /**
     * 9. Record transaction
     */
    await BillTransaction.create({
      user: userId,
      type: 'BETTING_FUND',
      amount,
      status: 'completed',
      reference,
      metaData: {
        provider: 'gaming',
        service: paybetaService,
        customerId: customer_id,
        paybetaReference: reference
      }
    });

    logger.info('✅ Betting funding successful', {
      requestId,
      userId,
      amount,
      service: paybetaService
    });

    return res.status(200).json({
      success: true,
      message: 'Betting account funded successfully'
    });

  } catch (err) {
    logger.error('💥 Betting funding failed (internal)', {
      requestId,
      error: err.message,
      stack: err.stack
    });

    return res.status(500).json({
      success: false,
      error: 'BETTING_FUNDING_FAILED',
      message: 'Unable to process betting transaction at this time'
    });
  }
};
