/**
 * Phase 4 — Discovery: Gemini suggests URLs / search entry points for a niche keyword.
 */

const { getGeminiModel, isAIAvailable } = require('./geminiClient');
const logger = require('../../utils/logger');

function parseSuggestionsJson(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  t = t.slice(start, end + 1);
  try {
    const o = JSON.parse(t);
    const raw = o.suggestions || o.items || o.results;
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

module.exports = {
  fetchDiscoverySuggestions,
  parseSuggestionsJson
};
