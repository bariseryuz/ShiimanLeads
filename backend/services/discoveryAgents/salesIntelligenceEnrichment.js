/**
 * Optional "Agent C" — map raw permit/API rows into a sales-style table (project, phase, why now).
 * Does NOT call Google Street View or guarantee named GCs; names only when present in row text.
 * Enable with AUTO_LEADS_SALES_SHAPE=true
 */

const logger = require('../../utils/logger');
const { getGeminiModel, isAIAvailable } = require('../ai/geminiClient');
const { retryWithBackoff } = require('../../utils/aiRetry');
const scaleLimits = require('../../config/scaleLimits');

function parseJson(text) {
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
 * @param {{ brief: string, intent: object, leads: object[] }} opts
 * @returns {Promise<{ sales_rows: object[] } | null>}
 */
async function enrichSalesIntelligenceTable(opts) {
  const brief = String(opts.brief || '').trim();
  const intent = opts.intent && typeof opts.intent === 'object' ? opts.intent : {};
  const leads = Array.isArray(opts.leads) ? opts.leads : [];
  if (leads.length < 1 || !isAIAvailable()) return null;

  const slice = leads.slice(0, 25);
  const prompt =
    'You shape public-record rows for a field sales trip. Return ONLY valid JSON:\n' +
    '{"sales_rows":[{"project_name":"...","location":"...","phase":"...","key_contact_gc":"...","why_its_a_lead":"..."}]}\n' +
    'Rules:\n' +
    '- project_name / location: from row fields when possible; otherwise infer short neutral labels from text.\n' +
    '- key_contact_gc: use a company or person ONLY if clearly present in the row JSON; otherwise "Not in source".\n' +
    '- phase: e.g. topping out, dry-in, interior build-out, permitting — infer cautiously from dates/descriptions.\n' +
    '- why_its_a_lead: 1–2 sentences tied to the user brief (window treatments, glazing, shades, etc.) without inventing dollar amounts or contracts.\n' +
    '- Do not claim Street View or site visits were performed.\n\n' +
    `User brief:\n${brief.slice(0, 3000)}\n\nIntent:\n${JSON.stringify(intent).slice(0, 2000)}\n\nRows (JSON):\n${JSON.stringify(slice).slice(0, 28000)}`;

  try {
    const model = getGeminiModel('discovery');
    const result = await retryWithBackoff(
      () => model.generateContent(prompt),
      { maxRetries: scaleLimits.gemini.maxRetries, baseMs: scaleLimits.gemini.retryBaseMs }
    );
    const raw = (await result.response).text();
    const o = parseJson(raw);
    const rows = Array.isArray(o?.sales_rows) ? o.sales_rows : [];
    const cleaned = rows
      .filter(r => r && typeof r === 'object')
      .map(r => ({
        project_name: String(r.project_name || '—').slice(0, 200),
        location: String(r.location || '—').slice(0, 300),
        phase: String(r.phase || '—').slice(0, 120),
        key_contact_gc: String(r.key_contact_gc || 'Not in source').slice(0, 200),
        why_its_a_lead: String(r.why_its_a_lead || '').slice(0, 600)
      }))
      .slice(0, 25);
    return cleaned.length ? { sales_rows: cleaned } : null;
  } catch (e) {
    logger.warn(`salesIntelligenceEnrichment: ${e.message}`);
    return null;
  }
}

module.exports = { enrichSalesIntelligenceTable };
