const logger = require('../../utils/logger');
const { hasSerper, googleSearchOrganic } = require('../serperSearch');
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

function pickLeadText(lead) {
  const project = String(lead.project_name || lead.lead_title || '').trim();
  const location = String(lead.location || lead.address || '').trim();
  const company = String(lead.company_name || lead.key_contact_or_firm || '').trim();
  return { project, location, company };
}

async function enrichOneLead(lead, brief, intent) {
  if (!isAIAvailable() || !hasSerper()) return null;
  const { project, location, company } = pickLeadText(lead);
  const base = [project || company, location].filter(Boolean).join(' ').trim();
  if (!base) return null;

  const queries = [
    `${base} general contractor OR developer`,
    `${base} project manager OR development director linkedin`,
    `${base} architect OR owner representative`
  ];

  const pooled = [];
  for (let i = 0; i < Math.min(2, queries.length); i++) {
    try {
      const rows = await googleSearchOrganic(queries[i], { num: 5, timeoutMs: 9000 });
      for (const r of rows) {
        pooled.push({
          title: String(r.title || '').slice(0, 220),
          link: String(r.link || '').slice(0, 300),
          snippet: String(r.snippet || '').slice(0, 300)
        });
      }
    } catch (e) {
      logger.warn(`companyPeopleEnrichment search: ${e.message}`);
    }
  }

  if (!pooled.length) return null;

  const model = getGeminiModel('discovery');
  const prompt =
    'Return ONLY JSON with this shape:\n' +
    '{"company_name":"","company_summary":"","key_people":[{"name":"","role":"","source_url":""}],"best_contact_path":"","confidence":"high|medium|low"}\n' +
    'Rules:\n' +
    '- Use only the provided snippets/links.\n' +
    '- Never invent person names.\n' +
    '- If no reliable name is found, key_people should be [].\n' +
    '- company_summary must be short (max 20 words).\n' +
    '- best_contact_path should be one practical sentence.\n\n' +
    `User brief:\n${String(brief || '').slice(0, 1200)}\n\n` +
    `Intent:\n${JSON.stringify(intent || {}).slice(0, 1200)}\n\n` +
    `Lead:\n${JSON.stringify(lead).slice(0, 1800)}\n\n` +
    `Search snippets:\n${JSON.stringify(pooled.slice(0, 12), null, 2)}`;

  try {
    const result = await model.generateContent(prompt);
    const raw = (await result.response).text();
    const obj = parseJson(raw);
    if (!obj || typeof obj !== 'object') return null;
    const kp = Array.isArray(obj.key_people) ? obj.key_people : [];
    const people = kp
      .filter(x => x && typeof x === 'object' && String(x.name || '').trim())
      .slice(0, 3)
      .map(x => ({
        name: String(x.name || '').trim().slice(0, 120),
        role: String(x.role || '').trim().slice(0, 120),
        source_url: String(x.source_url || '').trim().slice(0, 320)
      }));
    return {
      company_name: String(obj.company_name || company || '').trim().slice(0, 180),
      company_summary: String(obj.company_summary || '').trim().slice(0, 240),
      key_people: people,
      best_contact_path: String(obj.best_contact_path || '').trim().slice(0, 200),
      enrichment_confidence: ['high', 'medium', 'low'].includes(String(obj.confidence || '').toLowerCase())
        ? String(obj.confidence || '').toLowerCase()
        : 'low'
    };
  } catch (e) {
    logger.warn(`companyPeopleEnrichment ai: ${e.message}`);
    return null;
  }
}

async function enrichLeadsWithCompanyPeople({ brief, intent, leads, maxLeads = 5 }) {
  const rows = Array.isArray(leads) ? leads : [];
  if (!rows.length) return { leads: rows, enrichment_rows: [] };
  const out = rows.map(r => ({ ...r }));
  const enrichment_rows = [];
  const n = Math.min(Math.max(1, maxLeads), out.length);

  for (let i = 0; i < n; i++) {
    const e = await enrichOneLead(out[i], brief, intent);
    if (!e) continue;
    out[i] = {
      ...out[i],
      ...(e.company_name ? { company_name: e.company_name } : {}),
      ...(e.company_summary ? { company_summary: e.company_summary } : {}),
      ...(e.best_contact_path ? { best_contact_path: e.best_contact_path } : {}),
      ...(e.key_people?.length ? { key_people: e.key_people } : {}),
      ...(e.key_people?.length && !out[i].key_contact_or_firm
        ? { key_contact_or_firm: `${e.key_people[0].name}${e.key_people[0].role ? ` (${e.key_people[0].role})` : ''}` }
        : {})
    };
    enrichment_rows.push({
      index: i,
      company_name: e.company_name || 'Not found',
      key_people: e.key_people || [],
      confidence: e.enrichment_confidence || 'low'
    });
  }

  return { leads: out, enrichment_rows };
}

module.exports = { enrichLeadsWithCompanyPeople };

