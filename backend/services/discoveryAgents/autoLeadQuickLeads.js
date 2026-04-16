const logger = require('../../utils/logger');
const { getGeminiModel, isAIAvailable } = require('../ai/geminiClient');
const { fetchOpenDataSampleRows, parseSocrataResource } = require('../openDataDirectSample');

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
  const PLATFORM_PROVIDER_RE = /\b(socrata|arcgis|esri|tyler\s*tech|opendata\s*soft|accela)\b/i;
  const hasApiPivotSource = src.some(s => {
    const u = String(s?.url || '').toLowerCase();
    return /dev\.socrata\.com\/foundry\/|\/resource\/[0-9a-z]{4}-[0-9a-z]{4}|featureserver\/\d+|\/mapserver\//i.test(u) ||
      /^https?:\/\/(data|opendata)\./i.test(u);
  });

  function minValFromBrief(b) {
    const t = String(b || '');
    const m = t.match(/(?:over|above|>=?)\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)(?:\s*(k|m|million))?/i);
    if (!m) return null;
    const n = parseFloat(String(m[1] || '').replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    const u = String(m[2] || '').toLowerCase();
    if (/m|million/.test(u)) return Math.floor(n * 1000000);
    if (/k/.test(u)) return Math.floor(n * 1000);
    return Math.floor(n);
  }

  async function collectApiRowsFromSources() {
    const out = [];
    const minVal = minValFromBrief(brief);
    const kw = String(brief || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const opts = {
      ...(minVal && Number.isFinite(minVal) ? { minValuationUsd: minVal } : {}),
      ...(kw ? { searchText: kw } : {}),
      latestFirst: true
    };
    for (const s of src.slice(0, 5)) {
      const u = String(s?.url || '').trim();
      if (!/^https?:\/\//i.test(u)) continue;
      try {
        const soc = parseSocrataResource(u);
        if (soc) {
          logger.info(`[autoLeadQuickLeads] socrata pivot: ${u} -> https://${soc.host}/resource/${soc.resourceId}.json`);
        }
        const rows = await fetchOpenDataSampleRows(u, 6, opts);
        if (!Array.isArray(rows) || !rows.length) continue;
        for (const r of rows.slice(0, 3)) {
          if (!r || typeof r !== 'object') continue;
          out.push({
            source_url: u,
            source_title: String(s?.title || 'Source').slice(0, 180),
            row: r
          });
          if (out.length >= 8) return out;
        }
      } catch (e) {
        logger.debug(`[autoLeadQuickLeads] api-first ${u.slice(0, 80)}: ${e.message}`);
      }
    }
    return out;
  }

  function fallbackLeadFromSource(s, i) {
    return {
      lead_title: String(s?.title || `Opportunity ${i + 1}`).slice(0, 180),
      project_name: String(s?.title || `Opportunity ${i + 1}`).slice(0, 180),
      project_snapshot: 'Project details need verification from source',
      location: 'Unknown',
      address: 'Not publicly stated',
      company_name: 'Not publicly stated',
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
    return hasApiPivotSource ? [] : src.slice(0, 3).map((s, i) => fallbackLeadFromSource(s, i));
  }

  const model = getGeminiModel('discovery');
  const apiRows = await collectApiRowsFromSources();
  if (apiRows.length) {
    const promptApi =
      'Return ONLY JSON with this shape: {"leads":[{"lead_title":"","project_name":"","project_snapshot":"","location":"","address":"","company_name":"","permit_or_record_id":"","status_or_phase":"","estimated_value_usd":"","key_contact_or_firm":"","why_opportunity":"","evidence":"","recommended_next_step":"","source_title":"","source_url":"","missing_fields":"","data_completeness":""}]}\n' +
      'Build exactly 3 leads from the provided RAW DATA ROWS (not webpage summaries).\n' +
      'If Address/Company are missing in a row, try another row first.\n' +
      'Do not invent values. Use "Not publicly stated" only when row truly lacks it.\n\n' +
      `User brief:\n${String(brief || '').slice(0, 1800)}\n\n` +
      `Rows:\n${JSON.stringify(apiRows.slice(0, 8), null, 2)}`;
    try {
      const rApi = await model.generateContent(promptApi);
      const rawApi = (await rApi.response).text();
      const oApi = parseJson(rawApi);
      const arrApi = Array.isArray(oApi?.leads) ? oApi.leads : [];
      const allowed = new Set(src.map(s => s.url));
      const mappedApi = arrApi
        .filter(x => x && typeof x === 'object')
        .map((x, i) => {
          const fallbackUrl = String(apiRows[i]?.source_url || src[0]?.url || '').trim();
          const safeUrl = allowed.has(String(x.source_url || '').trim())
            ? String(x.source_url || '').trim()
            : fallbackUrl;
          const completenessRaw = String(x.data_completeness || '').toLowerCase().trim();
          const completeness = ['high', 'medium', 'low'].includes(completenessRaw) ? completenessRaw : 'low';
          return {
            lead_title: String(x.lead_title || x.project_name || '').trim().slice(0, 180) || 'Opportunity',
            project_name: String(x.project_name || x.lead_title || '').trim().slice(0, 180) || 'Opportunity',
            project_snapshot: String(x.project_snapshot || x.why_opportunity || x.project_name || '').trim().slice(0, 120) || 'Project details need verification from source',
            location: String(x.location || 'Unknown').trim().slice(0, 140),
            address: String(x.address || 'Not publicly stated').trim().slice(0, 220),
            company_name: (() => {
              const c = String(x.company_name || x.key_contact_or_firm || 'Not publicly stated').trim().slice(0, 180);
              return PLATFORM_PROVIDER_RE.test(c) ? 'Not publicly stated' : c;
            })(),
            permit_or_record_id: String(x.permit_or_record_id || 'Not publicly stated').trim().slice(0, 120),
            status_or_phase: String(x.status_or_phase || 'Not publicly stated').trim().slice(0, 120),
            estimated_value_usd: String(x.estimated_value_usd || 'Not publicly stated').trim().slice(0, 120),
            key_contact_or_firm: (() => {
              const k = String(x.key_contact_or_firm || 'Not publicly stated').trim().slice(0, 180);
              return PLATFORM_PROVIDER_RE.test(k) ? 'Not publicly stated' : k;
            })(),
            why_opportunity: String(x.why_opportunity || '').trim().slice(0, 360) || 'Potentially relevant source from quick search.',
            evidence: String(x.evidence || x.why_opportunity || '').trim().slice(0, 300) || 'Row-level evidence from public API.',
            recommended_next_step: String(x.recommended_next_step || 'Open source and confirm permit/project table columns before outreach.').trim().slice(0, 220),
            source_title: String(x.source_title || apiRows[i]?.source_title || 'Source').trim().slice(0, 180),
            source_url: safeUrl,
            missing_fields: String(x.missing_fields || '').trim().slice(0, 220) || 'Some sales fields still need validation from source.',
            data_completeness: completeness
          };
        })
        .slice(0, 3);
      if (mappedApi.length) return mappedApi;
      if (hasApiPivotSource) return [];
    } catch (e) {
      logger.warn(`autoLeadQuickLeads api-first: ${e.message}`);
      if (hasApiPivotSource) return [];
    }
  }

  const prompt =
    'Return ONLY JSON with this shape: {"leads":[{"lead_title":"","project_name":"","project_snapshot":"","location":"","address":"","company_name":"","permit_or_record_id":"","status_or_phase":"","estimated_value_usd":"","key_contact_or_firm":"","why_opportunity":"","evidence":"","recommended_next_step":"","source_title":"","source_url":"","missing_fields":"","data_completeness":""}]}\n' +
    'Create exactly 3 concise but client-ready opportunities from these source snippets.\n' +
    'project_snapshot must be a short 4-12 word summary of the specific project.\n' +
    'Try to include a real company_name from the snippet/title/domain context when possible.\n' +
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
          project_snapshot: String(x.project_snapshot || x.why_opportunity || x.project_name || '').trim().slice(0, 120) || 'Project details need verification from source',
          location: String(x.location || 'Unknown').trim().slice(0, 140),
          address: String(x.address || 'Not publicly stated').trim().slice(0, 220),
          company_name: (() => {
            const c = String(x.company_name || x.key_contact_or_firm || 'Not publicly stated').trim().slice(0, 180);
            return PLATFORM_PROVIDER_RE.test(c) ? 'Not publicly stated' : c;
          })(),
          permit_or_record_id: String(x.permit_or_record_id || 'Not publicly stated').trim().slice(0, 120),
          status_or_phase: String(x.status_or_phase || 'Not publicly stated').trim().slice(0, 120),
          estimated_value_usd: String(x.estimated_value_usd || 'Not publicly stated').trim().slice(0, 120),
          key_contact_or_firm: (() => {
            const k = String(x.key_contact_or_firm || 'Not publicly stated').trim().slice(0, 180);
            return PLATFORM_PROVIDER_RE.test(k) ? 'Not publicly stated' : k;
          })(),
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
    return hasApiPivotSource ? [] : src.slice(0, 3).map((s, i) => fallbackLeadFromSource(s, i));
  } catch (e) {
    logger.warn(`autoLeadQuickLeads: ${e.message}`);
    return hasApiPivotSource ? [] : src.slice(0, 3).map((s, i) => fallbackLeadFromSource(s, i));
  }
}

module.exports = { buildAutoLeadQuickLeads };

