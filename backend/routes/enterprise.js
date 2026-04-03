/**
 * Enterprise / compliance surface — honest capability flags (no fake certifications).
 */
const express = require('express');
const router = express.Router();

router.get('/capabilities', (req, res) => {
  res.json({
    version: 1,
    sso: {
      saml: false,
      oidc: false,
      note: 'SAML/OIDC SSO is available for enterprise deployments on request.'
    },
    data: {
      primary_store: 'sqlite',
      optional_redis: !!process.env.REDIS_URL,
      postgres: 'Migration path: contact for managed Postgres + HA.'
    },
    compliance: {
      gdpr: 'Customers should execute a DPA; configure data retention (LEAD_RETENTION_DAYS).',
      subprocessors: 'Gemini (Google AI), Serper (optional), Paddle (billing), email provider if SMTP set.',
      certifications: 'No SOC2/ISO badge bundled with the app — available via hosting + process for enterprise.'
    },
    observability: {
      prometheus: '/metrics',
      logs: 'LOG_FORMAT=json for log aggregators',
      health: ['/health', '/health/ready']
    }
  });
});

module.exports = router;
