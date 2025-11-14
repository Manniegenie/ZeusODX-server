const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  message: {
    type: String,
    required: true,
    trim: true
  },
  subtitle: {
    type: String,
    default: null,
    trim: true
  },
  type: {
    type: String,
    enum: [
      'DEPOSIT',
      'DEPOSIT_CONFIRMED',
      'WITHDRAWAL',
      'WITHDRAWAL_COMPLETED',
      'WITHDRAWAL_FAILED',
      'NGNZ_WITHDRAWAL',
      'TRANSFER_SENT',
      'TRANSFER_RECEIVED',
      'SWAP',
      'NGNZ_SWAP',
      'PAYMENT',
      'AIRTIME_PURCHASE',
      'SECURITY_ALERT',
      'KYC_VERIFICATION',
      'CUSTOM'
    ],
    default: 'CUSTOM',
    index: true
  },
  isRead: {
    type: Boolean,
    default: false,
    index: true
  },
  readAt: {
    type: Date,
    default: null
  },
  data: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // Push notification metadata
  pushSent: {
    type: Boolean,
    default: false
  },
  pushSentAt: {
    type: Date,
    default: null
  },
  pushVia: {
    type: String,
    enum: ['fcm', 'expo', null],
    default: null
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ createdAt: -1 }); // For cleanup queries

// Method to mark as read
notificationSchema.methods.markAsRead = function() {
  this.isRead = true;
  this.readAt = new Date();
  return this.save();
};

// Static method to get unread count
notificationSchema.statics.getUnreadCount = async function(userId) {
  return this.countDocuments({ userId, isRead: false });
};

// Static method to mark all as read
notificationSchema.statics.markAllAsRead = async function(userId) {
  return this.updateMany(
    { userId, isRead: false },
    { 
      $set: { 
        isRead: true, 
        readAt: new Date() 
      } 
    }
  );
};

module.exports = mongoose.model('Notification', notificationSchema);


