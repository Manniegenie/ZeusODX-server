const express = require('express');
const router = express.Router();
const User = require('../models/user');
const notificationService = require('../services/notificationService');
async function savePushCredentials({ userId, deviceId, expoPushToken, fcmToken, platform }) {
  if (!expoPushToken && !fcmToken) {
    const error = new Error('expoPushToken or fcmToken is required.');
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
  if (fcmToken) {
    user.fcmToken = fcmToken;
  }
  if (platform) {
    user.pushPlatform = platform;
  }

  await user.save();

  return user;
}
// Test Firebase connection
router.get('/test-firebase', async (req, res) => {
  try {
    const fcmAdmin = require('../services/fcmAdmin');
    res.json({ 
      success: true, 
      message: 'Firebase Admin SDK initialized successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Firebase test error:', error);
    res.status(500).json({ 
      error: 'Firebase initialization failed', 
      details: error.message 
    });
  }
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

// POST /notification/register-token (Expo legacy)
router.post('/register-token', async (req, res) => {
  try {
    const { expoPushToken, deviceId, userId, platform, fcmToken } = req.body;

    if (!expoPushToken) {
      return res.status(400).json({ error: 'expoPushToken is required.' });
    }

    const user = await savePushCredentials({
      userId,
      deviceId,
      expoPushToken,
      fcmToken,
      platform,
    });

    console.log(`✅ Push token registered for user/device: ${user.email || user.username || deviceId}`);
    return res.json({ message: 'Push token registered successfully.', userId: user._id });
  } catch (err) {
    console.error('Error registering push token:', err);
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

    // Get all users with push tokens
    const users = await User.find({
      $or: [
        { fcmToken: { $ne: null } },
        { expoPushToken: { $ne: null } }
      ]
    }).select('_id fcmToken expoPushToken');

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
      $or: [
        { fcmToken: { $ne: null } },
        { expoPushToken: { $ne: null } }
      ]
    });
    const fcmTokens = await User.countDocuments({ fcmToken: { $ne: null } });
    const expoTokens = await User.countDocuments({ expoPushToken: { $ne: null } });

    res.json({
      totalUsers,
      usersWithTokens,
      fcmTokens,
      expoTokens,
      lastSent: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error fetching notification stats:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /notification/register-fcm-token
router.post('/register-fcm-token', async (req, res) => {
  try {
    const { fcmToken, deviceId, userId, platform } = req.body;

    if (!fcmToken) {
      return res.status(400).json({ error: 'fcmToken is required.' });
    }

    const user = await savePushCredentials({
      userId,
      deviceId,
      fcmToken,
      expoPushToken: null,
      platform,
    });

    return res.json({ message: 'FCM token registered successfully.', userId: user._id });
  } catch (err) {
    console.error('Error registering FCM token:', err);
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: 'Internal server error.', details: err.message });
  }
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

module.exports = router;