const logger = require('../../utils/logger');
const { getGeminiModel, isAIAvailable } = require('../ai/geminiClient');

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

async function buildAutoLeadQuickLeads({ brief, sources }) {
  const src = Array.isArray(sources) ? sources : [];
  if (!src.length) return [];

  function fallbackLeadFromSource(s, i) {
    return {
      lead_title: String(s?.title || `Opportunity ${i + 1}`).slice(0, 180),
      project_name: String(s?.title || `Opportunity ${i + 1}`).slice(0, 180),
      location: 'Unknown',
      address: 'Not publicly stated',
      permit_or_record_id: 'Not publicly stated',
      status_or_phase: 'Not publicly stated',
      estimated_value_usd: 'Not publicly stated',
      key_contact_or_firm: 'Not publicly stated',
      why_opportunity: String(s?.snippet || 'Relevant source found').slice(0, 320),
      evidence: String(s?.snippet || 'Snippet-only quick mode evidence').slice(0, 260),
      recommended_next_step: 'Open source and confirm permit/project table columns before outreach.',
      source_title: String(s?.title || 'Source').slice(0, 180),
      source_url: String(s?.url || '').trim(),
      missing_fields: 'Address, contact, status, and value need source-level extraction',
      data_completeness: 'low'
    };
  }

  if (!isAIAvailable()) {
    return src.slice(0, 3).map((s, i) => fallbackLeadFromSource(s, i));
  }

  const model = getGeminiModel('discovery');
  const prompt =
    'Return ONLY JSON with this shape: {"leads":[{"lead_title":"","project_name":"","location":"","address":"","permit_or_record_id":"","status_or_phase":"","estimated_value_usd":"","key_contact_or_firm":"","why_opportunity":"","evidence":"","recommended_next_step":"","source_title":"","source_url":"","missing_fields":"","data_completeness":""}]}\n' +
    'Create exactly 3 concise but client-ready opportunities from these source snippets.\n' +
    'Do not invent exact budgets, permit IDs, contacts, addresses, or status values if not present.\n' +
    'If a value is not explicitly present, use "Not publicly stated".\n' +
    'data_completeness must be one of: high, medium, low.\n' +
    'Use source URLs from the input only.\n\n' +
    `User brief:\n${String(brief || '').slice(0, 1800)}\n\n` +
    `Sources:\n${JSON.stringify(src.slice(0, 8), null, 2)}`;

  try {
    const result = await model.generateContent(prompt);
    const raw = (await result.response).text();
    const o = parseJson(raw);
    const arr = Array.isArray(o?.leads) ? o.leads : [];
    const allowed = new Set(src.map(s => s.url));
    const out = arr
      .filter(x => x && typeof x === 'object')
      .map((x, i) => {
        const safeUrl = allowed.has(String(x.source_url || '').trim())
          ? String(x.source_url || '').trim()
          : String(src[i]?.url || src[0]?.url || '').trim();
        const completenessRaw = String(x.data_completeness || '').toLowerCase().trim();
        const completeness = ['high', 'medium', 'low'].includes(completenessRaw) ? completenessRaw : 'low';
        return {
          lead_title: String(x.lead_title || x.project_name || '').trim().slice(0, 180) || 'Opportunity',
          project_name: String(x.project_name || x.lead_title || '').trim().slice(0, 180) || 'Opportunity',
          location: String(x.location || 'Unknown').trim().slice(0, 140),
          address: String(x.address || 'Not publicly stated').trim().slice(0, 220),
          permit_or_record_id: String(x.permit_or_record_id || 'Not publicly stated').trim().slice(0, 120),
          status_or_phase: String(x.status_or_phase || 'Not publicly stated').trim().slice(0, 120),
          estimated_value_usd: String(x.estimated_value_usd || 'Not publicly stated').trim().slice(0, 120),
          key_contact_or_firm: String(x.key_contact_or_firm || 'Not publicly stated').trim().slice(0, 180),
          why_opportunity: String(x.why_opportunity || '').trim().slice(0, 360) || 'Potentially relevant source from quick search.',
          evidence: String(x.evidence || x.why_opportunity || '').trim().slice(0, 300) || 'Snippet-level evidence only.',
          recommended_next_step: String(x.recommended_next_step || 'Open source and confirm permit/project table columns before outreach.').trim().slice(0, 220),
          source_title: String(x.source_title || 'Source').trim().slice(0, 180),
          source_url: safeUrl,
          missing_fields: String(x.missing_fields || '').trim().slice(0, 220) || 'Some sales fields still need validation from source.',
          data_completeness: completeness
        };
      })
      .slice(0, 3);
    if (out.length) return out;
    return src.slice(0, 3).map((s, i) => fallbackLeadFromSource(s, i));
  } catch (e) {
    logger.warn(`autoLeadQuickLeads: ${e.message}`);
    return src.slice(0, 3).map((s, i) => fallbackLeadFromSource(s, i));
  }
}

module.exports = { buildAutoLeadQuickLeads };

