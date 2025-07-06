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

// Route Imports
const logoutRoutes = require("./routes/logout");
const refreshtokenRoutes = require("./routes/refreshtoken");
const addpinRoutes = require("./routes/passwordpin");
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
const passwordpinRoutes = require("./routes/passwordpin");

// Public Routes
app.use("/signin", signinRoutes);
app.use("/signup", signupRoutes);
app.use("/refresh-token", refreshtokenRoutes);
app.use("/deleteuser", deleteuserRoutes);
app.use("/verify-otp", verifyotpRoutes);
app.use("/webhook", webhookLimiter, webhookRoutes);
app.use("/billwebhook", webhookLimiter, billwebhookRoutes);
app.use("/updateuseraddress", updateuseraddressRoutes);
app.use("/naira-price", nairaPriceRouter);
app.use("/onramp", onrampRoutes);
app.use("/offramp", offrampRoutes);
app.use("/fetch-wallet", fetchwalletRoutes);
app.use("/delete-pin", deletepinRoutes);
app.use("/add-pin", addpinRoutes);
app.use("/fetch", fetchtransactionRoutes);
app.use("/set-fee", SetfeeRoutes);
app.use("/pending", clearpendingRoutes);
app.use("/fetching", fetchrefreshtoken);
app.use("/fund", FunduserRoutes);
app.use("/usernamecheck", usernamecheckRoutes);
app.use("/passwordpin", passwordpinRoutes);

// Protected Routes (JWT Required)
app.use("/logout", authenticateToken, logoutRoutes);
app.use("/username", authenticateToken, usernameRoutes);
app.use("/usernamecheck", authenticateToken, usernamecheckRoutes);
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
app.use("/passwordpin", authenticateToken, passwordpinRoutes);

// Health Check
app.get("/", (req, res) => {
  res.send(`🚀 API Running at ${new Date().toISOString()}`);
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, error: "Internal Server Error" });
});

// Comprehensive User Data Migration
async function migrateUserData() {
  try {
    console.log("🔧 Starting comprehensive user data migration...");
    const User = require("./models/User");

    // Handle duplicate data conflicts before dropping indexes
    console.log("   📋 Checking for data conflicts...");

    // Fix duplicate usernames (exclude null)
    const duplicateUsernames = await User.aggregate([
      { $match: { username: { $ne: null } } },
      { $group: { _id: "$username", count: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } }
    ]);

    for (const dup of duplicateUsernames) {
      console.log(`   ⚠️  Found ${dup.count} users with username "${dup._id}"`);
      for (let i = 1; i < dup.ids.length; i++) {
        const newUsername = `${dup._id}_${i}`;
        await User.updateOne({ _id: dup.ids[i] }, { username: newUsername });
        console.log(`   ✏️  Updated user ${dup.ids[i]} to username "${newUsername}"`);
      }
    }

    // Fix duplicate phone numbers (exclude null)
    const duplicatePhones = await User.aggregate([
      { $match: { phonenumber: { $ne: null } } },
      { $group: { _id: "$phonenumber", count: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } }
    ]);

    for (const dup of duplicatePhones) {
      console.log(`   ⚠️  Found ${dup.count} users with phone "${dup._id}"`);
      for (let i = 1; i < dup.ids.length; i++) {
        await User.updateOne({ _id: dup.ids[i] }, { $unset: { phonenumber: 1 } });
        console.log(`   ✏️  Removed duplicate phone for user ${dup.ids[i]}`);
      }
    }

    // Fix duplicate wallet addresses (including placeholders)
    const walletTypes = ['BTC_BTC', 'ETH_ETH', 'SOL_SOL', 'USDT_ETH', 'USDT_TRX', 'USDT_BSC', 'USDC_ETH', 'USDC_BSC', 'NGNB'];
    
    for (const walletType of walletTypes) {
      const fieldPath = `wallets.${walletType}.address`;
      
      // Find duplicate wallet addresses (exclude null/undefined)
      const duplicateWallets = await User.aggregate([
        { $match: { [fieldPath]: { $ne: null, $exists: true } } },
        { $group: { _id: `$${fieldPath}`, count: { $sum: 1 }, ids: { $push: "$_id" } } },
        { $match: { count: { $gt: 1 } } }
      ]);

      for (const dup of duplicateWallets) {
        console.log(`   ⚠️  Found ${dup.count} users with duplicate ${walletType} address "${dup._id}"`);
        
        // Keep the first one, remove duplicates
        for (let i = 1; i < dup.ids.length; i++) {
          await User.updateOne(
            { _id: dup.ids[i] }, 
            { $unset: { [`wallets.${walletType}.address`]: 1 } }
          );
          console.log(`   ✏️  Removed duplicate ${walletType} address for user ${dup.ids[i]}`);
        }
      }

      // Also fix duplicate wallet reference IDs
      const refFieldPath = `wallets.${walletType}.walletReferenceId`;
      const duplicateRefs = await User.aggregate([
        { $match: { [refFieldPath]: { $ne: null, $exists: true } } },
        { $group: { _id: `$${refFieldPath}`, count: { $sum: 1 }, ids: { $push: "$_id" } } },
        { $match: { count: { $gt: 1 } } }
      ]);

      for (const dup of duplicateRefs) {
        console.log(`   ⚠️  Found ${dup.count} users with duplicate ${walletType} reference ID`);
        for (let i = 1; i < dup.ids.length; i++) {
          await User.updateOne(
            { _id: dup.ids[i] }, 
            { $unset: { [`wallets.${walletType}.walletReferenceId`]: 1 } }
          );
          console.log(`   ✏️  Removed duplicate ${walletType} reference ID for user ${dup.ids[i]}`);
        }
      }
    }

    // Fix duplicate refresh tokens
    const duplicateTokens = await User.aggregate([
      { $unwind: "$refreshTokens" },
      { $group: { _id: "$refreshTokens.token", count: { $sum: 1 }, userIds: { $addToSet: "$_id" } } },
      { $match: { count: { $gt: 1 } } }
    ]);

    for (const dup of duplicateTokens) {
      console.log(`   ⚠️  Found duplicate refresh token across ${dup.userIds.length} users`);
      // Remove the token from all but the first user
      for (let i = 1; i < dup.userIds.length; i++) {
        await User.updateOne(
          { _id: dup.userIds[i] },
          { $pull: { refreshTokens: { token: dup._id } } }
        );
        console.log(`   ✏️  Removed duplicate refresh token from user ${dup.userIds[i]}`);
      }
    }

    // CRITICAL FIX: Handle multiple null values for ALL sparse index fields
    
    // Fix null usernames
    const usersWithNullUsername = await User.find({ username: null });
    if (usersWithNullUsername.length > 1) {
      console.log(`   ⚠️  Found ${usersWithNullUsername.length} users with null usernames`);
      for (let i = 1; i < usersWithNullUsername.length; i++) {
        const tempUsername = `temp_user_${usersWithNullUsername[i]._id.toString().slice(-8)}`;
        await User.updateOne({ _id: usersWithNullUsername[i]._id }, { username: tempUsername });
        console.log(`   ✏️  Temporarily assigned username "${tempUsername}" to user ${usersWithNullUsername[i]._id}`);
      }
    }

    // Fix null twoFASecret
    const usersWithNull2FA = await User.find({ twoFASecret: null });
    if (usersWithNull2FA.length > 1) {
      console.log(`   ⚠️  Found ${usersWithNull2FA.length} users with null 2FA secrets`);
      for (let i = 1; i < usersWithNull2FA.length; i++) {
        const temp2FA = `temp_2fa_${usersWithNull2FA[i]._id.toString().slice(-8)}`;
        await User.updateOne({ _id: usersWithNull2FA[i]._id }, { twoFASecret: temp2FA });
        console.log(`   ✏️  Temporarily assigned 2FA secret to user ${usersWithNull2FA[i]._id}`);
      }
    }

    // Fix null BVNs
    const usersWithNullBVN = await User.find({ bvn: null });
    if (usersWithNullBVN.length > 1) {
      console.log(`   ⚠️  Found ${usersWithNullBVN.length} users with null BVNs`);
      for (let i = 1; i < usersWithNullBVN.length; i++) {
        const tempBVN = `temp_bvn_${usersWithNullBVN[i]._id.toString().slice(-8)}`;
        await User.updateOne({ _id: usersWithNullBVN[i]._id }, { bvn: tempBVN });
        console.log(`   ✏️  Temporarily assigned BVN to user ${usersWithNullBVN[i]._id}`);
      }
    }

    // Fix null phone numbers  
    const usersWithNullPhone = await User.find({ phonenumber: null });
    if (usersWithNullPhone.length > 1) {
      console.log(`   ⚠️  Found ${usersWithNullPhone.length} users with null phone numbers`);
      for (let i = 1; i < usersWithNullPhone.length; i++) {
        const tempPhone = `temp_phone_${usersWithNullPhone[i]._id.toString().slice(-8)}`;
        await User.updateOne({ _id: usersWithNullPhone[i]._id }, { phonenumber: tempPhone });
        console.log(`   ✏️  Temporarily assigned phone to user ${usersWithNullPhone[i]._id}`);
      }
    }

    console.log("   ✅ Data conflict resolution completed");

    // Drop all problematic indexes
    console.log("   🗑️  Dropping old indexes...");
    
    const indexesToDrop = [
      'username_1',
      'phonenumber_1', 
      'bvn_1',
      'twoFASecret_1',
      'wallets.BTC_BTC.address_1',
      'wallets.ETH_ETH.address_1',
      'wallets.SOL_SOL.address_1',
      'wallets.USDT_ETH.address_1',
      'wallets.USDT_TRX.address_1',
      'wallets.USDT_BSC.address_1',
      'wallets.USDC_ETH.address_1',
      'wallets.USDC_BSC.address_1',
      'wallets.NGNB.address_1',
      'wallets.BTC_BTC.walletReferenceId_1',
      'wallets.ETH_ETH.walletReferenceId_1',
      'wallets.SOL_SOL.walletReferenceId_1',
      'wallets.USDT_ETH.walletReferenceId_1',
      'wallets.USDT_TRX.walletReferenceId_1',
      'wallets.USDT_BSC.walletReferenceId_1',
      'wallets.USDC_ETH.walletReferenceId_1',
      'wallets.USDC_BSC.walletReferenceId_1',
      'wallets.NGNB.walletReferenceId_1',
      'refreshTokens.token_1'
    ];

    for (const indexName of indexesToDrop) {
      try {
        await User.collection.dropIndex(indexName);
        console.log(`   ✅ Dropped index: ${indexName}`);
      } catch (error) {
        if (error.codeName !== 'IndexNotFound') {
          console.log(`   ℹ️  Index ${indexName} not found (already dropped or never existed)`);
        }
      }
    }

    // Recreate all indexes with proper sparse configuration
    console.log("   🔨 Creating new sparse indexes...");
    await User.ensureIndexes();
    console.log("   ✅ All new sparse indexes created successfully");

    // Reset ALL temporary values back to null (now that sparse indexes are created)
    console.log("   🔄 Resetting temporary values back to null...");
    
    // Reset temporary usernames
    const tempUsers = await User.find({ username: { $regex: /^temp_user_/ } });
    if (tempUsers.length > 0) {
      for (const user of tempUsers) {
        await User.updateOne({ _id: user._id }, { $unset: { username: 1 } });
      }
      console.log(`   ✅ Reset ${tempUsers.length} temporary usernames back to null`);
    }

    // Reset temporary 2FA secrets
    const temp2FAUsers = await User.find({ twoFASecret: { $regex: /^temp_2fa_/ } });
    if (temp2FAUsers.length > 0) {
      for (const user of temp2FAUsers) {
        await User.updateOne({ _id: user._id }, { $unset: { twoFASecret: 1 } });
      }
      console.log(`   ✅ Reset ${temp2FAUsers.length} temporary 2FA secrets back to null`);
    }

    // Reset temporary BVNs
    const tempBVNUsers = await User.find({ bvn: { $regex: /^temp_bvn_/ } });
    if (tempBVNUsers.length > 0) {
      for (const user of tempBVNUsers) {
        await User.updateOne({ _id: user._id }, { $unset: { bvn: 1 } });
      }
      console.log(`   ✅ Reset ${tempBVNUsers.length} temporary BVNs back to null`);
    }

    // Reset temporary phone numbers
    const tempPhoneUsers = await User.find({ phonenumber: { $regex: /^temp_phone_/ } });
    if (tempPhoneUsers.length > 0) {
      for (const user of tempPhoneUsers) {
        await User.updateOne({ _id: user._id }, { $unset: { phonenumber: 1 } });
      }
      console.log(`   ✅ Reset ${tempPhoneUsers.length} temporary phone numbers back to null`);
    }

    // Verify the migration
    const indexes = await User.collection.listIndexes().toArray();
    console.log("   📊 Current user indexes:");
    indexes.forEach(index => {
      const sparse = index.sparse ? " (sparse)" : "";
      const unique = index.unique ? " (unique)" : "";
      console.log(`     - ${index.name}: ${JSON.stringify(index.key)}${unique}${sparse}`);
    });

    console.log("✅ User data migration completed successfully!");
    
  } catch (error) {
    console.error("❌ User data migration failed:", error.message);
    // Don't crash the server, just log the error
    console.error("   Stack:", error.stack);
  }
}

// Launch Server with Comprehensive MongoDB Migration
const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {});
    console.log("✅ MongoDB Connected");
    
    // Run comprehensive user data migration
    await migrateUserData();
    
    // Fix transaction indexes (run once to resolve duplicate key issue)
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
    
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🔥 Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Error during startup:", error);
    process.exit(1);
  }
};

startServer();