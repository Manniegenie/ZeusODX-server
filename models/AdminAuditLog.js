const mongoose = require('mongoose');

const adminAuditLogSchema = new mongoose.Schema(
  {
    adminId:    { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', index: true },
    adminName:  { type: String },
    adminEmail: { type: String, index: true },
    adminRole:  { type: String },
    method:     { type: String },       // GET, POST, PATCH, DELETE
    route:      { type: String, index: true }, // full originalUrl
    action:     { type: String },       // human-readable label
    requestBody: { type: mongoose.Schema.Types.Mixed },
    statusCode: { type: Number },
    ipAddress:  { type: String },
    userAgent:  { type: String },
    durationMs: { type: Number },
  },
  { timestamps: true }
);

adminAuditLogSchema.index({ createdAt: -1 });
adminAuditLogSchema.index({ adminId: 1, createdAt: -1 });

module.exports = mongoose.model('AdminAuditLog', adminAuditLogSchema);
