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
  // Normalize path: strip trailing slash, lowercase
  const normPath = path.replace(/\/$/, '');
  return ACTION_MAP[`${method.toUpperCase()} ${normPath}`] || `${method.toUpperCase()} ${normPath}`;
}

module.exports = function adminAuditLog(req, res, next) {
  const startTime = Date.now();
  const originalJson = res.json.bind(res);

  res.json = function (body) {
    // Only log admin-authenticated requests
    if (req.admin) {
      const durationMs = Date.now() - startTime;
      const admin = req.admin;

      AdminAuditLog.create({
        adminId:     admin.id || admin._id,
        adminName:   admin.adminName,
        adminEmail:  admin.email,
        adminRole:   admin.adminRole,
        method:      req.method,
        route:       req.originalUrl,
        action:      deriveAction(req.method, req.path),
        requestBody: sanitize(req.body),
        statusCode:  res.statusCode,
        ipAddress:   req.ip || req.connection?.remoteAddress,
        userAgent:   req.headers['user-agent'],
        durationMs,
      }).catch(err => console.error('[audit] Log write failed:', err.message));
    }

    return originalJson(body);
  };

  next();
};
