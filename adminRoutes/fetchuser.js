const express = require('express');
const router = express.Router();
const User = require('../models/user'); // Adjust path as needed

// GET /admin/user-lookup?email=user@example.com
router.get('/user-lookup', async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ 
        error: 'Email query parameter is required',
        usage: 'GET /admin/user-lookup?email=user@example.com'
      });
    }

    const user = await User.findOne({ email: email.toLowerCase() })
      .select('_id email firstName lastName kycLevel createdAt updatedAt isActive phoneNumber');
    
    if (!user) {
      return res.status(404).json({ 
        error: 'User not found',
        email: email.toLowerCase()
      });
    }

    // Get KYC limits if method exists
    let kycLimits = null;
    if (user.getKycLimits && typeof user.getKycLimits === 'function') {
      try {
        kycLimits = user.getKycLimits();
      } catch (error) {
        console.warn('Failed to get KYC limits:', error.message);
      }
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName || null,
        lastName: user.lastName || null,
        fullName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || null,
        kycLevel: user.kycLevel || 0,
        phoneNumber: user.phoneNumber || null,
        isActive: user.isActive !== false, // Default to true if undefined
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        kycLimits: kycLimits
      },
      meta: {
        searchedEmail: email.toLowerCase(),
        foundAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error fetching user by email:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /admin/users/recent?limit=10
router.get('/users/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50); // Max 50 users
    
    const users = await User.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('_id email firstName lastName kycLevel createdAt isActive');

    const formattedUsers = users.map(user => ({
      id: user._id,
      email: user.email,
      fullName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'No name',
      kycLevel: user.kycLevel || 0,
      isActive: user.isActive !== false,
      createdAt: user.createdAt
    }));

    res.json({
      success: true,
      users: formattedUsers,
      meta: {
        total: formattedUsers.length,
        limit: limit,
        retrievedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error fetching recent users:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /admin/users/search?q=john&field=firstName
router.get('/users/search', async (req, res) => {
  try {
    const { q, field = 'email' } = req.query;
    
    if (!q) {
      return res.status(400).json({ 
        error: 'Search query parameter "q" is required',
        usage: 'GET /admin/users/search?q=john&field=firstName'
      });
    }

    const searchFields = ['email', 'firstName', 'lastName', '_id'];
    if (!searchFields.includes(field)) {
      return res.status(400).json({ 
        error: 'Invalid search field',
        allowedFields: searchFields
      });
    }

    let searchQuery = {};
    
    if (field === '_id') {
      // Exact match for ID
      searchQuery[field] = q;
    } else {
      // Case-insensitive partial match for text fields
      searchQuery[field] = { $regex: q, $options: 'i' };
    }

    const users = await User.find(searchQuery)
      .limit(20) // Limit results
      .select('_id email firstName lastName kycLevel createdAt isActive')
      .sort({ createdAt: -1 });

    const formattedUsers = users.map(user => ({
      id: user._id,
      email: user.email,
      fullName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'No name',
      kycLevel: user.kycLevel || 0,
      isActive: user.isActive !== false,
      createdAt: user.createdAt
    }));

    res.json({
      success: true,
      users: formattedUsers,
      meta: {
        searchQuery: q,
        searchField: field,
        resultsCount: formattedUsers.length,
        searchedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error searching users:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /admin/users/:userId/details
router.get('/users/:userId/details', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await User.findById(userId)
      .select('-password -refreshTokens'); // Exclude sensitive fields

    if (!user) {
      return res.status(404).json({ 
        error: 'User not found',
        userId: userId
      });
    }

    // Get KYC limits if method exists
    let kycLimits = null;
    if (user.getKycLimits && typeof user.getKycLimits === 'function') {
      try {
        kycLimits = user.getKycLimits();
      } catch (error) {
        console.warn('Failed to get KYC limits:', error.message);
      }
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName || null,
        lastName: user.lastName || null,
        fullName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || null,
        phoneNumber: user.phoneNumber || null,
        kycLevel: user.kycLevel || 0,
        isActive: user.isActive !== false,
        emailVerified: user.emailVerified || false,
        phoneVerified: user.phoneVerified || false,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.lastLoginAt || null,
        kycLimits: kycLimits,
        // Add other non-sensitive fields as needed
        country: user.country || null,
        state: user.state || null,
        city: user.city || null
      },
      meta: {
        retrievedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error fetching user details:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /admin/users/stats
router.get('/users/stats', async (req, res) => {
  try {
    const [
      totalUsers,
      kycStats,
      recentUsers,
      activeUsers
    ] = await Promise.all([
      User.countDocuments({}),
      User.aggregate([
        { $group: { _id: '$kycLevel', count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]),
      User.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      }),
      User.countDocuments({ isActive: true })
    ]);

    const kycBreakdown = {};
    kycStats.forEach(stat => {
      kycBreakdown[`level${stat._id || 0}`] = stat.count;
    });

    res.json({
      success: true,
      stats: {
        totalUsers,
        activeUsers,
        recentUsers: recentUsers, // Last 24 hours
        kycBreakdown,
        percentageActive: totalUsers > 0 ? ((activeUsers / totalUsers) * 100).toFixed(1) : 0
      },
      meta: {
        generatedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;