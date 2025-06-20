const express = require('express');
const router = express.Router();
const User = require('../models/user');

router.post('/search', async (req, res) => {
  try {
    const { q, limit = 20 } = req.body;
    
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    const users = await User.find({
      username: { $regex: `^${q}`, $options: 'i' },
      _id: { $ne: req.user.id }
    })
    .select('username firstname lastname avatarUrl')
    .limit(Math.min(limit, 50))
    .lean();

    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;