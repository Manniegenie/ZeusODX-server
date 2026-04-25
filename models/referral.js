// models/referral.js
const mongoose = require('mongoose');

/**
 * One Referral document per user.
 * Tracks the user's unique referral code, everyone they referred,
 * and all revenue-sharing earnings accumulated through the program.
 */
const referralSchema = new mongoose.Schema(
  {
    // The owner of this referral code
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },

    // Unique 8-character alphanumeric code (e.g. "ZEUS3K7M")
    referralCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      minlength: 8,
      maxlength: 8,
    },

    // Status flag — can be disabled by admin if abuse is detected
    isActive: {
      type: Boolean,
      default: true,
    },

    // ─── Referred users ──────────────────────────────────────────────────────
    referredUsers: [
      {
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
          required: true,
        },
        // When they completed signup using this code
        joinedAt: {
          type: Date,
          default: Date.now,
        },
        // Set to true once the referred user completes their first qualifying transaction
        hasConverted: {
          type: Boolean,
          default: false,
        },
        firstTransactionAt: {
          type: Date,
          default: null,
        },
        // Running earnings generated from this single referred user
        earningsFromUser: {
          type: Number,
          default: 0,
          min: 0,
        },
      },
    ],

    // ─── Aggregate earnings ──────────────────────────────────────────────────
    // Lifetime revenue-sharing earnings in NGNZ (update via your payout service)
    totalEarnings: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Lifetime count of users who signed up with this code
    totalReferrals: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Lifetime count of referred users who made at least one qualifying transaction
    totalConversions: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Pending earnings not yet paid out
    pendingEarnings: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Total earnings that have already been paid out to the referrer
    paidOutEarnings: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
referralSchema.index({ referralCode: 1 }, { unique: true });
referralSchema.index({ userId: 1 }, { unique: true });
referralSchema.index({ isActive: 1 });

// ─── Instance helpers ─────────────────────────────────────────────────────────

/**
 * Add a newly referred user to this referral document.
 * Call this when someone signs up using this referral code.
 */
referralSchema.methods.addReferredUser = async function (newUserId) {
  const alreadyReferred = this.referredUsers.some(
    (r) => r.userId.toString() === newUserId.toString()
  );
  if (alreadyReferred) return this;

  this.referredUsers.push({ userId: newUserId });
  this.totalReferrals += 1;
  return this.save();
};

/**
 * Mark a referred user as converted and credit earnings.
 * Call this from your transaction/revenue-sharing service.
 *
 * @param {ObjectId|string} referredUserId
 * @param {number}          earningsAmount  Amount in NGNZ to credit
 */
referralSchema.methods.recordConversion = async function (referredUserId, earningsAmount = 0) {
  let entry = this.referredUsers.find(
    (r) => r.userId.toString() === referredUserId.toString()
  );

  // Referee may not be in the array if the referral doc was auto-created for an
  // existing user, or if addReferredUser was missed. Add them now so stats stay
  // consistent and totalEarnings always gets credited.
  if (!entry) {
    this.referredUsers.push({ userId: referredUserId });
    this.totalReferrals += 1;
    entry = this.referredUsers[this.referredUsers.length - 1];
  }

  if (!entry.hasConverted) {
    entry.hasConverted = true;
    entry.firstTransactionAt = new Date();
    this.totalConversions += 1;
  }

  entry.earningsFromUser += earningsAmount;
  this.totalEarnings += earningsAmount;
  this.pendingEarnings += earningsAmount;

  return this.save();
};

/**
 * Mark a payout as completed (called from your payout/settlement service).
 *
 * @param {number} amount  Amount in NGNZ that was paid out
 */
referralSchema.methods.recordPayout = async function (amount) {
  if (amount > this.pendingEarnings) {
    throw new Error('Payout amount exceeds pending earnings');
  }
  this.pendingEarnings -= amount;
  this.paidOutEarnings += amount;
  return this.save();
};

module.exports = mongoose.model('Referral', referralSchema);
