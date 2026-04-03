/**
 * Subscription tiers: limits enforced in middleware + usageMeter.
 * Paddle checkout currently wires `starter`; map paid subscriptions to these keys via webhook / DB.
 */

const DEFAULT_PLANS = {
  free: {
    maxSources: 0,
    maxDiscoveryPerMonth: 0,
    maxApiPullsPerMonth: 0,
    maxIngestPerMonth: 0,
    aiDiscovery: false,
    apiConnector: false,
    inboundIngest: false
  },
  starter: {
    maxSources: 8,
    maxDiscoveryPerMonth: 60,
    maxApiPullsPerMonth: 2000,
    maxIngestPerMonth: 5000,
    aiDiscovery: true,
    apiConnector: true,
    inboundIngest: true
  },
  growth: {
    maxSources: 25,
    maxDiscoveryPerMonth: 200,
    maxApiPullsPerMonth: 15000,
    maxIngestPerMonth: 25000,
    aiDiscovery: true,
    apiConnector: true,
    inboundIngest: true
  },
  scale: {
    maxSources: 100,
    maxDiscoveryPerMonth: 1000,
    maxApiPullsPerMonth: 100000,
    maxIngestPerMonth: 200000,
    aiDiscovery: true,
    apiConnector: true,
    inboundIngest: true
  }
};

/**
 * @param {string} [planKey]
 */
function getPlanConfig(planKey) {
  const key = String(planKey || '').toLowerCase();
  return DEFAULT_PLANS[key] || DEFAULT_PLANS.free;
}

module.exports = {
  DEFAULT_PLANS,
  getPlanConfig
};
