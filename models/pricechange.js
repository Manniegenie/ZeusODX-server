const mongoose = require('mongoose');

const priceChangeSchema = new mongoose.Schema({
  symbol: {
    type: String,
    required: true,
    uppercase: true,
    enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX', 'NGNZ']
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
    enum: [
      'coingecko',
      'portfolio_service',
      'currency_api',
      'manual',
      // exchanges / market data
      'binance',
      'binance_vision',
      'coinbase',
      'kraken',
      'okx'
    ],
    default: 'portfolio_service'
  }
}, {
  timestamps: true,
  collection: 'pricechanges'
});

// Indexes
priceChangeSchema.index({ symbol: 1, timestamp: -1 });
priceChangeSchema.index({ timestamp: -1 });
priceChangeSchema.index({ symbol: 1, timestamp: 1 });

// Helpers
function enumHas(path, value) {
  const allowed = priceChangeSchema.path(path).enumValues || [];
  return allowed.includes(value);
}

// Store current prices (safe source normalization)
priceChangeSchema.statics.storePrices = async function(prices, source = 'portfolio_service') {
  try {
    const safeSource = enumHas('source', source) ? source : 'portfolio_service';
    const priceEntries = [];
    const timestamp = new Date();

    for (const [symbol, price] of Object.entries(prices)) {
      const upper = String(symbol || '').toUpperCase();
      if (!enumHas('symbol', upper)) continue;
      const p = Number(price);
      if (!Number.isFinite(p) || p <= 0) continue;

      priceEntries.push({ symbol: upper, price: p, timestamp, source: safeSource });
    }

    if (priceEntries.length > 0) {
      await this.insertMany(priceEntries);
      // Optional: console.log(`Stored ${priceEntries.length} price entries at ${timestamp.toISOString()}`);
    }
    return priceEntries.length;
  } catch (error) {
    console.error('Error storing prices:', error.message);
    throw error;
  }
};

// Historical lookup
priceChangeSchema.statics.getHistoricalPrice = async function(symbol, hoursAgo = 12) {
  try {
    const targetTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
    const doc = await this.findOne({
      symbol: String(symbol).toUpperCase(),
      timestamp: { $lte: targetTime }
    }).sort({ timestamp: -1 });
    return doc ? doc.price : null;
  } catch (e) {
    console.error(`Error getting historical price for ${symbol}:`, e.message);
    return null;
  }
};

// Price changes (ignores stables/NGNZ)
priceChangeSchema.statics.getPriceChanges = async function(currentPrices, hoursAgo = 12) {
  try {
    const skip = new Set(['USDT', 'USDC', 'NGNZ']);
    const out = {};

    for (const token of Object.keys(currentPrices)) {
      const sym = token.toUpperCase();
      if (skip.has(sym)) continue;

      const current = Number(currentPrices[token]);
      const past = await this.getHistoricalPrice(sym, hoursAgo);

      if (Number.isFinite(current) && Number.isFinite(past) && past > 0) {
        const abs = current - past;
        const pct = (abs / past) * 100;
        out[sym] = {
          priceChange: Number(abs.toFixed(8)),
          percentageChange: Number(pct.toFixed(2)),
          oldPrice: Number(past.toFixed(8)),
          newPrice: Number(current.toFixed(8)),
          timeframe: `${hoursAgo}h`,
          dataAvailable: true
        };
      } else {
        out[sym] = {
          priceChange: 0,
          percentageChange: 0,
          oldPrice: current || 0,
          newPrice: current || 0,
          timeframe: `${hoursAgo}h`,
          dataAvailable: false
        };
      }
    }
    return out;
  } catch (e) {
    console.error('Error calculating price changes:', e.message);
    return {};
  }
};

// Cleanup
priceChangeSchema.statics.cleanupOldPrices = async function(daysToKeep = 30) {
  try {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    const res = await this.deleteMany({ timestamp: { $lt: cutoff } });
    // Optional: console.log(`Cleaned up ${res.deletedCount} entries older than ${daysToKeep} days`);
    return res.deletedCount;
  } catch (e) {
    console.error('Error cleaning up old prices:', e.message);
    throw e;
  }
};

// History window
priceChangeSchema.statics.getPriceHistory = async function(symbol, hours = 24) {
  try {
    const start = new Date(Date.now() - hours * 60 * 60 * 1000);
    return await this.find({
      symbol: String(symbol).toUpperCase(),
      timestamp: { $gte: start }
    }).sort({ timestamp: 1 }).select('price timestamp -_id');
  } catch (e) {
    console.error(`Error getting price history for ${symbol}:`, e.message);
    return [];
  }
};

module.exports = mongoose.model('PriceChange', priceChangeSchema);
