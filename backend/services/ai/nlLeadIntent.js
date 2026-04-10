/**
 * Natural-language "find me leads like X" — parse intent, search the web (Serper), optionally sample ArcGIS rows.
 * Does not guarantee contacts: permit data rarely includes email; enrichment is separate.
 */

const axios = require('axios');
const logger = require('../../utils/logger');
const { getGeminiModel, isAIAvailable } = require('./geminiClient');
const { retryWithBackoff } = require('../../utils/aiRetry');
const scaleLimits = require('../../config/scaleLimits');
const { googleSearchOrganic, hasSerper, dedupeSearchResults, sleep } = require('../serperSearch');
const { ensureArcGISFeatureLayerQueryUrl } = require('../../engine/adapters/rest');
const { fetchOpenDataSampleRows } = require('../openDataDirectSample');
const { sortUrls } = require('../candidateUrlSort');
const { retrieveLeadGenContext, isRagEnabled } = require('./rag/leadGenRag');
const { expandHighSignalSearchQueries } = require('./searchQueryExpansion');
const { buildScoutTemporalQueries } = require('./scoutTemporalQueries');

function parseIntentJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * @param {string} brief - User sentence e.g. "3 hot leads, new multifamily permits in CA over $300k"
 */
async function parseBriefWithGemini(brief) {
  const b = String(brief || '').trim();
  if (b.length < 8) {
    throw new Error('Describe what leads you need in at least a short paragraph.');
  }
  if (!isAIAvailable()) {
    throw new Error('AI not configured (GEMINI_API_KEY)');
  }

  let ragContext = '';
  if (isRagEnabled()) {
    try {
      ragContext = await retrieveLeadGenContext(b, { topK: 5, maxChars: 3500 });
    } catch (e) {
      logger.debug(`nlLeadIntent RAG: ${e.message}`);
    }
  }

  const prompt =
    'You extract structured lead-search intent from a user message. Return ONLY valid JSON:\n' +
    '{\n' +
    '  "lead_count": <number 1-25, default 3>,\n' +
    '  "geography": "<plain words e.g. California, Los Angeles County, Nashville TN>",\n' +
    '  "geography_kind": "state"|"county"|"city"|"metro"|"unknown",\n' +
    '  "state_code": "<two-letter US state if applicable or empty>",\n' +
    '  "asset_or_use": "<e.g. multifamily residential, commercial office>",\n' +
    '  "trigger_or_record": "<e.g. building permit, certificate of occupancy, new construction>",\n' +
    '  "min_project_value_usd": <number or null if not specified>,\n' +
    '  "wants_contact_info": <boolean>,\n' +
    '  "keywords_for_search": ["3-6 short phrases for Google queries"]\n' +
    '}\n\n' +
    (ragContext
      ? `Retrieved domain knowledge (tune geography, keywords, and record types — user message still wins):\n${ragContext}\n\n`
      : '') +
    `User message:\n${b.slice(0, 4000)}`;

  const model = getGeminiModel('discovery');
  const result = await retryWithBackoff(
    () => model.generateContent(prompt),
    { maxRetries: scaleLimits.gemini.maxRetries, baseMs: scaleLimits.gemini.retryBaseMs }
  );
  const raw = (await result.response).text();
  const o = parseIntentJson(raw);
  if (!o || typeof o !== 'object') {
    throw new Error('Could not understand that request — try adding location, permit type, and any dollar threshold.');
  }
  let triggerOrRecord = String(o.trigger_or_record || 'building permit').trim();
  if (!triggerOrRecord || /^unknown$/i.test(triggerOrRecord)) {
    triggerOrRecord = 'building permit';
  }

  return {
    lead_count: Math.min(25, Math.max(1, parseInt(o.lead_count, 10) || 3)),
    geography: String(o.geography || '').trim() || 'United States',
    geography_kind: String(o.geography_kind || 'unknown'),
    state_code: String(o.state_code || '').trim().toUpperCase().slice(0, 2),
    asset_or_use: String(o.asset_or_use || '').trim(),
    trigger_or_record: triggerOrRecord,
    min_project_value_usd:
      o.min_project_value_usd != null && Number.isFinite(Number(o.min_project_value_usd))
        ? Number(o.min_project_value_usd)
        : null,
    wants_contact_info: !!o.wants_contact_info,
    keywords_for_search: Array.isArray(o.keywords_for_search)
      ? o.keywords_for_search.map(k => String(k || '').trim()).filter(Boolean).slice(0, 8)
      : []
  };
}

function buildSerperQueries(intent) {
  const geo = intent.geography;
  const st = intent.state_code;
  const asset = intent.asset_or_use;
  let trig = intent.trigger_or_record;
  if (!trig || /^unknown$/i.test(String(trig))) trig = 'building permit';
  const base = [
    `${geo} ${trig} open data ArcGIS FeatureServer site:gov`,
    `${st ? st + ' ' : ''}${trig} ${asset || 'commercial'} site:gov`,
    `${geo} ${trig} Socrata OR data portal`,
    `${geo} county ${trig} GIS`
  ];
  if (intent.keywords_for_search.length) {
    for (const k of intent.keywords_for_search.slice(0, 2)) {
      base.push(`${k} site:gov OR site:org`);
    }
  }
  return [...new Set(base.map(q => q.trim()).filter(q => q.length > 5))].slice(0, 5);
}

function looksLikeArcGisDataUrl(link) {
  return typeof link === 'string' && /featureserver\/\d+/i.test(link) && /^https?:\/\//i.test(link);
}

/**
 * Resolve FeatureServer layer URL, MapServer/N, or MapServer/layers catalog to a /query URL.
 */
async function resolveArcgisQueryUrl(layerPageUrl) {
  const raw = String(layerPageUrl || '').trim();
  if (!/^https?:\/\//i.test(raw)) return null;

  if (looksLikeArcGisDataUrl(raw)) {
    return ensureArcGISFeatureLayerQueryUrl(raw);
  }

  try {
    const lower = raw.toLowerCase();
    if (lower.includes('/mapserver/') && lower.endsWith('/layers')) {
      const resp = await axios.get(raw.split('?')[0], {
        params: { f: 'json' },
        timeout: 18000,
        validateStatus: () => true
      });
      const layers = Array.isArray(resp.data?.layers) ? resp.data.layers : [];
      const first =
        layers.find(l => String(l.type || '').toLowerCase().includes('feature')) || layers[0];
      if (first && Number.isFinite(Number(first.id))) {
        const base = raw.replace(/\/layers\/?$/i, '').replace(/\/$/, '');
        return `${base}/${first.id}/query`;
      }
      return null;
    }

    if (/\/mapserver\/\d+$/i.test(raw) && !lower.includes('/query')) {
      return `${raw.replace(/\/$/, '')}/query`;
    }
  } catch (e) {
    logger.warn(`[nlLeadIntent] resolveArcgisQueryUrl: ${e.message}`);
  }
  return null;
}

/**
 * Fetch up to N sample feature attributes from a public ArcGIS layer URL.
 */
async function tryArcgisSampleRows(layerPageUrl, maxFeatures = 5) {
  let queryUrl = await resolveArcgisQueryUrl(layerPageUrl);
  if (!queryUrl) return null;
  try {
    const u = new URL(queryUrl);
    if (!u.pathname.toLowerCase().includes('/query')) return null;
  } catch {
    return null;
  }

  try {
    const response = await axios.get(queryUrl, {
      params: {
        f: 'json',
        where: '1=1',
        outFields: '*',
        returnGeometry: false,
        resultRecordCount: maxFeatures
      },
      timeout: 18000,
      validateStatus: () => true
    });
    const data = response.data;
    if (data?.error) {
      logger.warn(`[nlLeadIntent] ArcGIS error: ${JSON.stringify(data.error).slice(0, 200)}`);
      return null;
    }
    const features = Array.isArray(data?.features) ? data.features : [];
    const rows = features.slice(0, maxFeatures).map(f => f.attributes || {});
    return rows.length ? rows : null;
  } catch (e) {
    logger.warn(`[nlLeadIntent] ArcGIS sample failed: ${e.message}`);
    return null;
  }
}

function filterUnhelpfulSearchLinks(rows) {
  return rows.filter(r => {
    const u = String(r.link || '');
    if (/\.pdf(\?|$)/i.test(u)) return false;
    if (/\.(png|jpg|jpeg|gif)(\?|$)/i.test(u)) return false;
    return true;
  });
}

async function pickBestSourceUrls(organicPool, intent) {
  const pool = filterUnhelpfulSearchLinks(organicPool);
  if (!pool.length || !isAIAvailable()) return [];
  try {
    const model = getGeminiModel('discovery');
    const pack =
      'Pick up to 5 URLs most likely to yield ROW-LEVEL public records (permits, licenses, bids, violations).\n' +
      'Prefer: ArcGIS FeatureServer or MapServer layer URLs, Socrata, open-data APIs — NOT generic department homepages unless no better link exists.\n' +
      'Never pick PDF or image URLs. Prefer links whose path includes FeatureServer, MapServer, "data", "permits", or hub.arcgis.com datasets.\n' +
      `Intent: ${JSON.stringify(intent)}\n\n` +
      'Candidates (title, link, snippet):\n' +
      JSON.stringify(
        pool.slice(0, 25).map((r, i) => ({ i, title: r.title, link: r.link, snippet: r.snippet })),
        null,
        2
      ) +
      '\n\nReturn ONLY JSON: {"urls":["https://..."]} — use link values exactly from candidates.';

    const result = await retryWithBackoff(
      () => model.generateContent(pack),
      { maxRetries: scaleLimits.gemini.maxRetries, baseMs: scaleLimits.gemini.retryBaseMs }
    );
    const raw = (await result.response).text();
    const o = parseIntentJson(raw);
    const urls = Array.isArray(o?.urls)
      ? o.urls.map(u => String(u || '').trim()).filter(u => /^https?:\/\//i.test(u))
      : [];
    const allowed = new Set(pool.map(r => r.link));
    return urls.filter(u => allowed.has(u)).slice(0, 5);
  } catch (e) {
    logger.warn(`[nlLeadIntent] pickBestSourceUrls: ${e.message}`);
    return [];
  }
}

/**
 * End-to-end: NL brief → intent → Serper → ranked URLs → optional ArcGIS preview rows.
 */
async function runNlLeadIntentDiscovery(brief) {
  const intent = await parseBriefWithGemini(brief);

  if (!hasSerper()) {
    return {
      intent,
      search_queries_used: [],
      results_pooled: 0,
      candidate_sources: [],
      preview_leads: null,
      preview_note:
        'Add SERPER_API_KEY to the server to search Google for real permit/open-data URLs. Intent was parsed successfully.',
      disclaimer:
        'Automated search finds public data portals — not guaranteed emails. Map valuation/multifamily filters after you connect a source; field names differ by county.'
    };
  }

  const baseQueries = buildSerperQueries(intent);
  const scoutQueries = buildScoutTemporalQueries(intent);
  let expanded = [];
  try {
    const ex = await expandHighSignalSearchQueries(brief, intent);
    expanded = Array.isArray(ex.queries) ? ex.queries : [];
  } catch (e) {
    logger.debug(`nlLeadIntent query expansion: ${e.message}`);
  }
  const queries = [
    ...new Set(
      [...scoutQueries, ...expanded, ...baseQueries]
        .map(q => String(q || '').trim())
        .filter(q => q.length > 5)
    )
  ].slice(0, 10);
  const maxSerper = Math.min(10, parseInt(process.env.NL_INTENT_MAX_SERPER || '8', 10) || 8);
  const nq = Math.min(queries.length, maxSerper);
  const collected = [];
  for (let i = 0; i < nq; i++) {
    try {
      const rows = await googleSearchOrganic(queries[i], { num: 10 });
      rows.forEach(r => collected.push({ ...r, sourceQuery: queries[i] }));
    } catch (e) {
      logger.warn(`[nlLeadIntent] Serper query failed: ${e.message}`);
    }
    await sleep(400);
  }

  const deduped = dedupeSearchResults(collected);
  const pool = deduped.slice(0, 30);

  let pickedUrls = await pickBestSourceUrls(pool, intent);
  if (!pickedUrls.length) {
    pickedUrls = pool
      .filter(r => looksLikeArcGisDataUrl(r.link) || /\/mapserver\//i.test(String(r.link || '')))
      .map(r => r.link)
      .slice(0, 3);
  }
  // Last resort: any organic HTTPS links so brief-only flows can still try browser extraction
  if (!pickedUrls.length && pool.length) {
    pickedUrls = pool
      .map(r => r.link)
      .filter(u => typeof u === 'string' && /^https?:\/\//i.test(u))
      .slice(0, 5);
  }

  pickedUrls = sortUrls(pickedUrls);

  const candidate_sources = pickedUrls.map(url => {
    const row = pool.find(r => r.link === url);
    return {
      title: row?.title || 'Source',
      url,
      snippet: (row?.snippet || '').slice(0, 400),
      sourceQuery: row?.sourceQuery
    };
  });

  let preview_leads = null;
  let preview_note = null;
  const firstUrl = pickedUrls[0];
  if (firstUrl) {
    try {
      preview_leads = await fetchOpenDataSampleRows(firstUrl, Math.min(intent.lead_count, 10));
    } catch (e) {
      logger.warn(`[nlLeadIntent] openDataDirect preview: ${e.message}`);
    }
  }
  if (!preview_leads?.length) {
    const firstArc =
      pickedUrls.find(looksLikeArcGisDataUrl) || pickedUrls.find(u => /\/mapserver\//i.test(String(u || '')));
    if (firstArc) {
      const n = Math.min(intent.lead_count, 10);
      preview_leads = await tryArcgisSampleRows(firstArc, n);
    }
  }
  if (preview_leads?.length) {
    preview_note =
      `Showing up to ${preview_leads.length} raw rows from the first candidate (open-data API or public layer, where=1=1). ` +
      `Apply dollar/location filters using the correct field names in My sources → JSON API if needed.`;
  } else {
    preview_note =
      'Could not fetch a live sample from the first URL (portal page only, auth, or non-public layer). Try another candidate or add the dataset as a JSON API source.';
  }

  return {
    intent,
    search_queries_used: queries.slice(0, nq),
    search_queries_expanded: expanded.length ? expanded : undefined,
    results_pooled: pool.length,
    candidate_sources,
    preview_leads,
    preview_note,
    disclaimer:
      'Contact emails are rarely in permit APIs. Use enrichment and your ICP after leads are in the dashboard.'
  };
}

module.exports = {
  parseBriefWithGemini,
  runNlLeadIntentDiscovery,
  buildSerperQueries,
  tryArcgisSampleRows
};
