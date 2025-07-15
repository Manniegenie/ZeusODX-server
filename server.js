require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const passport = require("passport");
const morgan = require("morgan");
const jwt = require("jsonwebtoken");
const cors = require("cors");

// Bring in your User model so we can zero balances
const User = require("./models/user");

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
app.use(
  "/webhook",
  express.raw({ type: "application/json" }),
  (req, res, next) => {
    req.rawBody = req.body.toString("utf8");
    next();
  }
);

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
const nairaPriceRouter = require("./routes/nairaprice");
const onrampRoutes = require("./adminRoutes/onramp");
const offrampRoutes = require("./adminRoutes/offramp");
const walletRoutes = require("./routes/wallet");
const TwoFARoutes = require("./auth/setup-2fa");
const AirtimeRoutes = require("./routes/airtime");
const DataRoutes = require("./routes/data");
const VerifybillRoutes = require("./routes/verifybill");
const ElectricityRoutes = require("./routes/electricity");
const BettingRoutes = require("./routes/betting");
const CableTVRoutes = require("./routes/cabletv");
const fetchdataplans = require("./routes/dataplans");
const billwebhookRoutes = require("./routes/billwebhook");
const dashboardRoutes = require("./routes/dashboard");
const pricemarkdownRoutes = require("./adminRoutes/pricemarkdown");
const swapRoutes = require("./routes/swap");
const ngnzSwapRoutes = require("./routes/NGNZSwaps");

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

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, error: "Internal Server Error" });
});

// Start Server and auto‑wipe balances on each boot
const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {});
    console.log("✅ MongoDB Connected");

    // Wipe all balances every time the server starts
    const zeroFields = {
      solBalance: 0,    solBalanceUSD: 0,    solPendingBalance: 0,
      btcBalance: 0,    btcBalanceUSD: 0,    btcPendingBalance: 0,
      usdtBalance: 0,   usdtBalanceUSD: 0,   usdtPendingBalance: 0,
      usdcBalance: 0,   usdcBalanceUSD: 0,   usdcPendingBalance: 0,
      ethBalance: 0,    ethBalanceUSD: 0,    ethPendingBalance: 0,
      bnbBalance: 0,    bnbBalanceUSD: 0,    bnbPendingBalance: 0,
      dogeBalance: 0,   dogeBalanceUSD: 0,   dogePendingBalance: 0,
      maticBalance: 0,  maticBalanceUSD: 0,  maticPendingBalance: 0,
      avaxBalance: 0,   avaxBalanceUSD: 0,   avaxPendingBalance: 0,
      ngnzBalance: 0,   ngnzBalanceUSD: 0,   ngnzPendingBalance: 0,
      totalPortfolioBalance: 0
    };

    console.log("⚠️  Auto‑wiping all user balances to zero…");
    const result = await User.updateMany({}, { $set: zeroFields });
    console.log(`✅  Matched ${result.n} users, modified ${result.nModified}`);

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🔥 Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Error during startup:", error);
    process.exit(1);
  }
};

startServer();
