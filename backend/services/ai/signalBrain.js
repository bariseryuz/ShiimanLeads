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
 * Analyst + event detection: permits vs hiring vs funding vs new location (trigger-based reasoning).
 */
function buildSignalAnalystPrompt(userProfile) {
  const industry = String(userProfile.industry || '').trim() || "the client's industry";
  const targetAudience = String(userProfile.target_audience || '').trim() || 'their target customers';
  const positiveSignals = String(userProfile.positive_signals || '').trim() || 'fit, intent, and deal potential';
  const negativeSignals = String(userProfile.negative_signals || '').trim();

  let text =
    `You are an analyst for ${industry}. ` +
    `Your client sells to ${targetAudience}. ` +
    `Rank this lead from 1–10 based on how strongly it matches these positive signals: ${positiveSignals}.\n\n` +
    `EVENT ANALYSIS — Identify the primary "Trigger Event" in the data (use only what is present; do not invent facts):\n` +
    `- CONSTRUCTION / PERMIT: permit numbers, square footage, zoning, contractor, address, job value.\n` +
    `- HIRING: job title, job description, careers page, ATS (Greenhouse/Lever), "we're hiring".\n` +
    `- FUNDING / STARTUP: funding round, investors, Crunchbase-style facts if present.\n` +
    `- EXPANSION / REAL ESTATE: new office, relocation, lease, BizJournal-style headlines if present.\n` +
    `- NEW BUSINESS: grand opening, new location, "opening soon".\n` +
    `- UNKNOWN / OTHER: weak or ambiguous.\n\n` +
    `If HIRING is the main signal, briefly infer commercial intent for ${industry} only as a soft hypothesis, e.g. ` +
    `hiring developers → possible need for SaaS/cloud/tools; hiring sales → CRM/lead gen; hiring PMs → delivery stack. ` +
    `Keep inferences tentative and label them as hypotheses.\n\n` +
    `RECENCY: If the data includes a posted date or "hours/days ago" and the signal is hiring or time-sensitive, ` +
    `favor higher scores (e.g. 9–10) when recency clearly indicates the last 48 hours; otherwise score normally.\n`;
  if (negativeSignals) {
    text += `Downrank leads that show these negative signals: ${negativeSignals}.\n`;
  }
  text +=
    '\nReturn ONLY valid JSON (no markdown fences) with this exact shape:\n' +
    '{"score": <integer 1-10>, "reason": "<one or two sentences: why this score for this client>", "contact_name": "<best contact or company name if inferable; else empty string>", ' +
    '"trigger_type": "<one of: construction_permit | hiring | funding | expansion | new_business | unknown>", ' +
    '"trigger_event": "<short label of the detected event>"}\n\n' +
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
    let reason = typeof o.reason === 'string' ? o.reason.trim() : String(o.reason || '').trim();
    const contact_name =
      o.contact_name == null ? '' : String(o.contact_name).trim().slice(0, 500);
    const trigger_type =
      o.trigger_type == null ? '' : String(o.trigger_type).trim().slice(0, 80);
    const trigger_event =
      o.trigger_event == null ? '' : String(o.trigger_event).trim().slice(0, 300);
    if (trigger_event || trigger_type) {
      const prefix = [trigger_type, trigger_event].filter(Boolean).join(' · ');
      reason = prefix ? `${prefix} — ${reason || ''}`.replace(/\s+—\s*$/, '').trim() || '—' : reason || '—';
    } else {
      reason = reason || '—';
    }
    return { score, reason, contact_name, trigger_type, trigger_event };
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
