/**
 * Adversarial second-pass AI recheck.
 *
 * After the AI filter + deterministic rules, any lead with confidence < 85
 * goes through a focused "challenge" prompt that tries to REJECT it.
 * Only leads that survive both passes get promoted to high confidence.
 *
 * This closes the gap between "AI said keep" and "deterministic rules said keep"
 * by asking a separate, adversarial question.
 */

const logger = require('../../utils/logger');
const { getGeminiModel, isAIAvailable } = require('../ai/geminiClient');
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
 * @param {object[]} leads - leads with _verification.confidence already set
 * @param {{ threshold?: number }} opts
 * @returns {Promise<object[]>} leads with possibly updated _verification
 */
async function adversarialRecheck(brief, leads, opts = {}) {
  if (!Array.isArray(leads) || !leads.length) return leads;
  if (!isAIAvailable()) return leads;

  const threshold = opts.threshold ?? 85;
  const borderline = [];
  const safe = [];

  for (const lead of leads) {
    const conf = lead._verification?.confidence ?? 100;
    if (conf >= threshold) {
      safe.push(lead);
    } else {
      borderline.push(lead);
    }
  }

  if (!borderline.length) {
    logger.info(`[adversarial-recheck] all ${leads.length} leads above threshold ${threshold} — skipping`);
    return leads;
  }

  logger.info(`[adversarial-recheck] challenging ${borderline.length} borderline leads (threshold < ${threshold})`);

  const payload = borderline.map((lead, i) => {
    const clean = { ...lead };
    delete clean._verification;
    return { i, row: clean };
  });

  const prompt =
    'You are a STRICT quality auditor. Your job is to REJECT leads that do NOT truly match the user\'s request.\n' +
    'For each row, decide: does this row contain a real, actionable lead matching the brief?\n\n' +
    'REJECT a row if:\n' +
    '- It is about a completely different geography than requested\n' +
    '- It is about a different industry/sector than requested\n' +
    '- It has no actionable data (no address, no permit, no project name — just generic text)\n' +
    '- It is clearly a test/sample/placeholder record\n' +
    '- The status is expired/void/closed and user did not ask for historical\n' +
    '- It is a duplicate concept of another row (same project, slightly different wording)\n\n' +
    'KEEP a row if:\n' +
    '- It genuinely matches the geography AND record type the user asked for\n' +
    '- It has at least some actionable fields (address, company, permit number, value)\n' +
    '- Even if incomplete, the core match is correct\n\n' +
    'Return ONLY valid JSON: { "verdicts": [{ "i": 0, "keep": true/false, "reason": "one sentence" }, ...] }\n\n' +
    `USER BRIEF:\n${String(brief).slice(0, 2000)}\n\n` +
    `ROWS TO AUDIT:\n${JSON.stringify(payload).slice(0, 20000)}`;

  try {
    const model = getGeminiModel('discovery');
    const result = await retryWithBackoff(
      () => model.generateContent(prompt),
      { maxRetries: scaleLimits.gemini.maxRetries, baseMs: scaleLimits.gemini.retryBaseMs }
    );
    const raw = (await result.response).text();
    const o = parseJsonBlock(raw);
    const verdicts = o && Array.isArray(o.verdicts) ? o.verdicts : null;

    if (!verdicts) {
      logger.warn('[adversarial-recheck] could not parse verdicts — keeping all borderline leads as-is');
      return leads;
    }

    const verdictMap = new Map();
    for (const v of verdicts) {
      if (v && typeof v.i === 'number') {
        verdictMap.set(v.i, v);
      }
    }

    const rechecked = [];
    for (let idx = 0; idx < borderline.length; idx++) {
      const lead = borderline[idx];
      const verdict = verdictMap.get(idx);

      if (!verdict) {
        rechecked.push(lead);
        continue;
      }

      if (verdict.keep === false) {
        if (lead._verification) {
          lead._verification.confidence = Math.min(lead._verification.confidence, 15);
          lead._verification.confidence_label = 'very_low';
          lead._verification.adversarial_rejected = true;
          lead._verification.adversarial_reason = String(verdict.reason || 'Failed adversarial audit').slice(0, 200);
        }
        logger.info(`[adversarial-recheck] REJECTED row ${idx}: ${verdict.reason || 'no reason'}`);
      } else {
        if (lead._verification) {
          lead._verification.confidence = Math.min(Math.max(lead._verification.confidence + 10, 65), 90);
          lead._verification.confidence_label =
            lead._verification.confidence >= 85 ? 'high' :
            lead._verification.confidence >= 60 ? 'medium' : 'low';
          lead._verification.adversarial_passed = true;
        }
      }
      rechecked.push(lead);
    }

    const finalKept = [...safe, ...rechecked.filter(l => !l._verification?.adversarial_rejected)];
    const finalRejected = rechecked.filter(l => l._verification?.adversarial_rejected);

    logger.info(
      `[adversarial-recheck] result: ${finalKept.length} kept, ${finalRejected.length} rejected by adversarial pass`
    );

    return finalKept;
  } catch (e) {
    logger.warn(`[adversarial-recheck] error: ${e.message} — keeping all borderline leads`);
    return leads;
  }
}

module.exports = { adversarialRecheck };
