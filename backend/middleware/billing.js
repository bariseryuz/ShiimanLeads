const { dbGet } = require('../db');
const { getPlanConfig } = require('../config/plans');

async function getBillingAccountForUser(userId) {
  const acct = await dbGet('SELECT * FROM billing_accounts WHERE user_id = ?', [userId]);
  return acct || { plan_key: 'free', status: 'inactive', grace_period_ends_at: null };
}

function isWithinGrace(acct) {
  if (!acct?.grace_period_ends_at) return false;
  const t = Date.parse(acct.grace_period_ends_at);
  if (!Number.isFinite(t)) return false;
  return Date.now() <= t;
}

function isPaidActive(acct) {
  if (!acct) return false;
  if (acct.status === 'active') return true;
  if (acct.status === 'past_due' && isWithinGrace(acct)) return true;
  return false;
}

/**
 * Require an active (or grace) subscription for paid features.
 * Admins bypass.
 */
async function requirePaid(req, res, next) {
  const userId = req.session?.user?.id;
  const role = req.session?.user?.role;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  if (role === 'admin') return next();

  // Temporary ops/testing only — set in server env, never in public client
  if (process.env.ALLOW_UNPAID_SCRAPE === 'true') {
    return next();
  }

  const acct = await getBillingAccountForUser(userId);
  if (!isPaidActive(acct)) {
    return res.status(402).json({
      error: 'Subscription required',
      billing: { status: acct.status, plan_key: acct.plan_key, grace_period_ends_at: acct.grace_period_ends_at }
    });
  }
  next();
}

/**
 * Enforce max sources per plan in backend.
 * Admins bypass.
 */
async function enforceSourceLimit(req, res, next) {
  const userId = req.session?.user?.id;
  const role = req.session?.user?.role;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  if (role === 'admin') return next();

  if (process.env.ALLOW_UNPAID_SCRAPE === 'true') {
    return next();
  }

  const acct = await getBillingAccountForUser(userId);
  const plan = getPlanConfig(acct.plan_key);
  const maxSources = plan.maxSources;

  if (!maxSources || maxSources <= 0) {
    return res.status(402).json({ error: 'Plan does not allow sources', plan_key: acct.plan_key });
  }

  const row = await dbGet('SELECT COUNT(*) as count FROM user_sources WHERE user_id = ?', [userId]);
  const current = row?.count || 0;
  if (current >= maxSources) {
    return res.status(403).json({
      error: `Plan limit reached: max ${maxSources} sources`,
      plan_key: acct.plan_key,
      maxSources
    });
  }
  next();
}

module.exports = {
  getBillingAccountForUser,
  requirePaid,
  enforceSourceLimit
};

