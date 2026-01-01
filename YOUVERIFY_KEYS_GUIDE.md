# Youverify API Keys - Quick Reference

## 🔑 Three Different Keys Explained

Youverify uses **3 different keys** for different purposes. Here's what each one does:

### 1. Public Merchant Key
**Environment Variable:** `YOUVERIFY_PUBLIC_MERCHANT_KEY`
**Format:** Starts with `YV_PUB_`
**Used For:** Authenticating API requests **TO** Youverify
**Where:** [routes/KYC.js](routes/KYC.js) - When submitting verification requests
**Required:** ✅ YES - Won't work without it
**Get It From:** Settings → API Keys in Youverify dashboard

**Example Usage:**
```javascript
// Sent in API request headers TO Youverify
headers: {
  'Token': YOUVERIFY_PUBLIC_MERCHANT_KEY
}
```

---

### 2. Webhook Signing Key
**Environment Variable:** `YOUVERIFY_WEBHOOK_SIGNING_KEY`
**Format:** Plain string (no prefix)
**Used For:** Verifying webhook signatures **FROM** Youverify
**Where:** [routes/kycwebhook.js](routes/kycwebhook.js) - When receiving webhook callbacks
**Required:** ✅ YES - Critical for security!
**Get It From:** Settings → Webhooks in Youverify dashboard (when you create/edit webhook)

**Example Usage:**
```javascript
// Used to verify HMAC signature from Youverify
const expectedSignature = crypto
  .createHmac('sha256', YOUVERIFY_WEBHOOK_SIGNING_KEY)
  .update(payload)
  .digest('hex');
```

**Security Note:** This prevents fake webhooks from approving/rejecting KYC!

---

### 3. Secret Key (Optional)
**Environment Variable:** `YOUVERIFY_SECRET_KEY`
**Format:** Starts with `YV_SEC_`
**Used For:** Advanced API operations (not currently used in your implementation)
**Where:** Not used yet
**Required:** ❌ NO - Optional for future features
**Get It From:** Settings → API Keys in Youverify dashboard

---

## 📝 How to Get These Keys

### Step 1: Get Public Merchant Key
1. Login to [Youverify Dashboard](https://youverify.co/dashboard)
2. Go to **Settings** → **API Keys**
3. Copy **Public Merchant Key** (starts with `YV_PUB_`)
4. Add to `.env`:
   ```bash
   YOUVERIFY_PUBLIC_MERCHANT_KEY=YV_PUB_your_actual_key
   ```

### Step 2: Get Webhook Signing Key
1. In Youverify Dashboard, go to **Settings** → **Webhooks**
2. Click **Add Webhook** or edit existing webhook
3. Copy the **Signing Key** (shown when you create/edit webhook)
4. Add to `.env`:
   ```bash
   YOUVERIFY_WEBHOOK_SIGNING_KEY=your_signing_key_here
   ```

### Step 3: Get Secret Key (Optional)
1. In **Settings** → **API Keys**
2. Copy **Secret Key** (starts with `YV_SEC_`)
3. Add to `.env`:
   ```bash
   YOUVERIFY_SECRET_KEY=YV_SEC_your_secret_key
   ```

---

## ✅ Final .env Configuration

Your `.env` file should have:

```bash
# REQUIRED: For API requests TO Youverify
YOUVERIFY_PUBLIC_MERCHANT_KEY=YV_PUB_xxxxxxxxxxxx

# REQUIRED: For verifying webhooks FROM Youverify
YOUVERIFY_WEBHOOK_SIGNING_KEY=your_signing_key_here

# REQUIRED: Where Youverify sends results
YOUVERIFY_CALLBACK_URL=https://your-domain.com/kyc-webhook/callback

# OPTIONAL: For advanced features
YOUVERIFY_SECRET_KEY=YV_SEC_xxxxxxxxxxxx

# OPTIONAL: API base URL (usually don't change)
YOUVERIFY_API_URL=https://api.youverify.co
```

---

## 🔒 Security Best Practices

1. **Never commit** these keys to git
   - Add `.env` to `.gitignore`
   - Use `.env.example` for template

2. **Keep webhook signing key secret**
   - Without it, anyone can fake webhook approvals!
   - Treat it like a password

3. **Use environment variables**
   - Don't hardcode keys in source code
   - Use different keys for dev/staging/production

4. **Rotate keys regularly**
   - Change keys every 3-6 months
   - Immediately if compromised

---

## 🧪 Testing Your Keys

Run the verification script:
```bash
cd /Users/mac/Projects/ZeusODX-server
node scripts/verify-kyc-setup.js
```

This will check:
- ✅ All required keys are set
- ✅ Keys are valid format (not placeholders)
- ✅ Can connect to Youverify API
- ✅ Webhook URL is configured

---

## 🐛 Troubleshooting

### Error: "Invalid Token" or 401 from Youverify API
**Problem:** `YOUVERIFY_PUBLIC_MERCHANT_KEY` is wrong or missing
**Fix:** Double-check the key in Settings → API Keys

### Error: "Invalid signature" in webhook logs
**Problem:** `YOUVERIFY_WEBHOOK_SIGNING_KEY` is wrong or missing
**Fix:**
1. Check the signing key in Settings → Webhooks
2. Make sure it matches exactly (no extra spaces)
3. Restart server after updating

### Webhooks not being received
**Problem:** Youverify doesn't have the correct webhook URL
**Fix:**
1. Verify `YOUVERIFY_CALLBACK_URL` in `.env`
2. Register this URL in Youverify dashboard
3. Make sure URL is publicly accessible

---

## 📚 Related Documentation

- Main Setup Guide: [KYC_SETUP_GUIDE.md](KYC_SETUP_GUIDE.md)
- Changes Summary: [CHANGES_SUMMARY.md](CHANGES_SUMMARY.md)
- Environment Template: [.env.example](.env.example)
- Verification Script: [scripts/verify-kyc-setup.js](scripts/verify-kyc-setup.js)

---

## Quick Reference Table

| Key | Required? | Used For | Get From |
|-----|-----------|----------|----------|
| Public Merchant Key | ✅ Yes | API requests TO Youverify | Settings → API Keys |
| Webhook Signing Key | ✅ Yes | Verify webhooks FROM Youverify | Settings → Webhooks |
| Secret Key | ❌ No | Advanced API operations | Settings → API Keys |

---

**Remember:** You provided your webhook signing key, which is the critical one for security. Make sure to add it to your `.env` file!
