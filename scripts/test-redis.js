#!/usr/bin/env node
/**
 * Redis Connection Test Script
 * Tests Redis connectivity and basic operations
 */

require('dotenv').config();
const Redis = require('ioredis');

console.log('🔍 Testing Redis Connection...\n');

const redis = new Redis({
  host: '127.0.0.1',
  port: 6379,
  password: process.env.REDIS_PASSWORD,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3
});

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

redis.on('connect', () => {
  console.log('✅ Connected to Redis server');
});

redis.on('ready', () => {
  console.log('✅ Redis client ready\n');
});

redis.on('error', (err) => {
  console.error('❌ Redis connection error:', err.message);
  process.exit(1);
});

async function runTest(name, testFn) {
  testsRun++;
  try {
    await testFn();
    testsPassed++;
    console.log(`✅ ${name}`);
    return true;
  } catch (error) {
    testsFailed++;
    console.error(`❌ ${name}: ${error.message}`);
    return false;
  }
}

(async () => {
  try {
    console.log('Running Redis tests...\n');

    // Test 1: PING
    await runTest('PING command', async () => {
      const result = await redis.ping();
      if (result !== 'PONG') throw new Error('Expected PONG');
    });

    // Test 2: SET
    await runTest('SET command', async () => {
      const result = await redis.set('zeusodx:test:key', 'test_value');
      if (result !== 'OK') throw new Error('SET failed');
    });

    // Test 3: GET
    await runTest('GET command', async () => {
      const result = await redis.get('zeusodx:test:key');
      if (result !== 'test_value') throw new Error('Value mismatch');
    });

    // Test 4: INCR
    await runTest('INCR command', async () => {
      await redis.set('zeusodx:test:counter', '0');
      const result = await redis.incr('zeusodx:test:counter');
      if (result !== 1) throw new Error('INCR failed');
    });

    // Test 5: EXPIRE
    await runTest('EXPIRE command', async () => {
      await redis.set('zeusodx:test:expire', 'value');
      const result = await redis.expire('zeusodx:test:expire', 60);
      if (result !== 1) throw new Error('EXPIRE failed');
    });

    // Test 6: TTL
    await runTest('TTL command', async () => {
      const ttl = await redis.ttl('zeusodx:test:expire');
      if (ttl <= 0 || ttl > 60) throw new Error('TTL incorrect');
    });

    // Test 7: DEL
    await runTest('DEL command', async () => {
      const result = await redis.del('zeusodx:test:key');
      if (result !== 1) throw new Error('DEL failed');
    });

    // Test 8: EXISTS
    await runTest('EXISTS command', async () => {
      await redis.set('zeusodx:test:exists', 'value');
      const exists = await redis.exists('zeusodx:test:exists');
      if (exists !== 1) throw new Error('EXISTS failed');
    });

    // Test 9: HSET/HGET (Hash operations)
    await runTest('HASH operations', async () => {
      await redis.hset('zeusodx:test:hash', 'field1', 'value1');
      const value = await redis.hget('zeusodx:test:hash', 'field1');
      if (value !== 'value1') throw new Error('HASH operations failed');
    });

    // Test 10: Multiple operations (pipeline)
    await runTest('Pipeline operations', async () => {
      const pipeline = redis.pipeline();
      pipeline.set('zeusodx:test:pipe1', 'value1');
      pipeline.set('zeusodx:test:pipe2', 'value2');
      pipeline.get('zeusodx:test:pipe1');
      const results = await pipeline.exec();
      if (results.length !== 3) throw new Error('Pipeline failed');
    });

    // Cleanup
    await redis.del(
      'zeusodx:test:counter',
      'zeusodx:test:expire',
      'zeusodx:test:exists',
      'zeusodx:test:hash',
      'zeusodx:test:pipe1',
      'zeusodx:test:pipe2'
    );

    console.log('\n================================================');
    console.log('📊 Test Results:');
    console.log(`   Total Tests: ${testsRun}`);
    console.log(`   Passed: ${testsPassed}`);
    console.log(`   Failed: ${testsFailed}`);
    console.log('================================================\n');

    if (testsFailed === 0) {
      console.log('✅ All Redis tests passed successfully!');
      console.log('\n🎉 Redis is ready for production use\n');

      // Show Redis info
      const info = await redis.info('server');
      const versionMatch = info.match(/redis_version:(\S+)/);
      if (versionMatch) {
        console.log(`📌 Redis Version: ${versionMatch[1]}`);
      }

      const memInfo = await redis.info('memory');
      const memMatch = memInfo.match(/used_memory_human:(\S+)/);
      if (memMatch) {
        console.log(`💾 Memory Used: ${memMatch[1]}\n`);
      }

      process.exit(0);
    } else {
      console.error('❌ Some tests failed. Please check Redis configuration.');
      process.exit(1);
    }

  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  } finally {
    await redis.quit();
  }
})();
