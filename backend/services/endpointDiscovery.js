/**
 * Universal endpoint discovery: given any URL, find the data API endpoint.
 * Neutral: works for ArcGIS Hub, .NET _Get* pages, or generic pages that trigger XHR/fetch.
 * Picks the endpoint that actually returns tabular/list JSON (not just the first XHR).
 */

const { chromium } = require('playwright');
const logger = require('../utils/logger');
const { getStealthLaunchOptions, getStealthContextOptions, injectStealthScripts } = require('./scraper/stealth');
const { discoverArcGISEndpoint } = require('./scraper/arcgis');
const { probeRowCount } = require('../engine/adapters/rest');

const MAX_CANDIDATES_TO_PROBE = parseInt(process.env.ENDPOINT_DISCOVERY_MAX_PROBE || '20', 10) || 20;

/** URL already looks like a data endpoint (no discovery needed) */
function isLikelyEndpoint(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return (
    u.includes('/_get') ||
    (u.includes('/query') && (u.includes('featureserver') || u.includes('arcgis') || u.includes('rest/services'))) ||
    (u.includes('featureserver') && u.includes('arcgis'))
  );
}

/** URL looks like an ArcGIS Hub / explore / datasets page (discover via ArcGIS) */
function isArcGISHubUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return (
    (u.includes('arcgis') && (u.includes('/datasets/') || u.includes('/explore') || u.includes('/items/'))) ||
    u.includes('/datasets/') ||
    (u.includes('/explore') && !u.includes('/query'))
  );
}

function isNoiseUrl(u) {
  if (!u || typeof u !== 'string') return true;
  if (/\.(js|mjs|css|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|svg|map)(\?|$)/i.test(u)) return true;
  const l = u.toLowerCase();
  return (
    l.includes('google-analytics.com') ||
    l.includes('googletagmanager.com') ||
    l.includes('facebook.net') ||
    l.includes('doubleclick.net') ||
    l.includes('/analytics/') ||
    l.includes('hotjar') ||
    l.includes('segment.io') ||
    l.includes('sentry.io')
  );
}

/**
 * Heuristic: likely data APIs observed in XHR/fetch (expand as portals evolve).
 */
function isCandidateApiUrl(reqUrl) {
  if (!reqUrl || isNoiseUrl(reqUrl)) return false;
  const u = reqUrl.split('?')[0].toLowerCase();

  if (u.includes('/_get')) return true;
  if (u.includes('/query') && (u.includes('featureserver') || u.includes('arcgis') || u.includes('rest/services'))) return true;
  if (u.includes('/api/') && !u.includes('/analytics')) return true;
  if (u.includes('/rest/services/')) return true;
  if (u.includes('/graphql') || u.includes('graphql')) return true;
  if (u.includes('odata')) return true;
  if (u.includes('.ashx')) return true;
  if (u.includes('/search') && (u.includes('api') || u.includes('data') || u.includes('json'))) return true;

  return false;
}

function scoreCandidateHeuristic(url) {
  let s = 0;
  const l = url.toLowerCase();
  const pathOnly = (url.split('?')[0] || '').toLowerCase();

  // ArcGIS: data lives at .../FeatureServer/N/query — not at .../FeatureServer/N (layer metadata).
  if (pathOnly.includes('featureserver') && pathOnly.includes('/query')) {
    s += 260;
  } else if (/\/featureserver\/\d+\/?$/i.test(url.split('?')[0] || '')) {
    s += 35;
  } else if (l.includes('featureserver') || (l.includes('/query') && l.includes('arcgis'))) {
    s += 120;
  }

  if (l.includes('/_get')) s += 90;
  if (l.includes('/api/')) s += 50;
  if (l.includes('graphql')) s += 45;
  if (l.includes('/rest/services')) s += 40;
  if (l.includes('odata')) s += 35;
  if (l.includes('.ashx')) s += 25;
  s += Math.min(url.length, 300) / 1000;
  return s;
}

/**
 * Collect unique API-like request URLs from a page (order preserved).
 */
async function discoverCandidateUrlsFromPage(pageUrl, timeoutMs = 20000) {
  let browser;
  const candidateUrls = [];
  const seen = new Set();

  try {
    browser = await chromium.launch(getStealthLaunchOptions());
    const context = await browser.newContext(getStealthContextOptions());
    const page = await context.newPage();
    await injectStealthScripts(page);

    page.on('request', req => {
      if (req.method() !== 'GET' && req.method() !== 'POST') return;
      if (req.resourceType() !== 'xhr' && req.resourceType() !== 'fetch') return;
      const reqUrl = req.url();
      if (!isCandidateApiUrl(reqUrl)) return;
      const base = reqUrl.split('?')[0];
      if (seen.has(base)) return;
      seen.add(base);
      candidateUrls.push(base);
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 60000) });
    await page.waitForTimeout(5000);
    const searchBtn = page.locator('button:has-text("Search"), button[type="submit"], input[type="submit"], [type="submit"]');
    if (await searchBtn.count() > 0) {
      await searchBtn.first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(8000);
    }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});

    if (candidateUrls.length) {
      logger.info(`[EndpointDiscovery] Collected ${candidateUrls.length} candidate URL(s) from page`);
    }
    return candidateUrls;
  } catch (err) {
    logger.warn(`[EndpointDiscovery] Page discovery failed: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return [];
  }
}

/**
 * Probe candidates with the same query/body as the user's manifest; pick highest row count.
 * @param {string[]} candidates - Base URLs (no query) from network capture
 * @param {object} probeManifest - Same shape as engine manifest (query_params, method, body, …)
 * @returns {Promise<{ url: string|null, rowCount: number }>}
 */
async function pickBestEndpointByProbing(candidates, probeManifest = {}) {
  if (!candidates || !candidates.length) return { url: null, rowCount: 0 };

  const ranked = [...new Set(candidates)].sort((a, b) => scoreCandidateHeuristic(b) - scoreCandidateHeuristic(a));
  const toProbe = ranked.slice(0, MAX_CANDIDATES_TO_PROBE);

  let bestUrl = null;
  let bestCount = 0;

  for (const url of toProbe) {
    const { rowCount } = await probeRowCount(url, probeManifest);
    if (rowCount > bestCount) {
      bestCount = rowCount;
      bestUrl = url;
      if (rowCount >= 50) {
        logger.info(`[EndpointDiscovery] Strong match: ${url} (${rowCount} rows)`);
        break;
      }
    }
  }

  if (bestUrl && bestCount > 0) {
    logger.info(`[EndpointDiscovery] Best probed endpoint: ${bestUrl} (${bestCount} rows)`);
    return { url: bestUrl, rowCount: bestCount };
  }

  if (toProbe.length) {
    const fallback = toProbe[0];
    logger.info(`[EndpointDiscovery] Probes returned no rows; using top-ranked candidate: ${fallback}`);
    return { url: fallback, rowCount: 0 };
  }

  return { url: null, rowCount: 0 };
}

/**
 * Discover endpoint from a generic page: collect candidates, probe with manifest, return best.
 */
async function discoverBestFromPage(pageUrl, probeManifest, timeoutMs = 20000) {
  const candidates = await discoverCandidateUrlsFromPage(pageUrl, timeoutMs);
  if (!candidates.length) return { endpointUrl: null, rowCount: 0, candidates: [] };

  const { url, rowCount } = await pickBestEndpointByProbing(candidates, probeManifest);
  return { endpointUrl: url, rowCount, candidates };
}

/** Legacy: best heuristic candidate (prefer ArcGIS /query over bare FeatureServer/N) */
async function discoverFromPage(pageUrl, timeoutMs = 20000) {
  const candidates = await discoverCandidateUrlsFromPage(pageUrl, timeoutMs);
  if (!candidates.length) return null;
  const sorted = [...new Set(candidates)].sort((a, b) => scoreCandidateHeuristic(b) - scoreCandidateHeuristic(a));
  const best = sorted[0];
  if (best) logger.info(`[EndpointDiscovery] Found from page (top heuristic): ${best}`);
  return best;
}

/**
 * Main entry: discover the data API endpoint for a given URL.
 * @param {string} url - User-entered URL (page or endpoint)
 * @param {object} [logOrOpts] - Legacy: Winston-style `logger`. Or `{ logger?, probeManifest? }` to probe candidates with your query/body.
 * @returns {Promise<{ endpointUrl: string|null, type: string, hint: string, rowCount?: number, candidates?: string[] }>}
 */
async function discoverEndpoint(url, logOrOpts = logger) {
  let log = logger;
  let probeManifest = null;
  if (logOrOpts && typeof logOrOpts.info === 'function') {
    log = logOrOpts;
  } else if (logOrOpts && typeof logOrOpts === 'object') {
    if (logOrOpts.logger && typeof logOrOpts.logger.info === 'function') log = logOrOpts.logger;
    if (logOrOpts.probeManifest != null && typeof logOrOpts.probeManifest === 'object') {
      probeManifest = logOrOpts.probeManifest;
    }
  }

  if (!url || typeof url !== 'string') {
    return { endpointUrl: null, type: 'unknown', hint: 'No URL provided.' };
  }

  const trimmed = url.trim();
  if (!trimmed) return { endpointUrl: null, type: 'unknown', hint: 'URL is empty.' };

  if (isLikelyEndpoint(trimmed)) {
    return {
      endpointUrl: trimmed,
      type: trimmed.toLowerCase().includes('arcgis') || trimmed.includes('FeatureServer') ? 'arcgis' : 'json',
      hint: 'URL already looks like an API endpoint.'
    };
  }

  if (isArcGISHubUrl(trimmed)) {
    log.info('[EndpointDiscovery] ArcGIS Hub URL detected, resolving endpoint...');
    const apiUrl = await discoverArcGISEndpoint(trimmed, log, []);
    if (apiUrl) {
      return { endpointUrl: apiUrl, type: 'arcgis', hint: 'ArcGIS API endpoint resolved from Hub URL.' };
    }
    return { endpointUrl: null, type: 'arcgis', hint: 'Could not resolve ArcGIS endpoint; check URL or try again.' };
  }

  log.info('[EndpointDiscovery] Page URL detected, listening for API requests...');

  if (probeManifest && Object.keys(probeManifest).length > 0) {
    const { endpointUrl, rowCount, candidates } = await discoverBestFromPage(trimmed, probeManifest, 20000);
    if (endpointUrl) {
      return {
        endpointUrl,
        type: 'json',
        hint:
          rowCount > 0
            ? `Data endpoint selected by probe (${rowCount} rows with your parameters).`
            : 'Data API endpoint detected from page requests (probed with your parameters).',
        rowCount,
        candidates
      };
    }
    if (candidates && candidates.length) {
      return {
        endpointUrl: null,
        type: 'json',
        hint: `Found ${candidates.length} API candidate(s) but none returned rows with current parameters. Adjust query/POST body or open the page and search again.`,
        candidates
      };
    }
  }

  const found = await discoverFromPage(trimmed, 20000);
  if (found) {
    return { endpointUrl: found, type: 'json', hint: 'Data API endpoint detected from page requests.' };
  }

  return {
    endpointUrl: null,
    type: 'page',
    hint: 'No data API endpoint detected. You can keep this URL to scrape as a webpage (AI or intercept).'
  };
}

module.exports = {
  discoverEndpoint,
  discoverBestFromPage,
  discoverCandidateUrlsFromPage,
  pickBestEndpointByProbing,
  isLikelyEndpoint,
  isArcGISHubUrl
};
