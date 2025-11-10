# Obiex IP Whitelisting Guide

## Your Server IP Address
**IP to Whitelist: `105.113.91.239`**

## Steps to Whitelist Your IP with Obiex

### 1. Contact Obiex Support

**Email:** support@obiex.finance (or check their website for the correct support email)

**Subject:** Request to Whitelist Server IP for API Access

**Email Template:**
```
Subject: Request to Whitelist Server IP for API Access

Hello Obiex Support Team,

I am experiencing Cloudflare 403 errors when making API requests to the Obiex API from my server.

I would like to request whitelisting of my server IP address for API access.

Server Details:
- IP Address: 105.113.91.239
- Server Provider: Contabo VPS
- Purpose: API access for wallet address generation and crypto transactions
- API Key: [Your API Key - last 4 characters: XXXX]
- Account/Merchant ID: [If applicable]

The API requests are being blocked by Cloudflare protection, and I need to whitelist this IP to allow automated API calls from my server.

Please let me know if you need any additional information.

Thank you,
[Your Name]
[Your Contact Information]
```

### 2. Check Obiex Dashboard

1. Log into your Obiex account dashboard
2. Navigate to:
   - **API Settings**
   - **Security Settings**
   - **IP Whitelist** or **Firewall Rules**
   - **Developer/API Access**
3. Add your IP address: `105.113.91.239`

### 3. Verify Your IP

Run this command on your server to verify your public IP:
```bash
curl -s ifconfig.me
```

Or use the provided script:
```bash
node scripts/check-server-ip.js
```

### 4. Alternative: Use Obiex API Documentation

Check Obiex API documentation for:
- IP whitelisting instructions
- Alternative API endpoints that bypass Cloudflare
- Special headers or configuration needed

## Current Issue

**Error:** Cloudflare 403 challenge page blocking API requests

**Solution:** Whitelist IP `105.113.91.239` with Obiex

## Testing After Whitelisting

After your IP is whitelisted, test with:
```bash
curl -X POST https://api.obiex.finance/v1/addresses/broker \
  -H "x-api-key: YOUR_API_KEY" \
  -H "x-api-timestamp: $(date +%s)000" \
  -H "x-api-signature: YOUR_SIGNATURE" \
  -H "Content-Type: application/json" \
  -d '{"purpose":"test","currency":"BTC","network":"BTC"}'
```

## Notes

- Your server IP is static (VPS), so it won't change
- Whitelisting usually takes 24-48 hours
- Keep your API credentials secure
- Monitor logs after whitelisting to confirm it's working


