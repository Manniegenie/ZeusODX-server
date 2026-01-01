#!/usr/bin/env node
/**
 * KYC Setup Verification Script
 * Run this to check if your Youverify integration is configured correctly
 *
 * Usage: node scripts/verify-kyc-setup.js
 */

require('dotenv').config();
const axios = require('axios');

const REQUIRED_ENV_VARS = [
  'YOUVERIFY_PUBLIC_MERCHANT_KEY',
  'YOUVERIFY_WEBHOOK_SIGNING_KEY',
  'YOUVERIFY_CALLBACK_URL'
];

const OPTIONAL_ENV_VARS = [
  'YOUVERIFY_SECRET_KEY' // Optional, only needed for advanced API operations
];

console.log('🔍 ZeusODX KYC Setup Verification\n');
console.log('=' .repeat(50));

// Check 1: Environment Variables
console.log('\n✓ Checking environment variables...\n');
let missingVars = [];

REQUIRED_ENV_VARS.forEach(varName => {
  const value = process.env[varName];
  if (!value) {
    console.log(`  ❌ ${varName}: NOT SET`);
    missingVars.push(varName);
  } else if (value.includes('your_') || value.includes('change_this')) {
    console.log(`  ⚠️  ${varName}: SET but looks like placeholder`);
    missingVars.push(varName);
  } else {
    const maskedValue = value.substring(0, 10) + '...' + value.substring(value.length - 4);
    console.log(`  ✅ ${varName}: ${maskedValue}`);
  }
});

if (missingVars.length > 0) {
  console.log('\n❌ Missing or invalid environment variables:');
  missingVars.forEach(v => console.log(`   - ${v}`));
  console.log('\n📝 Please update your .env file with actual Youverify credentials');
  console.log('   Get them from: https://youverify.co/dashboard');
  process.exit(1);
}

// Check 2: Config Loading
console.log('\n✓ Checking configuration loading...\n');
try {
  const config = require('../routes/config');

  if (config.youverify) {
    console.log('  ✅ Youverify config loaded from config.js');
    console.log(`     - API Base URL: ${config.youverify.apiBaseUrl || 'Not set'}`);
    console.log(`     - Callback URL: ${config.youverify.callbackUrl || 'Not set'}`);
  } else {
    console.log('  ❌ Youverify config not found in config.js');
  }
} catch (error) {
  console.log(`  ❌ Error loading config: ${error.message}`);
}

// Check 3: Webhook URL Accessibility
console.log('\n✓ Checking webhook URL...\n');
const callbackUrl = process.env.YOUVERIFY_CALLBACK_URL;

if (callbackUrl.includes('localhost') || callbackUrl.includes('127.0.0.1')) {
  console.log('  ⚠️  Callback URL is localhost - this will NOT work in production');
  console.log('     For local testing, use ngrok: https://ngrok.com');
} else if (callbackUrl.includes('ngrok')) {
  console.log('  ✅ Using ngrok URL - Good for local testing');
  console.log('  ⚠️  Remember to update webhook URL in Youverify dashboard when ngrok URL changes');
} else if (callbackUrl.includes('your-domain')) {
  console.log('  ❌ Callback URL is still placeholder - update with your actual domain');
} else {
  console.log(`  ✅ Callback URL looks valid: ${callbackUrl}`);
}

// Check 4: Test Youverify API Connection
console.log('\n✓ Testing Youverify API connection...\n');

async function testYouverifyConnection() {
  try {
    // Test endpoint - get account info
    const response = await axios.get('https://api.youverify.co/v2/account', {
      headers: {
        'Token': process.env.YOUVERIFY_PUBLIC_MERCHANT_KEY
      },
      timeout: 10000
    });

    console.log('  ✅ Successfully connected to Youverify API');
    console.log(`     Status: ${response.status}`);
    if (response.data?.data?.business) {
      console.log(`     Business: ${response.data.data.business.name || 'N/A'}`);
    }
    return true;
  } catch (error) {
    if (error.response) {
      console.log(`  ❌ Youverify API error: ${error.response.status}`);
      console.log(`     Message: ${error.response.data?.message || 'Unknown error'}`);

      if (error.response.status === 401) {
        console.log('\n  💡 This usually means your YOUVERIFY_PUBLIC_MERCHANT_KEY is invalid');
        console.log('     - Check that you copied it correctly from Youverify dashboard');
        console.log('     - Make sure there are no extra spaces');
      }
    } else if (error.code === 'ECONNREFUSED') {
      console.log('  ❌ Cannot connect to Youverify API');
      console.log('     - Check your internet connection');
    } else {
      console.log(`  ❌ Error: ${error.message}`);
    }
    return false;
  }
}

// Run async checks
(async () => {
  const apiConnected = await testYouverifyConnection();

  // Final Summary
  console.log('\n' + '='.repeat(50));
  console.log('\n📊 Setup Summary:\n');

  if (missingVars.length === 0 && apiConnected) {
    console.log('✅ All checks passed! Your KYC integration appears to be configured correctly.\n');
    console.log('Next steps:');
    console.log('  1. Register webhook URL in Youverify dashboard');
    console.log('     URL: ' + callbackUrl);
    console.log('  2. Restart your server');
    console.log('  3. Test with a real KYC submission');
    console.log('  4. Check logs: tail -f logs/combined.log\n');
  } else {
    console.log('❌ Setup incomplete. Please fix the issues above.\n');
    console.log('Setup guide: See KYC_SETUP_GUIDE.md\n');
  }

  console.log('='.repeat(50) + '\n');
})();
