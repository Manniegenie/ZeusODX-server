# ZeusODX KYC Integration Setup Guide

## Overview
This guide will help you set up Youverify KYC integration so that user verification requests are actually processed and receive APPROVED/REJECTED status.

## What Was Fixed

### The Problem
Your KYC system was creating PENDING records but never actually calling Youverify API, so verifications stayed stuck in PENDING status forever.

### The Solution
Added direct API integration with Youverify:
1. Backend now calls Youverify API when user submits KYC
2. Youverify processes the verification
3. Youverify sends webhook with results
4. Backend updates status to APPROVED/REJECTED

### Security Improvements Added
1. ✅ Mandatory webhook signature verification
2. ✅ Input sanitization to prevent injection attacks
3. ✅ Better error handling and logging

---

## Setup Instructions

### Step 1: Get Youverify Account & Credentials

1. **Sign up for Youverify:**
   - Go to [https://youverify.co](https://youverify.co)
   - Create a business account
   - Complete your business verification

2. **Get API Credentials:**
   - Login to [Youverify Dashboard](https://youverify.co/dashboard)
   - Navigate to **Settings → API Keys**
   - Copy your:
     - **Public Merchant Key** (starts with `YV_PUB_`)
     - **Secret Key** (starts with `YV_SEC_`)

### Step 2: Configure Environment Variables

1. **Copy the template:**
   ```bash
   cd /Users/mac/Projects/ZeusODX-server
   cp .env.example .env
   ```

2. **Edit .env file and add your Youverify credentials:**
   ```bash
   # Youverify KYC Integration
   YOUVERIFY_PUBLIC_MERCHANT_KEY=YV_PUB_your_actual_key_here
   YOUVERIFY_SECRET_KEY=YV_SEC_your_actual_secret_here
   YOUVERIFY_CALLBACK_URL=https://your-production-domain.com/kyc-webhook/callback
   ```

3. **For local testing with ngrok:**
   ```bash
   # Install ngrok
   brew install ngrok  # Mac
   # or download from https://ngrok.com

   # Start ngrok tunnel
   ngrok http 3000

   # Use the ngrok URL in .env
   YOUVERIFY_CALLBACK_URL=https://abc123.ngrok.io/kyc-webhook/callback
   ```

### Step 3: Register Webhook in Youverify Dashboard

1. **Login to Youverify Dashboard**

2. **Navigate to Settings → Webhooks**

3. **Add New Webhook:**
   - **Webhook URL:** `https://your-domain.com/kyc-webhook/callback`
   - **Events to subscribe:**
     - ✅ Identity Verification Completed
     - ✅ Identity Verification Failed
   - **Save**

4. **Test the webhook:**
   - Youverify dashboard has a "Test Webhook" button
   - Click it to send a test event
   - Check your server logs to confirm receipt

### Step 4: Restart Your Server

```bash
cd /Users/mac/Projects/ZeusODX-server
pm2 restart all  # If using PM2
# OR
npm run dev  # For development
```

### Step 5: Test KYC Flow

1. **Submit a test KYC from mobile app:**
   - Use a valid Nigerian ID (NIN, BVN, Passport, etc.)
   - Upload a selfie
   - Submit

2. **Check server logs:**
   ```bash
   tail -f logs/combined.log
   ```
   You should see:
   ```
   Submitting to Youverify API
   Youverify API response received
   Youverify submission successful
   ```

3. **Wait for webhook (usually 30 seconds - 5 minutes):**
   - Youverify processes the verification
   - Sends webhook to your callback URL
   - Your server updates KYC status

4. **Check database:**
   ```javascript
   // MongoDB query
   db.kycs.find({ userId: "user_id_here" }).sort({ createdAt: -1 }).limit(1)
   ```
   Status should change from `PENDING` → `APPROVED` or `REJECTED`

---

## Testing Checklist

- [ ] Youverify account created
- [ ] API credentials obtained
- [ ] Environment variables configured
- [ ] Webhook URL registered in Youverify dashboard
- [ ] Server restarted with new config
- [ ] Test KYC submission works
- [ ] Youverify API receives request (check logs)
- [ ] Webhook received (check logs for "Webhook received")
- [ ] KYC status updated to APPROVED/REJECTED
- [ ] User receives email notification

---

## Troubleshooting

### Problem: KYC still stuck in PENDING

**Check:**
1. Are environment variables set correctly?
   ```bash
   echo $YOUVERIFY_PUBLIC_MERCHANT_KEY
   ```

2. Check server logs for errors:
   ```bash
   grep -i "youverify" logs/combined.log
   grep -i "error" logs/error.log
   ```

3. Is webhook URL accessible?
   - Test: `curl https://your-domain.com/kyc-webhook/callback`
   - Should return 401 (signature required)

### Problem: "Youverify API error"

**Possible causes:**
- Invalid credentials
- Insufficient account balance
- ID number format incorrect
- Image too large (>5MB)

**Fix:**
- Verify credentials are correct
- Check Youverify dashboard for account status
- Review API error in logs

### Problem: Webhook not received

**Check:**
1. Is webhook URL registered in Youverify dashboard?
2. Is webhook URL publicly accessible?
3. Check Youverify webhook logs in their dashboard
4. Check your server logs for incoming requests

**For local development:**
- Use ngrok to expose localhost
- Update webhook URL in Youverify dashboard with ngrok URL

### Problem: "Invalid signature"

**This means:**
- Webhook signature verification failed
- Someone trying to send fake webhooks
- OR wrong secret key configured

**Fix:**
- Verify `YOUVERIFY_SECRET_KEY` matches what's in Youverify dashboard
- Check logs for actual vs expected signature

---

## API Endpoints

### Submit KYC Verification
```
POST /kyc/biometric-verification
Authorization: Bearer {jwt_token}

{
  "idType": "nin",
  "idNumber": "12345678901",
  "selfieImage": "data:image/jpeg;base64,..."
}
```

### Webhook Callback (Youverify calls this)
```
POST /kyc-webhook/callback
x-youverify-signature: {hmac_signature}

{
  "event": "verification.completed",
  "data": {
    "status": "found",
    "allValidationPassed": true,
    ...
  }
}
```

---

## Production Deployment

### Before Going Live:

1. **Use production Youverify credentials**
   - Not sandbox/test keys

2. **Set production webhook URL**
   ```
   YOUVERIFY_CALLBACK_URL=https://api.zeusodx.com/kyc-webhook/callback
   ```

3. **Enable rate limiting** (already configured in server.js)

4. **Monitor logs:**
   ```bash
   pm2 logs
   ```

5. **Set up alerts** for:
   - Failed Youverify API calls
   - Invalid webhook signatures
   - High error rates

---

## Support

### Youverify Support
- Email: support@youverify.co
- Dashboard: [https://youverify.co/dashboard](https://youverify.co/dashboard)
- Docs: [https://doc.youverify.co](https://doc.youverify.co)

### Files Modified
- `/routes/config.js` - Added Youverify config
- `/routes/KYC.js` - Added API integration
- `/routes/kycwebhook.js` - Added security fixes

---

## Summary

✅ **What now works:**
- KYC submissions are sent to Youverify API
- Youverify processes and verifies the documents
- Webhook updates status to APPROVED/REJECTED
- Users receive email notifications

❌ **What was broken before:**
- KYC records stayed PENDING forever
- Youverify was never contacted
- No verification actually happened

🔒 **Security improvements:**
- Mandatory webhook signature verification
- Input sanitization
- Better error handling
