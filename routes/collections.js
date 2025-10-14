const express = require('express');
const axios = require('axios');
const Transaction = require('../models/transaction');
const logger = require('../utils/logger');

const router = express.Router();

// Glyde API Configuration
const GLYDE_API_BASE_URL = process.env.GLYDE_API_BASE_URL || 'https://api.useglyde.io';
const GLYDE_API_KEY = process.env.GLYDE_API_KEY;

/**
 * Initialize Glyde collection
 */
async function initializeGlydeCollection(collectionData) {
  try {
    const response = await axios.post(
      `${GLYDE_API_BASE_URL}/v1/collection/initialise`,
      collectionData,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GLYDE_API_KEY}`
        },
        timeout: 30000
      }
    );

    return {
      success: true,
      data: response.data.data,
      message: response.data.message
    };

  } catch (error) {
    logger.error('Glyde API error', {
      error: error.message,
      response: error.response?.data,
      status: error.response?.status
    });

    return {
      success: false,
      error: error.response?.data?.message || error.message,
      statusCode: error.response?.status || 500
    };
  }
}

// INITIALIZE COLLECTION ENDPOINT
router.post('/initialize', async (req, res) => {
  try {
    const userId = req.user.id; // From global JWT middleware
    const { 
      currency, 
      amount, 
      customer_name, 
      customer_email, 
      customer_phone,
      channels, 
      default_channel, 
      meta
    } = req.body;
    
    // Fetch user from database
    const User = require('../models/user');
    const user = await User.findById(userId).select('email firstname lastname phonenumber');

    if (!user) {
      logger.warn('User not found', { userId, source: 'glyde-collection' });
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Basic validation
    if (!currency || !amount || !customer_name || !customer_email) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: currency, amount, customer_name, customer_email'
      });
    }

    if (amount < 100) {
      return res.status(400).json({
        success: false,
        message: 'Minimum collection amount is 100'
      });
    }

    // We only support bank transfer, so ignore any channels passed in the request

    // Use userId as reference for webhook tracking
    const reference = userId.toString();

    logger.info('Glyde collection request:', {
      userId,
      reference,
      amount,
      currency,
      customer: customer_name
    });

    // Prepare Glyde API payload with bank transfer channel
    const glydePayload = {
      currency: currency.toUpperCase(),
      reference: reference, // Use userId as reference
      amount: amount,
      customer_name,
      customer_email,
      channels: ["transfer"], // Only allow transfer
      default_channel: "transfer", // Set default to transfer
      ...(customer_phone && { customer_phone }),
      ...(meta && { meta })
    };

    // Call Glyde API
    const glydeResult = await initializeGlydeCollection(glydePayload);

    if (glydeResult.success) {
      // Create transaction record
      const transaction = new Transaction({
        userId,
        type: 'COLLECTION',
        currency: currency.toUpperCase(),
        amount: amount,
        status: 'PENDING',
        source: 'GLYDE_COLLECTION',
        reference: reference,
        narration: `Payment collection from ${customer_name}`,
        metadata: {
          glydeUrl: glydeResult.data?.url,
          customerName: customer_name,
          customerEmail: customer_email,
          paymentChannels: channels
        }
      });

      await transaction.save();

      logger.info('Glyde collection initialized successfully', {
        userId,
        reference,
        transactionId: transaction._id,
        paymentUrl: glydeResult.data?.url
      });

      return res.json({
        success: true,
        message: glydeResult.message || 'Collection initialized successfully',
        data: {
          reference: reference, // userId for webhook tracking
          transactionId: transaction._id,
          amount: amount,
          currency: currency.toUpperCase(),
          paymentUrl: glydeResult.data?.url,
          customer: {
            name: customer_name,
            email: customer_email
          },
          channels: channels,
          createdAt: new Date().toISOString()
        }
      });
    } else {
      logger.error('Glyde collection initialization failed', {
        userId,
        reference,
        error: glydeResult.error,
        statusCode: glydeResult.statusCode
      });

      return res.status(502).json({
        success: false,
        message: 'Collection initialization failed',
        error: glydeResult.error
      });
    }

  } catch (err) {
    logger.error('Collection initialization endpoint error', {
      error: err.stack,
      userId: req.user?.id
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// GET COLLECTION STATUS ENDPOINT
router.get('/status/:reference', async (req, res) => {
  try {
    const userId = req.user.id;
    const { reference } = req.params;

    // Reference should be the userId
    if (reference !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized access to this collection'
      });
    }

    const transaction = await Transaction.findOne({
      reference: reference,
      type: 'COLLECTION',
      source: 'GLYDE_COLLECTION'
    }).lean();

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Collection not found'
      });
    }

    return res.json({
      success: true,
      data: {
        reference: transaction.reference,
        transactionId: transaction._id,
        status: transaction.status,
        amount: transaction.amount,
        currency: transaction.currency,
        paymentUrl: transaction.metadata?.glydeUrl,
        customer: {
          name: transaction.metadata?.customerName,
          email: transaction.metadata?.customerEmail
        },
        createdAt: transaction.createdAt,
        completedAt: transaction.completedAt
      }
    });

  } catch (err) {
    logger.error('Collection status endpoint error', {
      error: err.stack,
      userId: req.user?.id,
      reference: req.params?.reference
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

module.exports = router;