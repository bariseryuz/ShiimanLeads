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
      out.push({
        title: title || 'Suggestion',
        kind: kind.includes('search') || kind === 'query' ? 'search_query' : 'url',
        monitorUrl: monitorUrl.slice(0, 2000),
        notes: String(item.notes || item.description || item.rationale || '').trim().slice(0, 500)
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
    'Act as a researcher. Suggest 5 specific URLs or search entry points (LinkedIn, niche boards, Google Maps, industry directories, permit portals) to find new leads for this niche.\n\n' +
    `Niche / keyword: ${k}\n\n` +
    'Return ONLY valid JSON with this exact shape:\n' +
    '{"suggestions":[{"title":"short label","kind":"url"|"search_query","monitorUrl":"https://... full URL to open in a browser (for search_query use Google Maps search URL, Google site: search, or LinkedIn search URL as appropriate)","notes":"one line why this helps"}]}\n' +
    'Provide exactly 5 suggestions. Every monitorUrl must start with http:// or https://.';

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
