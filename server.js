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

    // Log details of affected users
    usersWithNegativeBalances.forEach(user => {
      const negativeFields = usdBalanceFields.filter(field => user[field] < 0);
      logger.warn('User with negative balance found', {
        userId: user._id,
        username: user.username,
        phonenumber: user.phonenumber?.replace(/(\+234\d{3})\d{4}(\d{4})/, '$1****$2'),
        negativeBalances: negativeFields.map(field => ({
          field,
          value: user[field]
        }))
      });
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
      modifiedCount: result.modifiedCount,
      acknowledgedCount: result.acknowledged
    });

    // Verify the fix worked
    const remainingNegativeBalances = await User.countDocuments(negativeBalanceQuery);
    if (remainingNegativeBalances === 0) {
      logger.info('🎉 All negative balances successfully fixed');
    } else {
      logger.warn(`⚠️ ${remainingNegativeBalances} users still have negative balances after fix`);
    }

  } catch (error) {
    logger.error('❌ Error during negative balance fix', {
      error: error.message,
      stack: error.stack
    });
    // Don't throw error to prevent server startup failure
  }
};

// Database Migration for Duplicate obiexTransactionId
const migrateTransactions = async () => {
  try {
    logger.info('Starting transaction migration to fix duplicate obiexTransactionId values');

    // Find transactions with legacy obiex_ IDs (not ending in _out or _in)
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
            // Check if both SWAP_OUT and SWAP_IN exist for the swapId
            const { swapOutTransaction, swapInTransaction } = await Transaction.getSwapTransactions(swapDetails.swapId);
            
            if (swapOutTransaction && swapInTransaction) {
              // Update SWAP_OUT and SWAP_IN to have unique IDs
              if (swapOutTransaction.obiexTransactionId && !swapOutTransaction.obiexTransactionId.endsWith('_out')) {
                await Transaction.updateOne(
                  { _id: swapOutTransaction._id },
                  { $set: { obiexTransactionId: `${swapOutTransaction.obiexTransactionId}_out`, updatedAt: new Date() } },
                  { session }
                );
                logger.info(`Updated SWAP_OUT transaction ${swapOutTransaction._id} to obiexTransactionId: ${swapOutTransaction.obiexTransactionId}_out`);
              }
              if (swapInTransaction.obiexTransactionId && !swapInTransaction.obiexTransactionId.endsWith('_in')) {
                await Transaction.updateOne(
                  { _id: swapInTransaction._id },
                  { $set: { obiexTransactionId: `${swapInTransaction.obiexTransactionId}_in`, updatedAt: new Date() } },
                  { session }
                );
                logger.info(`Updated SWAP_IN transaction ${swapInTransaction._id} to obiexTransactionId: ${swapInTransaction.obiexTransactionId}_in`);
              }
            } else if (type === 'SWAP_OUT' || type === 'SWAP_IN') {
              // Handle orphaned transactions (e.g., only SWAP_OUT exists)
              const newId = `${tx.obiexTransactionId}_${type === 'SWAP_OUT' ? 'out' : 'in'}`;
              await Transaction.updateOne(
                { _id: tx._id },
                { $set: { obiexTransactionId: newId, updatedAt: new Date() } },
                { session }
              );
              logger.info(`Updated orphaned ${type} transaction ${tx._id} to obiexTransactionId: ${newId}`);
            }
          } else {
            // Non-swap transactions with obiex_ IDs (e.g., DEPOSIT, WITHDRAWAL)
            const newId = `legacy_${tx.obiexTransactionId}_${Math.random().toString(36).substr(2, 9)}`;
            await Transaction.updateOne(
              { _id: tx._id },
              { $set: { obiexTransactionId: newId, updatedAt: new Date() } },
              { session }
            );
            logger.info(`Updated non-swap transaction ${tx._id} to obiexTransactionId: ${newId}`);
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

    // 🚨 Run balance fix FIRST (most critical)
    await fixNegativeBalances();
    
    // Run transaction migration
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