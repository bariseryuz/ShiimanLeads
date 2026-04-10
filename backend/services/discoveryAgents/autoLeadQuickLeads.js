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

  if (!isAIAvailable()) {
    return src.slice(0, 3).map((s, i) => ({
      lead_title: s.title || `Opportunity ${i + 1}`,
      location: 'Unknown',
      why_opportunity: String(s.snippet || 'Relevant source found').slice(0, 220),
      source_url: s.url
    }));
  }

  const model = getGeminiModel('discovery');
  const prompt =
    'Return ONLY JSON with this shape: {"leads":[{"lead_title":"","location":"","why_opportunity":"","source_url":""}]}\n' +
    'Create exactly 3 concise opportunities from these source snippets.\n' +
    'Do not invent exact budgets, permit IDs, contacts, or status values if not present.\n' +
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
      .map(x => ({
        lead_title: String(x.lead_title || '').trim().slice(0, 180) || 'Opportunity',
        location: String(x.location || 'Unknown').trim().slice(0, 120),
        why_opportunity: String(x.why_opportunity || '').trim().slice(0, 280),
        source_url: allowed.has(String(x.source_url || '').trim()) ? String(x.source_url).trim() : src[0].url
      }))
      .slice(0, 3);
    return out.length ? out : [];
  } catch (e) {
    logger.warn(`autoLeadQuickLeads: ${e.message}`);
    return [];
  }
}

module.exports = { buildAutoLeadQuickLeads };

