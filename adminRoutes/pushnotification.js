const express = require('express');
const router = express.Router();
const User = require('../models/user');
const notificationService = require('../services/notificationService');
async function savePushCredentials({ userId, deviceId, expoPushToken, fcmToken, platform }) {
  // Expo-only: fcmToken is ignored but kept for backward compatibility
  if (!expoPushToken) {
    const error = new Error('expoPushToken is required.');
    error.status = 400;
    throw error;
  }

  if (!userId && !deviceId) {
    const error = new Error('userId or deviceId is required.');
    error.status = 400;
    throw error;
  }

  let user = null;

  if (userId) {
    user = await User.findById(userId);
    if (!user) {
      const error = new Error('User not found.');
      error.status = 404;
      throw error;
    }
  }

  if (!user && deviceId) {
    user = await User.findOne({ deviceId });
  }

  if (!user && deviceId && !userId) {
    user = new User({
      deviceId,
      expoPushToken: expoPushToken || undefined,
      fcmToken: fcmToken || undefined,
      email: `device_${deviceId}@temp.com`,
      password: 'temp_password',
      isEmailVerified: false,
    });
  }

  if (!user) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }

  if (deviceId) {
    user.deviceId = deviceId;
  }
  if (expoPushToken) {
    user.expoPushToken = expoPushToken;
  }
  // FCM removed - clear any existing FCM token
  user.fcmToken = null;
  if (platform) {
    user.pushPlatform = platform;
  }

  await user.save();

  return user;
}
// Test Expo notification service (Firebase/FCM removed)
router.get('/test-firebase', async (req, res) => {
  // Expo service is always available, no Firebase needed
  res.json({ 
    success: true, 
    message: 'Expo notification service is ready',
    timestamp: new Date().toISOString()
  });
});

// POST /notification/register (recommended)
router.post('/register', async (req, res) => {
  try {
    const { expoPushToken, fcmToken, deviceId, userId, platform } = req.body;

    const user = await savePushCredentials({
      userId,
      deviceId,
      expoPushToken,
      fcmToken,
      platform,
    });

    return res.json({ message: 'Push token(s) registered successfully.', userId: user._id });
  } catch (error) {
    console.error('Error registering push tokens:', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /notification/check-token - Check if device has a token in DB (no auth required)
router.get('/check-token', async (req, res) => {
  try {
    // Get deviceId from query parameters (no auth required)
    const { deviceId } = req.query;
    
    if (!deviceId) {
      return res.status(400).json({ 
        success: false,
        error: 'deviceId is required' 
      });
    }

    // Find user by deviceId
    const user = await User.findOne({ deviceId }).select('expoPushToken deviceId');
    
    if (!user) {
      // Device not found - no token registered
      return res.json({ 
        success: true,
        hasToken: false,
        message: 'Device does not have a push token registered'
      });
    }

    // Check if device has a token
    const hasToken = !!(user.expoPushToken && user.expoPushToken.trim().length > 0);

    return res.json({ 
      success: true,
      hasToken,
      message: hasToken ? 'Device has a push token registered' : 'Device does not have a push token'
    });
  } catch (err) {
    console.error('❌ Error checking push token:', {
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ 
      success: false,
      error: 'Internal server error.' 
    });
  }
});

// POST /notification/register-token (Expo legacy)
router.post('/register-token', async (req, res) => {
  try {
    const { expoPushToken, deviceId, userId, platform, fcmToken } = req.body;

    console.log('📱 Token registration request received:', {
      platform: platform || 'unknown',
      hasExpoToken: !!expoPushToken,
      expoTokenPrefix: expoPushToken ? expoPushToken.substring(0, 20) + '...' : 'none',
      hasDeviceId: !!deviceId,
      deviceId: deviceId || 'none',
      hasUserId: !!userId,
      userId: userId || 'none',
    });

    if (!expoPushToken) {
      console.error('❌ Token registration failed: expoPushToken is required');
      return res.status(400).json({ error: 'expoPushToken is required.' });
    }

    // Validate Expo token format
    if (!expoPushToken.startsWith('ExponentPushToken[') && !expoPushToken.startsWith('ExpoPushToken[')) {
      console.warn('⚠️ Unexpected token format:', expoPushToken.substring(0, 50));
    }

    const user = await savePushCredentials({
      userId,
      deviceId,
      expoPushToken,
      fcmToken,
      platform,
    });

    console.log(`✅ Push token registered successfully for:`, {
      platform: platform || 'unknown',
      user: user.email || user.username || deviceId || 'unknown',
      userId: user._id,
      hasExpoToken: !!user.expoPushToken,
      pushPlatform: user.pushPlatform || 'unknown',
    });

    return res.json({ 
      message: 'Push token registered successfully.', 
      userId: user._id,
      platform: platform || 'unknown',
    });
  } catch (err) {
    console.error('❌ Error registering push token:', {
      error: err.message,
      stack: err.stack,
      platform: req.body?.platform || 'unknown',
      hasExpoToken: !!req.body?.expoPushToken,
      hasDeviceId: !!req.body?.deviceId,
      hasUserId: !!req.body?.userId,
    });
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /notification/send-all
router.post('/send-all', async (req, res) => {
  try {
    const { title, body, message, data = {} } = req.body;

    // Support both 'message' (legacy) and 'body' (new format)
    const notificationBody = body || message;
    const notificationTitle = title || 'ZeusODX Notification';

    if (!notificationBody) {
      return res.status(400).json({ error: 'Message/body is required.' });
    }

    // Get all users with Expo push tokens
    const users = await User.find({
      expoPushToken: { $ne: null }
    }).select('_id expoPushToken');

    if (!users.length) {
      return res.status(404).json({ error: 'No users with push tokens found.' });
    }

    // Use notificationService to send to all users
    const results = await Promise.allSettled(
      users.map(user => 
        notificationService.sendCustomNotification(
          user._id.toString(),
          notificationTitle,
          notificationBody,
          data,
          { sound: 'default', priority: 'high' }
        )
      )
    );

    const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)).length;

    return res.json({ 
      success: true,
      message: `Notifications sent to ${successful} out of ${users.length} users.`,
      total: users.length,
      successful,
      failed,
      results: results.map((r, i) => ({
        userId: users[i]._id.toString(),
        success: r.status === 'fulfilled' && r.value.success,
        error: r.status === 'rejected' ? r.reason?.message : (r.status === 'fulfilled' && !r.value.success ? r.value.message : null)
      }))
    });
  } catch (err) {
    console.error('Error sending notifications:', err);
    return res.status(500).json({ error: 'Internal server error.', details: err.message });
  }
});

// GET /notification/stats - Get notification statistics
router.get('/stats', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const usersWithTokens = await User.countDocuments({
      expoPushToken: { $ne: null }
    });
    const expoTokens = await User.countDocuments({ expoPushToken: { $ne: null } });

    res.json({
      totalUsers,
      usersWithTokens,
      expoTokens,
      lastSent: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error fetching notification stats:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /notification/register-fcm-token (DEPRECATED - FCM removed, use Expo only)
router.post('/register-fcm-token', async (req, res) => {
  return res.status(410).json({ 
    error: 'FCM is no longer supported. Please use Expo push tokens instead.',
    deprecated: true,
    alternative: 'Use /notification/register-token with expoPushToken'
  });
});

// POST /notification/unregister
router.post('/unregister', async (req, res) => {
  try {
    const { userId, deviceId } = req.body;

    if (!userId && !deviceId) {
      return res.status(400).json({ error: 'userId or deviceId is required.' });
    }

    const user = userId
      ? await User.findById(userId)
      : await User.findOne({ deviceId });

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    user.expoPushToken = null;
    user.fcmToken = null;

    if (deviceId && user.deviceId && user.deviceId !== deviceId) {
      console.warn(`⚠️ Device ID mismatch during unregister. Stored=${user.deviceId} Provided=${deviceId}`);
    }

    await user.save();

    return res.json({ message: 'Push tokens removed successfully.' });
  } catch (error) {
    console.error('Error unregistering push tokens:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /notification/send-fcm (test) - send to userId or deviceId
router.post('/send-fcm', async (req, res) => {
  try {
    const { userId, deviceId, title = 'Test Notification', body = 'Hello from ZeusODX', data = {} } = req.body;

    if (!userId && !deviceId) {
      return res.status(400).json({ error: 'Provide userId or deviceId' });
    }

    let targetUserId = userId;
    if (!targetUserId && deviceId) {
      const user = await User.findOne({ deviceId }).select('_id');
      if (!user) return res.status(404).json({ error: 'User with deviceId not found' });
      targetUserId = user._id.toString();
    }

    const result = await notificationService.sendCustomNotification(
      targetUserId,
      title,
      body,
      data,
      { sound: 'default', priority: 'high' }
    );

    if (!result.success) {
      return res.status(500).json({ error: 'Failed to send', details: result.message || result.error });
    }

    return res.json({ success: true, via: result.via || 'fcm/expo', result });
  } catch (err) {
    console.error('Error sending FCM test notification:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * POST /notification/mock-test
 * Comprehensive mock test endpoint for all notification types
 * Tests: Deposit, Withdrawal, NGNZ Withdrawal, Swap, Payment, etc.
 */
router.post('/mock-test', async (req, res) => {
  try {
    const { userId, deviceId, testType = 'all' } = req.body;

    if (!userId && !deviceId) {
      return res.status(400).json({ 
        error: 'Provide userId or deviceId',
        example: { userId: 'user_id_here' }
      });
    }

    // Resolve userId from deviceId if needed
    let targetUserId = userId;
    if (!targetUserId && deviceId) {
      const user = await User.findOne({ deviceId }).select('_id email username');
      if (!user) {
        return res.status(404).json({ error: 'User with deviceId not found' });
      }
      targetUserId = user._id.toString();
    }

    // Verify user exists and has Expo push token
    const user = await User.findById(targetUserId).select('_id email username expoPushToken');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.expoPushToken) {
      return res.status(400).json({ 
        error: 'User has no Expo push token registered',
        hint: 'Register an Expo push token first using /notification/register-token'
      });
    }

    const results = {};
    const testTypes = testType === 'all' 
      ? ['deposit', 'withdrawal', 'ngnz_withdrawal', 'swap', 'payment', 'custom']
      : [testType.toLowerCase()];

    // Test Deposit Notification
    if (testTypes.includes('deposit')) {
      try {
        const depositResult = await notificationService.sendDepositNotification(
          targetUserId,
          0.5,
          'BTC',
          'confirmed',
          { reference: 'MOCK_TEST_REF', transactionId: 'MOCK_TX_ID', hash: 'MOCK_HASH' }
        );
        results.deposit = {
          success: depositResult.success,
          via: depositResult.via,
          message: depositResult.message || 'Deposit notification sent'
        };
      } catch (err) {
        results.deposit = { success: false, error: err.message };
      }
    }

    // Test Withdrawal Notification
    if (testTypes.includes('withdrawal')) {
      try {
        const withdrawalResult = await notificationService.sendWithdrawalNotification(
          targetUserId,
          0.1,
          'ETH',
          'completed',
          { reference: 'MOCK_WD_REF', transactionId: 'MOCK_WD_TX', hash: 'MOCK_WD_HASH', fee: 0.001 }
        );
        results.withdrawal = {
          success: withdrawalResult.success,
          via: withdrawalResult.via,
          message: withdrawalResult.message || 'Withdrawal notification sent'
        };
      } catch (err) {
        results.withdrawal = { success: false, error: err.message };
      }
    }

    // Test NGNZ Withdrawal Notification
    if (testTypes.includes('ngnz_withdrawal')) {
      try {
        const ngnzWithdrawalResult = await notificationService.sendWithdrawalNotification(
          targetUserId,
          5000,
          'NGNZ',
          'completed',
          { 
            reference: 'MOCK_NGNZ_REF', 
            transactionId: 'MOCK_NGNZ_TX',
            withdrawalType: 'NGNZ_TO_BANK',
            bankName: 'Test Bank',
            accountNumber: '****1234'
          }
        );
        results.ngnz_withdrawal = {
          success: ngnzWithdrawalResult.success,
          via: ngnzWithdrawalResult.via,
          message: ngnzWithdrawalResult.message || 'NGNZ withdrawal notification sent'
        };
      } catch (err) {
        results.ngnz_withdrawal = { success: false, error: err.message };
      }
    }

    // Test Swap Notification
    if (testTypes.includes('swap')) {
      try {
        const swapResult = await notificationService.sendSwapNotification(
          targetUserId,
          1,
          'BTC',
          50000,
          'NGNZ',
          { reference: 'MOCK_SWAP_REF', transactionId: 'MOCK_SWAP_TX' }
        );
        results.swap = {
          success: swapResult.success,
          via: swapResult.via,
          message: swapResult.message || 'Swap notification sent'
        };
      } catch (err) {
        results.swap = { success: false, error: err.message };
      }
    }

    // Test Payment Notification
    if (testTypes.includes('payment')) {
      try {
        const paymentResult = await notificationService.sendPaymentNotification(
          targetUserId,
          1000,
          'NGNZ',
          'Cable TV Subscription',
          { reference: 'MOCK_PAYMENT_REF', transactionId: 'MOCK_PAYMENT_TX' }
        );
        results.payment = {
          success: paymentResult.success,
          via: paymentResult.via,
          message: paymentResult.message || 'Payment notification sent'
        };
      } catch (err) {
        results.payment = { success: false, error: err.message };
      }
    }

    // Test Custom Notification
    if (testTypes.includes('custom')) {
      try {
        const customResult = await notificationService.sendCustomNotification(
          targetUserId,
          '🧪 Mock Test Notification',
          'This is a test notification from ZeusODX notification system',
          { testType: 'mock', timestamp: new Date().toISOString() },
          { sound: 'default', priority: 'high' }
        );
        results.custom = {
          success: customResult.success,
          via: customResult.via,
          message: customResult.message || 'Custom notification sent'
        };
      } catch (err) {
        results.custom = { success: false, error: err.message };
      }
    }

    // Calculate summary
    const totalTests = Object.keys(results).length;
    const successfulTests = Object.values(results).filter(r => r.success).length;
    const failedTests = totalTests - successfulTests;

    return res.json({
      success: true,
      message: `Mock test completed: ${successfulTests}/${totalTests} notifications sent successfully`,
      userId: targetUserId,
      userEmail: user.email,
      userUsername: user.username,
      hasExpoToken: !!user.expoPushToken,
      testType,
      summary: {
        total: totalTests,
        successful: successfulTests,
        failed: failedTests
      },
      results,
      usage: {
        endpoint: 'POST /notification/mock-test',
        body: {
          userId: 'user_id (required if deviceId not provided)',
          deviceId: 'device_id (required if userId not provided)',
          testType: 'all | deposit | withdrawal | ngnz_withdrawal | swap | payment | custom'
        }
      }
    });
  } catch (err) {
    console.error('Error in mock test:', err);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

module.exports = router;