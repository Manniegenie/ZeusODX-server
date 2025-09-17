require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const passport = require("passport");
const morgan = require("morgan");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const cron = require('node-cron');

// Import crypto price job
const { updateCryptoPrices } = require('./services/cryptoPriceJob');

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

// Database Index Fix Function
const fixCryptoFeeIndexes = async () => {
  try {
    const db = mongoose.connection.db;
    const collection = db.collection('cryptofeemarkups');
    
    // Check if collection exists
    const collections = await db.listCollections({ name: 'cryptofeemarkups' }).toArray();
    if (collections.length === 0) {
      console.log("CryptoFeeMarkup collection doesn't exist yet, skipping index fix");
      return;
    }
    
    // Get existing indexes
    const indexes = await collection.indexes();
    console.log("Current indexes for cryptofeemarkups:", indexes.map(idx => idx.name));
    
    // Drop old currency-only index if it exists
    try {
      await collection.dropIndex("currency_1");
      console.log("✅ Old currency index dropped successfully");
    } catch (error) {
      if (error.code === 27) {
        console.log("ℹ️  Old currency index doesn't exist, skipping drop");
      } else {
        console.log("⚠️  Error dropping old index:", error.message);
      }
    }
    
    // Create new compound index if it doesn't exist
    try {
      await collection.createIndex({ currency: 1, network: 1 }, { unique: true });
      console.log("✅ New compound index (currency + network) created successfully");
    } catch (error) {
      if (error.code === 85) {
        console.log("ℹ️  Compound index already exists, skipping creation");
      } else {
        console.log("⚠️  Error creating compound index:", error.message);
      }
    }
    
    // Verify final indexes
    const finalIndexes = await collection.indexes();
    console.log("Final indexes for cryptofeemarkups:", finalIndexes.map(idx => idx.name));
    
  } catch (error) {
    console.error("❌ Error fixing CryptoFeeMarkup indexes:", error.message);
  }
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
const cablepackagesRoutes = require('./routes/cabletvpackages');
const usernamewithdrawRoutes = require('./routes/usernamewithdraw');
const userqueryRoutes = require('./routes/usernamequery');
const fetchnetworkRoutes = require('./routes/fetchnetwork');
const TwooFARoutes = require('./adminRoutes/2FA');
const HistoryRoutes = require('./routes/transactionhistory');
const ProfileRoutes = require('./routes/Profile');
const bankAccountRoutes = require('./routes/bankAccount');
const Resetpin = require('./routes/ResetPin');
const DeleteAccountRoutes = require('./routes/deleteaccount');
const nairaAccountsRoutes = require('./routes/fetchnaira');
const giftcardRatesRoutes = require("./routes/giftcardrates");
const admingiftcardRoutes = require('./adminRoutes/giftcard');
const giftcardRoutes = require("./routes/giftcard");
const giftcardcountryRoutes = require("./routes/giftcardcountry");
const kycwebhookRoutes = require('./routes/kycwebhook');
const VerificationProgressRoutes = require('./routes/VerificationProgress');
const EnhancedKYCRoutes = require('./routes/EnhancedKYC');
const NGNZWithdrawal = require('./routes/NGNZWithdrawal');
const NINRoutes = require('./routes/NIN');
const EmailVerifyRoutes = require('./routes/EmailVerify')
const KYCRoutes = require('./routes/KYC');
const ForgotPinRoutes = require('./routes/forgotpasswordpin');
const AccountnameRoutes = require('./routes/Accountname');



// Public Routes
app.use("/signin", signinRoutes);
app.use("/signup", signupRoutes);
app.use("/refresh-token", refreshtokenRoutes);
app.use("/verify-otp", verifyotpRoutes);
app.use("/passwordpin", passwordpinRoutes);
app.use("/usernamecheck", usernamecheckRoutes);
app.use("/naira", nairaAccountsRoutes);
app.use("/accountname", AccountnameRoutes);


// Webhook Routes
app.use("/webhook", webhookLimiter, webhookRoutes);
app.use("/billwebhook", webhookLimiter, billwebhookRoutes);
app.use("/kyc-webhook", webhookLimiter, kycwebhookRoutes);

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
app.use("/2FA-Disable", TwooFARoutes);
app.use('/admingiftcard', admingiftcardRoutes);

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
app.use("/cable-packages", authenticateToken, cablepackagesRoutes);
app.use("/username-withdraw", authenticateToken, usernamewithdrawRoutes);
app.use("/user-query", authenticateToken, userqueryRoutes);
app.use("/fetchnetwork", fetchnetworkRoutes);
app.use("/history", authenticateToken, HistoryRoutes);
app.use("/profile", authenticateToken, ProfileRoutes);
app.use("/bank", authenticateToken, bankAccountRoutes);
app.use("/reset-pin", authenticateToken, Resetpin);
app.use("/delete-account", authenticateToken, DeleteAccountRoutes);
app.use("/giftcard", authenticateToken, giftcardRoutes);
app.use("/giftcardrates", authenticateToken, giftcardRatesRoutes);
app.use("/giftcardcountry", authenticateToken, giftcardcountryRoutes);
app.use("/verification", authenticateToken, VerificationProgressRoutes);
app.use("/enhanced-kyc", authenticateToken, EnhancedKYCRoutes);
app.use("/ngnz-withdrawal", authenticateToken, NGNZWithdrawal);
app.use("/nin", authenticateToken, NINRoutes);
app.use("/email", authenticateToken, EmailVerifyRoutes)
app.use("/kyc", authenticateToken, KYCRoutes);
app.use("/forgot-pin", ForgotPinRoutes);



// Health Check
app.get("/", (req, res) => {
  res.send(`🚀 API Running at ${new Date().toISOString()}`);
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, error: "Internal Server Error" });
});

// Crypto Price Update Job - Run every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  try {
    console.log('🔄 Starting scheduled crypto price update...');
    await updateCryptoPrices();
    console.log('✅ Scheduled crypto price update completed');
  } catch (error) {
    console.error('❌ Scheduled crypto price job failed:', error.message);
  }
});

// Start Server
const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {});
    console.log("✅ MongoDB Connected");
    
    // Fix CryptoFeeMarkup indexes after database connection
    console.log("🔧 Fixing CryptoFeeMarkup database indexes...");
    await fixCryptoFeeIndexes();
    
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🔥 Server running on port ${PORT}`);
      console.log('⏰ Crypto price update job scheduled every 15 minutes');
      
      // Run price update immediately on startup
      setTimeout(async () => {
        try {
          console.log('🚀 Running initial crypto price update...');
          await updateCryptoPrices();
          console.log('✅ Initial crypto price update completed');
        } catch (error) {
          console.error('❌ Initial crypto price update failed:', error.message);
        }
      }, 5000); // Wait 5 seconds after server start
    });
  } catch (error) {
    console.error("Error during startup:", error);
    process.exit(1);
  }
};

startServer();