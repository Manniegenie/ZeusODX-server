const express = require('express');
const router = express.Router();
const { 
  convertNairaToUsd, 
  convertUsdToNaira, 
  healthCheck, 
  getApiStatus, 
  clearCache,
  currencyService 
} = require('../services/onramppriceservice');
const NairaMark = require('../models/markup');
const logger = require('../utils/logger');

/**
 * GET /naira/rate
 * Get current USD-NGN exchange rate with markup
 */
router.get('/rate', async (req, res) => {
  try {
    const rateInfo = await currencyService.getUsdToNgnRate();
    const markup = await currencyService.getMarkup();
    
    // Calculate base rate (without markup)
    const baseRate = rateInfo.finalPrice - markup;
    
    res.status(200).json({
      success: true,
      data: {
        baseRate: parseFloat(baseRate.toFixed(2)),
        markup: markup,
        finalRate: parseFloat(rateInfo.finalPrice.toFixed(2)),
        lastUpdated: rateInfo.lastUpdated,
        source: rateInfo.source,
        reliability: rateInfo.reliability
      },
      message: `1 USD = ₦${rateInfo.finalPrice} (including ₦${markup} markup)`
    });
    
  } catch (error) {
    logger.error('Error fetching exchange rate:', error);
    res.status(500).json({
      success: false,
      error: 'rate_fetch_failed',
      message: 'Error fetching exchange rate',
      details: error.message
    });
  }
});

/**
 * POST /naira/convert/ngn-to-usd
 * Convert Naira to USD (markup included in calculation)
 */
router.post('/convert/ngn-to-usd', async (req, res) => {
  try {
    const { amount } = req.body;
    
    // Validate input
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'invalid_amount',
        message: 'Amount must be a positive number'
      });
    }
    
    // Perform conversion
    const usdAmount = await convertNairaToUsd(amount);
    const rateInfo = await currencyService.getUsdToNgnRate();
    const markup = await currencyService.getMarkup();
    
    res.status(200).json({
      success: true,
      data: {
        nairaAmount: amount,
        usdAmount: parseFloat(usdAmount.toFixed(4)),
        exchangeRate: rateInfo.finalPrice,
        markup: markup,
        calculation: `₦${amount} ÷ ₦${rateInfo.finalPrice} = $${usdAmount.toFixed(4)}`
      },
      message: `Converted ₦${amount.toLocaleString()} to $${usdAmount.toFixed(4)}`
    });
    
  } catch (error) {
    logger.error('NGN to USD conversion error:', error);
    res.status(500).json({
      success: false,
      error: 'conversion_failed',
      message: 'Error converting Naira to USD',
      details: error.message
    });
  }
});

/**
 * POST /naira/convert/usd-to-ngn
 * Convert USD to Naira (markup included in calculation)
 */
router.post('/convert/usd-to-ngn', async (req, res) => {
  try {
    const { amount } = req.body;
    
    // Validate input
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'invalid_amount',
        message: 'Amount must be a positive number'
      });
    }
    
    // Perform conversion
    const nairaAmount = await convertUsdToNaira(amount);
    const rateInfo = await currencyService.getUsdToNgnRate();
    const markup = await currencyService.getMarkup();
    
    res.status(200).json({
      success: true,
      data: {
        usdAmount: amount,
        nairaAmount: parseFloat(nairaAmount.toFixed(2)),
        exchangeRate: rateInfo.finalPrice,
        markup: markup,
        calculation: `$${amount} × ₦${rateInfo.finalPrice} = ₦${nairaAmount.toFixed(2)}`
      },
      message: `Converted $${amount} to ₦${nairaAmount.toLocaleString()}`
    });
    
  } catch (error) {
    logger.error('USD to NGN conversion error:', error);
    res.status(500).json({
      success: false,
      error: 'conversion_failed',
      message: 'Error converting USD to Naira',
      details: error.message
    });
  }
});

/**
 * GET /naira/markup
 * Get current markup configuration
 */
router.get('/markup', async (req, res) => {
  try {
    const markup = await currencyService.getMarkup();
    const rateInfo = await currencyService.getUsdToNgnRate();
    const baseRate = rateInfo.finalPrice - markup;
    
    res.status(200).json({
      success: true,
      data: {
        currentMarkup: markup,
        baseRate: parseFloat(baseRate.toFixed(2)),
        finalRate: parseFloat(rateInfo.finalPrice.toFixed(2)),
        markupEffect: `₦${markup} added per $1 USD`,
        percentageIncrease: markup > 0 ? ((markup / baseRate) * 100).toFixed(2) + '%' : '0%'
      },
      message: `Current markup: ₦${markup} per $1 USD`
    });
    
  } catch (error) {
    logger.error('Error fetching markup:', error);
    res.status(500).json({
      success: false,
      error: 'markup_fetch_failed',
      message: 'Error fetching markup configuration',
      details: error.message
    });
  }
});



/**
 * POST /naira/batch-convert
 * Convert multiple amounts at once
 */
router.post('/batch-convert', async (req, res) => {
  try {
    const { conversions } = req.body;
    
    if (!Array.isArray(conversions) || conversions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'invalid_input',
        message: 'conversions must be a non-empty array'
      });
    }
    
    const results = [];
    const rateInfo = await currencyService.getUsdToNgnRate();
    
    for (let i = 0; i < conversions.length; i++) {
      const conversion = conversions[i];
      
      if (!conversion.amount || !conversion.direction) {
        results.push({
          index: i,
          error: 'Missing amount or direction',
          input: conversion
        });
        continue;
      }
      
      try {
        let result;
        if (conversion.direction === 'ngn-to-usd') {
          const usdAmount = await convertNairaToUsd(conversion.amount);
          result = {
            index: i,
            input: { amount: conversion.amount, direction: 'ngn-to-usd' },
            output: { amount: parseFloat(usdAmount.toFixed(4)), currency: 'USD' },
            rate: rateInfo.finalPrice
          };
        } else if (conversion.direction === 'usd-to-ngn') {
          const nairaAmount = await convertUsdToNaira(conversion.amount);
          result = {
            index: i,
            input: { amount: conversion.amount, direction: 'usd-to-ngn' },
            output: { amount: parseFloat(nairaAmount.toFixed(2)), currency: 'NGN' },
            rate: rateInfo.finalPrice
          };
        } else {
          result = {
            index: i,
            error: 'Invalid direction. Use "ngn-to-usd" or "usd-to-ngn"',
            input: conversion
          };
        }
        
        results.push(result);
        
      } catch (conversionError) {
        results.push({
          index: i,
          error: conversionError.message,
          input: conversion
        });
      }
    }
    
    const successful = results.filter(r => !r.error).length;
    const failed = results.filter(r => r.error).length;
    
    res.status(200).json({
      success: true,
      data: {
        results: results,
        summary: {
          total: conversions.length,
          successful: successful,
          failed: failed,
          exchangeRate: rateInfo.finalPrice
        }
      },
      message: `Processed ${successful}/${conversions.length} conversions successfully`
    });
    
  } catch (error) {
    logger.error('Batch conversion error:', error);
    res.status(500).json({
      success: false,
      error: 'batch_conversion_failed',
      message: 'Error processing batch conversions',
      details: error.message
    });
  }
});

/**
 * GET /naira/health
 * Health check for currency service
 */
router.get('/health', async (req, res) => {
  try {
    const health = await healthCheck();
    const apiStatus = await getApiStatus();
    
    res.status(200).json({
      success: true,
      data: {
        serviceHealth: health,
        apiStatus: apiStatus,
        timestamp: new Date().toISOString()
      },
      message: `Currency service is ${health.status}`
    });
    
  } catch (error) {
    logger.error('Health check error:', error);
    res.status(500).json({
      success: false,
      error: 'health_check_failed',
      message: 'Error checking service health',
      details: error.message
    });
  }
});

/**
 * POST /naira/cache/clear
 * Clear all caches (admin only)
 */
router.post('/cache/clear', async (req, res) => {
  try {
    clearCache();
    
    res.status(200).json({
      success: true,
      message: 'All caches cleared successfully',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Cache clear error:', error);
    res.status(500).json({
      success: false,
      error: 'cache_clear_failed',
      message: 'Error clearing caches',
      details: error.message
    });
  }
});

module.exports = router;