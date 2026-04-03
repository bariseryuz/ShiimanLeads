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
    '"trigger_event": "<short label of the detected event>", ' +
    '"signal_line": "<REQUIRED: one line for the seller dashboard. Format EXACTLY: [Best address or city or property name] - Short factual event (e.g. new lease, permit issued, opening soon). Use only facts from the data; max 220 chars.>"}\n\n' +
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
    let signal_line =
      o.signal_line == null ? '' : String(o.signal_line).trim().slice(0, 300);
    if (!signal_line && (trigger_event || trigger_type)) {
      signal_line = `[${trigger_type || 'Event'}] - ${trigger_event}`.slice(0, 300);
    }
    if (trigger_event || trigger_type) {
      const prefix = [trigger_type, trigger_event].filter(Boolean).join(' · ');
      reason = prefix ? `${prefix} — ${reason || ''}`.replace(/\s+—\s*$/, '').trim() || '—' : reason || '—';
    } else {
      reason = reason || '—';
    }
    return { score, reason, contact_name, trigger_type, trigger_event, signal_line: signal_line || '' };
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

function envSignalLineWithoutProfile() {
  const v = process.env.SIGNAL_LINE_WITHOUT_ICP_PROFILE;
  if (v == null || !String(v).trim()) return true;
  return String(v).trim().toLowerCase() === 'true';
}

/**
 * When the user has not filled ICP fields, still produce a one-line "[Location] - event" if enabled.
 * @returns {Promise<{ signal_line: string } | null>}
 */
async function generateSignalLineOnly(userId, leadData) {
  if (!isAIAvailable() || !envSignalLineWithoutProfile()) return null;

  const user = await dbGet(
    'SELECT id, company_name, industry, target_audience FROM users WHERE id = ?',
    [userId]
  );
  const sellerHint = [user?.company_name, user?.industry || user?.target_audience]
    .filter(Boolean)
    .join(' · ')
    .trim()
    || 'B2B commercial services';

  const leadText = typeof leadData === 'string' ? leadData : JSON.stringify(leadData, null, 2);

  const prompt =
    `You format leads for a seller: ${sellerHint}.\n` +
    `Use ONLY facts from the JSON below. Do not invent addresses, permits, or openings.\n\n` +
    `Return ONLY valid JSON (no markdown):\n` +
    `{"signal_line":"[Location] - Short factual event."}\n\n` +
    `Rules for signal_line:\n` +
    `- Put the best location in square brackets: street + city if present, else city/state, else business/property name, else "Unknown location".\n` +
    `- After "] - " write ONE short event: permit type, lease, hiring, opening soon, renovation, etc.\n` +
    `- Max 220 characters. English.\n` +
    `- Examples (structure only; use real fields from data):\n` +
    `"[4521 Maple Ave, Dallas, TX] - Interior permit issued for condo renovation."\n` +
    `"[West End] - New office lease signed."\n` +
    `"[Uptown] - Restaurant opening soon; storefront under construction."\n\n` +
    `Lead JSON:\n${leadText}`;

  try {
    const model = getGeminiModel('signal');
    const result = await model.generateContent(prompt);
    const raw = (await result.response).text();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    const o = JSON.parse(raw.slice(start, end + 1));
    const sl = o.signal_line != null ? String(o.signal_line).trim().slice(0, 300) : '';
    return sl ? { signal_line: sl } : null;
  } catch (e) {
    logger.warn(`[SignalBrain] generateSignalLineOnly: ${e.message}`);
    return null;
  }
}

/**
 * Full ICP scoring when profile fields exist; otherwise optional one-line signal.
 * @returns {Promise<{ score: number|null, reason: string|null, contact_name: string|null, signal_line: string|null, trigger_type?: string, trigger_event?: string } | null>}
 */
async function enrichLeadSignals(userId, leadData) {
  const user = await dbGet(
    'SELECT industry, target_audience, positive_signals, negative_signals FROM users WHERE id = ?',
    [userId]
  );
  if (userProfileHasSignalInputs(user)) {
    const scored = await scoreLeadWithSignalBrain(userId, leadData);
    return scored;
  }
  const minimal = await generateSignalLineOnly(userId, leadData);
  if (!minimal?.signal_line) return null;
  return {
    score: null,
    reason: null,
    contact_name: null,
    signal_line: minimal.signal_line,
    trigger_type: null,
    trigger_event: null
  };
}

module.exports = {
  buildSignalAnalystPrompt,
  userProfileHasSignalInputs,
  scoreLeadWithSignalBrain,
  enrichLeadSignals,
  generateSignalLineOnly,
  getSignalScoreThreshold,
  parseSignalJson
};
