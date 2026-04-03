const logger = require('../utils/logger');
const { getTrustedOrigins, isOriginEnforcementEnabled } = require('../config/security');

/**
 * When API_ORIGIN_ENFORCE=true and TRUSTED_ORIGINS (or CORS_ORIGINS) is set,
 * reject cross-origin API writes if Origin does not match.
 * Exempts webhooks and token-based ingest (machine callers).
 */
function apiOriginEnforce(req, res, next) {
  if (!isOriginEnforcementEnabled()) return next();

  const trusted = getTrustedOrigins();
  if (!trusted.length) {
    logger.warn('[security] API_ORIGIN_ENFORCE is true but TRUSTED_ORIGINS/CORS_ORIGINS is empty — skipping enforcement');
    return next();
  }

  const method = req.method || 'GET';
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();

  const p = req.path || req.url || '';
  if (p.startsWith('/api/billing/webhook')) return next();
  if (p.startsWith('/api/ingest/leads')) return next();
  if (!p.startsWith('/api')) return next();

  if (req.get('authorization') || req.get('x-api-key')) return next();

  const origin = req.get('origin');
  if (!origin) return next();

  const ok = trusted.some(t => {
    const base = t.replace(/\/$/, '');
    return origin === base || origin === t || origin.startsWith(base + '/');
  });

  if (!ok) {
    logger.warn(`[security] Blocked Origin=${origin} ${method} ${p} reqId=${req.reqId || ''}`);
    return res.status(403).json({
      error: 'Origin not allowed for this API',
      code: 'FORBIDDEN_ORIGIN'
    });
  }
  next();
}

module.exports = { apiOriginEnforce };
