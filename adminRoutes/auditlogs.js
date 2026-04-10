const express = require('express');
const AdminAuditLog = require('../models/AdminAuditLog');

const router = express.Router();

// GET /audit-logs
// Query params: page, limit, adminEmail, adminRole, action, method, from, to
router.get('/', async (req, res) => {
  try {
    const {
      page  = 1,
      limit = 50,
      adminEmail,
      adminRole,
      action,
      method,
      from,
      to,
    } = req.query;

    const filter = {};
    if (adminEmail) filter.adminEmail = { $regex: adminEmail, $options: 'i' };
    if (adminRole)  filter.adminRole  = adminRole;
    if (action)     filter.action     = { $regex: action, $options: 'i' };
    if (method)     filter.method     = method.toUpperCase();
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to)   filter.createdAt.$lte = new Date(to);
    }

    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const skip     = (pageNum - 1) * limitNum;

    const [logs, total] = await Promise.all([
      AdminAuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      AdminAuditLog.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      logs,
      pagination: {
        total,
        page:  pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
