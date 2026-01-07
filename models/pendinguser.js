const mongoose = require('mongoose');

const pendingUserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  firstname: { type: String, required: true },
  middlename: { type: String, default: '' },
  lastname: { type: String, required: true },
  phonenumber: { type: String, required: true, unique: true },
  verificationCode: { type: String, required: true },
  verificationCodeCreatedAt: { type: Date, required: true },
  verificationCodeExpiresAt: { type: Date, required: true, index: { expires: 0 } }, // TTL index

  // OTP verification status fields
  otpVerified: { type: Boolean, default: false },
  otpVerifiedAt: { type: Date, default: null }
}, { timestamps: true });

/**
 * The `expires: 0` value means the document will be removed as soon as the
 * `verificationCodeExpiresAt` time is reached. TTL cleanup may take up to 60 seconds.
 */

module.exports = mongoose.model('PendingUser', pendingUserSchema);