const mongoose = require('mongoose');

const priceChangeSchema = new mongoose.Schema({
  symbol: {
    type: String,
    required: true,
    uppercase: true,
    enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'NGNB']
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  timestamp: {
    type: Date,
    default: Date.now,
    required: true
  },
  source: {
    type: String,
    enum: ['coingecko', 'portfolio_service', 'currency_api', 'manual'],
    default: 'portfolio_service'
  }
}, {
  timestamps: true,
  collection: 'pricechanges'
});

// Index for efficient queries
priceChangeSchema.index({ symbol: 1, timestamp: -1 });
priceChangeSchema.index({ timestamp: -1 });
priceChangeSchema.index({ symbol: 1, timestamp: 1 });

// Static method to store current prices
priceChangeSchema.statics.storePrices = async function(prices, source = 'portfolio_service') {
  try {
    const priceEntries = [];
    const timestamp = new Date();
    
    for (const [symbol, price] of Object.entries(prices)) {
      if (price && price > 0) {
        priceEntries.push({
          symbol: symbol.toUpperCase(),
          price: parseFloat(price),
          timestamp,
          source
        });
      }
    }
    
    if (priceEntries.length > 0) {
      await this.insertMany(priceEntries);
      console.log(`Stored ${priceEntries.length} price entries at ${timestamp.toISOString()}`);
    }
    
    return priceEntries.length;
  } catch (error) {
    console.error('Error storing prices:', error.message);
    throw error;
  }
};

// Static method to get historical price
priceChangeSchema.statics.getHistoricalPrice = async function(symbol, hoursAgo = 12) {
  try {
    const targetTime = new Date(Date.now() - (hoursAgo * 60 * 60 * 1000));
    
    const priceEntry = await this.findOne({
      symbol: symbol.toUpperCase(),
      timestamp: {
        $lte: targetTime
      }
    }).sort({ timestamp: -1 });
    
    return priceEntry ? priceEntry.price : null;
  } catch (error) {
    console.error(`Error getting historical price for ${symbol}:`, error.message);
    return null;
  }
};

// Static method to get price changes for multiple tokens
priceChangeSchema.statics.getPriceChanges = async function(currentPrices, hoursAgo = 12) {
  try {
    const volatileTokens = Object.keys(currentPrices).filter(token => 
      !['USDT', 'USDC', 'NGNB'].includes(token.toUpperCase())
    );
    
    const priceChanges = {};
    
    for (const token of volatileTokens) {
      const currentPrice = currentPrices[token];
      const historicalPrice = await this.getHistoricalPrice(token, hoursAgo);
      
      if (currentPrice && historicalPrice && historicalPrice > 0) {
        const absoluteChange = currentPrice - historicalPrice;
        const percentageChange = ((currentPrice - historicalPrice) / historicalPrice) * 100;
        
        priceChanges[token.toUpperCase()] = {
          priceChange: parseFloat(absoluteChange.toFixed(8)),
          percentageChange: parseFloat(percentageChange.toFixed(2)),
          oldPrice: parseFloat(historicalPrice.toFixed(8)),
          newPrice: parseFloat(currentPrice.toFixed(8)),
          timeframe: `${hoursAgo}h`,
          dataAvailable: true
        };
      } else {
        priceChanges[token.toUpperCase()] = {
          priceChange: 0,
          percentageChange: 0,
          oldPrice: currentPrice || 0,
          newPrice: currentPrice || 0,
          timeframe: `${hoursAgo}h`,
          dataAvailable: false
        };
      }
    }
    
    return priceChanges;
  } catch (error) {
    console.error('Error calculating price changes:', error.message);
    return {};
  }
};

// Static method to cleanup old price data
priceChangeSchema.statics.cleanupOldPrices = async function(daysToKeep = 30) {
  try {
    const cutoffDate = new Date(Date.now() - (daysToKeep * 24 * 60 * 60 * 1000));
    
    const result = await this.deleteMany({
      timestamp: { $lt: cutoffDate }
    });
    
    console.log(`Cleaned up ${result.deletedCount} old price entries older than ${daysToKeep} days`);
    return result.deletedCount;
  } catch (error) {
    console.error('Error cleaning up old prices:', error.message);
    throw error;
  }
};

// Static method to get price history for a token
priceChangeSchema.statics.getPriceHistory = async function(symbol, hours = 24) {
  try {
    const startTime = new Date(Date.now() - (hours * 60 * 60 * 1000));
    
    const history = await this.find({
      symbol: symbol.toUpperCase(),
      timestamp: { $gte: startTime }
    }).sort({ timestamp: 1 }).select('price timestamp -_id');
    
    return history;
  } catch (error) {
    console.error(`Error getting price history for ${symbol}:`, error.message);
    return [];
  }
};

module.exports = mongoose.model('PriceChange', priceChangeSchema);