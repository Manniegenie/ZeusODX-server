require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const passport = require("passport");
const morgan = require("morgan");
const jwt = require("jsonwebtoken");
const cors = require("cors");

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

// Raw Body Parser for Webhook Routes (before other body parsers)
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

// Database Migration Functions
async function migrateUserIndexes() {
  try {
    const collection = mongoose.connection.db.collection('users');
    
    console.log('🚀 Starting User collection migration...');
    
    // Step 1: Drop ALL existing indexes except _id
    console.log('📋 Checking existing indexes...');
    const existingIndexes = await collection.listIndexes().toArray();
    console.log('Current indexes:', existingIndexes.map(idx => idx.name));
    
    // Drop all indexes except _id
    const indexesToDrop = existingIndexes
      .map(idx => idx.name)
      .filter(name => name !== '_id_');
    
    for (const indexName of indexesToDrop) {
      try {
        await collection.dropIndex(indexName);
        console.log(`✅ Dropped index: ${indexName}`);
      } catch (error) {
        console.log(`⚠️  Could not drop index ${indexName}:`, error.message);
      }
    }
    
    // Step 2: Clean up duplicate data
    console.log('🧹 Cleaning up duplicate data...');
    
    // Note: Keeping users with placeholder wallet addresses since wallets are no longer unique
    console.log('📝 Wallet addresses are no longer unique - keeping all users with placeholder addresses');
    
    // Handle duplicate emails (keep the oldest one)
    console.log('📧 Checking for duplicate emails...');
    const emailDuplicates = await collection.aggregate([
      {
        $group: {
          _id: "$email",
          count: { $sum: 1 },
          docs: { $push: { id: "$_id", createdAt: "$createdAt" } }
        }
      },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();
    
    for (const duplicate of emailDuplicates) {
      const docsToDelete = duplicate.docs
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .slice(1);
      
      for (const doc of docsToDelete) {
        await collection.deleteOne({ _id: doc.id });
        console.log(`🗑️  Removed duplicate email user: ${doc.id}`);
      }
    }
    
    // Handle duplicate usernames (keep oldest, nullify others)
    console.log('👤 Checking for duplicate usernames...');
    const usernameDuplicates = await collection.aggregate([
      {
        $match: { username: { $ne: null, $ne: "" } }
      },
      {
        $group: {
          _id: "$username",
          count: { $sum: 1 },
          docs: { $push: { id: "$_id", createdAt: "$createdAt" } }
        }
      },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();
    
    for (const duplicate of usernameDuplicates) {
      const docsToUpdate = duplicate.docs
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .slice(1);
      
      for (const doc of docsToUpdate) {
        await collection.updateOne(
          { _id: doc.id },
          { $unset: { username: "" } }
        );
        console.log(`🔄 Nullified duplicate username for user: ${doc.id}`);
      }
    }
    
    // Handle duplicate phone numbers
    console.log('📱 Checking for duplicate phone numbers...');
    const phoneDuplicates = await collection.aggregate([
      {
        $match: { phonenumber: { $ne: null, $ne: "" } }
      },
      {
        $group: {
          _id: "$phonenumber",
          count: { $sum: 1 },
          docs: { $push: { id: "$_id", createdAt: "$createdAt" } }
        }
      },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();
    
    for (const duplicate of phoneDuplicates) {
      const docsToUpdate = duplicate.docs
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .slice(1);
      
      for (const doc of docsToUpdate) {
        await collection.updateOne(
          { _id: doc.id },
          { $unset: { phonenumber: "" } }
        );
        console.log(`🔄 Nullified duplicate phone number for user: ${doc.id}`);
      }
    }
    
    // Handle duplicate BVNs
    console.log('🏦 Checking for duplicate BVNs...');
    const bvnDuplicates = await collection.aggregate([
      {
        $match: { bvn: { $ne: null, $ne: "" } }
      },
      {
        $group: {
          _id: "$bvn",
          count: { $sum: 1 },
          docs: { $push: { id: "$_id", createdAt: "$createdAt" } }
        }
      },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();
    
    for (const duplicate of bvnDuplicates) {
      const docsToUpdate = duplicate.docs
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .slice(1);
      
      for (const doc of docsToUpdate) {
        await collection.updateOne(
          { _id: doc.id },
          { $unset: { bvn: "" } }
        );
        console.log(`🔄 Nullified duplicate BVN for user: ${doc.id}`);
      }
    }
    
    // Step 3: Create correct indexes
    console.log('🏗️  Creating new unique indexes...');
    
    await collection.createIndex({ email: 1 }, { unique: true });
    console.log('✅ Created unique index: email');
    
    await collection.createIndex({ username: 1 }, { unique: true, sparse: true });
    console.log('✅ Created unique sparse index: username');
    
    await collection.createIndex({ phonenumber: 1 }, { unique: true, sparse: true });
    console.log('✅ Created unique sparse index: phonenumber');
    
    await collection.createIndex({ bvn: 1 }, { unique: true, sparse: true });
    console.log('✅ Created unique sparse index: bvn');
    
    // Verify
    console.log('🔍 Verifying new indexes...');
    const newIndexes = await collection.listIndexes().toArray();
    console.log('New indexes:');
    newIndexes.forEach(idx => {
      console.log(`  - ${idx.name}: ${JSON.stringify(idx.key)} ${idx.unique ? '(unique)' : ''} ${idx.sparse ? '(sparse)' : ''}`);
    });
    
    console.log('🎉 User migration completed successfully!');
    
  } catch (error) {
    console.error('❌ User migration failed:', error);
    throw error;
  }
}

async function fixTransactionIndexes() {
  try {
    console.log("🔧 Checking transaction indexes...");
    const Transaction = require("./models/transaction");
    
    // Drop the problematic index that's causing duplicate key errors
    await Transaction.collection.dropIndex("transactionId_1").catch(() => {
      console.log("   Index transactionId_1 not found or already dropped");
    });
    
    // Recreate proper indexes from schema
    await Transaction.syncIndexes();
    
    console.log("✅ Transaction indexes fixed successfully");
  } catch (indexError) {
    console.error("❌ Transaction index fix failed (but continuing):", indexError.message);
    // Don't crash the server if index fix fails
  }
}

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

// Public Routes (No Authentication Required)
app.use("/signin", signinRoutes);
app.use("/signup", signupRoutes);
app.use("/refresh-token", refreshtokenRoutes);
app.use("/verify-otp", verifyotpRoutes);
app.use("/passwordpin", passwordpinRoutes);
app.use("/usernamecheck", usernamecheckRoutes);

// Webhook Routes (Special Rate Limiting)
app.use("/webhook", webhookLimiter, webhookRoutes);
app.use("/billwebhook", webhookLimiter, billwebhookRoutes);

// Admin/Utility Routes (No Authentication)
app.use("/deleteuser", deleteuserRoutes);
app.use("/updateuseraddress", updateuseraddressRoutes);
app.use("/fetch-wallet", fetchwalletRoutes);
app.use("/delete-pin", deletepinRoutes);
app.use("/fetch", fetchtransactionRoutes);
app.use("/set-fee", SetfeeRoutes);
app.use("/pending", clearpendingRoutes);
app.use("/fetching", fetchrefreshtoken);
app.use("/fund", FunduserRoutes);

// Public Data Routes
app.use("/naira-price", nairaPriceRouter);
app.use("/onramp", onrampRoutes);
app.use("/offramp", offrampRoutes);

// Protected Routes (JWT Required)
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

// Health Check
app.get("/", (req, res) => {
  res.send(`🚀 API Running at ${new Date().toISOString()}`);
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, error: "Internal Server Error" });
});

// Launch Server with Complete Database Migration
const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {});
    console.log("✅ MongoDB Connected");
    
    // Run complete database migration
    console.log("🔧 Running complete database migration...");
    
    // Fix user indexes and data
    await migrateUserIndexes();
    
    // Fix transaction indexes  
    await fixTransactionIndexes();
    
    console.log("✅ Complete migration finished successfully");
    
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🔥 Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Error during startup:", error);
    process.exit(1);
  }
};

startServer();