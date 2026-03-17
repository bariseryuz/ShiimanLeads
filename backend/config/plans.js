const DEFAULT_PLANS = {
  free: { maxSources: 0 },
  starter: { maxSources: 8 }
};

function getPlanConfig(planKey) {
  const key = String(planKey || '').toLowerCase();
  return DEFAULT_PLANS[key] || DEFAULT_PLANS.free;
}

module.exports = {
  DEFAULT_PLANS,
  getPlanConfig
};

