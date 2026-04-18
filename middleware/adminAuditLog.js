const AdminAuditLog = require('../models/AdminAuditLog');

const SENSITIVE_KEYS = ['password', 'passwordpin', 'apikey', 'secret', 'token', 'pin', 'otp', 'twofa'];

function sanitize(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const result = { ...body };
  for (const key of Object.keys(result)) {
    if (SENSITIVE_KEYS.some(s => key.toLowerCase().includes(s))) {
      result[key] = '[REDACTED]';
    }
  }
  return result;
}

const ACTION_MAP = {
  'POST /fund/add':                       'Fund User',
  'POST /fund/deduct':                    'Deduct Balance',
  'DELETE /deleteuser/user':              'Delete User',
  'POST /blockuser/block':                'Block User',
  'POST /blockuser/unblock':              'Unblock User',
  'PATCH /delete-pin/remove-passwordpin': 'Remove Password PIN',
  'POST /set-fee':                        'Update Fee',
  'POST /marker':                         'Update Price Markdown',
  'PATCH /marker':                        'Update Price Markdown',
  'POST /admin/register':                 'Register Admin',
  'PATCH /admin/permissions':             'Update Admin Permissions',
  'POST /admingiftcard':                  'Gift Card Action',
  'PATCH /admingiftcard':                 'Gift Card Update',
  'POST /admin-kyc':                      'KYC Review',
  'PATCH /admin-kyc':                     'KYC Update',
  'POST /usermanagement':                 'User Management Action',
  'PATCH /usermanagement':                'User Management Update',
  'POST /2FA-Disable':                    'Disable 2FA',
  'POST /updateuseraddress':              'Update Wallet Address',
  'POST /pending':                        'Clear Pending Balance',
  'DELETE /pending':                      'Clear Pending Balance',
  'POST /admin/notification':             'Send Push Notification',
  'POST /admin/scheduled-notifications':  'Schedule Notification',
  'DELETE /admin/scheduled-notifications':'Delete Scheduled Notification',
  'POST /admin/banners':                  'Create Banner',
  'PATCH /admin/banners':                 'Update Banner',
  'DELETE /admin/banners':                'Delete Banner',
  'POST /admin/blog':                     'Create Blog Post',
  'PATCH /admin/blog':                    'Update Blog Post',
  'DELETE /admin/blog':                   'Delete Blog Post',
  'PATCH /onramp':                        'Update On-ramp Rate',
  'PATCH /offramp':                       'Update Off-ramp Rate',
};

function deriveAction(method, path) {
  const normPath = path.replace(/\/$/, '');
  return ACTION_MAP[`${method.toUpperCase()} ${normPath}`] || `${method.toUpperCase()} ${normPath}`;
}

// Extract the target user identifier from the request body or params
function extractTarget(body, params) {
  const b = body || {};
  const p = params || {};
  const id    = b.userId   || b.user_id   || b.id   || p.userId || p.id   || null;
  const email = b.userEmail || b.email    || b.targetEmail       || null;
  return { targetUserId: id ? String(id) : null, targetUserEmail: email || null };
}

// Build a short human-readable summary from the most relevant body fields
const DETAIL_FIELD_MAP = {
  'Fund User':               ['userId', 'amount', 'currency', 'network'],
  'Deduct Balance':          ['userId', 'amount', 'currency'],
  'Delete User':             ['userId', 'email'],
  'Block User':              ['userId', 'email', 'reason'],
  'Unblock User':            ['userId', 'email'],
  'Remove Password PIN':     ['userId', 'email'],
  'Update Fee':              ['currency', 'fee', 'type'],
  'Update Price Markdown':   ['currency', 'markup', 'markdown', 'percent'],
  'Register Admin':          ['adminName', 'email', 'role'],
  'Update Admin Permissions':['adminId', 'permissions'],
  'Gift Card Action':        ['currency', 'rate', 'type'],
  'Gift Card Update':        ['currency', 'rate', 'status'],
  'KYC Review':              ['userId', 'status', 'reason'],
  'KYC Update':              ['userId', 'status', 'reason'],
  'User Management Action':  ['userId', 'action', 'email'],
  'User Management Update':  ['userId', 'field', 'value'],
  'Disable 2FA':             ['userId', 'email'],
  'Update Wallet Address':   ['userId', 'address', 'network'],
  'Clear Pending Balance':   ['userId', 'currency'],
  'Send Push Notification':  ['title', 'body', 'topic'],
  'Schedule Notification':   ['title', 'scheduledAt'],
  'Delete Scheduled Notification': ['notificationId'],
  'Create Banner':           ['title', 'type'],
  'Update Banner':           ['title', 'type'],
  'Delete Banner':           ['bannerId'],
  'Create Blog Post':        ['title', 'category'],
  'Update Blog Post':        ['title'],
  'Delete Blog Post':        ['postId'],
  'Update On-ramp Rate':     ['currency', 'rate'],
  'Update Off-ramp Rate':    ['currency', 'rate'],
};

function buildDetails(action, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields = DETAIL_FIELD_MAP[action];
  const source = fields || Object.keys(body).slice(0, 5); // fallback: first 5 keys
  const parts = [];
  for (const key of source) {
    const val = body[key];
    if (val !== undefined && val !== null && val !== '') {
      parts.push(`${key}: ${val}`);
    }
  }
  return parts.length ? parts.join(' | ') : null;
}

module.exports = function adminAuditLog(req, res, next) {
  const startTime = Date.now();
  const originalJson = res.json.bind(res);

  res.json = function (body) {
    if (req.admin) {
      const durationMs = Date.now() - startTime;
      const admin  = req.admin;
      const action = deriveAction(req.method, req.path);
      const sanitizedBody = sanitize(req.body);
      const { targetUserId, targetUserEmail } = extractTarget(req.body, req.params);

      AdminAuditLog.create({
        adminId:          admin.id || admin._id,
        adminName:        admin.adminName,
        adminEmail:       admin.email,
        adminRole:        admin.adminRole,
        method:           req.method,
        route:            req.originalUrl,
        action,
        requestBody:      sanitizedBody,
        targetUserId,
        targetUserEmail,
        details:          buildDetails(action, req.body),
        statusCode:       res.statusCode,
        ipAddress:        req.ip || req.connection?.remoteAddress,
        userAgent:        req.headers['user-agent'],
        durationMs,
      }).catch(err => console.error('[audit] Log write failed:', err.message));
    }

    return originalJson(body);
  };

  next();
};
