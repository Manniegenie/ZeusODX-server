const admin = require('firebase-admin');
const User = require('../models/user');

admin.initializeApp({
  credential: admin.credential.applicationDefault()
});

module.exports = async function sendNotification(userId, message) {
  const user = await User.findById(userId);
  if (!user || !user.fcmToken) return;

  const payload = {
    notification: {
      title: 'Transaction Update',
      body: message,
    },
    token: user.fcmToken
  };

  try {
    await admin.messaging().send(payload);
    console.log(`📲 Push sent to ${userId}`);
  } catch (err) {
    console.error('❌ FCM error:', err);
  }
};
