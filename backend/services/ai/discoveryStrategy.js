/**
 * Phase 4 — Discovery: Gemini suggests URLs / search entry points for a niche keyword.
 */

const { getGeminiModel, isAIAvailable } = require('./geminiClient');
const logger = require('../../utils/logger');
const { retryWithBackoff } = require('../../utils/aiRetry');
const scaleLimits = require('../../config/scaleLimits');
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

/** Parse Gemini response: either { suggestions: [...] } or a raw JSON array */
function parseEventDrivenSuggestions(text) {
  if (!text || typeof text !== 'string') return [];
  let t = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  try {
    let parsed;
    if (t.startsWith('[')) {
      parsed = JSON.parse(t);
    } else {
      const start = t.indexOf('{');
      const end = t.lastIndexOf('}');
      if (start === -1 || end <= start) return [];
      parsed = JSON.parse(t.slice(start, end + 1));
    }
    const raw = Array.isArray(parsed) ? parsed : parsed.suggestions || parsed.results || parsed.sources;
    return Array.isArray(raw) ? raw.slice(0, 8) : [];
  } catch {
    return [];
  }
}

function mapDiscoveryTypeToSignalCategory(typeRaw) {
  const t = String(typeRaw || '').toLowerCase();
  if (t === 'job_board') return 'hiring';
  if (t === 'news_feed') return 'general';
  if (t === 'search_query') return 'general';
  if (t === 'direct_url') return 'general';
  return 'general';
}

function normalizeEventItem(item) {
  const title = String(item.title || '').trim().slice(0, 200);
  const description = String(item.description || item.notes || '').trim().slice(0, 800);
  const typeRaw = String(item.type || 'direct_url').toLowerCase();
  const allowed = ['direct_url', 'search_query', 'job_board', 'news_feed'];
  const sourceType = allowed.includes(typeRaw) ? typeRaw : 'direct_url';
  const url = String(item.url || item.monitorUrl || '').trim();
  return {
    title: title || 'Suggested source',
    rawUrl: url,
    notes: description.slice(0, 500),
    triggerLogic: description,
    sourceType,
    suggestedFrequency: 'daily',
    signalCategory: mapDiscoveryTypeToSignalCategory(typeRaw),
    kind: sourceType === 'search_query' ? 'search_query' : 'url'
  };
}

function finalizeDirectMonitorUrl(norm, nicheKeyword) {
  const url = norm.rawUrl;
  if (!url) {
    return `https://www.google.com/search?q=${encodeURIComponent(nicheKeyword)}`;
  }
  if (/^https?:\/\//i.test(url)) return url.slice(0, 2000);
  return `https://www.google.com/search?q=${encodeURIComponent(url)}`;
}

function extractSerperQueryString(norm, nicheKeyword) {
  const raw = norm.rawUrl || '';
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      if (/google\./i.test(u.hostname) && u.pathname.includes('search')) {
        const q = u.searchParams.get('q');
        if (q) return q.trim();
      }
    } catch {
      /* fallthrough */
    }
    return raw;
  }
  return raw.trim() || nicheKeyword;
}

/**
 * Expand `search_query` rows into up to 5 real URLs via Serper (when configured).
 * Respects DISCOVER_MAX_SERPER_CALLS — when exhausted, falls back to Google search URLs only.
 */
async function expandSearchQueryItemsWithSerper(normalized, nicheKeyword) {
  const budget = { remaining: scaleLimits.serper.maxCallsPerDiscoveryRequest };
  const out = [];
  for (const norm of normalized) {
    if (norm.sourceType !== 'search_query') {
      out.push({
        ...norm,
        monitorUrl: finalizeDirectMonitorUrl(norm, nicheKeyword)
      });
      continue;
    }
    const q = extractSerperQueryString(norm, nicheKeyword);
    if (!hasSerper() || budget.remaining <= 0) {
      out.push({
        ...norm,
        monitorUrl: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
        ...(budget.remaining <= 0 && hasSerper() ? { serperSkipped: true } : {})
      });
      continue;
    }
    try {
      budget.remaining -= 1;
      const organic = await googleSearchOrganic(q, { num: 5 });
      await sleep(400);
      if (!organic.length) {
        out.push({
          ...norm,
          monitorUrl: `https://www.google.com/search?q=${encodeURIComponent(q)}`
        });
        continue;
      }
      organic.forEach((row, idx) => {
        out.push({
          title: (row.title || norm.title).slice(0, 200) || `Result ${idx + 1}`,
          monitorUrl: row.link,
          notes: String(row.snippet || '').slice(0, 400),
          triggerLogic: `${norm.triggerLogic} (Google top result for: ${q})`.slice(0, 800),
          sourceType: 'direct_url',
          suggestedFrequency: norm.suggestedFrequency,
          signalCategory: norm.signalCategory,
          kind: 'url',
          expandedFromSearchQuery: true,
          serperQuery: q
        });
      });
    } catch (e) {
      logger.warn(`[Discovery] Serper expand failed: ${e.message}`);
      out.push({
        ...norm,
        monitorUrl: `https://www.google.com/search?q=${encodeURIComponent(q)}`
      });
    }
  }
  return out.slice(0, 20);
}

/**
 * Keyword discovery: event-driven sources; search_query types expanded via Serper when SERPER_API_KEY is set.
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
    `The user is looking for lead generation sources for the niche: "${k}".\n` +
    `As an expert growth hacker, suggest exactly 5 specific types of sources to monitor.\n\n` +
    `For each source, provide:\n` +
    `1. "title": A clear name (e.g., "LinkedIn Jobs — web developer Dallas")\n` +
    `2. "url": A direct https URL when possible OR for "search_query" type a plain search query string (e.g. site:linkedin.com/jobs "office manager" Dallas) OR a Google Maps search URL\n` +
    `3. "description": Why this source surfaces high-intent leads and what TRIGGER EVENTS to watch for (new hires, permits, openings, funding, moves).\n` +
    `4. "type": one of: "direct_url", "search_query", "job_board", "news_feed"\n\n` +
    `Return ONLY valid JSON in this exact shape:\n` +
    `{"suggestions":[{"title":"...","url":"...","description":"...","type":"direct_url"}]}\n` +
    `You may also return a raw JSON array of 5 objects with the same fields.\n\n` +
    `Focus on TRIGGER EVENTS (new projects, new hires, new sales, openings, funding) — not generic static directories.`;

  try {
    const model = getGeminiModel('discovery');
    const result = await retryWithBackoff(
      () => model.generateContent(prompt),
      {
        maxRetries: scaleLimits.gemini.maxRetries,
        baseMs: scaleLimits.gemini.retryBaseMs
      }
    );
    const raw = (await result.response).text();
    const rawItems = parseEventDrivenSuggestions(raw);
    if (!rawItems.length) {
      logger.warn(`[Discovery] Unparseable response: ${String(raw).slice(0, 400)}`);
      throw new Error('Could not parse discovery suggestions from AI');
    }
    const normalized = rawItems.map(it => normalizeEventItem(it));
    const suggestions = await expandSearchQueryItemsWithSerper(normalized, k);
    if (!suggestions.length) {
      throw new Error('No suggestions after processing');
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
function extractLocation(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  return String(
    p.location || p.metro || p.area || p.city || p.geo || p.region || ''
  ).trim();
}

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
  const location = extractLocation(p);

  if (!product && !customer && !triggerEvents && !location) {
    throw new Error('Provide at least one of: product, customer, triggerEvents, location');
  }
  if (!isAIAvailable()) {
    throw new Error('AI not configured (GEMINI_API_KEY)');
  }

  const prompt =
    'You are a world-class B2B lead generation strategist (not a web browser — you only suggest URLs).\n' +
    'Map the client offer to TRIGGER EVENTS, then to AGGREGATOR SOURCES where those events are already collected.\n\n' +
    `What they sell: ${product || '(not specified)'}\n` +
    `Ideal customer: ${customer || '(not specified)'}\n` +
    (location ? `Geographic focus (anchor ALL relevant sources here): ${location}\n` : '') +
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
    const result = await retryWithBackoff(
      () => model.generateContent(prompt),
      {
        maxRetries: scaleLimits.gemini.maxRetries,
        baseMs: scaleLimits.gemini.retryBaseMs
      }
    );
    const response = await result.response;
    const raw = response.text();
    const suggestions = parseSuggestionsJson(raw);
    if (!suggestions || !suggestions.length) {
      logger.warn(`[Discovery] strategy unparseable: ${String(raw).slice(0, 300)}`);
      throw new Error('Could not parse strategy from AI');
    }
    return {
      suggestions,
      context: { product, customer, triggerEvents, location: location || undefined }
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
  const location = extractLocation(p);

  if (!isAIAvailable()) {
    throw new Error('AI not configured (GEMINI_API_KEY)');
  }
  if (!hasSerper()) {
    throw new Error(
      'SERPER_API_KEY is not set. Add it to .env for Google search-backed discovery (https://serper.dev). ' +
        'Alternatively use POST /api/discover/strategy without live Google results.'
    );
  }

  const contextBits = [
    product && `Product/service: ${product}`,
    customer && `Ideal customer: ${customer}`,
    location && `Geographic focus (every query MUST name this place or metro — e.g. city + state): ${location}`,
    triggerEvents && `Trigger events: ${triggerEvents}`,
    keyword && `Focus keyword: ${keyword}`
  ]
    .filter(Boolean)
    .join('\n');

  if (!contextBits.trim()) {
    throw new Error('Provide at least one of: product, customer, triggerEvents, keyword, location');
  }

  const queryGenPrompt =
    'You help B2B sellers find MONITORABLE web pages (aggregators, portals, job search URLs, news sections, open data).\n' +
    'Generate 4-5 concise Google search queries (English) that are likely to return such pages — not generic blog spam.\n' +
    'Include diverse intent: hiring/job boards, permits/construction, local business news, funding/startup where relevant.\n' +
    (location
      ? `CRITICAL: The user named a location — include "${location}" (or the metro/county) inside MOST queries so results are geographically real.\n`
      : '') +
    '\n' +
    `${contextBits}\n\n` +
    'Return ONLY valid JSON: {"queries":["query 1","query 2",...]}';

  const model = getGeminiModel('discovery');
  const qRes = await retryWithBackoff(
    () => model.generateContent(queryGenPrompt),
    {
      maxRetries: scaleLimits.gemini.maxRetries,
      baseMs: scaleLimits.gemini.retryBaseMs
    }
  );
  const queries = parseQueriesJson((await qRes.response).text());
  if (!queries.length) {
    throw new Error('Could not generate search queries from AI');
  }

  let serperBudget = scaleLimits.serper.maxCallsGoogleDiscovery;
  const collected = [];
  for (const q of queries) {
    if (serperBudget <= 0) {
      logger.warn('[Discovery/Google] Serper budget exhausted; skipping remaining queries');
      break;
    }
    serperBudget -= 1;
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
    'Choose exactly 5 as the best monitorable sources for this seller. Prefer list pages, search result pages on LinkedIn jobs, government portals, news sections, job boards — not generic homepages when a deeper URL is better.\n' +
    (location
      ? `Favor URLs that clearly relate to "${location}" (local gov, regional news, metro job boards) when snippets support it.\n`
      : '') +
    '\n' +
    `${contextBits}\n\n` +
    'Results JSON array:\n' +
    JSON.stringify(pool.map((r, i) => ({ i, title: r.title, link: r.link, snippet: r.snippet })), null, 2) +
    '\n\nReturn ONLY valid JSON with this shape (use ONLY links from the results above for monitorUrl):\n' +
    '{"suggestions":[{"title":"short label","kind":"url","monitorUrl":"<must be exactly one of link values>","notes":"why this page","suggestedFrequency":"daily"|"weekly",' +
    '"signalCategory":"hiring"|"real_estate"|"funding"|"permits"|"general",' +
    '"triggerLogic":"why monitoring this URL fits the seller"}]}\n' +
    'Exactly 5 suggestions. Every monitorUrl must match a link from the results exactly.';

  const packRes = await retryWithBackoff(
    () => model.generateContent(packPrompt),
    {
      maxRetries: scaleLimits.gemini.maxRetries,
      baseMs: scaleLimits.gemini.retryBaseMs
    }
  );
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
    context: { product, customer, triggerEvents, keyword, location: location || undefined },
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
