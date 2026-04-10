/**
 * Phase 1 — "Search query expansion": translate a user brief into parallel,
 * high-recall queries (permits, open data, GIS, major-project signals).
 * Complements deterministic buildSerperQueries(); does not replace it.
 */

const logger = require('../../utils/logger');
const { getGeminiModel, isAIAvailable } = require('./geminiClient');
const { retryWithBackoff } = require('../../utils/aiRetry');
const scaleLimits = require('../../config/scaleLimits');

function parseQueriesJson(text) {
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
 * Target shape for a future "enterprise lead" enrichment step (Phase 4).
 * Not enforced by the API yet — documented for product alignment.
 */
const ENTERPRISE_LEAD_SHAPE_EXAMPLE = {
  lead_name: 'Project or site name',
  contract_opportunity: 'What the ICP sells into this project',
  project_value: 'Total build or contract band',
  est_icp_budget: 'Estimated slice relevant to the user',
  project_stage: 'e.g. dry-in, interior build-out',
  target_contact_type: 'GC / owner rep / designer',
  primary_gc: 'Named GC if known',
  source_verification: 'Permit # or URL',
  why_hot: 'One-line reason to call now'
};

/**
 * @param {string} brief
 * @param {object} intent - from parseBriefWithGemini
 * @returns {Promise<{ queries: string[] }>}
 */
async function expandHighSignalSearchQueries(brief, intent) {
  const b = String(brief || '').trim();
  if (b.length < 12 || !isAIAvailable()) {
    return { queries: [] };
  }

  const prompt =
    'You are a B2B construction and public-records lead specialist.\n' +
    'Given the user brief and structured intent, output 5 DISTINCT Google search queries that maximize the chance of finding ' +
    'ROW-LEVEL public data: building permits, open-data portals, ArcGIS FeatureServer / MapServer, Socrata, agency project or permit lists.\n' +
    'Include at least one query aimed at PROJECT TIMING signals when relevant (e.g. topping out, crane watch, pipeline, large commercial permit bands) — ' +
    'B2B window/glazing/shade leads often track 6–12 months behind shell completion.\n' +
    'Avoid vague blog-only queries. Prefer queries that include: jurisdiction name, permit or project type, ' +
    '"open data" OR "GIS" OR "FeatureServer" OR "data portal", and when the brief implies large projects, ' +
    'signals like valuation bands, new construction, commercial, multifamily, or (if relevant) major development names or master plans.\n' +
    'Do not output instructions to humans — only search strings.\n\n' +
    'Return ONLY valid JSON: {"queries":["q1","q2","q3","q4","q5"]} — each string under 140 chars.\n\n' +
    `Intent (JSON):\n${JSON.stringify(intent).slice(0, 4000)}\n\nUser brief:\n${b.slice(0, 5000)}`;

  try {
    const model = getGeminiModel('discovery');
    const result = await retryWithBackoff(
      () => model.generateContent(prompt),
      { maxRetries: scaleLimits.gemini.maxRetries, baseMs: scaleLimits.gemini.retryBaseMs }
    );
    const raw = (await result.response).text();
    const o = parseQueriesJson(raw);
    const list = Array.isArray(o?.queries)
      ? o.queries.map(q => String(q || '').trim()).filter(q => q.length > 6 && q.length < 200)
      : [];
    const unique = [...new Set(list)].slice(0, 5);
    return { queries: unique };
  } catch (e) {
    logger.warn(`searchQueryExpansion: ${e.message}`);
    return { queries: [] };
  }
}

module.exports = {
  expandHighSignalSearchQueries,
  ENTERPRISE_LEAD_SHAPE_EXAMPLE
};
