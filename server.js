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
// Import scheduled notification service
const scheduledNotificationService = require('./services/scheduledNotificationService');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS Setup
app.set("trust proxy", 1);

// Allowed origins for CORS
const allowedOrigins = [
  process.env.CLIENT_URL,
  "http://localhost:5173", // Local development
  "https://www.zeusodx.online", // Admin frontend production
  "https://zeusodx.online", // Admin frontend (without www)
  "https://zeusadminxyz.online", // Server domain
].filter(Boolean); // Remove undefined values

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`🚫 CORS blocked origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true, // Allow cookies/auth headers
  })
);

// Morgan Logging
app.use(morgan("combined"));

// Helmet Security
app.use(helmet());

// Security: Track failed requests for rate limiting
const failedRequestTracker = new Map(); // IP -> { count, firstAttempt, lastAttempt }

// Security: Block access to sensitive files and directories
app.use((req, res, next) => {
  const path = req.path.toLowerCase();
  const originalPath = req.path;
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  
  // Attack pattern detection (Cisco ASA exploits, etc.)
  const attackPatterns = [
    /\+csco[le]\+/i,  // Cisco ASA exploits (+CSCOL+, +CSCOE+)
    /\+cscol\+/i,     // Cisco ASA exploit (+CSCOL+)
    /\+cscoe\+/i,     // Cisco ASA exploit (+CSCOE+)
    /\+cscot\+/i,     // Cisco ASA exploit (+CSCOT+)
    /\+cscou\+/i,     // Cisco ASA exploit (+CSCOU+)
    /\.\./,           // Path traversal attempts
    /%2e%2e/,         // URL-encoded path traversal
    /\.\.%2f/,        // URL-encoded path traversal
    /\/etc\/passwd/i, // System file access attempts
    /\/proc\/self/i,  // System file access attempts
    /\/boot\.ini/i,   // Windows system file
    /\/win\.ini/i,    // Windows system file
    /\/web\.config/i, // ASP.NET config
    /\/phpmyadmin/i,  // phpMyAdmin access
    /\/adminer/i,     // Adminer access
    /\/wp-login/i,    // WordPress login
    /\/xmlrpc\.php/i, // WordPress XML-RPC
  ];
  
  // Check for attack patterns
  const hasAttackPattern = attackPatterns.some(pattern => pattern.test(originalPath));
  
  // List of sensitive paths to block
  const sensitivePaths = [
    '/.git',
    '/.env',
    '/.env.local',
    '/.env.production',
    '/.env.development',
    '/package.json',
    '/package-lock.json',
    '/yarn.lock',
    '/composer.json',
    '/composer.lock',
    '/.htaccess',
    '/.htpasswd',
    '/web.config',
    '/.ssh',
    '/.docker',
    '/docker-compose.yml',
    '/.gitignore',
    '/.gitattributes',
    '/.git/config',
    '/.git/HEAD',
    '/.git/logs',
    '/.git/objects',
    '/.git/refs',
    '/.git/index',
    '/.git/hooks',
    '/.git/info',
    '/.git/description',
    '/.npmrc',
    '/.yarnrc',
    '/.vscode',
    '/.idea',
    '/node_modules',
    '/.DS_Store',
    '/Thumbs.db',
    '/backup',
    '/backups',
    '/config',
    '/logs',
    '/secure',
    '/private',
    '/admin/config',
    '/wp-admin',
    '/wp-config.php',
    '/phpinfo.php',
    '/.php',
    '/server-status',
    '/server-info',
    // Cisco ASA exploit paths
    '/+cscol+',
    '/+cscoe+',
    '/+cscot+',
    '/+cscou+',
  ];
  
  // Check if the path matches any sensitive path
  const isSensitive = sensitivePaths.some(sensitivePath => 
    path === sensitivePath || path.startsWith(sensitivePath + '/')
  );
  
  // Also check for common file extensions that shouldn't be accessed
  const sensitiveExtensions = ['.env', '.git', '.log', '.sql', '.bak', '.backup', '.old', '.tmp', '.swp', '.swo', '.jar'];
  const hasSensitiveExtension = sensitiveExtensions.some(ext => path.endsWith(ext));
  
  if (isSensitive || hasSensitiveExtension || hasAttackPattern) {
    // Track failed requests for rate limiting
    const now = Date.now();
    const tracker = failedRequestTracker.get(clientIP) || { count: 0, firstAttempt: now, lastAttempt: now };
    tracker.count++;
    tracker.lastAttempt = now;
    failedRequestTracker.set(clientIP, tracker);
    
    // Log the attempt for security monitoring
    const attackType = hasAttackPattern ? 'ATTACK_PATTERN' : isSensitive ? 'SENSITIVE_PATH' : 'SENSITIVE_EXTENSION';
    console.warn(`🚫 [${attackType}] Blocked access attempt to: ${originalPath} from IP: ${clientIP} (Attempt #${tracker.count})`);
    
    // If too many failed attempts from same IP, return 429 (Too Many Requests)
    if (tracker.count > 10) {
      console.error(`⚠️  IP ${clientIP} has made ${tracker.count} blocked requests - potential attacker`);
      return res.status(429).json({ 
        success: false, 
        error: 'Too Many Requests' 
      });
    }
    
    // Return 404 to not reveal that the path exists
    return res.status(404).json({ 
      success: false, 
      error: 'Not Found' 
    });
  }
  
  // Clean up old tracker entries (older than 1 hour)
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [ip, tracker] of failedRequestTracker.entries()) {
    if (tracker.lastAttempt < oneHourAgo) {
      failedRequestTracker.delete(ip);
    }
  }
  
  next();
});

// Raw Body Parser for Webhook Routes
app.use('/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  req.rawBody = req.body.toString('utf8');
  next();
});

// JSON Body Parser for Other Routes - INCREASED TO 50MB FOR IMAGE UPLOADS
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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

// Regular user authentication middleware
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

// Admin authentication middleware
const authenticateAdminToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  
  if (!token) {
    return res.status(401).json({ 
      success: false, 
      error: "Unauthorized: No admin token provided." 
    });
  }
  
  jwt.verify(token, process.env.ADMIN_JWT_SECRET, (err, admin) => {
    if (err) {
      return res.status(403).json({ 
        success: false, 
        error: "Forbidden: Invalid admin token." 
      });
    }
    
    req.admin = admin;
    next();
  });
};

// Role-specific middlewares
const requireSuperAdmin = (req, res, next) => {
  if (req.admin.adminRole !== 'super_admin') {
    return res.status(403).json({ 
      success: false, 
      error: "Super admin access required." 
    });
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (!['admin', 'super_admin'].includes(req.admin.adminRole)) {
    return res.status(403).json({ 
      success: false, 
      error: "Admin access required." 
    });
  }
  next();
};

const requireModerator = (req, res, next) => {
  if (!['moderator', 'admin', 'super_admin'].includes(req.admin.adminRole)) {
    return res.status(403).json({ 
      success: false, 
      error: "Moderator access required." 
    });
  }
  next();
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
const DebugRoutes = require('./routes/debug');
const Pushnotification = require('./adminRoutes/pushnotification');
const AdminKYCRoutes = require('./adminRoutes/kyc');
const collectionRoutes = require('./routes/collections');
const adminsigninRoutes = require("./adminRoutes/adminsign-in");
const adminRegisterRoutes = require("./adminRoutes/registeradmin");
const usermanagementRoutes = require("./adminRoutes/usermanagement");
const analyticsRoutes = require("./adminRoutes/analytics");
const resendOtpRoutes = require("./routes/resendOtp");
const Admin2FARoutes = require("./adminRoutes/Admin2FA");
const scheduledNotificationRoutes = require("./adminRoutes/scheduledNotifications");

// Public Routes
app.use("/signin", signinRoutes);
app.use("/signup", signupRoutes);
app.use('/auth', refreshtokenRoutes);
app.use("/verify-otp", verifyotpRoutes);
app.use("/passwordpin", passwordpinRoutes);
app.use("/usernamecheck", usernamecheckRoutes);
app.use("/naira", nairaAccountsRoutes);
app.use("/accountname", AccountnameRoutes);
app.use("/adminsignin", adminsigninRoutes);
app.use("/admin-2fa", Admin2FARoutes); // Admin 2FA setup routes (public)

// Webhook Routes
app.use("/webhook", webhookLimiter, webhookRoutes);
app.use("/billwebhook", webhookLimiter, billwebhookRoutes);
app.use("/kyc-webhook", webhookLimiter, kycwebhookRoutes);

// SUPER ADMIN ONLY ROUTES (highest permissions)
app.use("/deleteuser", authenticateAdminToken, requireSuperAdmin, deleteuserRoutes);
app.use("/fund", authenticateAdminToken, requireSuperAdmin, FunduserRoutes);
app.use("/delete-pin", authenticateAdminToken, requireSuperAdmin, deletepinRoutes);
app.use("/admin", authenticateAdminToken, requireSuperAdmin, adminRegisterRoutes);

// ADMIN LEVEL ROUTES (admin + super_admin)
app.use("/set-fee", authenticateAdminToken, requireAdmin, SetfeeRoutes);
app.use("/updateuseraddress", authenticateAdminToken, requireAdmin, updateuseraddressRoutes);
app.use("/marker", authenticateAdminToken, requireAdmin, pricemarkdownRoutes);
app.use('/admingiftcard', authenticateAdminToken, requireAdmin, admingiftcardRoutes);
// Public notification registration for users
app.use('/notification', Pushnotification);
// Admin notification management (requires auth)
app.use('/admin/notification', authenticateAdminToken, requireAdmin, Pushnotification);
app.use('/admin/scheduled-notifications', authenticateAdminToken, requireAdmin, scheduledNotificationRoutes);

// MODERATOR LEVEL ROUTES (all admin roles can access)
app.use("/fetch-wallet", authenticateAdminToken, requireModerator, fetchwalletRoutes);
app.use("/fetch", authenticateAdminToken, requireModerator, fetchtransactionRoutes);
app.use("/pending", authenticateAdminToken, requireModerator, clearpendingRoutes);
app.use("/fetching", authenticateAdminToken, requireModerator, fetchrefreshtoken);
app.use("/2FA-Disable", authenticateAdminToken, requireModerator, TwooFARoutes);
app.use('/admin-kyc', authenticateAdminToken, requireModerator, AdminKYCRoutes);
app.use("/usermanagement", authenticateAdminToken, requireModerator, usermanagementRoutes);
app.use("/analytics", authenticateAdminToken, requireModerator, analyticsRoutes);

// Public Data Routes
app.use("/naira-price", nairaPriceRouter);
app.use("/onramp", onrampRoutes);
app.use("/offramp", offrampRoutes);

// Protected User Routes
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
app.use("/debug", DebugRoutes);
app.use("/verifycabletv", authenticateToken, CableTVRoutes);
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
app.use("/collection", authenticateToken, collectionRoutes);
app.use("/signup", resendOtpRoutes);

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
      console.log('📦 Body parser limit: 50MB (for KYC image uploads)');
      console.log('⏰ Crypto price update job scheduled every 15 minutes');
      console.log('🔐 Admin authentication enabled with role-based access control');
      
      // Start scheduled notifications
      scheduledNotificationService.start();
      console.log('📱 Scheduled price notifications started (6am, 12pm, 6pm, 9pm)');
      
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