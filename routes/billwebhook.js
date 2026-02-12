/**
 * eBills Webhook Handler - Integrated with Portfolio Service
 * 
 * Balance Flow Integration:
 * 1. Transaction Created: reserveUserBalance() called in bill payment flow
 * 2. Webhook Received:
 *    - completed-api: releaseReservedBalance() + updateUserPortfolioBalance()
 *    - refunded: releaseReservedBalance() + updateUserPortfolioBalance()
 *    - failed: releaseReservedBalance() (if balance was reserved)
 * 
 * This handler works with:
 * - BillTransaction schema (NGNZ)
 * - Portfolio service (balance tracking for supported tokens)
 * - User schema (balance fields and pending balance tracking)
 */

const express = require('express');
const crypto = require('crypto');
const BillTransaction = require('../models/billstransaction');
const { 
  releaseReservedBalance, 
  updateUserPortfolioBalance,
  isTokenSupported 
} = require('../services/portfolio');
const { sendPaymentNotification, sendAirtimePurchaseNotification } = require('../services/notificationService');
const { invalidateSpending } = require('../services/kyccheckservice');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Verify eBills webhook signature using canonical JSON serialization
 * @param {string} payload - Raw JSON payload as string
 * @param {string} signature - X-Signature header value
 * @param {string} userPin - User's PIN for HMAC verification
 * @returns {boolean} - True if signature is valid
 */
function verifyWebhookSignature(payload, signature, userPin) {
  try {
    // Parse the payload to ensure we can re-serialize it consistently
    const parsedPayload = JSON.parse(payload);
    
    // Re-serialize with the same format eBills uses (no spaces, consistent ordering)
    const canonicalPayload = JSON.stringify(parsedPayload, null, 0);
    
    // eBills uses HMAC-SHA256 with user PIN on the canonical JSON
    const expectedSignature = crypto
      .createHmac('sha256', userPin)
      .update(canonicalPayload, 'utf8')
      .digest('hex');
    
    // Remove any prefix from signature (some webhooks include "sha256=")
    const cleanSignature = signature.replace(/^sha256=/, '');
    
    // Use timing-safe comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(cleanSignature, 'hex')
    );
  } catch (error) {
    logger.error('Signature verification error:', error);
    return false;
  }
}

/**
 * Add processing error to transaction
 * @param {Object} transaction - BillTransaction document
 * @param {string} error - Error message
 * @param {string} phase - Processing phase where error occurred
 */
function addProcessingError(transaction, error, phase) {
  if (!transaction.processingErrors) {
    transaction.processingErrors = [];
  }
  transaction.processingErrors.push({
    error,
    timestamp: new Date(),
    phase
  });
}

/**
 * eBills Webhook Handler
 * Processes order status updates from eBills API
 */
router.post('/ebills', express.raw({ type: 'application/json' }), async (req, res) => {
  const startTime = Date.now();
  let webhookData;
  let transaction;
  
  try {
    // Parse raw body to string for signature verification
    const rawPayload = req.body.toString('utf8');
    const signature = req.headers['x-signature'];
    
    if (!signature) {
      logger.warn('eBills webhook received without signature');
      return res.status(400).json({
        success: false,
        error: 'missing_signature',
        message: 'X-Signature header required'
      });
    }
    
    // Parse JSON payload
    try {
      webhookData = JSON.parse(rawPayload);
    } catch (parseError) {
      logger.error('Invalid JSON in eBills webhook:', parseError);
      return res.status(400).json({
        success: false,
        error: 'invalid_json',
        message: 'Invalid JSON payload'
      });
    }
    
    logger.info('eBills webhook received:', {
      order_id: webhookData.order_id,
      status: webhookData.status,
      request_id: webhookData.request_id,
      product_name: webhookData.product_name,
      amount: webhookData.amount,
      amount_charged: webhookData.amount_charged,
      signature: signature.substring(0, 16) + '...' // Log partial signature for debugging
    });
    
    // Validate required webhook fields per eBills documentation
    const requiredFields = ['order_id', 'status', 'request_id'];
    const missingFields = requiredFields.filter(field => !webhookData[field]);
    
    if (missingFields.length > 0) {
      logger.warn('eBills webhook missing required fields:', missingFields);
      return res.status(400).json({
        success: false,
        error: 'missing_fields',
        message: `Missing required fields: ${missingFields.join(', ')}`
      });
    }
    
    // Find the transaction by request_id or order_id with flexible matching
    transaction = await BillTransaction.findOne({
      $or: [
        { requestId: webhookData.request_id },
        { orderId: webhookData.order_id.toString() },
        { orderId: `pending_${webhookData.request_id}` }, // Check pending format
        // Also check if order_id matches without string conversion
        { orderId: webhookData.order_id }
      ]
    });
    
    if (!transaction) {
      logger.warn('Transaction not found for eBills webhook:', {
        order_id: webhookData.order_id,
        request_id: webhookData.request_id
      });
      
      // Return 200 to prevent eBills from retrying, but log the issue
      return res.status(200).json({
        success: true,
        message: 'Transaction not found, but webhook acknowledged',
        note: 'This may be a webhook for a transaction not processed by this system'
      });
    }
    
    // Get user PIN for signature verification
    const User = require('../models/user');
    const user = await User.findById(transaction.userId).select('pin userPin ebillsPin');
    
    if (!user) {
      logger.error('User not found for transaction:', transaction.userId);
      addProcessingError(transaction, 'User not found for signature verification', 'webhook_processing');
      await transaction.save();
      
      return res.status(400).json({
        success: false,
        error: 'user_not_found',
        message: 'Transaction user not found'
      });
    }
    
    // Use appropriate PIN field (adjust based on your user model)
    const userPin = user.ebillsPin || user.pin || user.userPin;
    
    if (!userPin) {
      logger.error('User PIN not found for signature verification:', user._id);
      addProcessingError(transaction, 'User PIN not found for signature verification', 'webhook_processing');
      await transaction.save();
      
      return res.status(400).json({
        success: false,
        error: 'missing_pin',
        message: 'User PIN required for signature verification'
      });
    }
    
    // Verify webhook signature
    if (!verifyWebhookSignature(rawPayload, signature, userPin)) {
      logger.error('Invalid eBills webhook signature:', {
        order_id: webhookData.order_id,
        userId: user._id,
        signatureReceived: signature.substring(0, 16) + '...'
      });
      
      addProcessingError(transaction, 'Invalid webhook signature', 'webhook_processing');
      await transaction.save();
      
      return res.status(401).json({
        success: false,
        error: 'invalid_signature',
        message: 'Invalid webhook signature'
      });
    }
    
    logger.info('eBills webhook signature verified successfully');
    
    // Check if webhook was already processed
    if (transaction.webhookProcessedAt) {
      logger.info('Webhook already processed for transaction:', transaction.orderId);
      return res.status(200).json({
        success: true,
        message: 'Webhook already processed',
        transaction_id: transaction._id
      });
    }
    
    // Update transaction with webhook data using schema-compatible structure
    const updateData = {
      orderId: webhookData.order_id.toString(),
      status: webhookData.status,
      webhookProcessedAt: new Date(),
      metaData: {
        ...transaction.metaData,
        webhook_data: webhookData,
        webhook_timestamp: webhookData.timestamp,
        date_created: webhookData.date_created,
        date_updated: webhookData.date_updated,
        amount_charged: webhookData.amount_charged,
        webhook_received_at: new Date().toISOString()
      }
    };
    
    // Handle different webhook statuses
    switch (webhookData.status) {
      case 'completed':
        logger.info(`Processing completed NGNZ bill transaction: ${webhookData.order_id}`);
        
        // For completed transactions: release pending balance and update portfolio
        try {
          const currency = transaction.paymentCurrency || 'NGNZ';
          const amount = transaction.amountNGNZ || transaction.amountCrypto || transaction.amountNaira;
          
          // Validate currency is supported by portfolio service
          if (!isTokenSupported(currency)) {
            throw new Error(`Unsupported currency for balance operations: ${currency}`);
          }
          
          // Release the pending/reserved balance (transaction is now complete)
          await releaseReservedBalance(transaction.userId, currency, amount);
          
          // Update user's portfolio balance to reflect the completed transaction
          await updateUserPortfolioBalance(transaction.userId);
          
          updateData.portfolioUpdated = true;
          updateData.balanceReserved = false; // Balance is no longer reserved
          
          // Update metadata to track balance completion
          updateData.metaData.balance_completed = true;
          updateData.metaData.balance_completed_at = new Date();
          updateData.metaData.pending_balance_released = true;
          
          logger.info(`Completed NGNZ balance processing for bill payment: ${transaction.userId}`, {
            amount,
            currency,
            billType: transaction.billType,
            orderId: webhookData.order_id
          });
          
        } catch (balanceError) {
          logger.error('Failed to process balance for completed transaction:', {
            transactionId: transaction._id,
            userId: transaction.userId,
            error: balanceError.message
          });
          
          // Add error to transaction using schema structure
          addProcessingError(transaction, `Balance completion failed: ${balanceError.message}`, 'webhook_processing');
        }
        
        // ✅ SEND COMPLETED NOTIFICATION
        try {
          const billType = transaction.billType || 'BILL';
          const productType = billType.toUpperCase();
          
          if (productType === 'AIRTIME' || productType === 'DATA') {
            await sendAirtimePurchaseNotification(
              transaction.userId,
              transaction.amountNGNZ || transaction.amountNaira || amount,
              transaction.metaData?.service_name || transaction.metaData?.service_id || 'UNKNOWN',
              transaction.metaData?.phone || transaction.metaData?.customerId || 'N/A',
              'completed',
              {
                orderId: webhookData.order_id.toString(),
                requestId: webhookData.request_id,
                serviceName: transaction.metaData?.service_name,
                currency: currency,
                productType: productType,
                webhookStatus: 'completed'
              }
            );
          } else {
            await sendPaymentNotification(
              transaction.userId,
              transaction.amountNGNZ || transaction.amountNaira || amount,
              currency,
              `${productType} payment completed`,
              {
                orderId: webhookData.order_id.toString(),
                requestId: webhookData.request_id,
                serviceName: transaction.metaData?.service_name,
                billType: productType,
                webhookStatus: 'completed'
              }
            );
          }
          
          logger.info('Webhook completed notification sent', { 
            userId: transaction.userId, 
            orderId: webhookData.order_id,
            billType: productType
          });
        } catch (notificationError) {
          logger.error('Failed to send webhook completed notification', {
            userId: transaction.userId,
            orderId: webhookData.order_id,
            error: notificationError.message
          });
        }

        // Invalidate KYC spending cache so next limit check uses fresh utility spending
        try {
          invalidateSpending(transaction.userId.toString(), 'BILL_PAYMENT');
        } catch (invErr) {
          logger.warn('KYC spending cache invalidation failed', { userId: transaction.userId, error: invErr.message });
        }

        break;

      case 'refunded':
        logger.info(`Processing refunded NGNZ bill transaction: ${webhookData.order_id}`);
        
        // Release the reserved balance (return NGNZ funds to user)
        try {
          const currency = transaction.paymentCurrency || 'NGNZ';
          const amount = transaction.amountNGNZ || transaction.amountCrypto || transaction.amountNaira;
          
          // Validate currency is supported by portfolio service
          if (!isTokenSupported(currency)) {
            throw new Error(`Unsupported currency for balance operations: ${currency}`);
          }
          
          await releaseReservedBalance(transaction.userId, currency, amount);
          
          // Update user's portfolio balance to reflect the refund
          await updateUserPortfolioBalance(transaction.userId);
          
          updateData.refundProcessed = true;
          updateData.balanceReserved = false; // Balance is released
          
          // Update metadata to track refund processing
          updateData.metaData.balance_released = true;
          updateData.metaData.balance_released_at = new Date();
          updateData.metaData.refund_reason = 'ebills_refund';
          updateData.metaData.refund_amount = amount;
          updateData.metaData.refund_currency = currency;
          
          logger.info(`Released reserved NGNZ balance for refunded bill payment: ${transaction.userId}`, {
            amount,
            currency,
            billType: transaction.billType,
            orderId: webhookData.order_id
          });
          
        } catch (balanceError) {
          logger.error('Failed to release balance for refunded transaction:', {
            transactionId: transaction._id,
            userId: transaction.userId,
            error: balanceError.message
          });
          
          // Add error to transaction using schema structure
          addProcessingError(transaction, `Balance release failed: ${balanceError.message}`, 'webhook_processing');
        }
        
        // ✅ SEND REFUNDED NOTIFICATION
        try {
          const billType = transaction.billType || 'BILL';
          const productType = billType.toUpperCase();
          
          if (productType === 'AIRTIME' || productType === 'DATA') {
            await sendAirtimePurchaseNotification(
              transaction.userId,
              transaction.amountNGNZ || transaction.amountNaira || amount,
              transaction.metaData?.service_name || transaction.metaData?.service_id || 'UNKNOWN',
              transaction.metaData?.phone || transaction.metaData?.customerId || 'N/A',
              'failed',
              {
                orderId: webhookData.order_id.toString(),
                requestId: webhookData.request_id,
                serviceName: transaction.metaData?.service_name,
                currency: currency,
                productType: productType,
                webhookStatus: 'refunded',
                reason: 'Transaction refunded by provider'
              }
            );
          } else {
            await sendPaymentNotification(
              transaction.userId,
              transaction.amountNGNZ || transaction.amountNaira || amount,
              currency,
              `${productType} payment refunded`,
              {
                orderId: webhookData.order_id.toString(),
                requestId: webhookData.request_id,
                serviceName: transaction.metaData?.service_name,
                billType: productType,
                webhookStatus: 'refunded',
                reason: 'Transaction refunded by provider'
              }
            );
          }
          
          logger.info('Webhook refunded notification sent', { 
            userId: transaction.userId, 
            orderId: webhookData.order_id,
            billType: productType
          });
        } catch (notificationError) {
          logger.error('Failed to send webhook refunded notification', {
            userId: transaction.userId,
            orderId: webhookData.order_id,
            error: notificationError.message
          });
        }

        try {
          invalidateSpending(transaction.userId.toString(), 'BILL_PAYMENT');
        } catch (invErr) {
          logger.warn('KYC spending cache invalidation failed', { userId: transaction.userId, error: invErr.message });
        }

        break;

      case 'failed':
        logger.info(`Processing failed NGNZ bill transaction: ${webhookData.order_id}`);
        
        // If balance was reserved, release it since transaction failed
        if (transaction.balanceReserved) {
          try {
            const currency = transaction.paymentCurrency || 'NGNZ';
            const amount = transaction.amountNGNZ || transaction.amountCrypto || transaction.amountNaira;
            
            // Validate currency is supported by portfolio service
            if (!isTokenSupported(currency)) {
              throw new Error(`Unsupported currency for balance operations: ${currency}`);
            }
            
            await releaseReservedBalance(transaction.userId, currency, amount);
            
            // Update user's portfolio balance
            await updateUserPortfolioBalance(transaction.userId);
            
            updateData.balanceReserved = false;
            updateData.metaData.balance_released = true;
            updateData.metaData.balance_released_at = new Date();
            updateData.metaData.release_reason = 'transaction_failed';
            updateData.metaData.failed_amount = amount;
            updateData.metaData.failed_currency = currency;
            
            logger.info(`Released reserved NGNZ balance for failed transaction: ${transaction.userId}`, {
              amount,
              currency,
              billType: transaction.billType,
              orderId: webhookData.order_id
            });
            
          } catch (balanceError) {
            logger.error('Failed to release balance for failed transaction:', {
              transactionId: transaction._id,
              userId: transaction.userId,
              error: balanceError.message
            });
            
            addProcessingError(transaction, `Balance release failed for failed transaction: ${balanceError.message}`, 'webhook_processing');
          }
        }
        
        // ✅ SEND FAILED NOTIFICATION
        try {
          const billType = transaction.billType || 'BILL';
          const productType = billType.toUpperCase();
          const currency = transaction.paymentCurrency || 'NGNZ';
          const amount = transaction.amountNGNZ || transaction.amountCrypto || transaction.amountNaira;
          
          if (productType === 'AIRTIME' || productType === 'DATA') {
            await sendAirtimePurchaseNotification(
              transaction.userId,
              amount,
              transaction.metaData?.service_name || transaction.metaData?.service_id || 'UNKNOWN',
              transaction.metaData?.phone || transaction.metaData?.customerId || 'N/A',
              'failed',
              {
                orderId: webhookData.order_id.toString(),
                requestId: webhookData.request_id,
                serviceName: transaction.metaData?.service_name,
                currency: currency,
                productType: productType,
                webhookStatus: 'failed',
                reason: 'Transaction failed'
              }
            );
          } else {
            await sendPaymentNotification(
              transaction.userId,
              amount,
              currency,
              `${productType} payment failed`,
              {
                orderId: webhookData.order_id.toString(),
                requestId: webhookData.request_id,
                serviceName: transaction.metaData?.service_name,
                billType: productType,
                webhookStatus: 'failed',
                reason: 'Transaction failed'
              }
            );
          }
          
          logger.info('Webhook failed notification sent', { 
            userId: transaction.userId, 
            orderId: webhookData.order_id,
            billType: productType
          });
        } catch (notificationError) {
          logger.error('Failed to send webhook failed notification', {
            userId: transaction.userId,
            orderId: webhookData.order_id,
            error: notificationError.message
          });
        }

        try {
          invalidateSpending(transaction.userId.toString(), 'BILL_PAYMENT');
        } catch (invErr) {
          logger.warn('KYC spending cache invalidation failed', { userId: transaction.userId, error: invErr.message });
        }

        break;

      default:
        logger.warn(`Unexpected webhook status: ${webhookData.status} for order ${webhookData.order_id}`);
        // Still update the transaction but don't process balance changes
        addProcessingError(transaction, `Unexpected webhook status: ${webhookData.status}`, 'webhook_processing');
        break;
    }
    
    // Update transaction in database using findByIdAndUpdate for atomicity
    const updatedTransaction = await BillTransaction.findByIdAndUpdate(
      transaction._id,
      { 
        $set: updateData,
        $push: transaction.processingErrors && transaction.processingErrors.length > 0 ? 
          { processingErrors: { $each: transaction.processingErrors } } : undefined
      },
      { new: true }
    );
    
    const processingTime = Date.now() - startTime;
    
    logger.info('eBills webhook processed successfully:', {
      order_id: webhookData.order_id,
      status: webhookData.status,
      transaction_id: updatedTransaction._id,
      processing_time: processingTime,
      amount_ngnz: updatedTransaction.amountNGNZ,
      bill_type: updatedTransaction.billType,
      balance_reserved: updatedTransaction.balanceReserved,
      portfolio_updated: updatedTransaction.portfolioUpdated,
      refund_processed: updatedTransaction.refundProcessed
    });
    
    // Send success response to eBills
    return res.status(200).json({
      success: true,
      message: 'Webhook processed successfully',
      data: {
        order_id: webhookData.order_id,
        status: webhookData.status,
        transaction_id: updatedTransaction._id,
        processed_at: updateData.webhookProcessedAt,
        bill_type: updatedTransaction.billType,
        amount_ngnz: updatedTransaction.amountNGNZ,
        balance_status: {
          reserved: updatedTransaction.balanceReserved,
          portfolio_updated: updatedTransaction.portfolioUpdated,
          refund_processed: updatedTransaction.refundProcessed
        }
      }
    });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    logger.error('eBills webhook processing error:', {
      error: error.message,
      stack: error.stack,
      webhook_data: webhookData,
      transaction_id: transaction?._id,
      processing_time: processingTime
    });
    
    // Add error to transaction if we have it
    if (transaction) {
      try {
        addProcessingError(transaction, `Webhook processing error: ${error.message}`, 'unexpected_error');
        await transaction.save();
      } catch (saveError) {
        logger.error('Failed to save processing error to transaction:', saveError);
      }
    }
    
    // Return 500 to make eBills retry the webhook
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      message: 'Webhook processing failed'
    });
  }
});

/**
 * Webhook health check
 */
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'eBills Webhook Handler (NGNZ)',
    timestamp: new Date().toISOString(),
    endpoints: {
      ebills: '/webhook/ebills',
      health: '/webhook/health',
      test_signature: '/webhook/test-signature'
    },
    features: [
      'NGNZ balance management',
      'Balance reservation tracking', 
      'Comprehensive error logging',
      'Signature verification',
      'Backward compatibility'
    ]
  });
});

/**
 * Test webhook signature verification
 */
router.post('/test-signature', express.json(), async (req, res) => {
  try {
    const { payload, signature, userPin } = req.body;
    
    if (!payload || !signature || !userPin) {
      return res.status(400).json({
        success: false,
        error: 'missing_fields',
        message: 'payload, signature, and userPin required'
      });
    }
    
    const isValid = verifyWebhookSignature(
      JSON.stringify(payload),
      signature,
      userPin
    );
    
    return res.status(200).json({
      success: true,
      signature_valid: isValid,
      message: isValid ? 'Signature is valid' : 'Signature is invalid',
      test_details: {
        payload_size: JSON.stringify(payload).length,
        signature_format: signature.includes('sha256=') ? 'prefixed' : 'raw',
        pin_length: userPin.length
      }
    });
    
  } catch (error) {
    logger.error('Signature test error:', error);
    return res.status(500).json({
      success: false,
      error: 'test_failed',
      message: error.message
    });
  }
});

/**
 * Get webhook processing statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const { userId, days = 7 } = req.query;
    const dateLimit = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    const query = {
      webhookProcessedAt: { $exists: true },
      createdAt: { $gte: dateLimit }
    };
    
    if (userId) {
      query.userId = userId;
    }
    
    const stats = await BillTransaction.aggregate([
      { $match: query },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$amountNGNZ' },
          avgProcessingTime: { 
            $avg: { 
              $subtract: ['$webhookProcessedAt', '$createdAt'] 
            } 
          }
        }
      },
      { $sort: { count: -1 } }
    ]);
    
    const totalProcessed = await BillTransaction.countDocuments(query);
    const errorCount = await BillTransaction.countDocuments({
      ...query,
      processingErrors: { $exists: true, $ne: [] }
    });
    
    return res.status(200).json({
      success: true,
      data: {
        period_days: days,
        total_processed: totalProcessed,
        error_count: errorCount,
        error_rate: totalProcessed > 0 ? (errorCount / totalProcessed * 100).toFixed(2) + '%' : '0%',
        status_breakdown: stats,
        generated_at: new Date().toISOString()
      }
    });
    
  } catch (error) {
    logger.error('Stats generation error:', error);
    return res.status(500).json({
      success: false,
      error: 'stats_failed',
      message: error.message
    });
  }
});

module.exports = router;