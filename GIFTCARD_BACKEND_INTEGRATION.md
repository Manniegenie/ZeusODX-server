# Gift Card Backend Integration Guide

## Current Status

✅ **Frontend**: Complete and deployed
❌ **Backend**: Routes exist but not mounted in server.js

## Error Encountered

```
Failed to load resource: the server responded with a status of 404
Error fetching gift card submissions
```

**Cause**: The `/admin/giftcard/submissions` endpoint is not accessible because the routes are not mounted in `server.js`.

## Files Already Created

The following backend files already exist and are ready to use:

1. ✅ `adminRoutes/giftcard.js` - All gift card endpoints (rates + submissions)
2. ✅ `models/giftcard.js` - Gift card submission model
3. ✅ `models/giftcardPrice.js` - Gift card rate model

## Integration Steps

### Step 1: Mount Gift Card Routes in Server

**File**: `server.js`

**Location**: After other admin routes (around line 415+)

**Add these lines**:

```javascript
// Gift Card Management Routes
const giftCardRoutes = require("./adminRoutes/giftcard");
app.use("/admin/giftcard", authenticateAdminToken, requireModerator, giftCardRoutes);
```

**Full Context**:
```javascript
// Existing routes...
const userManagementRoutes = require("./adminRoutes/usermanagement");
app.use("/usermanagement", authenticateAdminToken, requireModerator, userManagementRoutes);

// ADD THIS:
const giftCardRoutes = require("./adminRoutes/giftcard");
app.use("/admin/giftcard", authenticateAdminToken, requireModerator, giftCardRoutes);

// More routes continue...
```

### Step 2: Verify Dependencies

Ensure these packages are installed:

```bash
npm list mongoose cloudinary multer
```

All should already be installed as they're used by the existing gift card rate system.

### Step 3: Restart Server

```bash
# Stop server
# Restart server
npm start
# or
node server.js
```

## Available Endpoints After Integration

### Rate Management (Already Working)
- `GET /admin/giftcard/rates` - Get all rates
- `POST /admin/giftcard/rates` - Create rate
- `POST /admin/giftcard/rates/bulk` - Bulk create rates
- `PUT /admin/giftcard/rates/:id` - Update rate
- `DELETE /admin/giftcard/rates/:id` - Delete rate

### Submission Management (NEW - Will Work After Mounting)
- `GET /admin/giftcard/submissions` - List submissions with filtering
- `GET /admin/giftcard/submissions/:id` - Get submission details
- `POST /admin/giftcard/submissions/:id/approve` - Approve submission
- `POST /admin/giftcard/submissions/:id/reject` - Reject submission
- `POST /admin/giftcard/submissions/:id/review` - Mark as reviewing

## Testing the Integration

### 1. Check Server Logs

After mounting and restarting, you should see:
```
✓ Gift card routes mounted at /admin/giftcard
```

### 2. Test Endpoint Availability

```bash
# Test if submissions endpoint is accessible (should return 401 without auth)
curl http://localhost:YOUR_PORT/admin/giftcard/submissions
```

Expected response: Authentication error (401) - this means the route is accessible!

### 3. Test from Frontend

1. Login to admin panel
2. Navigate to "Gift Cards" → "Review submissions"
3. Should see submission list (empty if no submissions yet)
4. Check browser console - no 404 errors

## Expected Behavior After Integration

### Before (Current State - 404 Error)
```
GET /admin/giftcard/submissions
❌ 404 Not Found
```

### After (Mounted Routes)
```
GET /admin/giftcard/submissions
✅ 200 OK (with empty array if no submissions)
✅ 401 Unauthorized (if not authenticated)
✅ 403 Forbidden (if not moderator)
```

## Verification Checklist

- [ ] Add gift card route import to server.js
- [ ] Mount route with proper authentication and moderator middleware
- [ ] Restart server
- [ ] Check server logs for successful route mounting
- [ ] Test frontend access - no 404 errors
- [ ] Verify authentication is required
- [ ] Verify moderator permission is required

## File Structure Overview

```
ZeusODX-server/
├── server.js                           ← ADD ROUTE MOUNTING HERE
├── adminRoutes/
│   └── giftcard.js                    ✅ EXISTS (all endpoints defined)
├── models/
│   ├── giftcard.js                    ✅ EXISTS (submission model)
│   └── giftcardPrice.js               ✅ EXISTS (rate model)
└── routes/
    ├── giftcard.js                    ✅ EXISTS (user submission endpoint)
    ├── giftcardrates.js               ✅ EXISTS (rate calculation)
    └── giftcardcountry.js             ✅ EXISTS (country lookup)
```

## Security Notes

The routes are protected by:
1. **authenticateAdminToken** - Requires valid admin JWT token
2. **requireModerator** - Requires moderator role or higher
3. **Input validation** - All endpoints validate request data
4. **File upload limits** - Max 20 images per submission
5. **Cloudinary integration** - Secure image storage

## Troubleshooting

### Issue: Still Getting 404 After Mounting

**Check**:
1. Server restarted properly?
2. Route import path correct?
3. Route mounted before server starts listening?
4. No syntax errors in server.js?

### Issue: Getting 401 Unauthorized

**Solution**: This is expected! It means the route is working. The frontend will handle authentication automatically.

### Issue: Getting 403 Forbidden

**Check**: Admin user has moderator role in database.

### Issue: Submissions Not Saving

**Check**:
1. MongoDB connection active?
2. GiftCard model imported correctly?
3. Check server logs for errors

## Sample Server.js Integration

```javascript
// ... other imports ...

// Admin Routes
const userManagementRoutes = require("./adminRoutes/usermanagement");
const blockUserRoutes = require("./adminRoutes/blockuser");
const giftCardRoutes = require("./adminRoutes/giftcard"); // ADD THIS

// ... middleware setup ...

// Mount Admin Routes
app.use("/usermanagement", authenticateAdminToken, requireModerator, userManagementRoutes);
app.use("/blockuser", authenticateAdminToken, requireModerator, blockUserRoutes);
app.use("/admin/giftcard", authenticateAdminToken, requireModerator, giftCardRoutes); // ADD THIS

// ... rest of server ...
```

## Expected Server Response Format

### Successful Submission List
```json
{
  "success": true,
  "data": {
    "submissions": [],
    "pagination": {
      "currentPage": 1,
      "totalPages": 0,
      "totalSubmissions": 0,
      "limit": 20
    }
  },
  "message": "Submissions fetched successfully"
}
```

### Successful Approval
```json
{
  "success": true,
  "message": "Gift card submission approved and user funded successfully",
  "data": {
    "submissionId": "...",
    "status": "APPROVED",
    "paymentAmount": 150000,
    "transactionId": "...",
    "userBalance": 275000
  }
}
```

## Next Steps After Integration

1. ✅ Mount routes in server.js
2. ✅ Restart server
3. ✅ Test frontend access
4. ✅ Create test submission (via user app)
5. ✅ Review and approve test submission
6. ✅ Verify user balance updated
7. ✅ Check transaction record created

---

**Integration Time**: ~2 minutes
**Server Restart Required**: Yes
**Database Changes Required**: No (models already exist)
**Last Updated**: 2026-01-08
