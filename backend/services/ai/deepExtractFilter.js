/**
 * Post-filter extracted rows so only those strictly matching the user brief remain.
 */

const logger = require('../../utils/logger');
const { getGeminiModel, isAIAvailable } = require('./geminiClient');
const { retryWithBackoff } = require('../../utils/aiRetry');
const scaleLimits = require('../../config/scaleLimits');

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

/**
 * @param {string} brief
 * @param {string} strictRules
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Promise<{ leads: Array<Record<string, unknown>>, applied: boolean }>}
 */
async function filterLeadsToBrief(brief, strictRules, rows) {
  if (!rows || !rows.length) return { leads: [], applied: true };
  if (!isAIAvailable()) return { leads: rows, applied: false };

  const b = String(brief || '').trim().slice(0, 4000);
  const rules = String(strictRules || '').trim().slice(0, 2000);
  const slice = rows.slice(0, 80);
  const payload = slice.map((r, i) => ({ i, row: r }));

  const prompt =
    'You are a strict filter. Given the user request and rules, decide which extracted rows qualify.\n' +
    'Return ONLY valid JSON: { "keep_indices": [0, 2, ...] } using the "i" index from the input.\n' +
    'Exclude rows that are duplicates, empty, off-topic, wrong geography, wrong record type, or below stated thresholds.\n' +
    'For permits/licenses: prefer rows whose status is Issued, Active, Approved, or In Review when such a field exists; ' +
    'deprioritize Expired, Withdrawn, Void, or Closed unless the user asked for historical records.\n' +
    'If NO row qualifies, return { "keep_indices": [] }.\n' +
    'If unsure about a row, exclude it.\n\n' +
    `USER REQUEST:\n${b}\n\nSTRICT RULES:\n${rules || '(none)'}\n\nROWS (JSON):\n${JSON.stringify(payload).slice(0, 24000)}`;

  try {
    const model = getGeminiModel('discovery');
    const result = await retryWithBackoff(
      () => model.generateContent(prompt),
      { maxRetries: scaleLimits.gemini.maxRetries, baseMs: scaleLimits.gemini.retryBaseMs }
    );
    const raw = (await result.response).text();
    const o = parseJsonBlock(raw);
    const keep =
      o && Array.isArray(o.keep_indices)
        ? o.keep_indices.map(n => parseInt(n, 10)).filter(Number.isFinite)
        : null;
    if (!keep) {
      logger.warn('deepExtractFilter: could not parse keep_indices; returning unfiltered rows');
      return { leads: rows, applied: false };
    }
    const set = new Set(keep);
    const out = slice.filter((_, idx) => set.has(idx));
    return { leads: out.length ? out : [], applied: true };
  } catch (e) {
    logger.warn(`deepExtractFilter: ${e.message}`);
    return { leads: rows, applied: false };
  }
}

module.exports = { filterLeadsToBrief };
