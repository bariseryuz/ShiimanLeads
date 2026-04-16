/**
 * Conversational "quick read" for Find leads — Gemini prose, not JSON pipelines.
 * Separate from My sources / extract-to-format (API-heavy paths elsewhere).
 */

const logger = require('../../utils/logger');
const { generateProseAnswer, isAIAvailable } = require('../ai/geminiClient');

/**
 * @param {{
 *   brief: string,
 *   intent?: object,
 *   candidate_sources?: Array<{ title?: string, url?: string }>,
 *   leads?: object[],
 *   urls_attempted?: string[],
 *   noSearchHits?: boolean
 * }} input
 * @returns {Promise<string|null>}
 */
async function buildAutoLeadQuickRead(input) {
  const b = String(input.brief || '').trim();
  if (b.length < 8) return null;
  if (!isAIAvailable()) {
    return null;
  }

  const intent = input.intent && typeof input.intent === 'object' ? input.intent : {};
  const sources = Array.isArray(input.candidate_sources) ? input.candidate_sources : [];
  const leads = Array.isArray(input.leads) ? input.leads : [];
  const titles = sources
    .slice(0, 8)
    .map(s => (s && s.title ? String(s.title).slice(0, 120) : ''))
    .filter(Boolean);

  const ctx =
    `User brief (what they want):\n${b.slice(0, 2000)}\n\n` +
    `Parsed intent (geography, record type, etc.):\n${JSON.stringify(intent).slice(0, 2500)}\n\n` +
    `Public sources we surfaced (${sources.length}): ${titles.length ? titles.join(' | ') : '(none this run)'}\n` +
    `Lead opportunities drafted in this run: ${leads.length}\n` +
    (input.noSearchHits ? '\nNote: Web search returned no candidate URLs (check SERPER_API_KEY or wording).\n' : '') +
    `\nWrite like a helpful colleague — not a robot listing APIs.`;

  const prompt =
    'Write a short, conversational reply (2–4 brief paragraphs).\n' +
    '- Start naturally (e.g. acknowledge the place and what they sell / track).\n' +
    '- Explain where the opportunity usually shows up for this kind of request (permits, open data, major projects) without inventing fake project names, dollar amounts, or contacts.\n' +
    '- If sources were found, frame them as good places to dig; if no clear opportunities came back yet, say that plainly and suggest a better next search — without sounding like a system error.\n' +
    '- Keep it scannable; no JSON, no bullet walls unless 3–4 bullets help.\n' +
    '- Do not promise emails or guaranteed wins.';

  try {
    const out = await generateProseAnswer(prompt, { context: ctx });
    return out && out.length > 20 ? out : null;
  } catch (e) {
    logger.warn(`autoLeadQuickRead: ${e.message}`);
    return null;
  }
}

module.exports = { buildAutoLeadQuickRead };
