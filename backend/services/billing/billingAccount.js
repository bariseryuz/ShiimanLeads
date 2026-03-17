const { dbGet, dbRun } = require('../../db');

async function ensureBillingAccount(userId) {
  await dbRun(
    `INSERT OR IGNORE INTO billing_accounts (user_id, provider, plan_key, status)
     VALUES (?, 'paddle', 'free', 'inactive')`,
    [userId]
  );
  return dbGet('SELECT * FROM billing_accounts WHERE user_id = ?', [userId]);
}

async function updateBillingAccount(userId, patch) {
  const keys = Object.keys(patch || {});
  if (keys.length === 0) return ensureBillingAccount(userId);

  const setSql = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => patch[k]);
  await dbRun(
    `UPDATE billing_accounts SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
    [...values, userId]
  );
  return dbGet('SELECT * FROM billing_accounts WHERE user_id = ?', [userId]);
}

module.exports = {
  ensureBillingAccount,
  updateBillingAccount
};

