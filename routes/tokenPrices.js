const express = require('express');
const router = express.Router();
const PriceChange = require('../models/pricechange');

/**
 * GET /api/token-prices
 * Public endpoint to fetch current token prices
 * Query params:
 *   - symbols: comma-separated token symbols (optional, e.g., ?symbols=BTC,ETH,SOL)
 *   - includeChange: include 24h price change data (optional, default: true)
 */
router.get('/', async (req, res) => {
  try {
    const { symbols, includeChange } = req.query;
    const shouldIncludeChange = includeChange !== 'false';

    // Supported tokens
    const supportedTokens = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'TRX'];

    // Filter by requested symbols if provided
    let requestedSymbols = supportedTokens;
    if (symbols) {
      const symbolsArray = symbols.toUpperCase().split(',').map(s => s.trim());
      requestedSymbols = supportedTokens.filter(token => symbolsArray.includes(token));
    }

    // Fetch latest prices for each token
    const pricePromises = requestedSymbols.map(async (symbol) => {
      const latestPrice = await PriceChange.findOne({ symbol })
        .sort({ timestamp: -1 })
        .select('symbol price timestamp source');

      return latestPrice;
    });

    const priceResults = await Promise.all(pricePromises);

    // Build response data
    const tokenData = [];

    for (let i = 0; i < requestedSymbols.length; i++) {
      const symbol = requestedSymbols[i];
      const priceDoc = priceResults[i];

      if (!priceDoc) {
        // No price data available for this token
        continue;
      }

      const tokenInfo = {
        symbol: symbol,
        name: getTokenName(symbol),
        price: priceDoc.price,
        lastUpdated: priceDoc.timestamp,
        source: priceDoc.source || 'binance'
      };

      // Calculate 24h price change if requested
      if (shouldIncludeChange) {
        const historicalPrice = await PriceChange.getHistoricalPrice(symbol, 24);

        if (historicalPrice && historicalPrice > 0) {
          const change = priceDoc.price - historicalPrice;
          const percentChange = (change / historicalPrice) * 100;

          tokenInfo.change24h = parseFloat(percentChange.toFixed(2));
          tokenInfo.changeAbsolute24h = parseFloat(change.toFixed(8));
          tokenInfo.price24hAgo = parseFloat(historicalPrice.toFixed(8));
        } else {
          tokenInfo.change24h = 0;
          tokenInfo.changeAbsolute24h = 0;
          tokenInfo.price24hAgo = priceDoc.price;
        }
      }

      tokenData.push(tokenInfo);
    }

    res.json({
      success: true,
      data: tokenData,
      timestamp: new Date().toISOString(),
      count: tokenData.length
    });

  } catch (error) {
    console.error('Error fetching token prices:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch token prices',
      message: error.message
    });
  }
});

/**
 * GET /api/token-prices/:symbol
 * Get price for a specific token
 */
router.get('/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const { includeHistory } = req.query;

    // Validate symbol
    const supportedTokens = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'TRX'];
    if (!supportedTokens.includes(symbol)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid token symbol',
        supportedTokens
      });
    }

    // Get latest price
    const latestPrice = await PriceChange.findOne({ symbol })
      .sort({ timestamp: -1 })
      .select('symbol price timestamp source');

    if (!latestPrice) {
      return res.status(404).json({
        success: false,
        error: 'Price data not available for this token'
      });
    }

    // Calculate 24h change
    const historicalPrice = await PriceChange.getHistoricalPrice(symbol, 24);
    let change24h = 0;
    let changeAbsolute24h = 0;

    if (historicalPrice && historicalPrice > 0) {
      const change = latestPrice.price - historicalPrice;
      change24h = parseFloat(((change / historicalPrice) * 100).toFixed(2));
      changeAbsolute24h = parseFloat(change.toFixed(8));
    }

    const response = {
      success: true,
      data: {
        symbol: symbol,
        name: getTokenName(symbol),
        price: latestPrice.price,
        change24h,
        changeAbsolute24h,
        price24hAgo: historicalPrice || latestPrice.price,
        lastUpdated: latestPrice.timestamp,
        source: latestPrice.source || 'binance'
      },
      timestamp: new Date().toISOString()
    };

    // Include price history if requested
    if (includeHistory === 'true') {
      const history = await PriceChange.getPriceHistory(symbol, 24);
      response.data.history24h = history.map(h => ({
        price: h.price,
        timestamp: h.timestamp
      }));
    }

    res.json(response);

  } catch (error) {
    console.error('Error fetching token price:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch token price',
      message: error.message
    });
  }
});

/**
 * Helper function to get full token names
 */
function getTokenName(symbol) {
  const names = {
    BTC: 'Bitcoin',
    ETH: 'Ethereum',
    SOL: 'Solana',
    USDT: 'Tether',
    USDC: 'USD Coin',
    BNB: 'Binance Coin',
    MATIC: 'Polygon',
    TRX: 'Tron',
    NGNZ: 'Naira Token'
  };
  return names[symbol] || symbol;
}

module.exports = router;
