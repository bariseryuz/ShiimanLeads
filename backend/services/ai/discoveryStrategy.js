/**
 * Phase 4 — Discovery: Gemini suggests URLs / search entry points for a niche keyword.
 */

const { getGeminiModel, isAIAvailable } = require('./geminiClient');
const logger = require('../../utils/logger');
const {
  hasSerper,
  googleSearchOrganic,
  dedupeSearchResults,
  sleep
} = require('../serperSearch');

function parseSuggestionsJson(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  t = t.slice(start, end + 1);
  try {
    const o = JSON.parse(t);
    const raw = o.suggestions || o.items || o.results || o.sources || o.lead_sources;
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (const item of raw.slice(0, 8)) {
      if (!item || typeof item !== 'object') continue;
      const title = String(item.title || item.label || item.name || '').trim().slice(0, 200);
      let monitorUrl = String(item.monitorUrl || item.url || item.href || '').trim();
      const kind = String(item.kind || item.type || 'url').toLowerCase();
      if (!title || !monitorUrl) continue;
      if (!/^https?:\/\//i.test(monitorUrl)) {
        const q = encodeURIComponent(monitorUrl);
        monitorUrl = `https://www.google.com/search?q=${q}`;
      }
      const suggestedFrequency = String(
        item.suggestedFrequency || item.frequency || 'daily'
      )
        .trim()
        .toLowerCase();
      const freq = ['hourly', 'daily', 'weekly', 'monthly'].includes(suggestedFrequency)
        ? suggestedFrequency
        : 'daily';
      const triggerLogic = String(item.triggerLogic || item.logic || item.blueprint || '').trim().slice(0, 800);
      const signalCategory = String(
        item.signalCategory || item.category || item.signal_type || 'general'
      )
        .trim()
        .slice(0, 80);

      out.push({
        title: title || 'Suggestion',
        kind: kind.includes('search') || kind === 'query' ? 'search_query' : 'url',
        monitorUrl: monitorUrl.slice(0, 2000),
        notes: String(item.notes || item.description || item.rationale || '').trim().slice(0, 500),
        suggestedFrequency: freq,
        triggerLogic,
        signalCategory
      });
      if (out.length >= 5) break;
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} keyword - e.g. "Real Estate Dallas"
 * @returns {Promise<{ suggestions: Array<{ title, kind, monitorUrl, notes }> } | null>}
 */
async function fetchDiscoverySuggestions(keyword) {
  const k = String(keyword || '').trim();
  if (!k) {
    throw new Error('keyword is required');
  }
  if (!isAIAvailable()) {
    throw new Error('AI not configured (GEMINI_API_KEY)');
  }

  const prompt =
    'You are a SIGNAL AGGREGATOR strategist. Prefer pages where TRIGGER EVENTS are already collected (faster than scraping whole corporate sites).\n' +
    'Include a diverse mix when relevant to the niche:\n' +
    '- HIRING: LinkedIn Jobs search URLs (e.g. linkedin.com/jobs/search/?keywords=...&location=...), public Greenhouse/Lever board search, niche job boards.\n' +
    '- EXPANSION / REAL ESTATE: local Business Journal real estate or commercial news sections (e.g. bizjournals.com city news), regional business news.\n' +
    '- FUNDING / STARTUPS: Crunchbase explore/search, TechCrunch tag pages (only if the niche fits B2B to startups).\n' +
    '- PERMITS / CONSTRUCTION: ArcGIS hubs, city permit portals, county open data already in the conversation.\n\n' +
    `Niche / keyword: ${k}\n\n` +
    'Return ONLY valid JSON. Each of the 5 suggestions must be an ACTIONABLE MONITORING BLUEPRINT:\n' +
    '{"suggestions":[{"title":"short label","kind":"url"|"search_query","monitorUrl":"https://...","notes":"one line what this page aggregates",' +
    '"suggestedFrequency":"daily"|"weekly"|"hourly"|"monthly",' +
    '"signalCategory":"hiring"|"real_estate"|"funding"|"permits"|"general",' +
    '"triggerLogic":"1-2 sentences: what trigger to watch for and why it matters for sellers in this niche (e.g. hiring interior designer => finishing phase => blinds/shades)."}]}\n' +
    'Provide exactly 5 suggestions. Every monitorUrl must start with http:// or https://. ' +
    'At least 2 suggestions should be explicit HIRING or JOB-BOARD style entry points when the keyword allows it.';

  try {
    const model = getGeminiModel('discovery');
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const raw = response.text();
    const suggestions = parseSuggestionsJson(raw);
    if (!suggestions || !suggestions.length) {
      logger.warn(`[Discovery] Unparseable or empty response: ${String(raw).slice(0, 300)}`);
      throw new Error('Could not parse discovery suggestions from AI');
    }
    return { suggestions };
  } catch (e) {
    logger.error(`[Discovery] fetchDiscoverySuggestions: ${e.message}`);
    throw e;
  }
}

/**
 * "Growth consultant" mode: map product + ICP + trigger events → monitorable sources (no URL required from user).
 * @param {{ product?: string, customer?: string, triggerEvents?: string }} profile
 * @param {{ product?: string, customer?: string, triggerEvents?: string }} [aliases] - alternate keys from forms: whatYouSell, perfectCustomer, events
 */
async function generateDiscoveryStrategy(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const product = String(
    p.product || p.whatYouSell || p.what_you_sell || ''
  ).trim();
  const customer = String(
    p.customer || p.perfectCustomer || p.ideal_customer || p.who || ''
  ).trim();
  const triggerEvents = String(
    p.triggerEvents || p.events || p.triggers || p.when || ''
  ).trim();

  if (!product && !customer && !triggerEvents) {
    throw new Error('Provide at least one of: product, customer, triggerEvents');
  }
  if (!isAIAvailable()) {
    throw new Error('AI not configured (GEMINI_API_KEY)');
  }

  const prompt =
    'You are a world-class B2B lead generation strategist (not a web browser — you only suggest URLs).\n' +
    'Map the client offer to TRIGGER EVENTS, then to AGGREGATOR SOURCES where those events are already collected.\n\n' +
    `What they sell: ${product || '(not specified)'}\n` +
    `Ideal customer: ${customer || '(not specified)'}\n` +
    `Trigger events they care about (e.g. new lease, hiring, permit filed, funding): ${triggerEvents || '(infer from product + customer)'}\n\n` +
    'Return ONLY valid JSON with exactly 5 suggestions. Each must be a scrapable monitoring blueprint:\n' +
    '{"suggestions":[{"title":"short name e.g. LinkedIn Jobs — Office Manager Dallas","kind":"url"|"search_query",' +
    '"monitorUrl":"https://... full URL (use LinkedIn Jobs search, BizJournal real estate, city permit/ArcGIS portals, Crunchbase search, etc.)",' +
    '"notes":"one line what signal this aggregates",' +
    '"suggestedFrequency":"daily"|"weekly"|"hourly"|"monthly",' +
    '"signalCategory":"hiring"|"real_estate"|"funding"|"permits"|"general",' +
    '"triggerLogic":"Why this source fits THIS seller and what trigger to watch for."}]}\n' +
    'Every monitorUrl must start with http:// or https://. ' +
    'Prefer aggregator/list pages over scraping entire corporate homepages. ' +
    'Diversify: include hiring + news/permits + at least one local or niche source when relevant.';

  try {
    const model = getGeminiModel('discovery');
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const raw = response.text();
    const suggestions = parseSuggestionsJson(raw);
    if (!suggestions || !suggestions.length) {
      logger.warn(`[Discovery] strategy unparseable: ${String(raw).slice(0, 300)}`);
      throw new Error('Could not parse strategy from AI');
    }
    return {
      suggestions,
      context: { product, customer, triggerEvents }
    };
  } catch (e) {
    logger.error(`[Discovery] generateDiscoveryStrategy: ${e.message}`);
    throw e;
  }
}

function parseQueriesJson(text) {
  if (!text || typeof text !== 'string') return [];
  let t = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  t = t.slice(start, end + 1);
  try {
    const o = JSON.parse(t);
    const raw = o.queries || o.search_queries || o.q;
    if (!Array.isArray(raw)) return [];
    return raw
      .map(q => String(q || '').trim())
      .filter(Boolean)
      .slice(0, 6);
  } catch {
    return [];
  }
}

/**
 * Google-backed discovery: Gemini proposes search queries → Serper returns real URLs → Gemini picks 5 monitorable sources.
 * Requires SERPER_API_KEY (https://serper.dev) — does not scrape google.com with Playwright.
 */
async function generateDiscoveryFromGoogleSearch(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const product = String(p.product || p.whatYouSell || '').trim();
  const customer = String(p.customer || p.perfectCustomer || '').trim();
  const triggerEvents = String(p.triggerEvents || p.events || '').trim();
  const keyword = String(p.keyword || '').trim();

  if (!isAIAvailable()) {
    throw new Error('AI not configured (GEMINI_API_KEY)');
  }
  if (!hasSerper()) {
    throw new Error(
      'SERPER_API_KEY is not set. Add it to .env for Google search-backed discovery (https://serper.dev). ' +
        'Alternatively use POST /api/discover/strategy without live Google results.'
    );
  }

  const contextBits = [product && `Product/service: ${product}`, customer && `Ideal customer: ${customer}`, triggerEvents && `Trigger events: ${triggerEvents}`, keyword && `Focus keyword: ${keyword}`]
    .filter(Boolean)
    .join('\n');

  if (!contextBits.trim()) {
    throw new Error('Provide at least one of: product, customer, triggerEvents, keyword');
  }

  const queryGenPrompt =
    'You help B2B sellers find MONITORABLE web pages (aggregators, portals, job search URLs, news sections, open data).\n' +
    'Generate 4-5 concise Google search queries (English) that are likely to return such pages — not generic blog spam.\n' +
    'Include diverse intent: hiring/job boards, permits/construction, local business news, funding/startup where relevant.\n\n' +
    `${contextBits}\n\n` +
    'Return ONLY valid JSON: {"queries":["query 1","query 2",...]}';

  const model = getGeminiModel('discovery');
  const qRes = await model.generateContent(queryGenPrompt);
  const queries = parseQueriesJson((await qRes.response).text());
  if (!queries.length) {
    throw new Error('Could not generate search queries from AI');
  }

  const collected = [];
  for (const q of queries) {
    try {
      const rows = await googleSearchOrganic(q, { num: 10 });
      rows.forEach(r => collected.push({ ...r, sourceQuery: q }));
    } catch (e) {
      logger.warn(`[Discovery/Google] query failed "${q.slice(0, 60)}": ${e.message}`);
    }
    await sleep(450);
  }

  const deduped = dedupeSearchResults(collected);
  const pool = deduped.slice(0, 20);
  if (!pool.length) {
    throw new Error('No search results returned — try different keywords or check Serper quota');
  }

  const allowedLinks = new Set(pool.map(r => r.link));

  const packPrompt =
    'You are a lead-gen strategist. Below are REAL Google organic results (title, link, snippet). ' +
    'Choose exactly 5 as the best monitorable sources for this seller. Prefer list pages, search result pages on LinkedIn jobs, government portals, news sections, job boards — not generic homepages when a deeper URL is better.\n\n' +
    `${contextBits}\n\n` +
    'Results JSON array:\n' +
    JSON.stringify(pool.map((r, i) => ({ i, title: r.title, link: r.link, snippet: r.snippet })), null, 2) +
    '\n\nReturn ONLY valid JSON with this shape (use ONLY links from the results above for monitorUrl):\n' +
    '{"suggestions":[{"title":"short label","kind":"url","monitorUrl":"<must be exactly one of link values>","notes":"why this page","suggestedFrequency":"daily"|"weekly",' +
    '"signalCategory":"hiring"|"real_estate"|"funding"|"permits"|"general",' +
    '"triggerLogic":"why monitoring this URL fits the seller"}]}\n' +
    'Exactly 5 suggestions. Every monitorUrl must match a link from the results exactly.';

  const packRes = await model.generateContent(packPrompt);
  const rawPack = (await packRes.response).text();
  let suggestions = parseSuggestionsJson(rawPack);
  if (!suggestions || !suggestions.length) {
    logger.warn(`[Discovery/Google] package parse failed: ${String(rawPack).slice(0, 400)}`);
    throw new Error('Could not build suggestions from search results');
  }

  suggestions = suggestions.filter(s => allowedLinks.has(s.monitorUrl));
  while (suggestions.length < 5 && pool.length > suggestions.length) {
    const used = new Set(suggestions.map(s => s.monitorUrl));
    const next = pool.find(r => !used.has(r.link));
    if (!next) break;
    suggestions.push({
      title: next.title.slice(0, 200) || 'Search result',
      kind: 'url',
      monitorUrl: next.link,
      notes: (next.snippet || '').slice(0, 500),
      suggestedFrequency: 'daily',
      triggerLogic: 'Added from Google search results (fallback).',
      signalCategory: 'general'
    });
  }

  suggestions = suggestions.slice(0, 5);
  if (!suggestions.length) {
    throw new Error('No valid suggestions after Google search');
  }

  return {
    suggestions,
    context: { product, customer, triggerEvents, keyword },
    queriesUsed: queries,
    resultsPooled: pool.length
  };
}

module.exports = {
  fetchDiscoverySuggestions,
  generateDiscoveryStrategy,
  generateDiscoveryFromGoogleSearch,
  parseSuggestionsJson
};
