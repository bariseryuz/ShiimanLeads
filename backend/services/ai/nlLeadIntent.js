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
const { buildFallbackDiscoveryQueries } = require('./discoveryFallbackSearch');

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

function extractLeadCountHint(text) {
  const t = String(text || '').toLowerCase();
  const digitMatch = t.match(/\b(?:find|give|get|show|return)\s+(\d{1,2})\b/) || t.match(/\b(\d{1,2})\s+leads?\b/);
  if (digitMatch && digitMatch[1]) return parseInt(digitMatch[1], 10);
  const words = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10
  };
  const wordMatch = t.match(/\b(?:find|give|get|show|return)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/) ||
    t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+leads?\b/);
  if (wordMatch && wordMatch[1]) return words[wordMatch[1]] || null;
  return null;
}

function inferVertical(assetOrUse) {
  const a = String(assetOrUse || '').toLowerCase();
  if (!a) return 'unknown';
  if (/commercial|office|retail|industrial|hospital|hotel|resort|mixed-use|warehouse/.test(a)) return 'commercial';
  if (/residential|multifamily|single family|condo|apartment|housing/.test(a)) return 'residential';
  if (/public|government|municipal|school|university|campus/.test(a)) return 'public';
  return 'other';
}

/**
 * Canonical machine parameters object used BEFORE search.
 * Converts human brief intent into strict constraints for discovery/extraction.
 */
function buildMachineParameters(intent) {
  const i = intent && typeof intent === 'object' ? intent : {};
  return {
    geography: {
      text: String(i.geography || '').trim() || 'United States',
      kind: String(i.geography_kind || 'unknown'),
      state_code: String(i.state_code || '').trim().toUpperCase().slice(0, 2)
    },
    vertical: {
      raw: String(i.asset_or_use || '').trim(),
      normalized: inferVertical(i.asset_or_use)
    },
    record_type: String(i.trigger_or_record || 'building permit').trim() || 'building permit',
    constraints: {
      min_value_usd:
        i.min_project_value_usd != null && Number.isFinite(Number(i.min_project_value_usd))
          ? Number(i.min_project_value_usd)
          : null,
      max_value_usd:
        i.max_project_value_usd != null && Number.isFinite(Number(i.max_project_value_usd))
          ? Number(i.max_project_value_usd)
          : null,
      time_window_hours:
        i.time_window_hours != null && Number.isFinite(Number(i.time_window_hours))
          ? Number(i.time_window_hours)
          : null,
      decision_maker_roles: Array.isArray(i.decision_maker_roles)
        ? i.decision_maker_roles.map(r => String(r || '').trim()).filter(Boolean).slice(0, 6)
        : [],
      required_project_fields: Array.isArray(i.required_project_fields)
        ? i.required_project_fields.map(f => String(f || '').trim()).filter(Boolean).slice(0, 8)
        : [],
      must_search_multiple_sources: !!i.must_search_multiple_sources,
      wants_contact_info: !!i.wants_contact_info
    },
    lead_count: Math.min(25, Math.max(1, parseInt(i.lead_count, 10) || 3)),
    keywords: Array.isArray(i.keywords_for_search)
      ? i.keywords_for_search.map(k => String(k || '').trim()).filter(Boolean).slice(0, 8)
      : []
  };
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
    '  "max_project_value_usd": <number or null if user sets an upper budget bound>,\n' +
    '  "time_window_hours": <number or null if user asks for recent time windows>,\n' +
    '  "decision_maker_roles": ["<role title>", "..."] ,\n' +
    '  "required_project_fields": ["<field user explicitly wants in output>", "..."],\n' +
    '  "must_search_multiple_sources": <boolean>,\n' +
    '  "wants_contact_info": <boolean>,\n' +
    '  "keywords_for_search": ["3-6 short phrases for Google queries"]\n' +
    '}\n\n' +
    'Interpretation rules:\n' +
    '- Never hardcode domain-specific fields. Extract only what user requests.\n' +
    '- If user asks for multiple sources, set must_search_multiple_sources=true.\n' +
    '- decision_maker_roles should reflect the actual buyer roles requested by user.\n' +
    '- required_project_fields should mirror requested lead details (e.g. floors, value, project type) only when explicitly requested.\n\n' +
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
    lead_count: Math.min(25, Math.max(1, parseInt(o.lead_count, 10) || extractLeadCountHint(b) || 3)),
    geography: String(o.geography || '').trim() || 'United States',
    geography_kind: String(o.geography_kind || 'unknown'),
    state_code: String(o.state_code || '').trim().toUpperCase().slice(0, 2),
    asset_or_use: String(o.asset_or_use || '').trim(),
    trigger_or_record: triggerOrRecord,
    min_project_value_usd:
      o.min_project_value_usd != null && Number.isFinite(Number(o.min_project_value_usd))
        ? Number(o.min_project_value_usd)
        : null,
    max_project_value_usd:
      o.max_project_value_usd != null && Number.isFinite(Number(o.max_project_value_usd))
        ? Number(o.max_project_value_usd)
        : null,
    time_window_hours:
      o.time_window_hours != null && Number.isFinite(Number(o.time_window_hours)) && Number(o.time_window_hours) > 0
        ? Number(o.time_window_hours)
        : null,
    decision_maker_roles: Array.isArray(o.decision_maker_roles)
      ? o.decision_maker_roles.map(r => String(r || '').trim()).filter(Boolean).slice(0, 6)
      : [],
    required_project_fields: Array.isArray(o.required_project_fields)
      ? o.required_project_fields.map(f => String(f || '').trim()).filter(Boolean).slice(0, 8)
      : [],
    must_search_multiple_sources: !!o.must_search_multiple_sources,
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
  if (intent.time_window_hours != null && Number.isFinite(Number(intent.time_window_hours))) {
    base.push(`${geo} ${trig} last ${Math.max(1, Math.floor(Number(intent.time_window_hours)))} hours`);
  }
  if (Array.isArray(intent.required_project_fields) && intent.required_project_fields.length) {
    const f = intent.required_project_fields.slice(0, 3).join(' ');
    base.push(`${geo} ${trig} ${f} site:gov`);
  }
  if (Array.isArray(intent.decision_maker_roles) && intent.decision_maker_roles.length) {
    base.push(`${geo} ${asset || 'construction'} ${intent.decision_maker_roles.slice(0, 2).join(' OR ')}`);
  }
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

  async function runArcQuery(u) {
    const response = await axios.get(u, {
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
    return response.data;
  }

  try {
    let data = await runArcQuery(queryUrl);
    if (data?.error) {
      logger.warn(`[nlLeadIntent] ArcGIS error: ${JSON.stringify(data.error).slice(0, 200)}`);
      data = null;
    }
    let features = Array.isArray(data?.features) ? data.features : [];
    let rows = features.slice(0, maxFeatures).map(f => f.attributes || {});
    if (rows.length) return rows;

    // Layer fallback for common ArcGIS pattern: layer 0 empty, layer 1/2 contain table data.
    for (const lid of [1, 2]) {
      let alt = '';
      if (/\/FeatureServer\/\d+\/query$/i.test(queryUrl)) {
        alt = queryUrl.replace(/\/FeatureServer\/\d+\/query$/i, `/FeatureServer/${lid}/query`);
      } else if (/\/MapServer\/\d+\/query$/i.test(queryUrl)) {
        alt = queryUrl.replace(/\/MapServer\/\d+\/query$/i, `/MapServer/${lid}/query`);
      } else {
        continue;
      }
      const altData = await runArcQuery(alt).catch(() => null);
      if (altData?.error) continue;
      const altFeatures = Array.isArray(altData?.features) ? altData.features : [];
      const altRows = altFeatures.slice(0, maxFeatures).map(f => f.attributes || {});
      if (altRows.length) {
        logger.info(`[nlLeadIntent] ArcGIS layer fallback ${lid} yielded ${altRows.length} row(s)`);
        return altRows;
      }
    }
    return null;
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

function looksDataLikeUrl(url) {
  const u = String(url || '').toLowerCase();
  if (/dev\.socrata\.com\/foundry\//.test(u)) return false;
  if (/\/about($|[/?#])/.test(u) && /(data\.|opendata|hub\.arcgis)/.test(u)) return false;
  return (
    /featureserver\/\d+|\/mapserver\//i.test(u) ||
    /\/resource\/[0-9a-z]{4}-[0-9a-z]{4}/i.test(u) ||
    /\/dataset\/[^/]+\/[0-9a-z]{4}-[0-9a-z]{4}/i.test(u) ||
    /hub\.arcgis\.com\/datasets\//i.test(u) ||
    /\/open-?data\//i.test(u) ||
    /\/data\//i.test(u) ||
    /[?&]f=json\b/i.test(u) ||
    /\.json(\?|$)/i.test(u)
  );
}

function looksArticleLikeResult(row) {
  const link = String(row?.link || '').toLowerCase();
  const title = String(row?.title || '').toLowerCase();
  const snippet = String(row?.snippet || '').toLowerCase();
  const blogHost =
    /blog\./i.test(link) ||
    /medium\.com|substack\.com|wordpress\.com|wixsite|blogspot/i.test(link);
  const articlePath =
    /\/(blog|news|insights|article|story|guide|opinion|press-release)\//i.test(link) ||
    /-(guide|tips|best-practices|news)$/i.test(link.replace(/[/?#].*$/, ''));
  const nonDataLanguage =
    /(guide|how to|cost per sq ft|what is|top \d+|best \d+)/i.test(title) ||
    /(guide|how to|sponsored|advertisement)/i.test(snippet);
  const isDocumentation =
    /dev\.socrata\.com\/foundry\//.test(link) ||
    (/\/about($|[/?#])/.test(link) && /(data\.|opendata|hub\.arcgis)/.test(link));

  return blogHost || articlePath || nonDataLanguage || isDocumentation;
}

function prioritizeDataLikePool(rows) {
  const clean = filterUnhelpfulSearchLinks(rows);
  const dataLike = clean.filter(r => looksDataLikeUrl(r.link));
  const maybePortal = clean.filter(r => !looksArticleLikeResult(r));
  if (dataLike.length) return dataLike;
  if (maybePortal.length) return maybePortal;
  return clean;
}

async function pickBestSourceUrls(organicPool, intent) {
  const pool = prioritizeDataLikePool(organicPool);
  if (!pool.length || !isAIAvailable()) return [];
  try {
    const model = getGeminiModel('discovery');
    const pack =
      'Pick up to 5 URLs most likely to yield ROW-LEVEL public records (permits, licenses, bids, violations).\n' +
      'Prefer: ArcGIS FeatureServer or MapServer layer URLs, Socrata, open-data APIs — NOT generic department homepages unless no better link exists.\n' +
      'Never pick PDF/image/blog/news/guide URLs unless there are no portal/data URLs left.\n' +
      'Prefer links whose path includes FeatureServer, MapServer, "data", "permits", resource/{id}, or hub.arcgis.com datasets.\n' +
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
  const machine_parameters = buildMachineParameters(intent);

  if (!hasSerper()) {
    return {
      intent,
      machine_parameters,
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
  const maxSerper = Math.min(12, parseInt(process.env.NL_INTENT_MAX_SERPER || '10', 10) || 10);
  let nq = Math.min(queries.length, maxSerper);
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

  let deduped = dedupeSearchResults(collected);
  const minPool = Math.min(8, parseInt(process.env.NL_INTENT_MIN_POOL || '8', 10) || 8);
  if (deduped.length < minPool && hasSerper()) {
    const extraQs = buildFallbackDiscoveryQueries(brief, intent).filter(
      q => !queries.includes(q)
    );
    const budgetLeft = Math.max(0, maxSerper - nq);
    const take = Math.min(extraQs.length, budgetLeft, parseInt(process.env.NL_INTENT_FALLBACK_QUERIES || '4', 10) || 4);
    for (let j = 0; j < take; j++) {
      try {
        const rows = await googleSearchOrganic(extraQs[j], { num: 10 });
        rows.forEach(r => collected.push({ ...r, sourceQuery: extraQs[j] }));
        logger.info(`[nlLeadIntent] fallback Serper query: ${extraQs[j].slice(0, 72)}…`);
      } catch (e) {
        logger.warn(`[nlLeadIntent] fallback Serper failed: ${e.message}`);
      }
      await sleep(400);
    }
    deduped = dedupeSearchResults(collected);
  }

  const pool = deduped.slice(0, 30);
  const prioritizedPool = prioritizeDataLikePool(pool);

  let pickedUrls = await pickBestSourceUrls(prioritizedPool, intent);
  if (!pickedUrls.length) {
    pickedUrls = prioritizedPool
      .filter(r => looksLikeArcGisDataUrl(r.link) || /\/mapserver\//i.test(String(r.link || '')))
      .map(r => r.link)
      .slice(0, 3);
  }
  // Last resort: still avoid obvious article/blog pages.
  if (!pickedUrls.length && pool.length) {
    pickedUrls = prioritizedPool
      .map(r => r.link)
      .filter(u => typeof u === 'string' && /^https?:\/\//i.test(u))
      .slice(0, 5);
  }

  pickedUrls = sortUrls(pickedUrls);

  const candidate_sources = pickedUrls.map(url => {
    const row = prioritizedPool.find(r => r.link === url) || pool.find(r => r.link === url);
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
    machine_parameters,
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
  buildMachineParameters,
  runNlLeadIntentDiscovery,
  buildSerperQueries,
  tryArcgisSampleRows
};
