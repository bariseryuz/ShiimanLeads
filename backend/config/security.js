/**
 * CORS, trusted origins, metrics auth — production hardening.
 */

function splitList(envKey) {
  const raw = process.env[envKey];
  if (!raw || !String(raw).trim()) return [];
  return String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Allowed browser origins for CORS (comma-separated). Empty = allow all (legacy). */
function getCorsOrigins() {
  const list = splitList('CORS_ORIGINS');
  if (list.length) return list;
  return ['*'];
}

/** Same as CORS list when TRUSTED_ORIGINS unset — for Origin enforcement */
function getTrustedOrigins() {
  const t = splitList('TRUSTED_ORIGINS');
  if (t.length) return t;
  const c = splitList('CORS_ORIGINS');
  return c.length ? c : [];
}

function isOriginEnforcementEnabled() {
  return String(process.env.API_ORIGIN_ENFORCE || '').trim().toLowerCase() === 'true';
}

function isMetricsAuthConfigured() {
  return !!(process.env.METRICS_BEARER_TOKEN && String(process.env.METRICS_BEARER_TOKEN).trim());
}

module.exports = {
  getCorsOrigins,
  getTrustedOrigins,
  isOriginEnforcementEnabled,
  isMetricsAuthConfigured,
  splitList
};
