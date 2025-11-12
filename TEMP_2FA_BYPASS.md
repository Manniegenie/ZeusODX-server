# Temporary 2FA Bypass - REMOVE BEFORE PRODUCTION

## Overview

A temporary bypass has been added to allow the 2FA code "00000" to work for testing and development purposes.

## Files Modified

1. **`services/twofactorAuth.js`**
   - Added bypass for "00000" in `validateTwoFactorAuth()` function
   - This function is used throughout the application for 2FA validation

2. **`auth/setup-2fa.js`**
   - Added bypass for "00000" in `/verify-2fa` route
   - Added bypass for "00000" in `/disable-2fa` route

3. **`adminRoutes/Admin2FA.js`**
   - Added bypass for "00000" in `/verify-2fa` route for admin users

## How It Works

When a user or admin enters "00000" as their 2FA code:
- The bypass is triggered before the actual TOTP verification
- A warning is logged: `⚠️ TEMPORARY 2FA BYPASS USED: Code "00000" accepted`
- The verification returns `true`, allowing the operation to proceed

## Usage

**For Users:**
- Enter "00000" as the 2FA code when prompted
- Works for all operations that require 2FA (withdrawals, purchases, etc.)

**For Admins:**
- Enter "00000" as the 2FA code when prompted
- Works for admin 2FA verification

## ⚠️ IMPORTANT: REMOVE BEFORE PRODUCTION

This bypass is **TEMPORARY** and should be **REMOVED** before deploying to production.

### Steps to Remove:

1. **Remove bypass from `services/twofactorAuth.js`:**
   ```javascript
   // Remove these lines:
   // TEMPORARY BYPASS: Allow "00000" to work for testing/development
   // TODO: Remove this bypass before production deployment
   if (twoFactorCode === '00000') {
     console.warn('⚠️ TEMPORARY 2FA BYPASS USED: Code "00000" accepted for user:', user._id);
     return true;
   }
   ```

2. **Remove bypass from `auth/setup-2fa.js`:**
   - Remove bypass from `/verify-2fa` route
   - Remove bypass from `/disable-2fa` route

3. **Remove bypass from `adminRoutes/Admin2FA.js`:**
   - Remove bypass from `/verify-2fa` route

4. **Test after removal:**
   - Verify that "00000" no longer works
   - Verify that valid 2FA codes still work
   - Verify that invalid codes are rejected

## Security Notes

- ⚠️ **This bypass allows anyone with "00000" to bypass 2FA**
- ⚠️ **Do NOT deploy this to production**
- ⚠️ **Remove this bypass before going live**
- ⚠️ **Test thoroughly after removal**

## Search for TODO

To find all instances of this bypass, search for:
- `TEMPORARY 2FA BYPASS`
- `TODO: Remove this bypass`
- `00000`

---

**Status**: Temporary bypass active
**Action Required**: Remove before production deployment
**Created**: [Current Date]
**Remove By**: Before production deployment

