/**
 * Monthly usage counters (per user, YYYY-MM). Used for subscription enforcement.
 */

const { dbGet, dbRun } = require('../db');
const { getPlanConfig } = require('../config/plans');

function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function getBillingPlanKey(userId) {
  const row = await dbGet('SELECT plan_key FROM billing_accounts WHERE user_id = ?', [userId]);
  return row?.plan_key || 'free';
}

/**
 * @param {number} userId
 * @param {'discovery'|'api_pull'|'ingest'} metric
 */
async function getUsage(userId, metric) {
  const row = await dbGet(
    'SELECT count FROM usage_counters WHERE user_id = ? AND period = ? AND metric = ?',
    [userId, currentPeriod(), metric]
  );
  return row?.count != null ? Number(row.count) : 0;
}

/**
 * @param {number} userId
 * @param {'discovery'|'api_pull'|'ingest'} metric
 * @param {number} [amount]
 */
async function incrementUsage(userId, metric, amount = 1) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  if (n <= 0) return;
  const period = currentPeriod();
  await dbRun(
    `INSERT INTO usage_counters (user_id, period, metric, count) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, period, metric) DO UPDATE SET count = count + ?`,
    [userId, period, metric, n, n]
  );
}

const METRIC_LIMIT = {
  discovery: 'maxDiscoveryPerMonth',
  api_pull: 'maxApiPullsPerMonth',
  ingest: 'maxIngestPerMonth'
};

/**
 * @param {import('express').Request} [req] — when present, admin bypasses limits
 */
async function assertMonthlyAllowance(userId, metric, req) {
  if (req?.session?.user?.role === 'admin') return;

  const planKey = await getBillingPlanKey(userId);
  const plan = getPlanConfig(planKey);
  const limitField = METRIC_LIMIT[metric];
  if (!limitField) {
    const err = new Error('Unknown usage metric');
    err.status = 500;
    throw err;
  }

  if (metric === 'discovery' && !plan.aiDiscovery) {
    const err = new Error('AI discovery is not included in your plan. Upgrade to Starter or higher.');
    err.status = 402;
    err.code = 'PLAN_FEATURE';
    throw err;
  }
  if (metric === 'api_pull' && !plan.apiConnector) {
    const err = new Error('API connectors are not included in your plan.');
    err.status = 402;
    err.code = 'PLAN_FEATURE';
    throw err;
  }
  if (metric === 'ingest' && !plan.inboundIngest) {
    const err = new Error('Inbound lead ingest is not included in your plan.');
    err.status = 402;
    err.code = 'PLAN_FEATURE';
    throw err;
  }

  const limit = plan[limitField];
  if (limit == null || limit < 0) return;

  const used = await getUsage(userId, metric);
  if (used >= limit) {
    const err = new Error(
      `Monthly limit reached for ${metric.replace('_', ' ')} (${used}/${limit}). Resets next calendar month or upgrade your plan.`
    );
    err.status = 429;
    err.code = 'USAGE_LIMIT';
    err.details = { metric, used, limit, plan_key: planKey };
    throw err;
  }
}

/**
 * Snapshot for UI / billing status.
 * @param {number} userId
 */
async function getUsageSnapshot(userId) {
  const planKey = await getBillingPlanKey(userId);
  const plan = getPlanConfig(planKey);
  const period = currentPeriod();
  const [discovery, api_pull, ingest] = await Promise.all([
    getUsage(userId, 'discovery'),
    getUsage(userId, 'api_pull'),
    getUsage(userId, 'ingest')
  ]);
  return {
    period,
    plan_key: planKey,
    limits: {
      maxSources: plan.maxSources,
      maxDiscoveryPerMonth: plan.maxDiscoveryPerMonth,
      maxApiPullsPerMonth: plan.maxApiPullsPerMonth,
      maxIngestPerMonth: plan.maxIngestPerMonth,
      aiDiscovery: plan.aiDiscovery,
      apiConnector: plan.apiConnector,
      inboundIngest: plan.inboundIngest
    },
    used: {
      discovery,
      api_pull,
      ingest
    }
  };
}

/**
 * Ingest: ensure this batch would not exceed monthly cap.
 * @param {number} leadCount
 */
async function assertIngestBatchAllowance(userId, leadCount, req) {
  if (req?.session?.user?.role === 'admin') return;
  const n = Math.max(0, Math.floor(Number(leadCount) || 0));
  if (n <= 0) return;

  const planKey = await getBillingPlanKey(userId);
  const plan = getPlanConfig(planKey);
  if (!plan.inboundIngest) {
    const err = new Error('Inbound lead ingest is not included in your plan.');
    err.status = 402;
    err.code = 'PLAN_FEATURE';
    throw err;
  }
  const limit = plan.maxIngestPerMonth;
  if (limit == null || limit < 0) return;
  const used = await getUsage(userId, 'ingest');
  if (used + n > limit) {
    const err = new Error(
      `This batch would exceed your monthly ingest limit (${used + n} > ${limit}). Reduce batch size or upgrade.`
    );
    err.status = 429;
    err.code = 'USAGE_LIMIT';
    err.details = { metric: 'ingest', used, adding: n, limit, plan_key: planKey };
    throw err;
  }
}

module.exports = {
  currentPeriod,
  getUsage,
  incrementUsage,
  assertMonthlyAllowance,
  assertIngestBatchAllowance,
  getUsageSnapshot,
  getBillingPlanKey
};
