const logger = require('../../utils/logger');
const { getGeminiModel, isAIAvailable } = require('../ai/geminiClient');
const { readMultiplePages } = require('./pageReader');

function parseJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  try {
    return JSON.parse(t.slice(s, e + 1));
  } catch {
    return null;
  }
}

const PLATFORM_PROVIDER_RE = /\b(socrata|arcgis|esri|tyler\s*tech|opendata\s*soft|accela)\b/i;

function sanitizeCompany(raw) {
  const c = String(raw || 'Not publicly stated').trim().slice(0, 180);
  return PLATFORM_PROVIDER_RE.test(c) ? 'Not publicly stated' : c;
}

function mapLeadFromAI(x, i, sources) {
  if (!x || typeof x !== 'object') return null;
  const src = Array.isArray(sources) ? sources : [];
  const allowed = new Set(src.map(s => s.url || s.source_url));
  const rawUrl = String(x.source_url || '').trim();
  const safeUrl = allowed.has(rawUrl) ? rawUrl : String(src[i]?.url || src[0]?.url || '').trim();
  const completenessRaw = String(x.data_completeness || '').toLowerCase().trim();
  const completeness = ['high', 'medium', 'low'].includes(completenessRaw) ? completenessRaw : 'low';
  return {
    lead_title: String(x.lead_title || x.project_name || '').trim().slice(0, 180) || 'Opportunity',
    project_name: String(x.project_name || x.lead_title || '').trim().slice(0, 180) || 'Opportunity',
    project_snapshot: String(x.project_snapshot || x.why_opportunity || '').trim().slice(0, 120) || 'Details on source page',
    location: String(x.location || 'See source').trim().slice(0, 140),
    address: String(x.address || 'Not publicly stated').trim().slice(0, 220),
    company_name: sanitizeCompany(x.company_name || x.key_contact_or_firm),
    permit_or_record_id: String(x.permit_or_record_id || 'Not publicly stated').trim().slice(0, 120),
    status_or_phase: String(x.status_or_phase || 'Not publicly stated').trim().slice(0, 120),
    estimated_value_usd: String(x.estimated_value_usd || 'Not publicly stated').trim().slice(0, 120),
    key_contact_or_firm: sanitizeCompany(x.key_contact_or_firm),
    why_opportunity: String(x.why_opportunity || '').trim().slice(0, 360) || 'Relevant to your search.',
    evidence: String(x.evidence || x.why_opportunity || '').trim().slice(0, 300) || 'Found on source page.',
    recommended_next_step: String(x.recommended_next_step || 'Review the source page and reach out to the decision maker.').trim().slice(0, 220),
    source_title: String(x.source_title || 'Source').trim().slice(0, 180),
    source_url: safeUrl,
    missing_fields: String(x.missing_fields || '').trim().slice(0, 220),
    data_completeness: completeness
  };
}

async function buildAutoLeadQuickLeads({ brief, sources, targetLeads, intent }) {
  const src = Array.isArray(sources) ? sources : [];
  if (!src.length) return [];
  const desiredCount = Math.min(25, Math.max(1, parseInt(targetLeads, 10) || 3));

  if (!isAIAvailable()) {
    logger.warn('[autoLeadQuickLeads] AI not available, returning empty');
    return [];
  }

  // Step 1: Actually visit and read top source pages
  const maxPages = Math.min(4, src.length);
  logger.info(`[autoLeadQuickLeads] reading ${maxPages} pages from ${src.length} candidates`);
  const pages = await readMultiplePages(src, maxPages);
  logger.info(`[autoLeadQuickLeads] successfully read ${pages.length} pages`);

  // Build context from page content + snippets as fallback
  let sourceContext = '';
  if (pages.length) {
    sourceContext = pages.map((p, i) =>
      `--- Source ${i + 1}: ${p.title} (${p.url}) ---\n${p.text.slice(0, 4000)}\n`
    ).join('\n');
  }
  // Add snippet context for pages we couldn't read
  const readUrls = new Set(pages.map(p => p.url));
  const unreadSources = src.filter(s => !readUrls.has(s.url));
  if (unreadSources.length) {
    sourceContext += '\n--- Additional sources (snippet only) ---\n';
    sourceContext += unreadSources.slice(0, 4).map(s =>
      `${s.title || 'Source'} (${s.url}): ${String(s.snippet || '').slice(0, 300)}`
    ).join('\n');
  }

  if (!sourceContext.trim()) {
    logger.warn('[autoLeadQuickLeads] no page content or snippets available');
    return [];
  }

  const model = getGeminiModel('discovery');
  const prompt =
    'You are a lead research assistant. The user described what they are looking for. ' +
    'I visited several web pages and extracted their text content for you below.\n\n' +
    'Your job: read through the page content carefully and find real, specific opportunities that match what the user wants. ' +
    'Extract concrete details you can see in the text: company names, project names, addresses, people mentioned, values, statuses.\n\n' +
    'Return ONLY valid JSON:\n' +
    '{"leads":[{"lead_title":"","project_name":"","project_snapshot":"","location":"","address":"","company_name":"","permit_or_record_id":"","status_or_phase":"","estimated_value_usd":"","key_contact_or_firm":"","why_opportunity":"","evidence":"","recommended_next_step":"","source_title":"","source_url":"","missing_fields":"","data_completeness":"high|medium|low"}]}\n\n' +
    'Rules:\n' +
    `- Return up to ${desiredCount} leads.\n` +
    '- Only use facts visible in the page text. Do not invent names, addresses, or numbers.\n' +
    '- company_name must be a real company/person from the text, not a platform name.\n' +
    '- evidence must quote or closely paraphrase a specific passage from the page.\n' +
    '- If a field is not in the text, use "Not publicly stated".\n' +
    '- source_url must match one of the provided source URLs exactly.\n\n' +
    `USER REQUEST:\n${String(brief || '').slice(0, 2000)}\n\n` +
    `PAGE CONTENT:\n${sourceContext.slice(0, 18000)}`;

  try {
    const result = await model.generateContent(prompt);
    const raw = (await result.response).text();
    const o = parseJson(raw);
    const arr = Array.isArray(o?.leads) ? o.leads : [];
    const mapped = arr
      .map((x, i) => mapLeadFromAI(x, i, src))
      .filter(Boolean)
      .slice(0, desiredCount);
    if (mapped.length) {
      logger.info(`[autoLeadQuickLeads] AI produced ${mapped.length} leads from page content`);
      return mapped;
    }
  } catch (e) {
    logger.warn(`autoLeadQuickLeads page-content AI: ${e.message}`);
  }

  // Last resort: snippet-only generation
  logger.info('[autoLeadQuickLeads] falling back to snippet-based generation');
  const snippetPrompt =
    'You are a lead research assistant. I could not fully read the source pages, but here are search result snippets.\n' +
    'Find the best opportunities matching the user request from these snippets.\n\n' +
    'Return ONLY valid JSON:\n' +
    '{"leads":[{"lead_title":"","project_name":"","project_snapshot":"","location":"","address":"","company_name":"","permit_or_record_id":"","status_or_phase":"","estimated_value_usd":"","key_contact_or_firm":"","why_opportunity":"","evidence":"","recommended_next_step":"","source_title":"","source_url":"","missing_fields":"","data_completeness":"high|medium|low"}]}\n\n' +
    `Return up to ${desiredCount} leads. Only use facts from snippets. Do not invent.\n\n` +
    `USER REQUEST:\n${String(brief || '').slice(0, 2000)}\n\n` +
    `SNIPPETS:\n${JSON.stringify(src.slice(0, 8), null, 2)}`;

  try {
    const result = await model.generateContent(snippetPrompt);
    const raw = (await result.response).text();
    const o = parseJson(raw);
    const arr = Array.isArray(o?.leads) ? o.leads : [];
    const mapped = arr
      .map((x, i) => mapLeadFromAI(x, i, src))
      .filter(Boolean)
      .slice(0, desiredCount);
    if (mapped.length) return mapped;
  } catch (e) {
    logger.warn(`autoLeadQuickLeads snippet AI: ${e.message}`);
  }

  return [];
}

module.exports = { buildAutoLeadQuickLeads };
