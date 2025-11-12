/**
 * Script to create a demo account for Google Play review
 * 
 * Usage: node scripts/createDemoAccount.js
 * 
 * This creates a pre-configured demo account that:
 * - Bypasses OTP verification
 * - Has 2FA disabled
 * - Never gets locked
 * - Has test balance
 * - Works from any location
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
require('dotenv').config();

const DEMO_ACCOUNT = {
  phonenumber: '+2348000000001',
  email: 'demo@zeusodx.com',
  username: 'demo_user',
  passwordpin: '123456', // Will be hashed
  kycLevel: 1,
  isVerified: true,
  twoFactorEnabled: false,
  isDemoAccount: true,
  phoneVerified: true,
  emailVerified: true,
  skipOTP: true,
  isActive: true,
  lockUntil: null,
  loginAttempts: 0,
  // Balances (using correct field names from User model)
  ngnzBalance: 10000,      // ₦10,000 NGN
  usdtBalance: 10,         // $10 USDT
  usdcBalance: 10,         // $10 USDC
  btcBalance: 0.001,       // 0.001 BTC
  ethBalance: 0.01,        // 0.01 ETH
  bnbBalance: 0.1,         // 0.1 BNB
  solBalance: 1,            // 1 SOL
  maticBalance: 10,         // 10 MATIC
  trxBalance: 100,          // 100 TRX
};

async function createDemoAccount() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI not found in environment variables');
    }

    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Check if demo account already exists
    const existing = await User.findOne({ 
      $or: [
        { phonenumber: DEMO_ACCOUNT.phonenumber },
        { email: DEMO_ACCOUNT.email }
      ]
    });

    if (existing) {
      console.log('⚠️  Demo account already exists. Updating...');
      
      // Hash PIN
      const salt = await bcrypt.genSalt(10);
      const hashedPin = await bcrypt.hash(DEMO_ACCOUNT.passwordpin, salt);
      
      // Update existing account
      existing.passwordpin = hashedPin;
      existing.email = DEMO_ACCOUNT.email;
      existing.username = DEMO_ACCOUNT.username;
      existing.kycLevel = DEMO_ACCOUNT.kycLevel;
      existing.isVerified = DEMO_ACCOUNT.isVerified;
      existing.twoFactorEnabled = false;
      existing.isDemoAccount = true;
      existing.phoneVerified = true;
      existing.emailVerified = true;
      existing.skipOTP = true;
      existing.isActive = true;
      existing.lockUntil = null;
      existing.loginAttempts = 0;
      // Update balances
      existing.ngnzBalance = DEMO_ACCOUNT.ngnzBalance;
      existing.usdtBalance = DEMO_ACCOUNT.usdtBalance;
      existing.usdcBalance = DEMO_ACCOUNT.usdcBalance;
      existing.btcBalance = DEMO_ACCOUNT.btcBalance;
      existing.ethBalance = DEMO_ACCOUNT.ethBalance;
      existing.bnbBalance = DEMO_ACCOUNT.bnbBalance;
      existing.solBalance = DEMO_ACCOUNT.solBalance;
      existing.maticBalance = DEMO_ACCOUNT.maticBalance;
      existing.trxBalance = DEMO_ACCOUNT.trxBalance;
      existing.updatedAt = new Date();
      
      await existing.save();
      console.log('✅ Demo account updated successfully');
    } else {
      // Hash PIN
      const salt = await bcrypt.genSalt(10);
      const hashedPin = await bcrypt.hash(DEMO_ACCOUNT.passwordpin, salt);
      
      // Create new account
      const demoUser = new User({
        ...DEMO_ACCOUNT,
        passwordpin: hashedPin,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      
      await demoUser.save();
      console.log('✅ Demo account created successfully');
    }

    // Verify the account
    const created = await User.findOne({ phonenumber: DEMO_ACCOUNT.phonenumber });
    console.log('\n📋 Demo Account Details:');
    console.log('─────────────────────────────────────────');
    console.log(`Phone: ${created.phonenumber}`);
    console.log(`Email: ${created.email}`);
    console.log(`Username: ${created.username}`);
    console.log(`PIN: ${DEMO_ACCOUNT.passwordpin} (hashed in database)`);
    console.log(`KYC Level: ${created.kycLevel}`);
    console.log(`2FA Enabled: ${created.twoFactorEnabled}`);
    console.log(`Is Demo Account: ${created.isDemoAccount}`);
    console.log(`Balance NGN: ₦${created.ngnzBalance || 0}`);
    console.log(`Balance USDT: $${created.usdtBalance || 0}`);
    console.log(`Balance USDC: $${created.usdcBalance || 0}`);
    console.log(`Balance BTC: ${created.btcBalance || 0}`);
    console.log(`Balance ETH: ${created.ethBalance || 0}`);
    console.log('─────────────────────────────────────────\n');

    console.log('✅ Demo account is ready for Google Play review!');
    console.log('\n📝 Next steps:');
    console.log('1. Test login with phone: +2348000000001 and PIN: 123456');
    console.log('2. Add credentials to Google Play Console');
    console.log('3. Submit app for review');

  } catch (error) {
    console.error('❌ Error creating demo account:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('✅ Database connection closed');
  }
}

// Run the script
if (require.main === module) {
  createDemoAccount();
}

module.exports = { createDemoAccount, DEMO_ACCOUNT };

