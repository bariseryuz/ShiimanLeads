/**
 * Universal endpoint discovery: given any URL, try to find the data API endpoint.
 * Neutral: works for ArcGIS Hub, .NET _Get* pages, or generic pages that trigger XHR/fetch.
 */

const { chromium } = require('playwright');
const logger = require('../utils/logger');
const { getStealthLaunchOptions, getStealthContextOptions, injectStealthScripts } = require('./scraper/stealth');
const { discoverArcGISEndpoint } = require('./scraper/arcgis');

/** URL already looks like a data endpoint (no discovery needed) */
function isLikelyEndpoint(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return (
    u.includes('/_get') ||
    u.includes('/query') && (u.includes('featureserver') || u.includes('arcgis') || u.includes('rest/services')) ||
    (u.includes('featureserver') && u.includes('arcgis'))
  );
}

/** URL looks like an ArcGIS Hub / explore / datasets page (discover via ArcGIS) */
function isArcGISHubUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return (
    u.includes('arcgis') && (u.includes('/datasets/') || u.includes('/explore') || u.includes('/items/')) ||
    u.includes('/datasets/') ||
    (u.includes('/explore') && !u.includes('/query'))
  );
}

/** Discover endpoint from a generic page by listening for API-like requests (e.g. _Get*, /query, /api/) */
async function discoverFromPage(pageUrl, timeoutMs = 20000) {
  let browser;
  try {
    browser = await chromium.launch(getStealthLaunchOptions());
    const context = await browser.newContext(getStealthContextOptions());
    const page = await context.newPage();
    await injectStealthScripts(page);

    const candidateUrls = [];

    page.on('request', (req) => {
      const reqUrl = req.url();
      if (req.method() !== 'GET' && req.method() !== 'POST') return;
      if (req.resourceType() !== 'xhr' && req.resourceType() !== 'fetch') return;
      if (/\.(js|css|png|jpg|ico|woff)(\?|$)/i.test(reqUrl)) return;
      if (candidateUrls.some((c) => reqUrl.startsWith(c))) return;
      if (reqUrl.includes('/_Get') || reqUrl.includes('/query') || reqUrl.includes('/api/') && !reqUrl.includes('/analytics/')) {
        candidateUrls.push(reqUrl.split('?')[0]);
      }
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

    const first = candidateUrls[0] || null;
    if (first) logger.info(`[EndpointDiscovery] Found from page: ${first}`);
    return first;
  } catch (err) {
    logger.warn(`[EndpointDiscovery] Page discovery failed: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

/**
 * Main entry: discover the data API endpoint for a given URL.
 * @param {string} url - User-entered URL (page or endpoint)
 * @param {object} logger - Logger instance
 * @returns {Promise<{ endpointUrl: string|null, type: string, hint: string }>}
 */
async function discoverEndpoint(url, log = logger) {
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
  isLikelyEndpoint,
  isArcGISHubUrl
};
