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
const { createUserSourceCore } = require('../services/createUserSourceCore');
const logger = require('../utils/logger');
const { requirePaid, enforceSourceLimit } = require('../middleware/billing');
const { assertMonthlyAllowance, incrementUsage } = require('../services/usageMeter');
const { createRateLimiter } = require('../middleware/rateLimitMemory');
const scaleLimits = require('../config/scaleLimits');

const discoverLimiter = createRateLimiter({
  windowMs: scaleLimits.discoverRate.windowMs,
  max: scaleLimits.discoverRate.max,
  name: 'discover',
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
    const hints =
      (monitoringHints != null && String(monitoringHints).trim()
        ? String(monitoringHints).trim().slice(0, 1200)
        : null) ||
      (description != null && String(description).trim()
        ? String(description).trim().slice(0, 1200)
        : null);
    const sourceData = {
      name: String(name).slice(0, 200),
      url: String(url).trim(),
      method: 'playwright',
      usePlaywright: true,
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
