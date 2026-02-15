# AppsFlyer S2S Events Integration Guide

## ✅ Implementation Status

### Completed
- ✅ S2S Service created (`services/appsFlyerS2SService.js`)
- ✅ Helper utility created (`utils/appsFlyerHelper.js`)
- ✅ Sign up event tracking integrated (`routes/passwordpin.js`)
- ✅ Login event tracking integrated (`routes/signin.js`)
- ✅ Environment variables added to `.env.example`

### Pending Integration
The following events need to be integrated into their respective routes:

1. **Swap_** - Add to swap routes (`routes/swap.js` or `routes/NGNZSwaps.js`)
2. **Withdrawal** - Add to withdrawal routes (`routes/withdraw.js` or `routes/NGNZWithdrawal.js`)
3. **Deposit** - Add to deposit routes (`routes/deposit.js`)
4. **Utility** - Add to utility routes:
   - `routes/airtime.js`
   - `routes/data.js`
   - `routes/electricity.js`
   - `routes/cabletv.js`
   - `routes/betting.js`
5. **Email Verified** - Add to email verification route (`routes/EmailVerify.js`)
6. **KYC_1** - Add to KYC Level 1 completion (already happens in signup, but may need separate tracking)
7. **KYC_2** - Add to KYC Level 2 completion (`routes/KYC.js` or `routes/EnhancedKYC.js`)

## 📋 How to Integrate Events

### Step 1: Import the helper
Add this import at the top of your route file:
```javascript
const { trackEvent } = require('../utils/appsFlyerHelper');
```

### Step 2: Add event tracking after successful operation

#### Example: Swap Event
```javascript
// After successful swap
trackEvent(user._id, 'Swap_', {
  fromCurrency: 'NGN',
  toCurrency: 'USDT',
  amount: swapAmount
}, req).catch(err => {
  logger.warn('Failed to track AppsFlyer Swap_ event', { userId: user._id, error: err.message });
});
```

#### Example: Withdrawal Event
```javascript
// After successful withdrawal
trackEvent(user._id, 'Withdrawal', {
  amount: withdrawalAmount,
  currency: 'NGN',
  method: 'bank_transfer'
}, req).catch(err => {
  logger.warn('Failed to track AppsFlyer Withdrawal event', { userId: user._id, error: err.message });
});
```

#### Example: Deposit Event
```javascript
// After successful deposit
trackEvent(user._id, 'Deposit', {
  amount: depositAmount,
  currency: 'NGN',
  method: 'bank_transfer'
}, req).catch(err => {
  logger.warn('Failed to track AppsFlyer Deposit event', { userId: user._id, error: err.message });
});
```

#### Example: Utility Event (Airtime, Data, Electricity, Cable TV, Betting)
```javascript
// After successful utility purchase
trackEvent(user._id, 'Utility', {
  utilityType: 'airtime', // or 'data', 'electricity', 'cable_tv', 'betting'
  amount: purchaseAmount,
  currency: 'NGN',
  provider: providerName
}, req).catch(err => {
  logger.warn('Failed to track AppsFlyer Utility event', { userId: user._id, error: err.message });
});
```

#### Example: Email Verified Event
```javascript
// After email verification
trackEvent(user._id, 'Email Verified', {}, req).catch(err => {
  logger.warn('Failed to track AppsFlyer Email Verified event', { userId: user._id, error: err.message });
});
```

#### Example: KYC Events
```javascript
// After KYC Level 1 completion
trackEvent(user._id, 'KYC_1', {}, req).catch(err => {
  logger.warn('Failed to track AppsFlyer KYC_1 event', { userId: user._id, error: err.message });
});

// After KYC Level 2 completion
trackEvent(user._id, 'KYC_2', {}, req).catch(err => {
  logger.warn('Failed to track AppsFlyer KYC_2 event', { userId: user._id, error: err.message });
});
```

## 🔧 Configuration

### Environment Variables Required
Add these to your `.env` file:

```bash
# AppsFlyer S2S API Credentials
APPSFLYER_DEV_KEY=Av6nnqAQzF26yExKyQ6g4U
APPSFLYER_S2S_API_TOKEN=your_s2s_api_token_here
APPSFLYER_IOS_APP_ID=com.manniegenie.zeusodx
APPSFLYER_ANDROID_APP_ID=com.manniegenie.zeusodx
```

### Getting S2S API Token
1. Login to AppsFlyer Dashboard: https://hq1.appsflyer.com/
2. Go to Settings → App Settings → API Access
3. Copy your S2S API Token
4. Add it to your `.env` file

## 📊 Event Parameters

### sign_up
- `registrationMethod`: 'phone' (default)

### login_
- `loginMethod`: 'pin' (default)

### Swap_
- `fromCurrency`: Source currency (e.g., 'NGN', 'USDT')
- `toCurrency`: Destination currency
- `amount`: Swap amount

### Withdrawal
- `amount`: Withdrawal amount
- `currency`: Currency code (e.g., 'NGN')
- `method`: Withdrawal method (e.g., 'bank_transfer')

### Deposit
- `amount`: Deposit amount
- `currency`: Currency code (e.g., 'NGN')
- `method`: Deposit method (e.g., 'bank_transfer')

### Utility
- `utilityType`: 'airtime', 'data', 'electricity', 'cable_tv', or 'betting'
- `amount`: Purchase amount
- `currency`: Currency code (e.g., 'NGN')
- `provider`: Provider name

### Email Verified
- No additional parameters

### KYC_1 / KYC_2
- No additional parameters

## 🔍 Platform Detection

The helper automatically detects platform from:
1. `x-platform` header (if sent by client)
2. `req.body.platform` (if included in request)
3. User-Agent header (fallback)
4. Defaults to 'android' if unknown

## ⚠️ Important Notes

1. **Non-blocking**: All event tracking is non-blocking (fire-and-forget) to avoid impacting user experience
2. **Requires AppsFlyer ID**: Events are only sent if user has `appsflyer_id` stored in database
3. **Error Handling**: Failed events are logged but don't affect the main operation
4. **Platform Detection**: Make sure your mobile app sends `x-platform` header or includes `platform` in request body for accurate tracking

## 🧪 Testing

1. Ensure AppsFlyer credentials are configured in `.env`
2. Test each event by performing the action (signup, login, swap, etc.)
3. Check AppsFlyer Dashboard → Real-Time → In-App Events to verify events are being received
4. Check server logs for any tracking errors

## 📝 Files Created/Modified

### Created
- `services/appsFlyerS2SService.js` - S2S API service
- `utils/appsFlyerHelper.js` - Helper utility for event tracking

### Modified
- `routes/passwordpin.js` - Added sign_up event tracking
- `routes/signin.js` - Added login_ event tracking
- `.env.example` - Added AppsFlyer S2S credentials

### To Be Modified
- `routes/swap.js` or `routes/NGNZSwaps.js` - Add Swap_ event
- `routes/withdraw.js` or `routes/NGNZWithdrawal.js` - Add Withdrawal event
- `routes/deposit.js` - Add Deposit event
- `routes/airtime.js` - Add Utility event
- `routes/data.js` - Add Utility event
- `routes/electricity.js` - Add Utility event
- `routes/cabletv.js` - Add Utility event
- `routes/betting.js` - Add Utility event
- `routes/EmailVerify.js` - Add Email Verified event
- `routes/KYC.js` or `routes/EnhancedKYC.js` - Add KYC_2 event
