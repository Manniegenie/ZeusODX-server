require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const passport = require("passport");
const morgan = require("morgan");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const logger = require("./utils/logger"); // Assuming logger is available
const Transaction = require("./models/transaction"); // Import Transaction model
const User = require("./models/user"); // Import User model for balance fix

const app = express();
const PORT = process.env.PORT || 3000;

// CORS Setup
app.set("trust proxy", 1);
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-obiex-signature"],
  })
);

// Morgan Logging
app.use(morgan("combined"));

// Helmet Security
app.use(helmet());

// Raw Body Parser for Webhook Routes
app.use('/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  req.rawBody = req.body.toString('utf8');
  next();
});

// JSON Body Parser for Other Routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate Limiters
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(apiLimiter);

const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { success: false, error: "Too many webhook requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Passport Init
app.use(passport.initialize());

// JWT Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ success: false, error: "Unauthorized: No token provided." });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, error: "Forbidden: Invalid token." });

    req.user = user;
    next();
  });
};

// Route Imports
const logoutRoutes = require("./routes/logout");
const refreshtokenRoutes = require("./routes/refreshtoken");
const passwordpinRoutes = require("./routes/passwordpin");
const signinRoutes = require("./routes/signin");
const signupRoutes = require("./routes/signup");
const usernameRoutes = require("./routes/username");
const balanceRoutes = require("./routes/balance");
const webhookRoutes = require("./routes/obiexwebhooktrx");
const depositRoutes = require("./routes/deposit");
const deleteuserRoutes = require("./adminRoutes/deleteuser");
const SetfeeRoutes = require("./adminRoutes/cryptofee");
const verifyotpRoutes = require("./routes/verifyotp");
const usernamecheckRoutes = require("./routes/usernamecheck");
const withdrawRoutes = require("./routes/withdraw");
const validatewithdrawRoutes = require("./routes/validate-balance");
const updateuseraddressRoutes = require("./adminRoutes/updatewalletaddress");
const fetchrefreshtoken = require("./adminRoutes/refresh-token");
const FunduserRoutes = require("./adminRoutes/funduser");
const clearpendingRoutes = require("./adminRoutes/pendingbalance");
const fetchwalletRoutes = require("./adminRoutes/fetchwallet");
const fetchtransactionRoutes = require("./adminRoutes/fetchtransactions");
const deletepinRoutes = require("./adminRoutes/deletepin");
const nairaPriceRouter = require('./routes/nairaprice');
const onrampRoutes = require('./adminRoutes/onramp');
const offrampRoutes = require('./adminRoutes/offramp');
const walletRoutes = require('./routes/wallet');
const TwoFARoutes = require('./auth/setup-2fa');
const AirtimeRoutes = require('./routes/airtime');
const DataRoutes = require('./routes/data');
const VerifybillRoutes = require('./routes/verifybill');
const ElectricityRoutes = require('./routes/electricity');
const BettingRoutes = require('./routes/betting');
const CableTVRoutes = require('./routes/cabletv');
const fetchdataplans = require('./routes/dataplans');
const billwebhookRoutes = require('./routes/billwebhook');
const dashboardRoutes = require('./routes/dashboard');
const pricemarkdownRoutes = require('./adminRoutes/pricemarkdown');
const swapRoutes = require('./routes/swap');
const ngnzSwapRoutes = require('./routes/NGNZSwaps');

// Public Routes
app.use("/signin", signinRoutes);
app.use("/signup", signupRoutes);
app.use("/refresh-token", refreshtokenRoutes);
app.use("/verify-otp", verifyotpRoutes);
app.use("/passwordpin", passwordpinRoutes);
app.use("/usernamecheck", usernamecheckRoutes);

// Webhook Routes
app.use("/webhook", webhookLimiter, webhookRoutes);
app.use("/billwebhook", webhookLimiter, billwebhookRoutes);

// Admin/Utility Routes
app.use("/deleteuser", deleteuserRoutes);
app.use("/updateuseraddress", updateuseraddressRoutes);
app.use("/fetch-wallet", fetchwalletRoutes);
app.use("/delete-pin", deletepinRoutes);
app.use("/fetch", fetchtransactionRoutes);
app.use("/set-fee", SetfeeRoutes);
app.use("/pending", clearpendingRoutes);
app.use("/fetching", fetchrefreshtoken);
app.use("/fund", FunduserRoutes);
app.use("/marker", pricemarkdownRoutes);

// Public Data Routes
app.use("/naira-price", nairaPriceRouter);
app.use("/onramp", onrampRoutes);
app.use("/offramp", offrampRoutes);

// Protected Routes
app.use("/logout", authenticateToken, logoutRoutes);
app.use("/username", authenticateToken, usernameRoutes);
app.use("/balance", authenticateToken, balanceRoutes);
app.use("/deposit", authenticateToken, depositRoutes);
app.use("/wallet", authenticateToken, walletRoutes);
app.use("/withdraw", authenticateToken, withdrawRoutes);
app.use("/validate-balance", authenticateToken, validatewithdrawRoutes);
app.use("/2FA", authenticateToken, TwoFARoutes);
app.use("/airtime", authenticateToken, AirtimeRoutes);
app.use("/plans", authenticateToken, fetchdataplans);
app.use("/data", authenticateToken, DataRoutes);
app.use("/verifybill", authenticateToken, VerifybillRoutes);
app.use("/electricity", authenticateToken, ElectricityRoutes);
app.use("/betting", authenticateToken, BettingRoutes);
app.use("/cabletv", authenticateToken, CableTVRoutes);
app.use("/dashboard", authenticateToken, dashboardRoutes);
app.use("/swap", authenticateToken, swapRoutes);
app.use("/ngnz-swap", authenticateToken, ngnzSwapRoutes);

// Health Check
app.get("/", (req, res) => {
  res.send(`🚀 API Running at ${new Date().toISOString()}`);
});

// 🚨 FIX NEGATIVE BALANCES SCRIPT
const fixNegativeBalances = async () => {
  try {
    logger.info('🔧 Starting negative balance fix script');

    // Define all USD balance fields
    const usdBalanceFields = [
      'btcBalanceUSD', 'ethBalanceUSD', 'solBalanceUSD', 'usdtBalanceUSD',
      'usdcBalanceUSD', 'avaxBalanceUSD', 'bnbBalanceUSD', 'maticBalanceUSD', 'ngnzBalanceUSD'
    ];

    // Find users with negative USD balances
    const negativeBalanceQuery = {
      $or: usdBalanceFields.map(field => ({ [field]: { $lt: 0 } }))
    };

    const usersWithNegativeBalances = await User.find(negativeBalanceQuery)
      .select(['_id', 'username', 'phonenumber', ...usdBalanceFields])
      .lean();

    if (usersWithNegativeBalances.length === 0) {
      logger.info('✅ No users with negative USD balances found');
      return;
    }

    logger.info(`🔍 Found ${usersWithNegativeBalances.length} users with negative USD balances`, {
      userCount: usersWithNegativeBalances.length
    });

    // Fix negative balances using aggregation pipeline
    const result = await User.updateMany(
      negativeBalanceQuery,
      [
        {
          $set: {
            btcBalanceUSD: { $max: ["$btcBalanceUSD", 0] },
            ethBalanceUSD: { $max: ["$ethBalanceUSD", 0] },
            solBalanceUSD: { $max: ["$solBalanceUSD", 0] },
            usdtBalanceUSD: { $max: ["$usdtBalanceUSD", 0] },
            usdcBalanceUSD: { $max: ["$usdcBalanceUSD", 0] },
            avaxBalanceUSD: { $max: ["$avaxBalanceUSD", 0] },
            bnbBalanceUSD: { $max: ["$bnbBalanceUSD", 0] },
            maticBalanceUSD: { $max: ["$maticBalanceUSD", 0] },
            ngnzBalanceUSD: { $max: ["$ngnzBalanceUSD", 0] },
            portfolioLastUpdated: new Date()
          }
        }
      ]
    );

    logger.info('✅ Negative balance fix completed successfully', {
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount
    });

  } catch (error) {
    logger.error('❌ Error during negative balance fix', {
      error: error.message,
      stack: error.stack
    });
  }
};

// 🚨 MIGRATE ALL BALANCES TO 8 DECIMAL PLACES
const migrateBalancesToEightDecimals = async () => {
  try {
    logger.info('🔧 Starting balance migration to 8 decimal places');

    // Helper function to limit to 8 decimal places
    const limitToEightDecimals = (value) => {
      if (typeof value === 'number') {
        return Math.round(value * 100000000) / 100000000;
      }
      return value;
    };

    // Define all balance fields that need to be migrated
    const balanceFields = [
      'solBalance', 'solBalanceUSD', 'solPendingBalance',
      'btcBalance', 'btcBalanceUSD', 'btcPendingBalance',
      'usdtBalance', 'usdtBalanceUSD', 'usdtPendingBalance',
      'usdcBalance', 'usdcBalanceUSD', 'usdcPendingBalance',
      'ethBalance', 'ethBalanceUSD', 'ethPendingBalance',
      'bnbBalance', 'bnbBalanceUSD', 'bnbPendingBalance',
      'dogeBalance', 'dogeBalanceUSD', 'dogePendingBalance',
      'maticBalance', 'maticBalanceUSD', 'maticPendingBalance',
      'avaxBalance', 'avaxBalanceUSD', 'avaxPendingBalance',
      'ngnzBalance', 'ngnzBalanceUSD', 'ngnzPendingBalance',
      'totalPortfolioBalance'
    ];

    const totalUsers = await User.countDocuments();
    logger.info(`📊 Found ${totalUsers} users to migrate`);

    if (totalUsers === 0) {
      logger.info('✅ No users found, migration not needed');
      return;
    }

    let usersWithChanges = 0;
    const batchSize = 100;

    // Process users in batches
    for (let skip = 0; skip < totalUsers; skip += batchSize) {
      const users = await User.find({})
        .select(['_id', 'username', ...balanceFields])
        .skip(skip)
        .limit(batchSize)
        .lean();

      const bulkOps = [];

      for (const user of users) {
        const updateFields = {};
        let hasChanges = false;

        // Check each balance field
        for (const field of balanceFields) {
          const currentValue = user[field];
          if (typeof currentValue === 'number') {
            const limitedValue = limitToEightDecimals(currentValue);
            
            if (currentValue !== limitedValue) {
              updateFields[field] = limitedValue;
              hasChanges = true;
            }
          }
        }

        if (hasChanges) {
          updateFields.portfolioLastUpdated = new Date();
          
          bulkOps.push({
            updateOne: {
              filter: { _id: user._id },
              update: { $set: updateFields }
            }
          });

          usersWithChanges++;
        }
      }

      // Execute bulk operations if any
      if (bulkOps.length > 0) {
        await User.bulkWrite(bulkOps);
      }
    }

    logger.info('✅ Balance migration to 8 decimals completed successfully', {
      totalUsers,
      usersWithChanges
    });

  } catch (error) {
    logger.error('❌ Error during balance migration', {
      error: error.message,
      stack: error.stack
    });
  }
};

// 🚨 NEW: FIX INCONSISTENT USD BALANCES (crypto = 0 but USD > 0)
const fixInconsistentUSDBalances = async () => {
  try {
    logger.info('🔧 Starting inconsistent USD balance fix script');

    // Define crypto balance pairs (crypto balance + corresponding USD balance)
    const balancePairs = [
      { crypto: 'btcBalance', usd: 'btcBalanceUSD' },
      { crypto: 'ethBalance', usd: 'ethBalanceUSD' },
      { crypto: 'solBalance', usd: 'solBalanceUSD' },
      { crypto: 'usdtBalance', usd: 'usdtBalanceUSD' },
      { crypto: 'usdcBalance', usd: 'usdcBalanceUSD' },
      { crypto: 'avaxBalance', usd: 'avaxBalanceUSD' },
      { crypto: 'bnbBalance', usd: 'bnbBalanceUSD' },
      { crypto: 'maticBalance', usd: 'maticBalanceUSD' },
      { crypto: 'ngnzBalance', usd: 'ngnzBalanceUSD' }
    ];

    // Build query to find users with inconsistent balances
    const inconsistentQueries = balancePairs.map(pair => ({
      [pair.crypto]: 0,           // Crypto balance is 0
      [pair.usd]: { $gt: 0 }      // But USD balance > 0
    }));

    const usersWithInconsistentBalances = await User.find({
      $or: inconsistentQueries
    }).select(['_id', 'username', 'phonenumber', ...balancePairs.flatMap(p => [p.crypto, p.usd])]).lean();

    if (usersWithInconsistentBalances.length === 0) {
      logger.info('✅ No users with inconsistent USD balances found');
      return;
    }

    logger.info(`🔍 Found ${usersWithInconsistentBalances.length} users with inconsistent USD balances`);

    // Log examples of inconsistencies found
    let exampleCount = 0;
    for (const user of usersWithInconsistentBalances) {
      if (exampleCount >= 3) break; // Only log first 3 examples
      
      const inconsistencies = [];
      for (const pair of balancePairs) {
        const cryptoBalance = user[pair.crypto];
        const usdBalance = user[pair.usd];
        
        if (cryptoBalance === 0 && usdBalance > 0) {
          inconsistencies.push({
            token: pair.crypto.replace('Balance', '').toUpperCase(),
            cryptoBalance,
            usdBalance
          });
        }
      }
      
      if (inconsistencies.length > 0) {
        logger.warn('User with inconsistent balances found', {
          userId: user._id,
          username: user.username,
          inconsistencies
        });
        exampleCount++;
      }
    }

    // Fix inconsistent balances using aggregation pipeline
    const fixOperations = [];
    
    for (const pair of balancePairs) {
      fixOperations.push({
        $set: {
          // If crypto balance is 0, set USD balance to 0, otherwise keep current USD balance
          [pair.usd]: {
            $cond: {
              if: { $eq: [`$${pair.crypto}`, 0] },
              then: 0,
              else: `$${pair.usd}`
            }
          }
        }
      });
    }

    // Execute the fix
    const result = await User.updateMany(
      { $or: inconsistentQueries },
      [
        ...fixOperations,
        {
          $set: {
            portfolioLastUpdated: new Date()
          }
        }
      ]
    );

    logger.info('✅ Inconsistent USD balance fix completed successfully', {
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount
    });

    // Recalculate total portfolio balances for affected users
    if (result.modifiedCount > 0) {
      logger.info('🔄 Recalculating total portfolio balances for affected users');
      
      const affectedUsers = await User.find({
        portfolioLastUpdated: { $gte: new Date(Date.now() - 10000) } // Users updated in last 10 seconds
      }).select('_id');

      for (const user of affectedUsers) {
        try {
          const userData = await User.findById(user._id);
          if (userData) {
            const newTotalPortfolio = 
              (userData.btcBalanceUSD || 0) +
              (userData.ethBalanceUSD || 0) +
              (userData.solBalanceUSD || 0) +
              (userData.usdtBalanceUSD || 0) +
              (userData.usdcBalanceUSD || 0) +
              (userData.avaxBalanceUSD || 0) +
              (userData.bnbBalanceUSD || 0) +
              (userData.maticBalanceUSD || 0) +
              (userData.ngnzBalanceUSD || 0);

            await User.findByIdAndUpdate(user._id, {
              totalPortfolioBalance: parseFloat(newTotalPortfolio.toFixed(8))
            });
          }
        } catch (error) {
          logger.warn('Failed to recalculate portfolio for user', { userId: user._id, error: error.message });
        }
      }

      logger.info('✅ Portfolio recalculation completed');
    }

    // Verify the fix worked
    const remainingInconsistencies = await User.countDocuments({ $or: inconsistentQueries });
    
    if (remainingInconsistencies === 0) {
      logger.info('🎉 All inconsistent USD balances successfully fixed');
    } else {
      logger.warn(`⚠️ ${remainingInconsistencies} users still have inconsistent balances after fix`);
    }

  } catch (error) {
    logger.error('❌ Error during inconsistent USD balance fix', {
      error: error.message,
      stack: error.stack
    });
  }
};

// Database Migration for Duplicate obiexTransactionId
const migrateTransactions = async () => {
  try {
    logger.info('Starting transaction migration to fix duplicate obiexTransactionId values');

    const legacyTransactions = await Transaction.find({
      obiexTransactionId: { $regex: '^obiex_', $not: { $regex: '_out$|_in$' } }
    });

    if (legacyTransactions.length === 0) {
      logger.info('No legacy transactions with obiex_ IDs found, migration not needed');
      return;
    }

    logger.info(`Found ${legacyTransactions.length} legacy transactions to migrate`);

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        for (const tx of legacyTransactions) {
          const { swapDetails, type } = tx;
          if (swapDetails && swapDetails.swapId) {
            const { swapOutTransaction, swapInTransaction } = await Transaction.getSwapTransactions(swapDetails.swapId);
            
            if (swapOutTransaction && swapInTransaction) {
              if (swapOutTransaction.obiexTransactionId && !swapOutTransaction.obiexTransactionId.endsWith('_out')) {
                await Transaction.updateOne(
                  { _id: swapOutTransaction._id },
                  { $set: { obiexTransactionId: `${swapOutTransaction.obiexTransactionId}_out`, updatedAt: new Date() } },
                  { session }
                );
              }
              if (swapInTransaction.obiexTransactionId && !swapInTransaction.obiexTransactionId.endsWith('_in')) {
                await Transaction.updateOne(
                  { _id: swapInTransaction._id },
                  { $set: { obiexTransactionId: `${swapInTransaction.obiexTransactionId}_in`, updatedAt: new Date() } },
                  { session }
                );
              }
            } else if (type === 'SWAP_OUT' || type === 'SWAP_IN') {
              const newId = `${tx.obiexTransactionId}_${type === 'SWAP_OUT' ? 'out' : 'in'}`;
              await Transaction.updateOne(
                { _id: tx._id },
                { $set: { obiexTransactionId: newId, updatedAt: new Date() } },
                { session }
              );
            }
          } else {
            const newId = `legacy_${tx.obiexTransactionId}_${Math.random().toString(36).substr(2, 9)}`;
            await Transaction.updateOne(
              { _id: tx._id },
              { $set: { obiexTransactionId: newId, updatedAt: new Date() } },
              { session }
            );
          }
        }
      });
      logger.info('Transaction migration completed successfully');
    } catch (error) {
      logger.error('Transaction migration failed', { error: error.message });
      throw error;
    } finally {
      session.endSession();
    }
  } catch (error) {
    logger.error('Error during transaction migration', { error: error.message });
  }
};

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, error: "Internal Server Error" });
});

// Start Server
const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {});
    console.log("✅ MongoDB Connected");

    // 🚨 Run balance migrations in order
    await fixNegativeBalances();
    await migrateBalancesToEightDecimals();
    await fixInconsistentUSDBalances(); // NEW: Fix crypto=0 but USD>0 cases
    await migrateTransactions();
    
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🔥 Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Error during startup:", error);
    process.exit(1);
  }
};

startServer();