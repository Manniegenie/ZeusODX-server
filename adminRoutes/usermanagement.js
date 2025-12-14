// routes/users.js
const express = require('express');
const router = express.Router();
const User = require('../models/user'); // adjust path to your model
const { getPricesWithCache, SUPPORTED_TOKENS } = require('../services/portfolio');

// Helper to escape user input for regex
function escapeRegex(text = '') {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * GET /users
 * Advanced filtering, pagination and sorting
 */
router.get('/users', async (req, res) => {
  try {
    const {
      limit: limitRaw = '100',
      skip: skipRaw = '0',
      kycLevel,
      emailVerified,
      chatbotTransactionVerified,
      firstname,
      lastname,
      fullname,
      nameStartsWith,
      email,
      emailDomain,
      emailStartsWith,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      q // General search query parameter
    } = req.query;

    // parse ints with sensible defaults/limits
    const limit = Math.min(Math.max(parseInt(limitRaw, 10) || 100, 1), 2000);
    const skip = Math.max(parseInt(skipRaw, 10) || 0, 0);

    // Base filter
    const filter = {};

    if (kycLevel !== undefined && kycLevel !== '') {
      const k = parseInt(kycLevel, 10);
      if (!Number.isNaN(k)) filter.kycLevel = k;
    }
    if (emailVerified !== undefined) {
      filter.emailVerified = String(emailVerified).toLowerCase() === 'true';
    }
    if (chatbotTransactionVerified !== undefined) {
      filter.chatbotTransactionVerified = String(chatbotTransactionVerified).toLowerCase() === 'true';
    }

    // Handle general search query first
    if (q) {
      const searchRegex = new RegExp(escapeRegex(q), 'i');
      filter.$or = [
        { email: { $regex: searchRegex } },
        { username: { $regex: searchRegex } },
        { firstname: { $regex: searchRegex } },
        { lastname: { $regex: searchRegex } },
        { phoneNumber: { $regex: searchRegex } }
      ];
    }

    // Build email conditions so multiple email filters don't override each other
    const emailConditions = [];
    if (email) {
      const r = new RegExp(escapeRegex(email), 'i'); // partial match anywhere
      emailConditions.push({ email: { $regex: r } });
    }
    if (emailDomain) {
      // match @domain or @sub.domain at end
      const domain = escapeRegex(emailDomain);
      const r = new RegExp(`@${domain}$`, 'i');
      emailConditions.push({ email: { $regex: r } });
    }
    if (emailStartsWith) {
      const r = new RegExp(`^${escapeRegex(emailStartsWith)}`, 'i');
      emailConditions.push({ email: { $regex: r } });
    }
    // if any email conditions exist, AND them
    if (emailConditions.length === 1) {
      Object.assign(filter, emailConditions[0]);
    } else if (emailConditions.length > 1) {
      filter.$and = filter.$and || [];
      filter.$and.push(...emailConditions);
    }

    // Name filters
    const nameOrConditions = []; // used for fullname / nameStartsWith logic
    if (firstname) {
      const r = new RegExp(escapeRegex(firstname), 'i');
      filter.firstname = { $regex: r };
    }
    if (lastname) {
      const r = new RegExp(escapeRegex(lastname), 'i');
      filter.lastname = { $regex: r };
    }

    // fullname: search across firstname, lastname, and concatenated firstname + ' ' + lastname
    if (fullname) {
      const escaped = escapeRegex(fullname);
      const r = new RegExp(escaped, 'i');
      // Use $or with $expr regexMatch for combined name. Some MongoDB versions require 4.2+
      nameOrConditions.push({ firstname: { $regex: r } });
      nameOrConditions.push({ lastname: { $regex: r } });
      nameOrConditions.push({
        $expr: {
          $regexMatch: {
            input: { $concat: ['$firstname', ' ', '$lastname'] },
            regex: escaped,
            options: 'i'
          }
        }
      });
    }

    // nameStartsWith: match start of firstname or lastname
    if (nameStartsWith) {
      const r = new RegExp(`^${escapeRegex(nameStartsWith)}`, 'i');
      nameOrConditions.push({ firstname: { $regex: r } });
      nameOrConditions.push({ lastname: { $regex: r } });
    }

    // If we have nameOrConditions, incorporate them into filter properly (merge with existing $and/$or)
    if (nameOrConditions.length) {
      // Prefer $and combining existing filter with the name $or
      if (!filter.$and && !filter.$or) {
        // If filter already contains keys like firstname/lastname, keep them and add $or for combined name queries
        filter.$or = nameOrConditions;
      } else {
        // Ensure we don't clobber an existing $and; add an $and with our $or inside
        filter.$and = filter.$and || [];
        filter.$and.push({ $or: nameOrConditions });
      }
    }

    // Build sort
    const sort = {};
    sort[sortBy] = String(sortOrder).toLowerCase() === 'desc' ? -1 : 1;

    // Select fields to return
    const users = await User.find(filter)
      .select('_id email username firstname lastname kycLevel kycStatus emailVerified phoneNumber createdAt lastBalanceUpdate')
      .sort(sort)
      .limit(limit)
      .skip(skip)
      .lean();

    const total = await User.countDocuments(filter);

    res.json({
      success: true,
      data: {
        users,
        pagination: {
          total,
          limit,
          skip,
          hasMore: skip + users.length < total
        }
      }
    });
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /users/all
 * Return all users (use with caution)
 */
router.get('/users/all', async (req, res) => {
  try {
    const users = await User.find({}).lean();
    res.json({ success: true, data: { users, total: users.length } });
  } catch (err) {
    console.error('Error fetching all users:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /users/summary
 * Return users with selected fields (supports same filters as /users for convenience)
 * We'll reuse a simplified subset of filters for summary.
 */
router.get('/users/summary', async (req, res) => {
  try {
    // Reuse most query params but keep implementation concise
    const {
      limit: limitRaw = '100',
      skip: skipRaw = '0',
      firstname,
      lastname,
      fullname,
      nameStartsWith,
      email,
      emailDomain,
      emailStartsWith,
      kycLevel,
      emailVerified
    } = req.query;

    const limit = Math.min(Math.max(parseInt(limitRaw, 10) || 100, 1), 2000);
    const skip = Math.max(parseInt(skipRaw, 10) || 0, 0);

    const filter = {};

    if (kycLevel !== undefined && kycLevel !== '') {
      const k = parseInt(kycLevel, 10);
      if (!Number.isNaN(k)) filter.kycLevel = k;
    }
    if (emailVerified !== undefined) {
      filter.emailVerified = String(emailVerified).toLowerCase() === 'true';
    }

    // Email filters (same safe combination)
    const emailConditions = [];
    if (email) emailConditions.push({ email: { $regex: new RegExp(escapeRegex(email), 'i') } });
    if (emailDomain) {
      const domain = escapeRegex(emailDomain);
      emailConditions.push({ email: { $regex: new RegExp(`@${domain}$`, 'i') } });
    }
    if (emailStartsWith) emailConditions.push({ email: { $regex: new RegExp(`^${escapeRegex(emailStartsWith)}`, 'i') } });
    if (emailConditions.length === 1) Object.assign(filter, emailConditions[0]);
    else if (emailConditions.length > 1) filter.$and = filter.$and || [], filter.$and.push(...emailConditions);

    // Name filters (simple)
    if (firstname) filter.firstname = { $regex: new RegExp(escapeRegex(firstname), 'i') };
    if (lastname) filter.lastname = { $regex: new RegExp(escapeRegex(lastname), 'i') };

    const nameOr = [];
    if (fullname) {
      const escaped = escapeRegex(fullname);
      nameOr.push({ firstname: { $regex: new RegExp(escaped, 'i') } });
      nameOr.push({ lastname: { $regex: new RegExp(escaped, 'i') } });
      nameOr.push({
        $expr: {
          $regexMatch: {
            input: { $concat: ['$firstname', ' ', '$lastname'] },
            regex: escaped,
            options: 'i'
          }
        }
      });
    }
    if (nameStartsWith) {
      nameOr.push({ firstname: { $regex: new RegExp(`^${escapeRegex(nameStartsWith)}`, 'i') } });
      nameOr.push({ lastname: { $regex: new RegExp(`^${escapeRegex(nameStartsWith)}`, 'i') } });
    }
    if (nameOr.length) filter.$or = filter.$or || nameOr;

    const users = await User.find(filter)
      .select('email username firstname lastname kycLevel kycStatus emailVerified chatbotTransactionVerified createdAt lastBalanceUpdate')
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .lean();

    const total = await User.countDocuments(filter);

    res.json({
      success: true,
      data: {
        users,
        pagination: { total, limit, skip, hasMore: skip + users.length < total }
      }
    });
  } catch (err) {
    console.error('Error fetching user summary:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /summary
 * Return complete user summary with user info, wallets, and balances
 * Query params: email (required)
 */
router.get('/summary', async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email parameter is required' 
      });
    }

    // Find user by email
    const user = await User.findOne({ email: String(email) }).lean();

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }

    // Extract wallet information
    const wallets = {};
    if (user.wallets) {
      Object.entries(user.wallets).forEach(([key, wallet]) => {
        if (wallet && wallet.address) {
          wallets[key] = {
            address: wallet.address,
            network: wallet.network || '',
            walletReferenceId: wallet.walletReferenceId || ''
          };
        }
      });
    }

    // Extract balances
    const balances = {
      btcBalance: user.btcBalance || 0,
      btcPendingBalance: user.btcPendingBalance || 0,
      ethBalance: user.ethBalance || 0,
      ethPendingBalance: user.ethPendingBalance || 0,
      solBalance: user.solBalance || 0,
      solPendingBalance: user.solPendingBalance || 0,
      usdtBalance: user.usdtBalance || 0,
      usdtPendingBalance: user.usdtPendingBalance || 0,
      usdcBalance: user.usdcBalance || 0,
      usdcPendingBalance: user.usdcPendingBalance || 0,
      bnbBalance: user.bnbBalance || 0,
      bnbPendingBalance: user.bnbPendingBalance || 0,
      maticBalance: user.maticBalance || 0,
      maticPendingBalance: user.maticPendingBalance || 0,
      trxBalance: user.trxBalance || 0,
      trxPendingBalance: user.trxPendingBalance || 0,
      ngnzBalance: user.ngnzBalance || 0,
      ngnzPendingBalance: user.ngnzPendingBalance || 0
    };

    // Calculate USD balances using the same logic as the balance route
    let totalPortfolioBalance = 0;
    const usdBalances = {};
    
    try {
      // Get all supported tokens from portfolio service
      const tokens = Object.keys(SUPPORTED_TOKENS);
      
      // Get current prices with automatic markdown application from portfolio service
      const prices = await getPricesWithCache(tokens);
      
      // Calculate USD values for each token
      for (const token of tokens) {
        const tokenLower = token.toLowerCase();
        const balanceField = `${tokenLower}Balance`;
        const usdBalanceField = `${tokenLower}BalanceUSD`;
        
        // Get token amount from user
        const tokenAmount = user[balanceField] || 0;
        const tokenPrice = prices[token] || 0;
        
        // Calculate USD value (prices already include markdown from portfolio service)
        const usdValue = tokenAmount * tokenPrice;
        
        // Store calculated USD balance
        usdBalances[usdBalanceField] = parseFloat(usdValue.toFixed(2));
        
        // Add to total portfolio
        totalPortfolioBalance += usdValue;
      }
      
      // Round total portfolio balance
      totalPortfolioBalance = parseFloat(totalPortfolioBalance.toFixed(2));
    } catch (error) {
      console.error('Error calculating USD balances:', error);
      // If calculation fails, set total to 0 and USD balances to empty
      totalPortfolioBalance = 0;
    }

    // Prepare user info (exclude sensitive fields)
    const userInfo = {
      _id: user._id,
      email: user.email,
      username: user.username,
      firstname: user.firstname,
      lastname: user.lastname,
      phonenumber: user.phonenumber,
      avatarUrl: user.avatarUrl,
      kycLevel: user.kycLevel,
      kycStatus: user.kycStatus,
      emailVerified: user.emailVerified,
      chatbotTransactionVerified: user.chatbotTransactionVerified,
      is2FAEnabled: user.is2FAEnabled,
      is2FAVerified: user.is2FAVerified,
      bvnVerified: user.bvnVerified,
      bankAccounts: user.bankAccounts || [],
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastBalanceUpdate: user.lastBalanceUpdate,
      portfolioLastUpdated: user.portfolioLastUpdated,
      kyc: user.kyc
    };

    res.json({
      success: true,
      data: {
        user: userInfo,
        wallets,
        balances: {
          ...balances,
          ...usdBalances, // Include USD balances for each token
          totalPortfolioBalance
        },
        lastUpdated: user.lastBalanceUpdate || user.updatedAt || new Date()
      }
    });
  } catch (err) {
    console.error('Error fetching complete user summary:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
