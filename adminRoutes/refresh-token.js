const express = require('express');
const router = express.Router();
const User = require('../models/user'); // Adjust path as needed

router.get('/refresh-tokens', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: 'Email query parameter is required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() }).select('refreshTokens');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Optionally, return only the most recent token(s), for example the latest one:
    const sortedTokens = user.refreshTokens.sort((a, b) => b.createdAt - a.createdAt);

    res.json({
      email,
      refreshTokens: sortedTokens, // or: sortedTokens[0] to send only the latest token
    });
  } catch (error) {
    console.error('Error fetching refresh tokens:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
