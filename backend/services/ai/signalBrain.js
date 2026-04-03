/**
 * Phase 3 — Signal Brain: dynamic analyst prompt + Gemini JSON scoring.
 */

const { dbGet } = require('../../db');
const { getGeminiModel, isAIAvailable } = require('./geminiClient');
const logger = require('../../utils/logger');

function getSignalScoreThreshold() {
  const n = parseFloat(String(process.env.SIGNAL_SCORE_THRESHOLD || '7').trim(), 10);
  return Number.isFinite(n) ? n : 7;
}

/**
 * True if the user has any ICP / signal fields filled (skips API calls when empty).
 */
function userProfileHasSignalInputs(row) {
  if (!row || typeof row !== 'object') return false;
  return ['industry', 'target_audience', 'positive_signals', 'negative_signals'].some(
    k => row[k] != null && String(row[k]).trim() !== ''
  );
}

/**
 * Roadmap template: analyst for [Industry], sells to [Target Audience], rank 1–10 on [Positive Signals].
 */
function buildSignalAnalystPrompt(userProfile) {
  const industry = String(userProfile.industry || '').trim() || "the client's industry";
  const targetAudience = String(userProfile.target_audience || '').trim() || 'their target customers';
  const positiveSignals = String(userProfile.positive_signals || '').trim() || 'fit, intent, and deal potential';
  const negativeSignals = String(userProfile.negative_signals || '').trim();

  let text =
    `You are an analyst for ${industry}. ` +
    `Your client sells to ${targetAudience}. ` +
    `Rank this lead from 1–10 based on how strongly it matches these positive signals: ${positiveSignals}.`;
  if (negativeSignals) {
    text += ` Downrank or penalize leads that show these negative signals: ${negativeSignals}.`;
  }
  text +=
    '\n\nReturn ONLY valid JSON with this exact shape (no markdown fences):\n' +
    '{"score": <integer 1-10>, "reason": "<one or two sentences>", "contact_name": "<best contact or company name if inferable; else empty string>"}\n\n' +
    'Lead data to evaluate:\n';
  return text;
}

function parseSignalJson(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  t = t.slice(start, end + 1);
  try {
    const o = JSON.parse(t);
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
    let score = o.score;
    if (typeof score === 'string') score = Number.parseFloat(score);
    if (typeof score !== 'number' || !Number.isFinite(score)) return null;
    score = Math.round(Math.min(10, Math.max(1, score)));
    const reason = typeof o.reason === 'string' ? o.reason.trim() : String(o.reason || '').trim();
    const contact_name =
      o.contact_name == null ? '' : String(o.contact_name).trim().slice(0, 500);
    return { score, reason: reason || '—', contact_name };
  } catch {
    return null;
  }
}

/**
 * Score a single lead using the user's Signal Brain profile (text-only Gemini).
 * @returns {Promise<{ score: number, reason: string, contact_name: string } | null>}
 */
async function scoreLeadWithSignalBrain(userId, leadData) {
  if (!isAIAvailable()) return null;

  const user = await dbGet(
    'SELECT industry, target_audience, positive_signals, negative_signals FROM users WHERE id = ?',
    [userId]
  );
  if (!userProfileHasSignalInputs(user)) return null;

  const leadText =
    typeof leadData === 'string' ? leadData : JSON.stringify(leadData, null, 2);
  const prompt = buildSignalAnalystPrompt(user) + leadText;

  try {
    const model = getGeminiModel('signal');
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const raw = response.text();
    const parsed = parseSignalJson(raw);
    if (!parsed) {
      logger.warn(`[SignalBrain] Could not parse JSON for user ${userId}: ${String(raw).slice(0, 200)}`);
      return null;
    }
    return parsed;
  } catch (e) {
    logger.error(`[SignalBrain] scoreLeadWithSignalBrain failed: ${e.message}`);
    return null;
  }
}

module.exports = {
  buildSignalAnalystPrompt,
  userProfileHasSignalInputs,
  scoreLeadWithSignalBrain,
  getSignalScoreThreshold,
  parseSignalJson
};
