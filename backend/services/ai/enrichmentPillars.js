/**
 * Deep enrichment for AI Enrichment page — structured JSON for 3 pillars + icebreaker.
 */

const logger = require('../../utils/logger');
const { genAI, isAIAvailable } = require('./geminiClient');

function stripJsonFence(text) {
  let t = String(text || '').trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }
  return t.trim();
}

function fallbackFromLead(lead) {
  const addr =
    extractBracketAddress(lead) ||
    lead.PropertyAddress ||
    lead.property_address ||
    lead.address ||
    'this property';
  const city = lead.City || lead.city || '';
  const st = lead.State || lead.state || '';
  const permit = lead.PermitType || lead.permit_type || lead['Permit Type'] || 'permit';
  return {
    situation_insight:
      `Lead points to activity at ${addr}. Review permit type and dates in the raw fields to judge whether this looks like new work, addition, or renovation.`,
    market_snippet: city
      ? `Market context for ${city}${st ? ', ' + st : ''}: use local comps and zip-level growth data in your CRM for a full picture.`
      : 'Pull zip-level growth and median price trends from your data vendor to qualify the neighborhood.',
    decision_maker_blurb:
      (lead.contact_name || lead.OwnerName || lead.ContractorName)
        ? `Possible contacts in the record: ${[lead.contact_name, lead.OwnerName, lead.ContractorName].filter(Boolean).join(' · ')}. Confirm roles before outreach.`
        : 'No named owner in the payload — use county records or LinkedIn search by company name.',
    linkedin_angle: 'Search company name + city for the GC or owner; look for recent project posts.',
    contact_email_verified_story: 'Verification needs Hunter/Apollo or manual cross-check — single-source emails stay unverified.',
    email_verified: false,
    risk_opportunity_score: 5,
    risk_opportunity_summary: `Permit type: ${permit}. Estimate scope from square footage and fee fields when present.`,
    icebreaker_email: `Hi — I noticed recent permit activity tied to ${addr}. If you're scaling similar work in the area, I'd love to compare notes on timelines and vendors. Open to a quick call?`
  };
}

function extractBracketAddress(lead) {
  const sl = lead.signal_line != null ? String(lead.signal_line) : '';
  const m = sl.match(/\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

function buildPillarsPrompt(lead) {
  const payload = JSON.stringify(lead, null, 2);
  return (
    `You are a senior commercial researcher helping a salesperson. You ONLY receive JSON lead data (often building permits). ` +
    `Infer carefully: label speculation as hypothesis. Return ONLY valid JSON (no markdown fences) with exactly these keys:\n` +
    `{\n` +
    `  "situation_insight": "string, 2-4 sentences. Property/LLC/permit situation. Mention flip/rental/addition ONLY as hypothesis if data suggests.",\n` +
    `  "market_snippet": "string, 1-3 sentences. Local market angle for the city/zip if inferable; else what to look up externally.",\n` +
    `  "decision_maker_blurb": "string, 2-3 sentences. Who likely decides (owner, GC, developer) based on fields.",\n` +
    `  "linkedin_angle": "string, one short line: what to search on LinkedIn.",\n` +
    `  "contact_email_verified_story": "string, one sentence explaining verification state.",\n` +
    `  "email_verified": boolean, true ONLY if the data explicitly suggests the same email appeared in two places OR enrichment_status suggests verified; else false.\n` +
    `  "risk_opportunity_score": integer 1-10 (10 = strong opportunity for the seller).,\n` +
    `  "risk_opportunity_summary": "string, 2 sentences on timeline/value/risk from permit type and numbers in data.",\n` +
    `  "icebreaker_email": "string, a 4-7 sentence cold email. Use a real first name from data if present; else Hi there. Reference the address or permit. Professional, concise."\n` +
    `}\n\n` +
    `Lead JSON:\n${payload}`
  );
}

async function generatePillarInsights(lead) {
  if (!lead || typeof lead !== 'object') {
    throw new Error('lead object required');
  }
  if (!isAIAvailable() || !genAI) {
    logger.warn('[EnrichmentPillars] AI unavailable — using fallback');
    return { ...fallbackFromLead(lead), _fallback: true };
  }

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash-lite',
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json'
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' }
    ]
  });

  try {
    const result = await model.generateContent(buildPillarsPrompt(lead));
    const response = await result.response;
    const raw = stripJsonFence(response.text());
    const parsed = JSON.parse(raw);
    return {
      situation_insight: String(parsed.situation_insight || '').trim(),
      market_snippet: String(parsed.market_snippet || '').trim(),
      decision_maker_blurb: String(parsed.decision_maker_blurb || '').trim(),
      linkedin_angle: String(parsed.linkedin_angle || '').trim(),
      contact_email_verified_story: String(parsed.contact_email_verified_story || '').trim(),
      email_verified: !!parsed.email_verified,
      risk_opportunity_score: Math.min(10, Math.max(1, parseInt(parsed.risk_opportunity_score, 10) || 5)),
      risk_opportunity_summary: String(parsed.risk_opportunity_summary || '').trim(),
      icebreaker_email: String(parsed.icebreaker_email || '').trim(),
      _fallback: false
    };
  } catch (e) {
    logger.warn(`[EnrichmentPillars] Gemini failed: ${e.message}`);
    return { ...fallbackFromLead(lead), _fallback: true, _error: e.message };
  }
}

function buildIntroEmailPrompt(lead, prior) {
  const payload = JSON.stringify({ lead, prior_context: prior || null }, null, 2);
  return (
    `Rewrite a short intro email (4-7 sentences) for this lead. Professional, specific to permit/address. JSON only: {"intro_email":"..."}\n\n` +
    payload
  );
}

async function generateIntroEmail(lead, priorContext) {
  if (!isAIAvailable() || !genAI) {
    const f = fallbackFromLead(lead);
    return { intro_email: f.icebreaker_email };
  }
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash-lite',
    generationConfig: {
      temperature: 0.45,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json'
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' }
    ]
  });
  try {
    const result = await model.generateContent(buildIntroEmailPrompt(lead, priorContext));
    const response = await result.response;
    const raw = stripJsonFence(response.text());
    const parsed = JSON.parse(raw);
    return { intro_email: String(parsed.intro_email || parsed.icebreaker_email || '').trim() };
  } catch (e) {
    logger.warn(`[EnrichmentPillars] intro email: ${e.message}`);
    return { intro_email: fallbackFromLead(lead).icebreaker_email };
  }
}

module.exports = {
  generatePillarInsights,
  generateIntroEmail,
  fallbackFromLead,
  extractBracketAddress
};
