/**
 * Single source of truth for product name, positioning, and public links (sales, security reviews, integrations).
 * Override via env for white-label deployments.
 */

const path = require('path');

let pkgVersion = '1.0.0';
try {
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  pkgVersion = pkg.version || pkgVersion;
} catch {
  /* ignore */
}

/** @returns {Record<string, unknown>} */
function getProductIdentity() {
  const name = String(process.env.PRODUCT_PUBLIC_NAME || 'Shiiman Leads').trim() || 'Shiiman Leads';
  const tagline = String(
    process.env.PRODUCT_TAGLINE ||
      'AI-assisted B2B lead generation: discover public records and open data, monitor sources, and export structured leads—built for teams that sell to businesses.'
  ).trim();

  const salesEmail = String(process.env.PRODUCT_SALES_EMAIL || '').trim() || null;
  const supportEmail = String(process.env.SUPPORT_EMAIL || '').trim() || null;

  return {
    name,
    tagline,
    version: pkgVersion,
    category: 'B2B sales intelligence / lead generation SaaS',
    positioning: [
      'Multi-tenant workspaces: each customer sees only their own sources and leads',
      'Discovery and extraction powered by Google Gemini with optional retrieval (RAG) context',
      'REST-first ingestion for ArcGIS FeatureServer and Socrata-style JSON APIs; browser extraction when the site has no API',
      'Usage metering, billing hooks (Paddle), rate limits, and audit-friendly logging options',
      'Public-facing legal pages: Privacy, Terms, Support, Data retention — suitable for procurement questionnaires'
    ],
    links: {
      privacy: '/privacy.html',
      terms: '/terms.html',
      support: '/support.html',
      data_retention: '/data-retention.html',
      enterprise_capabilities: '/api/enterprise/capabilities',
      health: '/health',
      health_ready: '/health/ready'
    },
    contact: {
      sales_email: salesEmail,
      support_email: supportEmail
    },
    subprocessors_note:
      'Typical deployment uses Google (Gemini), optional Serper (web search), Paddle (payments), and your SMTP provider — see /api/enterprise/capabilities.'
  };
}

module.exports = { getProductIdentity };
