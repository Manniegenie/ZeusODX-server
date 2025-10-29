const express = require('express');
const router = express.Router();
const { Expo } = require('expo-server-sdk');
const User = require('../models/user');
const notificationService = require('../services/notificationService');

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

// POST /notification/register-token (Expo legacy)
router.post('/register-token', async (req, res) => {
  try {
    const { expoPushToken, deviceId, userId } = req.body;

    if (!expoPushToken || !deviceId) {
      return res.status(400).json({ error: 'expoPushToken and deviceId are required.' });
    }

    // If userId is provided, update that specific user
    if (userId) {
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found.' });
      }
      
      user.expoPushToken = expoPushToken;
      user.deviceId = deviceId;
      await user.save();
      
      console.log(`✅ Push token registered for authenticated user: ${user.email || user.username}`);
      return res.json({ message: 'Push token registered successfully for authenticated user.' });
    }

    // Fallback: Find or create a user based on deviceId (for unauthenticated users)
    let user = await User.findOne({ deviceId });
    if (!user) {
      user = new User({ 
        deviceId, 
        expoPushToken,
        email: `device_${deviceId}@temp.com`, // Required field
        password: 'temp_password', // Required for some operations
        isEmailVerified: false
      });
    } else {
      user.expoPushToken = expoPushToken;
    }

    await user.save();
    console.log(`✅ Push token registered for device: ${deviceId}`);
    return res.json({ message: 'Push token registered successfully.' });
  } catch (err) {
    console.error('Error registering push token:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /notification/send-all
router.post('/send-all', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    const users = await User.find({ expoPushToken: { $ne: null } });
    if (!users.length) {
      return res.status(404).json({ error: 'No users with push tokens found.' });
    }

    const expo = new Expo();
    const notifications = users.map(user => ({
      to: user.expoPushToken,
      sound: 'default',
      body: message,
    }));

    const chunks = expo.chunkPushNotifications(notifications);
    const tickets = [];

    for (const chunk of chunks) {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    }

    return res.json({ message: 'Notifications sent to all users.', tickets });
  } catch (err) {
    console.error('Error sending notifications:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /notification/register-fcm-token
router.post('/register-fcm-token', async (req, res) => {
  try {
    console.log('FCM registration request:', req.body);
    const { fcmToken, deviceId, userId } = req.body;

    if (!fcmToken) {
      return res.status(400).json({ error: 'fcmToken is required.' });
    }

    if (userId) {
      console.log('Updating existing user:', userId);
      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ error: 'User not found.' });
      user.fcmToken = fcmToken;
      if (deviceId) user.deviceId = deviceId;
      await user.save();
      return res.json({ message: 'FCM token registered for user.' });
    }

    if (!deviceId) return res.status(400).json({ error: 'deviceId is required when userId is not provided.' });
    
    console.log('Looking for user with deviceId:', deviceId);
    let user = await User.findOne({ deviceId });
    
    if (!user) {
      console.log('Creating new user for deviceId:', deviceId);
      // Create a new user with required fields
      user = new User({ 
        deviceId, 
        fcmToken,
        email: `device_${deviceId}@temp.com`, // Required field
        password: 'temp_password', // Required for some operations
        isEmailVerified: false
      });
    } else {
      console.log('Updating existing user for deviceId:', deviceId);
      user.fcmToken = fcmToken;
    }
    
    console.log('Saving user...');
    await user.save();
    console.log('User saved successfully');
    return res.json({ message: 'FCM token registered for device.' });
  } catch (err) {
    console.error('Error registering FCM token:', err);
    return res.status(500).json({ error: 'Internal server error.', details: err.message });
  }
});

module.exports = router;
 
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