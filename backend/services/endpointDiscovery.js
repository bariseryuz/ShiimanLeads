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
const { getGeminiModel, isAIAvailable } = require('./ai/geminiClient');

const MAX_CANDIDATES_TO_PROBE = parseInt(process.env.ENDPOINT_DISCOVERY_MAX_PROBE || '20', 10) || 20;

/** Set ENDPOINT_DISCOVERY_USE_GEMINI=false to skip Gemini even when GEMINI_API_KEY is set. */
function geminiDiscoveryEnabled() {
  return process.env.ENDPOINT_DISCOVERY_USE_GEMINI !== 'false';
}

/**
 * Gemini: pick best URL + per-candidate pull guide (method, parameters, example Query Parameters JSON for Shiiman).
 * @param {{ url: string, rowCount: number, score: number }[]} probeResults
 * @param {string} pageUrlHint
 * @returns {Promise<{ recommendedUrl: string|null, reason: string, apiGuides: object[] }|null>}
 */
async function enrichDiscoveryWithGemini(probeResults, pageUrlHint = '') {
  if (!geminiDiscoveryEnabled() || !isAIAvailable() || !probeResults || probeResults.length === 0) {
    return null;
  }
  try {
    const model = getGeminiModel('endpoint_discovery');
    const lines = probeResults.slice(0, 20).map(
      (r, i) => `${i + 1}. rows=${r.rowCount} heuristicScore=${r.score} url=${r.url}`
    );
    const prompt = `You help configure HTTP data pulls for a lead app (permits, inspections, licenses, open data).

Page URL: ${pageUrlHint || 'unknown'}

Candidates (each probed with JSON where=1=1; rowCount = rows returned for that layer):
${lines.join('\n')}

Tasks:
1) Pick recommendedUrl — best for TABULAR operational data (permits, applications, inspections). Prefer Planning/Permits/Inspections layers. Avoid basemaps, roads-only, evacuation, VectorTileServer unless no alternative.
2) For EACH candidate URL above, output ONE object in apiGuides with the SAME url string (exact match).
   - ArcGIS .../FeatureServer/N/query: httpMethod GET; parameters must include f, where, outFields, returnGeometry, resultRecordCount (and common optional: outSR, orderByFields, spatialRel). Explain each briefly.
   - Non-ArcGIS REST: describe real query params or POST body fields.
   - queryParamsJsonExample: a SINGLE LINE string that is valid JSON (escaped) suitable for Shiiman "Query Parameters" — e.g. {"f":"json","where":"1=1","outFields":"*","returnGeometry":"false","resultRecordCount":"1000"}
   - howToPull: one sentence (GET with query string vs POST).

Return ONLY valid JSON, no markdown:
{
  "recommendedUrl":"<exact url from list or null>",
  "reason":"<short>",
  "apiGuides":[
    {
      "url":"<exact url from list>",
      "title":"<short label>",
      "httpMethod":"GET",
      "parameters":[{"name":"f","role":"output format","example":"json"}],
      "queryParamsJsonExample":"{\"f\":\"json\",\"where\":\"1=1\",\"outFields\":\"*\",\"returnGeometry\":\"false\"}",
      "howToPull":"<one sentence>"
    }
  ]
}
apiGuides length must equal the number of candidate lines (${lines.length}).`;

    const result = await model.generateContent(prompt);
    const raw = (await result.response.text()).trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    const parsed = JSON.parse(raw);
    const reason = parsed && typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 400) : '';
    const rawRec = parsed && Object.prototype.hasOwnProperty.call(parsed, 'recommendedUrl') ? parsed.recommendedUrl : null;
    let recommendedUrl = null;
    if (rawRec !== null && rawRec !== undefined) {
      const rec = typeof rawRec === 'string' ? rawRec.trim() : '';
      if (rec && probeResults.some(p => p.url === rec)) {
        recommendedUrl = rec;
        logger.info(`[EndpointDiscovery] Gemini recommends: ${rec.slice(0, 120)}…`);
      } else if (rec) {
        logger.warn(`[EndpointDiscovery] Gemini recommendedUrl not in probe list; ignoring.`);
      }
    }

    const guidesIn = Array.isArray(parsed.apiGuides) ? parsed.apiGuides : [];
    const allowed = new Set(probeResults.map(p => p.url));
    const apiGuides = guidesIn
      .filter(g => g && typeof g.url === 'string' && allowed.has(g.url))
      .map(g => ({
        url: g.url,
        title: typeof g.title === 'string' ? g.title.slice(0, 200) : '',
        httpMethod: typeof g.httpMethod === 'string' ? g.httpMethod : 'GET',
        parameters: Array.isArray(g.parameters) ? g.parameters : [],
        queryParamsJsonExample:
          typeof g.queryParamsJsonExample === 'string' ? g.queryParamsJsonExample.slice(0, 4000) : '',
        howToPull: typeof g.howToPull === 'string' ? g.howToPull.slice(0, 500) : ''
      }));

    return { recommendedUrl, reason: reason || '', apiGuides };
  } catch (e) {
    logger.warn(`[EndpointDiscovery] Gemini enrichment failed: ${e.message}`);
  }
  return null;
}

/**
 * @returns {Promise<{ recommendedUrl: string|null, reason: string }|null>}
 */
async function suggestEndpointWithGemini(probeResults, pageUrlHint = '') {
  const e = await enrichDiscoveryWithGemini(probeResults, pageUrlHint);
  if (!e) return null;
  return { recommendedUrl: e.recommendedUrl, reason: e.reason };
}

/**
 * Pull .../FeatureServer/N/query URLs out of a full request URL (including ArcGIS /sharing/proxy?https://...).
 * @param {string} fullUrl
 * @returns {string[]}
 */
function extractFeatureServerQueryUrls(fullUrl) {
  if (!fullUrl || typeof fullUrl !== 'string') return [];
  const re = /(https?:\/\/[^\s"'<>]+\/FeatureServer\/\d+\/query)/gi;
  const m = fullUrl.match(re);
  return m ? [...new Set(m.map(u => u.replace(/\/+$/, '')))] : [];
}

/**
 * Endpoints that look like APIs in DevTools but are not tabular JSON for leads (basemap tiles, SDK, etc.).
 * @param {string} url
 * @returns {boolean}
 */
function isDiscoveryNoiseEndpoint(url) {
  if (!url || isNoiseUrl(url)) return true;
  const l = url.split('?')[0].toLowerCase();
  if (l.includes('basemaps.arcgis.com')) return true;
  if (l.includes('js.arcgis.com')) return true;
  if (l.includes('static.arcgis.com')) return true;
  if (l.includes('vectortileserver') || l.includes('vector_tileserver')) return true;
  if (l.includes('/tilemap/')) return true;
  if (l.includes('/vector_tileserver/')) return true;
  if (/\/imageserver\/[^/]+\/tile\b/i.test(l)) return true;
  if (l.includes('world_basemap') || l.includes('world_hillshade')) return true;
  return false;
}

/** Soft positive signals for municipal / operational datasets (sector-agnostic). */
function dataIntentBoost(url) {
  const l = (url || '').toLowerCase();
  let b = 0;
  if (/(permit|planning|inspection|license|issued|violation|parcel|address|zoning|code enforce)/i.test(l)) b += 85;
  if (/(demolition|construction|building|application)/i.test(l)) b += 35;
  return b;
}

/** Downrank reference / basemap layers that are rarely the “business” table users want. */
function referenceLayerPenalty(url) {
  const l = (url || '').toLowerCase();
  let p = 0;
  if (/(roads|centerline|boundary|basemap|evacuation|hillshade|contour|hydro)/i.test(l)) p += 55;
  if (/services1\.arcgis\.com.*evacuation/i.test(l)) p += 40;
  return p;
}

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
  const pathOnly = reqUrl.split('?')[0] || '';
  if (isDiscoveryNoiseEndpoint(pathOnly)) return false;

  const inners = extractFeatureServerQueryUrls(reqUrl);
  if (inners.length) {
    return inners.some(u => !isDiscoveryNoiseEndpoint(u));
  }

  const u = pathOnly.toLowerCase();
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

/**
 * Rank candidates: prefer FeatureServer/query on operational layers, penalize basemap/tiles/noise.
 * @param {string} url
 * @returns {number}
 */
function scoreCandidateHeuristic(url) {
  if (!url) return -9999;
  if (isDiscoveryNoiseEndpoint(url)) return -9999;

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

  s += dataIntentBoost(url);
  s -= referenceLayerPenalty(url);

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
      const reqUrl = req.url();
      const rt = req.resourceType();
      const looksLikeFeatureQuery = /\/featureserver\/\d+\/query/i.test(reqUrl);
      if (!looksLikeFeatureQuery && rt !== 'xhr' && rt !== 'fetch') return;
      if (!isCandidateApiUrl(reqUrl)) return;

      const toAdd = [];
      const inners = extractFeatureServerQueryUrls(reqUrl);
      if (inners.length) {
        inners.forEach(u => {
          if (!isDiscoveryNoiseEndpoint(u)) toAdd.push(u);
        });
      } else {
        const base = reqUrl.split('?')[0];
        if (!isDiscoveryNoiseEndpoint(base)) toAdd.push(base);
      }
      for (const base of toAdd) {
        if (seen.has(base)) continue;
        seen.add(base);
        candidateUrls.push(base);
      }
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 60000) });
    await page.waitForTimeout(8000);
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
 * Ensure probe uses JSON + permissive WHERE so we rank **layers** by who returns rows.
 * (User-specific demolition filters often match zero rows on the wrong layer — discovery would then fail every probe.)
 * @param {object} probeManifest
 * @returns {object}
 */
function buildProbeManifest(probeManifest = {}) {
  const m = { ...probeManifest };
  const qp = { ...(m.query_params || m.params || {}) };
  if (qp.f == null || qp.f === '') qp.f = 'json';
  qp.where = '1=1';
  if (qp.outFields == null || qp.outFields === '') qp.outFields = '*';
  m.query_params = qp;
  return m;
}

/**
 * Probe candidates with the same query/body as the user's manifest; pick highest row count.
 * Does not return a misleading "guess" when all probes return 0 rows — caller should show ranked list for manual pick.
 * @param {string[]} candidates - Base URLs (no query) from network capture
 * @param {object} probeManifest - Same shape as engine manifest (query_params, method, body, …)
 * @returns {Promise<{ url: string|null, rowCount: number, rankedCandidates: string[] }>}
 */
async function pickBestEndpointByProbing(candidates, probeManifest = {}) {
  if (!candidates || !candidates.length) {
    return { url: null, rowCount: 0, rankedCandidates: [], probeResults: [] };
  }

  const ranked = [...new Set(candidates)]
    .filter(u => scoreCandidateHeuristic(u) > -9000)
    .sort((a, b) => scoreCandidateHeuristic(b) - scoreCandidateHeuristic(a));
  const toProbe = ranked.slice(0, MAX_CANDIDATES_TO_PROBE);

  const manifest = buildProbeManifest(probeManifest);

  /** @type {{ url: string, rowCount: number, score: number }[]} */
  const probeResults = [];
  for (const url of toProbe) {
    const { rowCount } = await probeRowCount(url, manifest);
    probeResults.push({
      url,
      rowCount,
      score: Math.round(scoreCandidateHeuristic(url))
    });
  }
  probeResults.sort((a, b) => b.rowCount - a.rowCount || b.score - a.score);

  let bestUrl = null;
  let bestCount = 0;
  for (const r of probeResults) {
    if (r.rowCount > bestCount) {
      bestCount = r.rowCount;
      bestUrl = r.url;
    }
  }

  if (bestUrl && bestCount > 0) {
    logger.info(`[EndpointDiscovery] Best probed endpoint: ${bestUrl} (${bestCount} rows)`);
    return { url: bestUrl, rowCount: bestCount, rankedCandidates: ranked, probeResults };
  }

  logger.warn(
    `[EndpointDiscovery] No candidate returned rows with probe (where/outFields). ` +
      `Pick a URL from the ranked list manually or paste .../FeatureServer/N/query from DevTools. ` +
      `Top heuristic: ${ranked[0] || 'none'}`
  );
  return { url: null, rowCount: 0, rankedCandidates: ranked, probeResults };
}

/**
 * Discover endpoint from a generic page: collect candidates, probe with manifest, return best.
 */
async function discoverBestFromPage(pageUrl, probeManifest, timeoutMs = 20000) {
  const candidates = await discoverCandidateUrlsFromPage(pageUrl, timeoutMs);
  if (!candidates.length) {
    return {
      endpointUrl: null,
      rowCount: 0,
      candidates: [],
      probeResults: [],
      aiSuggestion: null,
      apiGuides: []
    };
  }

  const { url, rowCount, rankedCandidates, probeResults } = await pickBestEndpointByProbing(candidates, probeManifest);
  const listForUi = rankedCandidates && rankedCandidates.length ? rankedCandidates : candidates;

  let aiSuggestion = null;
  let apiGuides = [];
  if (probeResults && probeResults.length > 0) {
    try {
      const enriched = await enrichDiscoveryWithGemini(probeResults, pageUrl);
      if (enriched) {
        aiSuggestion = { recommendedUrl: enriched.recommendedUrl, reason: enriched.reason };
        apiGuides = Array.isArray(enriched.apiGuides) ? enriched.apiGuides : [];
      }
    } catch (e) {
      logger.warn(`[EndpointDiscovery] Gemini advisory: ${e.message}`);
    }
  }

  return {
    endpointUrl: url,
    rowCount,
    candidates: listForUi,
    probeResults: probeResults || [],
    aiSuggestion,
    apiGuides
  };
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

  const defaultProbe = { query_params: { f: 'json', where: '1=1', outFields: '*' } };
  const effectiveProbe =
    probeManifest && typeof probeManifest === 'object' && Object.keys(probeManifest).length > 0
      ? probeManifest
      : defaultProbe;

  const { endpointUrl, rowCount, candidates, probeResults, aiSuggestion, apiGuides } = await discoverBestFromPage(
    trimmed,
    effectiveProbe,
    20000
  );
  const aiHint =
    aiSuggestion && aiSuggestion.reason
      ? ` Gemini: ${aiSuggestion.reason}${aiSuggestion.recommendedUrl ? ` Suggested URL: ${aiSuggestion.recommendedUrl}` : ''}`
      : '';
  if (endpointUrl) {
    return {
      endpointUrl,
      type: 'json',
      hint: `Data endpoint selected by probe (${rowCount} row(s); probe used where=1=1). Adjust Query Parameters for your filters.${aiHint}`,
      rowCount,
      candidates,
      probeResults,
      aiSuggestion,
      apiGuides: apiGuides || []
    };
  }
  if (candidates && candidates.length) {
    return {
      endpointUrl: null,
      type: 'json',
      hint: `Found ${candidates.length} API candidate(s); none returned rows on probe. Pick one below or paste .../FeatureServer/N/query from DevTools.${aiHint}`,
      candidates,
      probeResults,
      aiSuggestion,
      apiGuides: apiGuides || []
    };
  }

  const found = await discoverFromPage(trimmed, 20000);
  if (found) {
    return {
      endpointUrl: found,
      type: 'json',
      hint: 'Data API endpoint detected from page requests (heuristic only; no row probe). Prefer a full discover run with network capture.',
      candidates: [found],
      probeResults: [],
      apiGuides: []
    };
  }

  return {
    endpointUrl: null,
    type: 'page',
    hint: 'No data API endpoint detected. You can keep this URL to scrape as a webpage (AI or intercept).',
    probeResults: [],
    apiGuides: []
  };
}

module.exports = {
  discoverEndpoint,
  discoverBestFromPage,
  discoverCandidateUrlsFromPage,
  pickBestEndpointByProbing,
  enrichDiscoveryWithGemini,
  suggestEndpointWithGemini,
  isLikelyEndpoint,
  isArcGISHubUrl
};
