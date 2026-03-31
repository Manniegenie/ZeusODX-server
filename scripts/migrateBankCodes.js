/**
 * One-time migration: update saved bank accounts from old Obiex sort codes to new ones.
 * Run once: node scripts/migrateBankCodes.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { SORT_CODE_MAP } = require('../utils/sortCodeMigration');
const User = require('../models/user');
const logger = console;

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  logger.log('Connected to MongoDB');

  const oldCodes = Object.keys(SORT_CODE_MAP);

  // Find all users with at least one bank account using an old code
  const users = await User.find({
    'bankAccounts.bankCode': { $in: oldCodes }
  });

  logger.log(`Found ${users.length} users with old bank codes`);

  let totalUpdated = 0;

  for (const user of users) {
    let changed = false;

    user.bankAccounts.forEach(account => {
      const newCode = SORT_CODE_MAP[account.bankCode];
      if (newCode) {
        logger.log(`  User ${user._id}: ${account.bankName} ${account.bankCode} → ${newCode}`);
        account.bankCode = newCode;
        changed = true;
        totalUpdated++;
      }
    });

    if (changed) {
      await user.save({ validateBeforeSave: false });
    }
  }

  logger.log(`\nDone. Updated ${totalUpdated} bank account(s) across ${users.length} user(s).`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
