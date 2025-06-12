// routes/userRoutes.js
const express = require('express');
const router = express.Router();
const User = require('../models/user');

// GET /check-username?username=john
router.get('/check-username', async (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ message: 'Username is required' });
  }

  try {
    const userExists = await User.exists({ username: username });

    if (userExists) {
      return res.status(200).json({ exists: true, message: 'Username already taken' });
    } else {
      return res.status(200).json({ exists: false, message: 'Username is available' });
    }
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;
