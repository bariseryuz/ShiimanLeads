/**
 * Phase 4 — Discovery: AI suggests URLs to monitor; /monitor saves to user_sources.
 */

const express = require('express');
const router = express.Router();
const {
  fetchDiscoverySuggestions,
  generateDiscoveryStrategy,
  generateDiscoveryFromGoogleSearch
} = require('../services/ai/discoveryStrategy');
const { runNlLeadIntentDiscovery } = require('../services/ai/nlLeadIntent');
const { createUserSourceCore } = require('../services/createUserSourceCore');
const { runExtractNowForUrl } = require('../services/discoverExtractRun');
const { fetchLeadsFromBriefOnly } = require('../services/autoLeadFromBrief');
const { inferMonitorSourceFromUrl } = require('../services/inferMonitorSourceFromUrl');
const logger = require('../utils/logger');
const { requirePaid, enforceSourceLimit } = require('../middleware/billing');
const { assertMonthlyAllowance, incrementUsage } = require('../services/usageMeter');
const { createRateLimiter } = require('../middleware/rateLimitMemory');
const scaleLimits = require('../config/scaleLimits');
const { getRedis } = require('../services/redisClient');

const discoverLimiter = createRateLimiter({
  windowMs: scaleLimits.discoverRate.windowMs,
  max: scaleLimits.discoverRate.max,
  name: 'discover',
  redis: getRedis(),
  keyFn: req => `discover:u:${req.session && req.session.user ? req.session.user.id : 'anon'}:${req.ip || 'na'}`
});

router.use(discoverLimiter);

async function withDiscoveryMonthlyLimit(req, res, next) {
  try {
    await assertMonthlyAllowance(req.session.user.id, 'discovery', req);
    next();
  } catch (e) {
    const code = e.status && typeof e.status === 'number' ? e.status : 500;
    res.status(code).json({ error: e.message, code: e.code, details: e.details });
  }
}

/**
 * POST /api/discover
 * Body: { keyword: "Real Estate Dallas" }
 */
router.post('/', requirePaid, express.json(), withDiscoveryMonthlyLimit, async (req, res) => {
  try {
    const keyword = req.body && req.body.keyword;
    const out = await fetchDiscoverySuggestions(keyword);
    await incrementUsage(req.session.user.id, 'discovery', 1);
    res.json({
      success: true,
      keyword: String(keyword || '').trim(),
      suggestions: out.suggestions
    });
  } catch (e) {
    const msg = e.message || String(e);
    const code = msg.includes('required') || msg.includes('keyword') ? 400 : 500;
    logger.error(`POST /api/discover: ${msg}`);
    res.status(code).json({ error: msg });
  }
});

/**
 * POST /api/discover/strategy
 * Body: { product, customer, triggerEvents } — "Growth consultant" mode (no URL required upfront).
 * Aliases: whatYouSell, perfectCustomer, events
 */
router.post('/strategy', requirePaid, express.json(), withDiscoveryMonthlyLimit, async (req, res) => {
  try {
    const body = req.body || {};
    const out = await generateDiscoveryStrategy(body);
    await incrementUsage(req.session.user.id, 'discovery', 1);
    res.json({
      success: true,
      mode: 'strategy',
      product: out.context.product,
      customer: out.context.customer,
      triggerEvents: out.context.triggerEvents,
      location: out.context.location,
      suggestions: out.suggestions
    });
  } catch (e) {
    const msg = e.message || String(e);
    const code =
      msg.includes('Provide at least') || msg.includes('required') || msg.includes('configured') ? 400 : 500;
    logger.error(`POST /api/discover/strategy: ${msg}`);
    res.status(code).json({ error: msg });
  }
});

/**
 * POST /api/discover/google
 * Same body as /strategy — uses Serper to run real Google searches, then Gemini picks monitorable URLs.
 * Requires SERPER_API_KEY in .env (https://serper.dev).
 */
router.post('/google', requirePaid, express.json(), withDiscoveryMonthlyLimit, async (req, res) => {
  try {
    const out = await generateDiscoveryFromGoogleSearch(req.body || {});
    await incrementUsage(req.session.user.id, 'discovery', 1);
    res.json({
      success: true,
      mode: 'google_search',
      product: out.context.product,
      customer: out.context.customer,
      triggerEvents: out.context.triggerEvents,
      keyword: out.context.keyword,
      location: out.context.location,
      queriesUsed: out.queriesUsed,
      resultsPooled: out.resultsPooled,
      suggestions: out.suggestions
    });
  } catch (e) {
    const msg = e.message || String(e);
    const code =
      msg.includes('SERPER') || msg.includes('Provide at least') || msg.includes('not set') || msg.includes('configured')
        ? 400
        : 500;
    logger.error(`POST /api/discover/google: ${msg}`);
    res.status(code).json({ error: msg });
  }
});

/**
 * POST /api/discover/auto-leads — Primary flow: brief only → search → extract → leads (no URL required).
 * Body: { brief, maxLeads?: 15, maxSites?: 2, quickOnly?: true } — quickOnly skips verify/read (fast assistant brief + sources only).
 */
router.post('/auto-leads', requirePaid, enforceSourceLimit, express.json(), withDiscoveryMonthlyLimit, async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    const body = req.body || {};
    const brief = body.brief != null ? String(body.brief).trim() : '';
    if (brief.length < 12) {
      return res.status(400).json({
        error: 'Describe the leads you want (location, record type, filters) in at least one sentence.'
      });
    }
    const maxLeads = Math.min(50, Math.max(1, parseInt(body.maxLeads, 10) || 15));
    const maxSites = Math.min(3, Math.max(1, parseInt(body.maxSites, 10) || 2));
    const quickOnly = body.quickOnly === true;

    const out = await fetchLeadsFromBriefOnly({
      userId,
      brief,
      req,
      maxLeads,
      maxSites,
      quickOnly
    });
    await incrementUsage(req.session.user.id, 'discovery', 1);
    res.json(out);
  } catch (e) {
    const msg = e.message || String(e);
    const code = msg.includes('Describe') || msg.includes('at least') ? 400 : 500;
    logger.error(`POST /api/discover/auto-leads: ${msg}`);
    res.status(code).json({ error: msg });
  }
});

/**
 * POST /api/discover/extract-now — Optional: you already have a URL.
 * Body: { url, brief, maxLeads?: 15, deleteAfter?: false }
 */
router.post('/extract-now', requirePaid, enforceSourceLimit, express.json(), withDiscoveryMonthlyLimit, async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    const body = req.body || {};
    const brief = body.brief != null ? String(body.brief).trim() : '';
    const rawUrl = body.url != null ? String(body.url).trim() : '';
    let pageUrl;
    try {
      pageUrl = new URL(rawUrl).href;
    } catch {
      return res.status(400).json({ error: 'Valid url is required (include https://).' });
    }
    if (brief.length < 12) {
      return res.status(400).json({
        error: 'Provide a brief describing the exact fields and filters you need (one short paragraph is enough).'
      });
    }

    const maxLeads = Math.min(50, Math.max(1, parseInt(body.maxLeads, 10) || 15));
    const deleteAfter = body.deleteAfter === true || body.deleteAfter === 'true';

    const out = await runExtractNowForUrl({
      userId,
      brief,
      url: pageUrl,
      maxLeads,
      deleteAfter,
      req
    });

    await incrementUsage(req.session.user.id, 'discovery', 1);
    res.json({
      success: true,
      mode: 'extract_now',
      source_id: out.sourceId,
      field_schema: out.manifest.field_schema,
      strict_match_rules: out.manifest.strict_match_rules,
      strict_filter_applied: out.strictFilterApplied,
      leads: out.leads,
      note: out.note,
      deleted_ephemeral_source: deleteAfter
    });
  } catch (e) {
    const msg = e.message || String(e);
    const code =
      msg.includes('required') || msg.includes('Valid url') || msg.includes('Describe') ? 400 : 500;
    logger.error(`POST /api/discover/extract-now: ${msg}`);
    res.status(code).json({ error: msg });
  }
});

router.post('/nl-intent', requirePaid, express.json(), withDiscoveryMonthlyLimit, async (req, res) => {
  try {
    const brief = req.body && req.body.brief;
    if (!brief || String(brief).trim().length < 8) {
      return res.status(400).json({
        error: 'Provide a brief (what leads, where, e.g. permits, dollar threshold).'
      });
    }
    const out = await runNlLeadIntentDiscovery(String(brief).trim());
    await incrementUsage(req.session.user.id, 'discovery', 1);
    res.json({ success: true, mode: 'nl_intent', ...out });
  } catch (e) {
    const msg = e.message || String(e);
    logger.error(`POST /api/discover/nl-intent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /api/discover/monitor
 * Body: { name, url, keyword? } — creates a Playwright source in user_sources.
 */
router.post('/monitor', requirePaid, enforceSourceLimit, express.json(), async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    const {
      name,
      url,
      keyword,
      triggerLogic,
      suggestedFrequency,
      signalCategory,
      monitoringHints,
      description,
      sourceType
    } = req.body || {};
    if (!name || !url) {
      return res.status(400).json({ error: 'name and url are required' });
    }
    const inferred = inferMonitorSourceFromUrl(String(url).trim());
    logger.info(
      `[discover/monitor] URL inference: ${inferred.mode} (${inferred.sourceData.discoveryInferredMode || inferred.mode})`
    );
    const hints =
      (monitoringHints != null && String(monitoringHints).trim()
        ? String(monitoringHints).trim().slice(0, 1200)
        : null) ||
      (description != null && String(description).trim()
        ? String(description).trim().slice(0, 1200)
        : null);
    const sourceData = {
      name: String(name).slice(0, 200),
      url: inferred.url,
      ...inferred.sourceData,
      discoveryKeyword: keyword != null ? String(keyword).slice(0, 200) : null,
      fromDiscovery: true,
      ...(triggerLogic != null && String(triggerLogic).trim()
        ? { triggerLogic: String(triggerLogic).trim().slice(0, 800) }
        : {}),
      ...(hints ? { monitoringHints: hints } : {}),
      ...(suggestedFrequency != null && String(suggestedFrequency).trim()
        ? { suggestedMonitorFrequency: String(suggestedFrequency).trim().slice(0, 32) }
        : {}),
      ...(signalCategory != null && String(signalCategory).trim()
        ? { signalCategory: String(signalCategory).trim().slice(0, 80) }
        : {}),
      ...(sourceType != null && String(sourceType).trim()
        ? { discoverySourceType: String(sourceType).trim().slice(0, 40) }
        : {})
    };
    const result = await createUserSourceCore({ userId, sourceData, req });
    res.json(result);
  } catch (e) {
    const status = e.status && typeof e.status === 'number' ? e.status : 500;
    logger.error(`POST /api/discover/monitor: ${e.message}`);
    res.status(status).json({ error: e.message });
  }
});

module.exports = router;
