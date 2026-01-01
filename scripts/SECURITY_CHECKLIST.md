# 🔒 ZeusODX Security Improvement Checklist

**Generated:** 2026-01-01
**Last Updated:** 2026-01-01
**Status:** In Progress

---

## 📋 CRITICAL PRIORITY (Fix Immediately - Week 1)

### ✅ = Completed | 🔄 = In Progress | ⏳ = Pending | ⚠️ = Blocked

---

### 🚨 **1. Race Condition in Balance Deduction**
**Status:** ⏳ Pending
**Severity:** CRITICAL (10/10)
**File:** `routes/withdraw.js:226-231`, `routes/NGNZWithdrawal.js:132-138`

**Vulnerability:**
- Multiple simultaneous withdrawals can bypass balance checks
- Window: <50ms between balance check and deduction
- Impact: User can withdraw 100x their actual balance

**Implementation Requirements:**
- [ ] Install Redis client: `npm install redis ioredis`
- [ ] Create distributed lock utility: `utils/redisLock.js`
- [ ] Update `reserveUserBalanceInternal()` to use atomic operations
- [ ] Add `withdrawalInProgress` flag to User model
- [ ] Test with concurrent requests (100 simultaneous)

**Code Location:** `routes/withdraw.js:226-231`

**Estimated Time:** 4-6 hours
**Dependencies:** Redis server running
**Testing Required:** Load testing with concurrent requests

---

### 🚨 **2. Missing 2FA Brute Force Protection**
**Status:** ⏳ Pending
**Severity:** CRITICAL (10/10)
**File:** `routes/withdraw.js:197-198`, `routes/NGNZWithdrawal.js:271-273`

**Vulnerability:**
- No rate limiting on 2FA attempts
- 6-digit code = 1,000,000 combinations
- No exponential backoff
- Replay attacks possible within 30-second window

**Implementation Requirements:**
- [ ] Add 2FA attempt counter using Redis
- [ ] Implement exponential backoff (3 attempts → 5 min, 5 attempts → 1 hour, etc.)
- [ ] Add 2FA code replay prevention (track used codes)
- [ ] Enforce 2FA enabled check before withdrawal
- [ ] Add time-window validation (current window only)
- [ ] Send security alerts on 3+ failed attempts

**Code Location:** `services/twofactorAuth.js`

**Estimated Time:** 3-4 hours
**Dependencies:** Redis, Email service
**Testing Required:** Brute force simulation

---

### 🚨 **3. PIN Brute Force Vulnerability**
**Status:** ⏳ Pending
**Severity:** CRITICAL (8/10)
**File:** `routes/withdraw.js:200`, `routes/NGNZWithdrawal.js:275-276`

**Vulnerability:**
- No rate limiting on PIN attempts
- 6-digit PIN = 1,000,000 combinations
- No account lockout after failed attempts
- Can be brute forced in minutes

**Implementation Requirements:**
- [ ] Add PIN attempt counter using Redis
- [ ] Lock account after 5 failed attempts (24 hours)
- [ ] Add `accountLocked`, `lockedUntil`, `lockedReason` fields to User model
- [ ] Send email alert when account is locked
- [ ] Create admin endpoint to unlock accounts
- [ ] Show remaining attempts to user

**Code Location:** `routes/withdraw.js:200`, `routes/NGNZWithdrawal.js:275`

**Estimated Time:** 3-4 hours
**Dependencies:** Redis, Email service
**Testing Required:** Failed attempt simulation

---

### 🚨 **4. Cryptocurrency Address Validation Bypass**
**Status:** ⏳ Pending
**Severity:** CRITICAL (9/10)
**File:** `routes/withdraw.js:156-161`

**Vulnerability:**
- Regex validation only (format, not checksum)
- No blacklist for known scam addresses
- Homoglyph attacks possible (0 vs O, 1 vs l)
- No address ownership verification

**Implementation Requirements:**
- [ ] Install validation libraries: `npm install bs58check bitcoin-address-validation`
- [ ] Implement checksum validation per blockchain:
  - [ ] Bitcoin (BTC) - Base58Check
  - [ ] Ethereum (ETH) - EIP-55 checksum
  - [ ] Solana (SOL) - Base58 validation
  - [ ] USDT/USDC - Network-specific
- [ ] Create `AddressBlacklist` model
- [ ] Create `WhitelistedAddress` model
- [ ] Add address blacklist check before withdrawal
- [ ] Require address whitelisting for amounts > $10,000
- [ ] Send email verification link for whitelisting

**Code Location:** `routes/withdraw.js:138-167`

**Estimated Time:** 6-8 hours
**Dependencies:** Blockchain validation libraries
**Testing Required:** Test invalid checksums, homoglyphs

---

## 📊 HIGH PRIORITY (Week 2)

---

### ⚠️ **5. Missing Withdrawal Velocity Limits**
**Status:** ⏳ Pending
**Severity:** HIGH (9/10)
**File:** All withdrawal endpoints

**Vulnerability:**
- No limit on withdrawals per hour/day
- Can bypass KYC limits by splitting withdrawals
- Example: $499 × 1,000 times = $499,000 (bypassing $500 limit)

**Implementation Requirements:**
- [ ] Create withdrawal velocity checker service
- [ ] Track withdrawals in last 1 hour, 24 hours, 7 days
- [ ] Define limits per KYC tier:
  - Tier 0 (No KYC): 3 withdrawals/day, $100/day
  - Tier 1 (Basic): 10 withdrawals/day, $500/day
  - Tier 2 (Verified): 20 withdrawals/day, $10,000/day
  - Tier 3 (Enhanced): 50 withdrawals/day, $100,000/day
- [ ] Add velocity checks before withdrawal execution
- [ ] Cache velocity data in Redis for performance

**Code Location:** `services/withdrawalVelocityService.js` (new file)

**Estimated Time:** 4-5 hours
**Dependencies:** Redis
**Testing Required:** Split withdrawal attack simulation

---

### ⚠️ **6. Insufficient Security Logging**
**Status:** ⏳ Pending
**Severity:** HIGH (7/10)
**File:** All routes

**Vulnerability:**
- Missing context: IP, user agent, geolocation
- No failed attempt logging
- Difficult to trace security incidents
- No real-time alerting

**Implementation Requirements:**
- [ ] Create enhanced logger middleware
- [ ] Add to all logs:
  - User ID
  - IP address
  - User agent
  - Country (from Cloudflare header or GeoIP)
  - Timestamp (ISO format)
  - Success/failure
  - Reason for failure
- [ ] Create security alert service
- [ ] Define alert triggers:
  - 3+ failed 2FA attempts
  - 5+ failed PIN attempts
  - Withdrawal from new country
  - Large withdrawal (>$10k)
- [ ] Send alerts via email + SMS + Slack

**Code Location:** `utils/securityLogger.js` (new), `services/securityAlertService.js` (new)

**Estimated Time:** 3-4 hours
**Dependencies:** Email, SMS services
**Testing Required:** Alert delivery verification

---

### ⚠️ **7. Transaction Status Manipulation**
**Status:** ⏳ Pending
**Severity:** HIGH (6/10)
**File:** `routes/NGNZWithdrawal.js:221-228`

**Vulnerability:**
- Status set to SUCCESSFUL before bank confirms
- Trusts provider response without webhook verification
- False success notifications to users

**Implementation Requirements:**
- [ ] Change status to 'PROCESSING' after provider accepts
- [ ] Only set 'SUCCESSFUL' after webhook confirmation
- [ ] Add webhook signature verification for Obiex
- [ ] Implement webhook retry mechanism
- [ ] Add timeout for stuck 'PROCESSING' transactions (auto-check after 1 hour)

**Code Location:** `routes/NGNZWithdrawal.js:221-228`, `routes/obiexwebhooktrx.js`

**Estimated Time:** 3-4 hours
**Dependencies:** Webhook signing secret from Obiex
**Testing Required:** Webhook delivery simulation

---

### ⚠️ **8. No Address Whitelisting for Large Withdrawals**
**Status:** ⏳ Pending
**Severity:** HIGH (8/10)
**File:** `routes/withdraw.js`

**Vulnerability:**
- No additional verification for large amounts
- Typo in address = irreversible loss
- No cooling-off period

**Implementation Requirements:**
- [ ] Create `WhitelistedAddress` model:
  - userId
  - address
  - network
  - label (user-friendly name)
  - verified (email confirmation)
  - verificationToken
  - createdAt
- [ ] Require whitelisting for withdrawals > $10,000
- [ ] Send email verification link
- [ ] Add 24-hour cooling-off period before first use
- [ ] Allow user to manage whitelist in settings

**Code Location:** `models/WhitelistedAddress.js` (new), `routes/addressWhitelist.js` (new)

**Estimated Time:** 5-6 hours
**Dependencies:** Email service
**Testing Required:** Email verification flow

---

## 📈 MEDIUM PRIORITY (Week 3)

---

### ⚙️ **9. No Geofencing for High-Risk Countries**
**Status:** ⏳ Pending
**Severity:** MEDIUM (8/10)
**File:** All withdrawal endpoints

**Vulnerability:**
- No country-based restrictions
- Regulatory compliance risk (OFAC, sanctions)
- No VPN/Tor detection

**Implementation Requirements:**
- [ ] Install GeoIP library: `npm install geoip-lite` or use Cloudflare headers
- [ ] Define restricted countries (OFAC list):
  - North Korea (KP)
  - Iran (IR)
  - Syria (SY)
  - Crimea region
  - Cuba (CU) - partial
- [ ] Block withdrawals from restricted countries
- [ ] Detect VPN/proxy usage (check for mismatched timezone)
- [ ] Add "travel mode" for legitimate travel:
  - User can pre-approve withdrawal from specific country
  - Requires email confirmation
- [ ] Store user's last login country
- [ ] Alert on country change

**Code Location:** `middleware/geofencing.js` (new)

**Estimated Time:** 4-5 hours
**Dependencies:** GeoIP database or Cloudflare
**Testing Required:** VPN testing from different countries

---

### ⚙️ **10. Missing Network-Specific Withdrawal Limits**
**Status:** ⏳ Pending
**Severity:** MEDIUM (5/10)
**File:** `routes/withdraw.js`

**Vulnerability:**
- No minimum withdrawal amounts per network
- High-fee networks allow micro-withdrawals
- Fee revenue loss from unprofitable transactions

**Implementation Requirements:**
- [ ] Define minimum/maximum per network:
  ```javascript
  const NETWORK_LIMITS = {
    'BTC-BITCOIN': { min: 0.001, max: 10, maxPerDay: 50 },
    'ETH-ETHEREUM': { min: 0.01, max: 100, maxPerDay: 500 },
    'USDT-TRC20': { min: 10, max: 100000, maxPerDay: 500000 },
    'USDT-ERC20': { min: 50, max: 100000, maxPerDay: 500000 },
    'SOL-SOLANA': { min: 0.1, max: 1000, maxPerDay: 10000 },
  };
  ```
- [ ] Add validation before withdrawal
- [ ] Show minimum/maximum to user in UI
- [ ] Track daily withdrawal totals per network

**Code Location:** `routes/withdraw.js:138-167`

**Estimated Time:** 2-3 hours
**Dependencies:** None
**Testing Required:** Below minimum withdrawal attempt

---

### ⚙️ **11. Webhook Signature Verification Missing**
**Status:** ⏳ Pending
**Severity:** MEDIUM (7/10)
**File:** `routes/obiexwebhooktrx.js`

**Vulnerability:**
- Trusts webhook data without verification
- Anyone can send fake webhook to approve transactions
- No HMAC signature validation

**Implementation Requirements:**
- [ ] Get webhook signing secret from Obiex
- [ ] Add to `.env`: `OBIEX_WEBHOOK_SECRET=xxx`
- [ ] Implement signature verification:
  ```javascript
  const crypto = require('crypto');
  const signature = req.headers['x-obiex-signature'];
  const payload = JSON.stringify(req.body);
  const expected = crypto
    .createHmac('sha256', OBIEX_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  if (signature !== expected) return res.status(401).json({ error: 'Invalid signature' });
  ```
- [ ] Reject webhooks with invalid signatures
- [ ] Log rejected webhook attempts

**Code Location:** `routes/obiexwebhooktrx.js`

**Estimated Time:** 2-3 hours
**Dependencies:** Webhook secret from Obiex
**Testing Required:** Manual webhook simulation

---

### ⚙️ **12. No Suspicious Activity Detection**
**Status:** ⏳ Pending
**Severity:** MEDIUM (7/10)
**File:** All withdrawal endpoints

**Vulnerability:**
- No pattern detection for fraud
- No alerts for unusual behavior

**Implementation Requirements:**
- [ ] Create suspicious activity detector service
- [ ] Define suspicious patterns:
  - Withdrawal to new address after account compromise indicators
  - Withdrawal amount = 99% of total balance
  - Withdrawal shortly after deposit (possible laundering)
  - Multiple failed 2FA/PIN attempts followed by success
  - IP address change + immediate large withdrawal
  - Withdrawal from new device/browser
- [ ] Require additional verification for suspicious activity:
  - Send email confirmation link
  - Require re-entering 2FA
  - 1-hour delay before processing
- [ ] Alert security team for manual review

**Code Location:** `services/fraudDetectionService.js` (new)

**Estimated Time:** 6-8 hours
**Dependencies:** Redis, ML model (optional)
**Testing Required:** Simulate suspicious patterns

---

## 🔧 LOW PRIORITY (Week 4 - Hardening)

---

### 🛠️ **13. Error Messages Leak Information**
**Status:** ⏳ Pending
**Severity:** LOW (3/10)
**File:** All routes

**Current Issue:**
```javascript
// Bad: Reveals if user exists
return res.status(404).json({ message: 'User not found' });

// Bad: Reveals if balance is insufficient vs other error
return res.status(400).json({ message: 'Insufficient balance' });
```

**Implementation Requirements:**
- [ ] Use generic error messages for authentication
- [ ] Don't reveal user existence
- [ ] Don't reveal specific failure reasons
- [ ] Log detailed errors server-side only

**Recommended Messages:**
```javascript
// Authentication
return res.status(401).json({ message: 'Invalid credentials' });

// Withdrawal failure
return res.status(400).json({ message: 'Unable to process withdrawal. Please try again or contact support.' });
```

**Estimated Time:** 2 hours
**Dependencies:** None
**Testing Required:** Review all error responses

---

### 🛠️ **14. Missing Security Headers**
**Status:** ⏳ Pending
**Severity:** LOW (4/10)
**File:** `server.js`

**Implementation Requirements:**
- [ ] Add Strict-Transport-Security (HSTS)
- [ ] Add Content-Security-Policy (CSP)
- [ ] Add X-Content-Type-Options
- [ ] Add X-Frame-Options
- [ ] Add Referrer-Policy

```javascript
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'");
  next();
});
```

**Estimated Time:** 1 hour
**Dependencies:** None
**Testing Required:** SecurityHeaders.com scan

---

### 🛠️ **15. No CSRF Protection for State-Changing Operations**
**Status:** ⏳ Pending
**Severity:** LOW (5/10)
**File:** All POST/PUT/DELETE routes

**Implementation Requirements:**
- [ ] Install CSRF library: `npm install csurf`
- [ ] Generate CSRF tokens for authenticated sessions
- [ ] Validate tokens on state-changing requests
- [ ] Exemption for API with Bearer tokens only

**Estimated Time:** 2-3 hours
**Dependencies:** csurf package
**Testing Required:** CSRF attack simulation

---

### 🛠️ **16. No Rate Limiting on GET Endpoints**
**Status:** ⏳ Pending
**Severity:** LOW (4/10)
**File:** `server.js`

**Current State:**
- Global rate limit: 1,000 requests/15 min (too high for some endpoints)

**Implementation Requirements:**
- [ ] Add stricter limits for sensitive GET endpoints:
  - `/withdraw/status/:id` - 100/15min
  - `/user/profile` - 200/15min
  - `/transactions` - 300/15min
- [ ] Keep global limit for other routes

**Estimated Time:** 1 hour
**Dependencies:** None
**Testing Required:** Load testing

---

## 📦 INFRASTRUCTURE REQUIREMENTS

### **Redis Setup** (Required for items 1, 2, 3, 5, 6, 12)
- [ ] Install Redis: `brew install redis` (Mac) or `apt-get install redis` (Linux)
- [ ] Start Redis: `redis-server`
- [ ] Install Node client: `npm install ioredis`
- [ ] Add to `.env`: `REDIS_URL=redis://localhost:6379`
- [ ] Create Redis connection utility: `utils/redis.js`

**Estimated Time:** 1-2 hours

---

### **Blockchain Validation Libraries** (Required for item 4)
- [ ] Install: `npm install bs58check bitcoinjs-lib @ethereumjs/util`
- [ ] Create validation utilities: `utils/addressValidation.js`

**Estimated Time:** 1 hour

---

### **GeoIP Database** (Required for item 9)
- [ ] Option A: Use Cloudflare headers (free, no setup)
- [ ] Option B: Install GeoIP: `npm install geoip-lite`
- [ ] Update monthly: GeoIP database

**Estimated Time:** 30 minutes

---

## 📊 IMPLEMENTATION SUMMARY

| Priority | Items | Estimated Time | Dependencies |
|----------|-------|----------------|--------------|
| **CRITICAL** | 4 | 16-22 hours | Redis, Email |
| **HIGH** | 4 | 15-19 hours | Redis, Webhooks |
| **MEDIUM** | 5 | 14-19 hours | GeoIP, ML (optional) |
| **LOW** | 4 | 6-8 hours | None |
| **Infrastructure** | 3 | 2-3 hours | Redis, Libraries |
| **TOTAL** | **20** | **53-71 hours** | **~2 weeks** |

---

## 🎯 IMMEDIATE ACTIONS (Can Do Today - 4 hours)

### ✅ **Quick Wins (No Dependencies)**

1. **Error Message Sanitization** (30 min)
   - File: All routes
   - Change: Use generic error messages
   - No dependencies needed

2. **Security Headers** (30 min)
   - File: `server.js`
   - Add: HSTS, CSP, X-Frame-Options
   - No dependencies needed

3. **2FA Enabled Enforcement** (30 min)
   - File: `routes/withdraw.js:197`, `routes/NGNZWithdrawal.js:271`
   - Add: Check if 2FA is enabled before allowing withdrawal
   - No dependencies needed

4. **Network Minimum Limits** (1 hour)
   - File: `routes/withdraw.js`
   - Add: Minimum withdrawal validation per network
   - No dependencies needed

5. **Enhanced Logging** (1.5 hours)
   - File: All withdrawal routes
   - Add: IP, user agent, country to logs
   - Use existing logger

**Total Quick Wins: ~4 hours**

---

## 🧪 TESTING REQUIREMENTS

### **Security Testing Checklist**

- [ ] **Race Condition Test**
  - Send 100 simultaneous withdrawal requests
  - Verify only 1 succeeds

- [ ] **2FA Brute Force Test**
  - Attempt 10 wrong codes
  - Verify account locks after threshold

- [ ] **PIN Brute Force Test**
  - Attempt 10 wrong PINs
  - Verify account locks

- [ ] **Address Validation Test**
  - Test invalid checksums (should fail)
  - Test homoglyph addresses (should fail)
  - Test valid addresses (should pass)

- [ ] **Velocity Limit Test**
  - Make 11 withdrawals in 1 hour
  - Verify 11th is rejected

- [ ] **Geofencing Test**
  - Use VPN to simulate Iran/North Korea
  - Verify withdrawal blocked

- [ ] **Webhook Signature Test**
  - Send webhook with wrong signature
  - Verify rejection

---

## 📝 PROGRESS TRACKING

**Started:** 2026-01-01
**Target Completion:** 2026-01-15
**Completed Items:** 0/20
**Progress:** 0%

### **Weekly Goals**
- **Week 1 (Jan 1-7):** Complete all CRITICAL items (4/20)
- **Week 2 (Jan 8-14):** Complete all HIGH items (8/20)
- **Week 3 (Jan 15-21):** Complete all MEDIUM items (13/20)
- **Week 4 (Jan 22-28):** Complete all LOW items (20/20)

---

## 🚀 DEPLOYMENT CHECKLIST

Before deploying security fixes to production:

- [ ] All fixes tested in staging environment
- [ ] Load testing completed (1000 concurrent users)
- [ ] Security testing passed (penetration testing)
- [ ] Redis cluster configured with failover
- [ ] Monitoring dashboards set up
- [ ] Alert channels tested (email, SMS, Slack)
- [ ] Rollback plan documented
- [ ] Team trained on new security features
- [ ] Documentation updated
- [ ] Customer communication sent (if service interruption)

---

## 📞 SUPPORT & ESCALATION

**Security Issues:**
- Report to: security@zeusodx.com
- Severity: Critical issues within 1 hour, High within 4 hours

**Infrastructure:**
- Redis issues: Check `redis-cli ping`
- Database issues: Check MongoDB connection

**Monitoring:**
- Logs: `tail -f logs/security.log`
- Alerts: Check Slack #security-alerts channel

---

## 📚 REFERENCES

- OWASP Top 10 2023: https://owasp.org/www-project-top-ten/
- NIST Cybersecurity Framework: https://www.nist.gov/cyberframework
- PCI-DSS 4.0: https://www.pcisecuritystandards.org/
- CWE Top 25: https://cwe.mitre.org/top25/

---

**Last Review:** 2026-01-01
**Next Review:** 2026-02-01
**Reviewed By:** Security Audit Team
