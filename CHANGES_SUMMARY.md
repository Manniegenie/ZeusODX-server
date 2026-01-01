# KYC Integration Fix - Summary of Changes

## Date: 2026-01-01

## Problem Identified
Your KYC system was creating PENDING records in the database but **never actually calling Youverify API** to verify the documents. This caused all KYC submissions to stay stuck in PENDING status indefinitely.

---

## Root Cause
The backend was designed to wait for Youverify webhook callbacks, but **no initial request was being sent to Youverify**. The frontend was just capturing selfies and sending them to your backend, which stored them but never triggered actual verification.

---

## Changes Made

### 1. Added Youverify API Integration
**File:** `routes/KYC.js`

**Added:**
- `submitToYouverify()` function that calls Youverify API v2 endpoint
- Direct API call after creating KYC record
- Error handling for API failures
- Updates KYC record with Youverify ID when successful
- Uses country and ID-type specific endpoints per Youverify API v2 spec

**API Endpoints Used:**
- NIN: `POST /v2/api/identity/ng/nin`
- BVN: `POST /v2/api/identity/ng/bvn`
- Passport: `POST /v2/api/identity/ng/passport`
- Driver's License: `POST /v2/api/identity/ng/drivers-license`

**What it does:**
- When user submits KYC, backend now immediately calls Youverify API
- Sends ID details, selfie image, and user information
- Receives Youverify verification ID
- Stores the ID in database for tracking

### 2. Updated Configuration
**File:** `routes/config.js`

**Added:**
```javascript
youverify: {
  publicMerchantKey: process.env.YOUVERIFY_PUBLIC_MERCHANT_KEY,
  secretKey: process.env.YOUVERIFY_SECRET_KEY,
  callbackUrl: process.env.YOUVERIFY_CALLBACK_URL,
  apiBaseUrl: process.env.YOUVERIFY_API_URL
}
```

### 3. Security Improvements
**File:** `routes/kycwebhook.js`

**Fixed:**
1. **Mandatory signature verification** (line 113-121)
   - Before: Signature check was skipped if secret key wasn't configured
   - After: Rejects webhook if secret key missing OR signature invalid
   - Prevents fake webhooks from approving KYC

2. **Input sanitization** (line 63-66)
   - Added sanitize() function to clean webhook data
   - Removes special characters that could cause injection attacks
   - Limits field lengths to prevent DoS

### 4. Created Documentation
**New files:**
- `.env.example` - Template for environment variables
- `KYC_SETUP_GUIDE.md` - Complete setup instructions
- `CHANGES_SUMMARY.md` - This file

---

## Required Setup (CRITICAL)

### 1. Get Youverify Credentials
You MUST sign up at [youverify.co](https://youverify.co) and get:
- Public Merchant Key
- Secret Key

### 2. Add Environment Variables
Create/update `.env` file in server root:
```bash
YOUVERIFY_PUBLIC_MERCHANT_KEY=YV_PUB_your_key
YOUVERIFY_SECRET_KEY=YV_SEC_your_secret
YOUVERIFY_CALLBACK_URL=https://your-domain.com/kyc-webhook/callback
```

### 3. Register Webhook in Youverify Dashboard
1. Login to Youverify dashboard
2. Go to Settings → Webhooks
3. Add URL: `https://your-domain.com/kyc-webhook/callback`
4. Subscribe to "Identity Verification Completed" events

### 4. Restart Server
```bash
pm2 restart all
```

---

## Testing

### Before (Broken):
```
User submits KYC
  ↓
Backend creates PENDING record
  ↓
[STOPS HERE - Nothing happens]
  ↓
Record stays PENDING forever ❌
```

### After (Fixed):
```
User submits KYC
  ↓
Backend creates PENDING record
  ↓
Backend calls Youverify API ✅
  ↓
Youverify verifies document
  ↓
Youverify sends webhook ✅
  ↓
Backend updates to APPROVED/REJECTED ✅
  ↓
User receives email notification ✅
```

---

## What You Need to Do Next

### Immediate (Required):
1. [ ] Sign up for Youverify account
2. [ ] Get API credentials (Public Key + Secret Key)
3. [ ] Add credentials to `.env` file
4. [ ] Register webhook URL in Youverify dashboard
5. [ ] Restart server
6. [ ] Test with one KYC submission

### For Production:
1. [ ] Use production Youverify credentials (not test/sandbox)
2. [ ] Ensure webhook URL is publicly accessible
3. [ ] Monitor logs for errors
4. [ ] Set up alerts for failed verifications

---

## Files Modified

```
ZeusODX-server/
├── routes/
│   ├── KYC.js                    # ✅ Added Youverify API integration
│   ├── kycwebhook.js             # ✅ Added security fixes
│   └── config.js                 # ✅ Added Youverify config
├── .env.example                  # ✅ NEW - Environment template
├── KYC_SETUP_GUIDE.md           # ✅ NEW - Setup instructions
└── CHANGES_SUMMARY.md           # ✅ NEW - This file
```

---

## Expected Behavior After Setup

### When KYC is Submitted:
1. User fills form and takes selfie in mobile app
2. Frontend sends to `/kyc/biometric-verification`
3. **Backend calls Youverify API** (NEW!)
4. Server logs show: "Youverify submission successful"
5. Response includes `youverifyId`

### Within 30 seconds - 5 minutes:
1. Youverify processes verification
2. **Youverify sends webhook** to your callback URL
3. Server logs show: "Webhook received"
4. KYC status updates to APPROVED or REJECTED
5. Email sent to user

---

## Troubleshooting

### If KYC still stays PENDING:

**Check logs:**
```bash
cd /Users/mac/Projects/ZeusODX-server
tail -f logs/combined.log | grep -i youverify
```

**Look for:**
- ✅ "Submitting to Youverify API" - Good, API call attempted
- ✅ "Youverify submission successful" - Great, API accepted request
- ❌ "Youverify API error" - Check credentials/configuration
- ❌ "secretKey not configured" - Add YOUVERIFY_SECRET_KEY to .env

### If webhook not received:

1. Check Youverify dashboard webhook logs
2. Verify webhook URL is correct
3. Test URL is publicly accessible
4. For local testing, use ngrok

---

## Security Improvements Made

### 1. Signature Verification (Critical)
**Before:**
```javascript
if (secretKey && !verifySignature()) {
  reject();
}
// If secretKey missing, accepts ANY webhook! ⚠️
```

**After:**
```javascript
if (!secretKey) {
  return error(); // Rejects if not configured
}
if (!verifySignature()) {
  return error(); // Rejects invalid signatures
}
```

### 2. Input Sanitization
**Before:**
```javascript
idNumber: data.idNumber  // Raw data from webhook ⚠️
```

**After:**
```javascript
idNumber: sanitize(data.idNumber)  // Cleaned and validated ✅
```

### 3. Error Handling
- Better logging of API errors
- Graceful degradation if Youverify API fails
- Status set to PROVISIONAL if submission fails

---

## Support Resources

### Youverify Documentation
- Main Docs: https://doc.youverify.co
- API Reference: https://doc.youverify.co/webhooks
- Dashboard: https://youverify.co/dashboard

### Your Documentation
- Setup Guide: See `KYC_SETUP_GUIDE.md`
- Environment Template: See `.env.example`

---

## Summary

✅ **Fixed:** KYC now actually calls Youverify API
✅ **Fixed:** Webhook signature verification enforced
✅ **Fixed:** Input sanitization added
✅ **Added:** Complete setup documentation

⚠️ **Required:** You must get Youverify credentials and configure them for this to work

🎯 **Result:** KYC submissions will now be verified and receive APPROVED/REJECTED status instead of staying PENDING forever
