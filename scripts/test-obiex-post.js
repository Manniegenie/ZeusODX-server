#!/usr/bin/env node
/**
 * Test script to diagnose Cloudflare blocking issue with Obiex API POST requests
 * Run this on your Contabo VPS: node scripts/test-obiex-post.js
 */

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const OBIEX_BASE_URL = process.env.OBIEX_BASE_URL || 'https://api.obiex.finance';
const OBIEX_API_KEY = process.env.OBIEX_API_KEY;
const OBIEX_API_SECRET = process.env.OBIEX_API_SECRET;

function signRequest(method, url) {
  const timestamp = Date.now();
  const path = url.startsWith('/') ? url : `/${url}`;
  const content = `${method.toUpperCase()}/v1${path}${timestamp}`;
  const signature = crypto
    .createHmac('sha256', OBIEX_API_SECRET)
    .update(content)
    .digest('hex');
  return { timestamp, signature };
}

async function test1_curlLikePost() {
  console.log('\n📋 Test 1: POST with curl-like headers (minimal)');
  console.log('─────────────────────────────────────────────────');
  
  const path = '/v1/addresses/broker';
  const { timestamp, signature } = signRequest('POST', path);
  const payload = {
    purpose: 'test-diagnosis',
    currency: 'BTC',
    network: 'BTC'
  };

  try {
    const response = await axios.post(`${OBIEX_BASE_URL}${path}`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': OBIEX_API_KEY,
        'x-api-timestamp': timestamp,
        'x-api-signature': signature,
      },
      timeout: 10000,
      validateStatus: () => true, // Don't throw on any status
    });

    console.log(`Status: ${response.status}`);
    if (response.status === 403 || (typeof response.data === 'string' && response.data.includes('Just a moment'))) {
      console.log('❌ BLOCKED by Cloudflare');
      console.log('Response snippet:', response.data?.substring?.(0, 200) || response.data);
    } else {
      console.log('✅ SUCCESS');
      console.log('Response:', JSON.stringify(response.data).substring(0, 200));
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    if (error.response) {
      console.log(`Status: ${error.response.status}`);
      console.log('Response:', error.response.data?.substring?.(0, 200) || error.response.data);
    }
  }
}

async function test2_browserLikePost() {
  console.log('\n📋 Test 2: POST with browser-like headers');
  console.log('─────────────────────────────────────────────────');
  
  const path = '/v1/addresses/broker';
  const { timestamp, signature } = signRequest('POST', path);
  const payload = {
    purpose: 'test-diagnosis',
    currency: 'BTC',
    network: 'BTC'
  };

  try {
    const response = await axios.post(`${OBIEX_BASE_URL}${path}`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': OBIEX_BASE_URL,
        'Referer': `${OBIEX_BASE_URL}/`,
        'x-api-key': OBIEX_API_KEY,
        'x-api-timestamp': timestamp,
        'x-api-signature': signature,
      },
      timeout: 10000,
      validateStatus: () => true,
    });

    console.log(`Status: ${response.status}`);
    if (response.status === 403 || (typeof response.data === 'string' && response.data.includes('Just a moment'))) {
      console.log('❌ BLOCKED by Cloudflare');
      console.log('Response snippet:', response.data?.substring?.(0, 200) || response.data);
    } else {
      console.log('✅ SUCCESS');
      console.log('Response:', JSON.stringify(response.data).substring(0, 200));
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    if (error.response) {
      console.log(`Status: ${error.response.status}`);
      console.log('Response:', error.response.data?.substring?.(0, 200) || error.response.data);
    }
  }
}

async function test3_http2Check() {
  console.log('\n📋 Test 3: Check if HTTP/2 is supported');
  console.log('─────────────────────────────────────────────────');
  
  try {
    const response = await axios.get(`${OBIEX_BASE_URL}/v1/currencies`, {
      headers: {
        'Accept': 'application/json',
      },
      timeout: 5000,
    });
    console.log(`✅ GET request works (Status: ${response.status})`);
    console.log(`HTTP Version: ${response.request.res?.httpVersion || 'unknown'}`);
    console.log(`Protocol: ${response.request.res?.socket?.alpnProtocol || 'unknown'}`);
  } catch (error) {
    console.log(`❌ GET request failed: ${error.message}`);
  }
}

async function test4_nodeVersion() {
  console.log('\n📋 Test 4: Node.js and System Info');
  console.log('─────────────────────────────────────────────────');
  console.log(`Node.js version: ${process.version}`);
  console.log(`Platform: ${process.platform}`);
  console.log(`Arch: ${process.arch}`);
  
  // Check IP
  try {
    const https = require('https');
    const { promisify } = require('util');
    const get = promisify(https.get);
    
    await new Promise((resolve) => {
      https.get('https://api.ipify.org', (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          console.log(`Public IP: ${data.trim()}`);
          resolve();
        });
      }).on('error', () => {
        console.log('Public IP: Could not determine');
        resolve();
      });
    });
  } catch (e) {
    console.log('Public IP: Could not determine');
  }
}

async function test5_axiosConfig() {
  console.log('\n📋 Test 5: Axios default configuration');
  console.log('─────────────────────────────────────────────────');
  console.log('Axios version:', require('axios/package.json').version);
  
  const path = '/v1/addresses/broker';
  const { timestamp, signature } = signRequest('POST', path);
  const payload = {
    purpose: 'test-diagnosis',
    currency: 'BTC',
    network: 'BTC'
  };

  // Create custom HTTPS agent with specific TLS options
  const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: 50,
    maxFreeSockets: 10,
  });

  try {
    const response = await axios.post(`${OBIEX_BASE_URL}${path}`, payload, {
      httpsAgent: httpsAgent,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'x-api-key': OBIEX_API_KEY,
        'x-api-timestamp': timestamp,
        'x-api-signature': signature,
      },
      timeout: 10000,
      validateStatus: () => true,
    });

    console.log(`Status: ${response.status}`);
    if (response.status === 403 || (typeof response.data === 'string' && response.data.includes('Just a moment'))) {
      console.log('❌ BLOCKED by Cloudflare (even with custom HTTPS agent)');
    } else {
      console.log('✅ SUCCESS with custom HTTPS agent');
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
  }
}

async function main() {
  if (!OBIEX_API_KEY || !OBIEX_API_SECRET) {
    console.error('❌ Missing OBIEX_API_KEY or OBIEX_API_SECRET in .env file');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('   Obiex API POST Request Diagnostic Test');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Base URL: ${OBIEX_BASE_URL}`);
  console.log(`API Key: ${OBIEX_API_KEY.substring(0, 8)}...`);

  await test4_nodeVersion();
  await test3_http2Check();
  await test1_curlLikePost();
  await test2_browserLikePost();
  await test5_axiosConfig();

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('   Diagnostic Complete');
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(console.error);


