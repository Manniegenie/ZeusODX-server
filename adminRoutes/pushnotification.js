const express = require('express');
const router = express.Router();
const { Expo } = require('expo-server-sdk');
const User = require('../models/user');

// POST /notification/register-token
router.post('/register-token', async (req, res) => {
  try {
    const { expoPushToken, deviceId } = req.body;

    if (!expoPushToken || !deviceId) {
      return res.status(400).json({ error: 'expoPushToken and deviceId are required.' });
    }

    // Find or create a user based on deviceId
    let user = await User.findOne({ deviceId });
    if (!user) {
      user = new User({ deviceId, expoPushToken });
    } else {
      user.expoPushToken = expoPushToken;
    }

    await user.save();
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

module.exports = router;