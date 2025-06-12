// routes/user.js

const express = require('express');
const router = express.Router();
const User = require('../models/user');

// PATCH /users/remove-passwordpin
router.patch('/remove-passwordpin', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    user.passwordpin = null; // You could also use: undefined or delete user.passwordpin;
    await user.save();

    return res.json({ message: 'Password PIN removed successfully.' });
  } catch (err) {
    console.error('Error removing password PIN:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
