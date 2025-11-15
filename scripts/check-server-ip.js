#!/usr/bin/env node
/**
 * Script to check your server's public IP address
 * This is the IP you need to whitelist with Obiex
 */

const https = require('https');
const http = require('http');

async function getPublicIP() {
  const services = [
    'https://api.ipify.org',
    'https://ifconfig.me',
    'https://icanhazip.com',
    'https://checkip.amazonaws.com',
  ];

  console.log('🔍 Checking your server\'s public IP address...\n');

  for (const service of services) {
    try {
      const ip = await fetch(service).then(res => res.text());
      const cleanIP = ip.trim();
      console.log(`✅ IP Address: ${cleanIP}`);
      console.log(`   (via ${service})\n`);
      return cleanIP;
    } catch (error) {
      console.log(`❌ Failed to get IP from ${service}`);
    }
  }

  throw new Error('Could not determine public IP address');
}

async function checkOutboundConnections() {
  console.log('📡 Testing outbound connection to Obiex API...\n');
  
  const obiexURL = process.env.OBIEX_BASE_URL || 'https://api.obiex.finance';
  
  try {
    // Make a test request to see what IP Obiex sees
    const response = await fetch(`${obiexURL}/v1/currencies`, {
      method: 'GET',
      headers: {
        'User-Agent': 'ZeusODX-Server-IP-Check',
      },
    });
    
    console.log(`✅ Connection successful`);
    console.log(`   Status: ${response.status}`);
    console.log(`   Obiex API: ${obiexURL}\n`);
  } catch (error) {
    if (error.message.includes('403') || error.message.includes('Just a moment')) {
      console.log(`❌ Connection blocked by Cloudflare (403)`);
      console.log(`   This confirms your IP needs to be whitelisted\n`);
    } else {
      console.log(`⚠️  Connection test failed: ${error.message}\n`);
    }
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('   Contabo VPS IP Check for Obiex Whitelisting');
  console.log('═══════════════════════════════════════════════════════\n');

  try {
    const ip = await getPublicIP();
    
    console.log('📋 INFORMATION FOR OBIEX SUPPORT:');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`IP Address to Whitelist: ${ip}`);
    console.log(`Server Provider: Contabo VPS`);
    console.log(`Purpose: API access for wallet address generation`);
    console.log('═══════════════════════════════════════════════════════\n');

    await checkOutboundConnections();

    console.log('📧 Next Steps:');
    console.log('1. Email Obiex support at: support@obiex.finance');
    console.log('2. Include your IP address:', ip);
    console.log('3. Request IP whitelisting for API access');
    console.log('4. Include your API key (last 4 chars) for verification\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Use node-fetch if available, otherwise fallback
let fetch;
try {
  fetch = require('node-fetch');
} catch (e) {
  // Node 18+ has fetch built-in
  if (typeof globalThis.fetch === 'undefined') {
    console.error('❌ Please install node-fetch: npm install node-fetch');
    process.exit(1);
  }
  fetch = globalThis.fetch;
}

main();




