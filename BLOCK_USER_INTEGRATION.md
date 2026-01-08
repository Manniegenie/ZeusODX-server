# Block User Feature - Integration Guide

## Overview
This feature allows administrators to block users from performing withdrawals and utility transactions (airtime, electricity, betting, cable TV, data).

## Backend Integration Complete

### Files Created/Modified

#### 1. Utility Function
**File**: `utils/checkUserBlocked.js` ✅ CREATED

**Functions**:
```javascript
// Check if user is blocked
checkUserBlocked(userId, idType = 'id')

// Middleware for routes
requireNotBlocked(req, res, next)
```

#### 2. Admin Endpoints
**File**: `adminRoutes/blockuser.js` ✅ CREATED

**Endpoints**:
- `POST /blockuser/block` - Block a user
- `POST /blockuser/unblock` - Unblock a user
- `GET /blockuser/check` - Check block status

### Required Steps to Complete Backend Integration

#### Step 1: Add Block Fields to User Model
**File**: `models/user.js`

Add these fields to the User schema:

```javascript
const userSchema = new mongoose.Schema({
  // ... existing fields ...

  // Block/Unblock feature
  isBlocked: {
    type: Boolean,
    default: false,
    index: true
  },
  blockReason: {
    type: String,
    default: null
  },
  blockedAt: {
    type: Date,
    default: null
  },
  unblockedAt: {
    type: Date,
    default: null
  }
});
```

#### Step 2: Mount Block User Routes in Server
**File**: `server.js`

Add these lines:

```javascript
// Add to imports section (around line 415)
const blockUserRoutes = require("./adminRoutes/blockuser");

// Add to routes section (after other admin routes)
app.use("/blockuser", authenticateAdminToken, requireModerator, blockUserRoutes);
```

#### Step 3: Integrate Block Check into Withdrawal Routes
**Files to Update**:
- `routes/ngnzwithdrawal.js`
- `routes/withdrawal.js`

Add at the top of each file:

```javascript
const { requireNotBlocked } = require('../utils/checkUserBlocked');
```

Then add the middleware to withdrawal routes:

```javascript
// Example for NGNZ withdrawal
router.post('/initiate',
  authenticateToken,        // existing middleware
  requireNotBlocked,        // NEW middleware
  async (req, res) => {
    // existing code...
  }
);
```

#### Step 4: Integrate Block Check into Utility Routes
**Files to Update**:
- `routes/data.js`
- `routes/airtime.js`
- `routes/electricity.js`
- `routes/betting.js`
- `routes/cabletv.js`

For each file, add:

```javascript
const { requireNotBlocked } = require('../utils/checkUserBlocked');

// Add to purchase/payment routes
router.post('/purchase',
  authenticateToken,
  requireNotBlocked,  // NEW
  async (req, res) => {
    // existing code...
  }
);
```

## Frontend Integration Complete ✅

### Files Created
1. `src/features/users/pages/BlockUser.tsx` - Block/Unblock page
2. Updated `src/features/users/services/usersService.ts` - Added block services
3. Updated `src/features/users/pages/UserActions.tsx` - Added block button
4. Updated `src/core/routes/routes.tsx` - Added routing

### Features
- ✅ Block user with reason
- ✅ Unblock user
- ✅ Check current block status
- ✅ Visual status indicators
- ✅ Warning messages
- ✅ Integration with user management flow

## Usage Flow

### Admin Blocks a User
1. Admin goes to Users page
2. Clicks ⋮ menu on user
3. Selects "Manage User"
4. Clicks "Block/Unblock User" in Danger Zone
5. Enters reason for blocking
6. Clicks "Block User"
7. User is blocked from withdrawals and utilities

### What Happens When User is Blocked
When a blocked user tries to:
- Withdraw NGNZ → Returns 403 error
- Withdraw crypto → Returns 403 error
- Purchase airtime → Returns 403 error
- Pay electricity → Returns 403 error
- Place bet → Returns 403 error
- Pay for cable TV → Returns 403 error
- Purchase data → Returns 403 error

**Error Response**:
```json
{
  "success": false,
  "error": "Your account is blocked. Please contact support.",
  "isBlocked": true,
  "blockedAt": "2026-01-08T12:00:00.000Z"
}
```

### Admin Unblocks a User
1. Admin goes to Block/Unblock page
2. Sees user is currently blocked with reason
3. Clicks "Unblock User"
4. User can now perform all transactions

## API Endpoints

### Block User
```http
POST /blockuser/block
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "email": "user@example.com",
  "reason": "Suspicious activity detected"
}
```

**Response**:
```json
{
  "success": true,
  "message": "User blocked successfully.",
  "user": {
    "id": "user_id",
    "email": "user@example.com",
    "isBlocked": true,
    "blockReason": "Suspicious activity detected",
    "blockedAt": "2026-01-08T12:00:00.000Z"
  }
}
```

### Unblock User
```http
POST /blockuser/unblock
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "email": "user@example.com"
}
```

### Check Block Status
```http
GET /blockuser/check?email=user@example.com
Authorization: Bearer <admin_token>
```

## Integration Checklist

### Backend
- [ ] Add `isBlocked`, `blockReason`, `blockedAt`, `unblockedAt` fields to User model
- [ ] Mount `/blockuser` routes in server.js
- [ ] Add `requireNotBlocked` middleware to NGNZ withdrawal routes
- [ ] Add `requireNotBlocked` middleware to crypto withdrawal routes
- [ ] Add `requireNotBlocked` middleware to `data.js` routes
- [ ] Add `requireNotBlocked` middleware to `airtime.js` routes
- [ ] Add `requireNotBlocked` middleware to `electricity.js` routes
- [ ] Add `requireNotBlocked` middleware to `betting.js` routes
- [ ] Add `requireNotBlocked` middleware to `cabletv.js` routes
- [ ] Test block functionality
- [ ] Test unblock functionality

### Frontend
- [x] Create BlockUser page
- [x] Add block/unblock services
- [x] Add block button to UserActions
- [x] Add routing
- [x] Build successfully

## Security Considerations

1. **Admin Only**: Block/unblock operations require admin authentication
2. **Audit Trail**: All blocks are logged with:
   - Timestamp (`blockedAt`)
   - Reason (`blockReason`)
   - Admin who performed the action (in logs)

3. **Fail Open**: If check fails due to error, user is NOT blocked (for business continuity)

4. **Reversible**: Blocks can be easily removed by admins

## Error Handling

The `checkUserBlocked` function:
- Returns `{ isBlocked: false }` if user not found (fail open)
- Returns `{ isBlocked: false }` if error occurs (fail open)
- Logs all errors for debugging
- Provides detailed error messages to blocked users

## Testing

### Test Block Functionality
1. Block a user via admin panel
2. Try to withdraw as that user → Should fail with 403
3. Try to purchase airtime as that user → Should fail with 403
4. Check logs for block attempt

### Test Unblock Functionality
1. Unblock the user
2. Try to withdraw → Should succeed
3. Try to purchase utilities → Should succeed

### Test Edge Cases
1. Try to block non-existent user → Should return 404
2. Try to block already blocked user → Should return error
3. Try to unblock non-blocked user → Should return error

## Maintenance

### View All Blocked Users
```javascript
// In MongoDB shell or admin tool
db.users.find({ isBlocked: true }).project({ email: 1, blockReason: 1, blockedAt: 1 })
```

### Unblock All Users (Emergency)
```javascript
// CAUTION: Only use in emergency
db.users.updateMany({ isBlocked: true }, { $set: { isBlocked: false, blockReason: null } })
```

---

**Status**: ✅ Frontend Complete | ⏳ Backend Integration Pending
**Last Updated**: 2026-01-08
