const express = require('express');
const router = express.Router();
const { Expo } = require('expo-server-sdk');
const User = require('../models/user');

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
      user = new User({ deviceId, expoPushToken });
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
    const { fcmToken, deviceId, userId } = req.body;

    if (!fcmToken) {
      return res.status(400).json({ error: 'fcmToken is required.' });
    }

    if (userId) {
      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ error: 'User not found.' });
      user.fcmToken = fcmToken;
      if (deviceId) user.deviceId = deviceId;
      await user.save();
      return res.json({ message: 'FCM token registered for user.' });
    }

    if (!deviceId) return res.status(400).json({ error: 'deviceId is required when userId is not provided.' });
    let user = await User.findOne({ deviceId });
    if (!user) user = new User({ deviceId, fcmToken });
    else user.fcmToken = fcmToken;
    await user.save();
    return res.json({ message: 'FCM token registered for device.' });
  } catch (err) {
    console.error('Error registering FCM token:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;