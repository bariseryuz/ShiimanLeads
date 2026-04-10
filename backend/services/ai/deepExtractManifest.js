/**
 * Turn a user brief into field_schema + navigation instructions for Playwright + AI scrape.
 */

const logger = require('../../utils/logger');
const { getGeminiModel, isAIAvailable } = require('./geminiClient');
const { retryWithBackoff } = require('../../utils/aiRetry');
const scaleLimits = require('../../config/scaleLimits');
const { retrieveLeadGenContext, isRagEnabled } = require('./rag/leadGenRag');

function parseJsonBlock(text) {
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

const FALLBACK_SCHEMA = {
  title: 'Short label or title for the row',
  details: 'Main text or description visible for this record',
  location_or_party: 'Address, city, applicant, or owner if shown',
  date_or_amount: 'Permit date, value, or other key number/date if visible'
};

/**
 * @param {string} brief - What the user wants extracted (format + filters)
 * @returns {Promise<{ field_schema: Record<string,string>, navigation_instructions: string, strict_match_rules: string }>}
 */
async function buildManifestFromBrief(brief) {
  const b = String(brief || '').trim();
  if (b.length < 12) {
    throw new Error('Describe the exact fields and filters you need (at least one sentence).');
  }
  if (!isAIAvailable()) {
    throw new Error('AI not configured (GEMINI_API_KEY)');
  }

  let ragContext = '';
  if (isRagEnabled()) {
    try {
      ragContext = await retrieveLeadGenContext(b, { topK: 4, maxChars: 3000 });
    } catch (e) {
      logger.debug(`deepExtractManifest RAG: ${e.message}`);
    }
  }

  const prompt =
    'You help configure a web scraper. The user will give a URL and a brief describing WHAT data they want and in WHAT shape.\n' +
    'Return ONLY valid JSON with this exact shape:\n' +
    '{\n' +
    '  "field_schema": { "<snake_case_key>": "<one line: what to put in this field from the page>", ... },\n' +
    '  "navigation_instructions": "<numbered steps, like a human analyst: first infer what kind of page this is (open data portal, agency permits section, ArcGIS hub, static brochure site). Then list ONLY logical actions in order — dismiss overlays/cookies if blocking, find Data/Permits/GIS/Search, use filters that match the brief, prefer reaching a table or API-backed list over random clicks. Do not invent login credentials or bypass paywalls. Max 900 chars>",\n' +
    '  "strict_match_rules": "<bullet-style text: criteria a row MUST satisfy to count as a match for this user (geo, permit type, dollar min, date range). Rows that only partially match must be excluded later. Max 600 chars>"\n' +
    '}\n' +
    'Rules:\n' +
    '- field_schema: 4–12 keys. Keys must be stable snake_case. Descriptions must match the user brief.\n' +
    '- Do NOT invent contact emails unless the user asked for contacts and the page type usually has them.\n' +
    '- navigation_instructions: write as ordered steps (1. 2. 3.). Context first: what site pattern, then path to tabular data. ' +
    'For government data portals: prefer finding Search Permits, Open Data, GIS, API, Socrata, or ArcGIS Hub links over scraping marketing homepage text; ' +
    'if the page is a catalog, look for embedded dataset or JSON/API links before generic body text.\n' +
    '- strict_match_rules: when the brief implies fenestration, glazing, shades, or curtain wall, require permit/description text to align with those trades when such fields exist.\n\n' +
    (ragContext ? `Retrieved domain knowledge (public data patterns — user brief still wins):\n${ragContext}\n\n` : '') +
    `User brief:\n${b.slice(0, 6000)}`;

  const model = getGeminiModel('discovery');
  const result = await retryWithBackoff(
    () => model.generateContent(prompt),
    { maxRetries: scaleLimits.gemini.maxRetries, baseMs: scaleLimits.gemini.retryBaseMs }
  );
  const raw = (await result.response).text();
  const o = parseJsonBlock(raw);

  if (!o || typeof o !== 'object') {
    logger.warn('deepExtractManifest: Gemini returned unparseable JSON, using fallback schema');
    return {
      field_schema: FALLBACK_SCHEMA,
      navigation_instructions:
        'If a cookie or region banner appears, dismiss it. Find search or data/permit listings, apply filters that match the user brief, then stop when a table or list of records is visible.',
      strict_match_rules: b.slice(0, 500)
    };
  }

  let field_schema = o.field_schema && typeof o.field_schema === 'object' && !Array.isArray(o.field_schema) ? o.field_schema : null;
  if (!field_schema || Object.keys(field_schema).length < 2) {
    field_schema = FALLBACK_SCHEMA;
  } else {
    field_schema = Object.fromEntries(
      Object.entries(field_schema)
        .map(([k, v]) => [String(k || '').replace(/\s+/g, '_').toLowerCase().slice(0, 64), String(v || '').trim().slice(0, 240)])
        .filter(([k]) => k.length > 0)
    );
  }

  return {
    field_schema,
    navigation_instructions: String(o.navigation_instructions || '').trim().slice(0, 1200),
    strict_match_rules: String(o.strict_match_rules || '').trim().slice(0, 800)
  };
}

module.exports = { buildManifestFromBrief, FALLBACK_SCHEMA };
