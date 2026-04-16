/**
 * Fast scout for quick-only mode.
 * Goal: return candidate source snippets quickly (no deep query expansion, no browser).
 */

const { hasSerper, googleSearchOrganic, dedupeSearchResults, normalizeUrlKey } = require('../serperSearch');
const { sortCandidateSources } = require('../candidateUrlSort');
const { parseBriefWithGemini, buildSerperQueries, buildMachineParameters } = require('../ai/nlLeadIntent');

function fallbackIntentFromBrief(brief) {
  const b = String(brief || '').trim();
  const NUMBER_WORDS = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10
  };
  const minMatch = b.match(/(?:over|above|>=?)\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)(?:\s*(k|m|million))?/i);
  let minVal = null;
  if (minMatch) {
    const raw = parseFloat(String(minMatch[1] || '').replace(/,/g, ''));
    const unit = String(minMatch[2] || '').toLowerCase();
    if (Number.isFinite(raw)) {
      minVal = /m|million/.test(unit) ? raw * 1000000 : /k/.test(unit) ? raw * 1000 : raw;
    }
  }
  const countDigitMatch = b.match(/\b(?:find|give|get|show|return)\s+(\d{1,2})\b/i) || b.match(/\b(\d{1,2})\s+leads?\b/i);
  const countWordMatch = b.match(/\b(?:find|give|get|show|return)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/i) ||
    b.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+leads?\b/i);
  const requestedLeadCount = countDigitMatch
    ? parseInt(countDigitMatch[1], 10)
    : (countWordMatch ? NUMBER_WORDS[String(countWordMatch[1]).toLowerCase()] : null);
  const st = b.match(/\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY|DC)\b/i);
  return {
    lead_count: Math.min(25, Math.max(1, requestedLeadCount || 3)),
    geography: st ? `United States (${String(st[1]).toUpperCase()})` : 'United States',
    geography_kind: st ? 'state' : 'unknown',
    state_code: st ? String(st[1]).toUpperCase() : '',
    asset_or_use: '',
    trigger_or_record: /permit/i.test(b) ? 'building permit' : 'construction record',
    min_project_value_usd: minVal,
    wants_contact_info: /contact|owner|contractor|gc|manager|people/i.test(b),
    keywords_for_search: []
  };
}

function buildFastQueries(brief) {
  const b = String(brief || '').trim().replace(/\s+/g, ' ');
  if (!b) return [];
  return [
    `${b} permits OR construction projects OR open data`,
    `${b} site:gov permits OR data portal`
  ].map(q => q.slice(0, 220));
}

function buildFastQueriesFromIntent(intent, brief, opts = {}) {
  const nonTechnical = opts.nonTechnical === true;
  const i = intent && typeof intent === 'object' ? intent : {};
  const geo = String(i.geography || '').trim();
  const trigger = String(i.trigger_or_record || 'building permit').trim();
  const vertical = String(i.asset_or_use || '').trim();
  const minVal = i.min_project_value_usd != null && Number.isFinite(Number(i.min_project_value_usd))
    ? Math.floor(Number(i.min_project_value_usd))
    : null;
  const valToken = minVal ? `>${minVal}` : '';
  const intentQueries = buildSerperQueries(i)
    .map(q => String(q || '').trim())
    .filter(q => q.length > 4);

  const targeted = (nonTechnical
    ? [
        [geo, vertical || 'commercial', 'new construction project', valToken].filter(Boolean).join(' '),
        [geo, trigger, 'site:.gov permit search'].filter(Boolean).join(' '),
        [geo, 'building permits', 'active projects', 'contractor'].filter(Boolean).join(' '),
        [geo, 'construction pipeline', 'development project list'].filter(Boolean).join(' ')
      ]
    : [
        [geo, vertical, trigger, valToken, 'open data API FeatureServer Socrata'].filter(Boolean).join(' '),
        [geo, trigger, 'site:gov data portal json'].filter(Boolean).join(' '),
        [geo, vertical || 'commercial', '"resource" ".json" site:data.*.gov permits valuation'].filter(Boolean).join(' '),
        [geo, '"dev.socrata.com/foundry"', '"resource" ".json"'].filter(Boolean).join(' '),
        [geo, trigger, '"FeatureServer" "query?f=json"'].filter(Boolean).join(' '),
        [geo, trigger, '"Open Data" "JSON API"'].filter(Boolean).join(' ')
      ])
    .map(q => q.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const rawFallback = buildFastQueries(brief);
  return [...new Set([...targeted, ...intentQueries, ...rawFallback])].slice(0, 8).map(q => q.slice(0, 220));
}

function isLowSignalArticle(link, title) {
  const u = String(link || '').toLowerCase();
  const t = String(title || '').toLowerCase();
  if (/medium\.com|substack\.com|wordpress|blogspot|wixsite/.test(u)) return true;
  if (/github\.com|observablehq\.com|npmjs\.com|stackoverflow\.com/.test(u)) return true;
  if (/wikipedia\.org|reddit\.com|quora\.com/.test(u)) return true;
  if (/dev\.socrata\.com\/foundry\//.test(u)) return true;
  if (/\/foundry\//.test(u) && /socrata/.test(u)) return true;
  if (/\/docs?\//.test(u) || /\/documentation\//.test(u) || /\/api\//.test(u) && /(guide|docs|reference)/.test(u)) return true;
  if (/\/about($|[/?#])/.test(u) && /(data\.|opendata|hub\.arcgis)/.test(u)) return true;
  if (/\.pdf($|\?)/.test(u)) return true;
  if (/\/(report|whitepaper|ebook|brochure)\//.test(u)) return true;
  if (/\/(blog|news|article|guide|insight|press-release)\//.test(u)) return true;
  if (/(guide|tutorial|how to|introduction|quickstart|api key|sdk|reference|swagger|cost per sq ft|tips|market report|quarterly report|pipeline report)/.test(t)) return true;
  return false;
}

function hasProjectSignal(result, brief) {
  const blob = `${String(result?.title || '')} ${String(result?.snippet || '')} ${String(result?.link || '')}`.toLowerCase();
  const baseSignals = /\b(project|construction|permit|development|building|contractor|owner|applicant|gc|architect|bid|proposal|issued|active)\b/;
  if (baseSignals.test(blob)) return true;
  const b = String(brief || '').toLowerCase();
  const tokens = b.split(/[^a-z0-9]+/).filter(x => x.length > 3).slice(0, 8);
  return tokens.some(tok => blob.includes(tok));
}

async function runAgentFindFast(brief, opts = {}) {
  const nonTechnical = opts.nonTechnical === true;
  let intent = null;
  try {
    intent = await parseBriefWithGemini(brief);
  } catch (e) {
    intent = fallbackIntentFromBrief(brief);
  }
  const machineParameters = buildMachineParameters(intent);
  const queries = buildFastQueriesFromIntent(intent, brief, { nonTechnical });
  if (!hasSerper() || !queries.length) {
    return {
      intent: { mode: 'fast', ...(intent || {}) },
      machine_parameters: machineParameters,
      search_queries_used: [],
      results_pooled: 0,
      candidate_sources: [],
      preview_note: 'Fast mode needs SERPER_API_KEY.',
      disclaimer: 'Quick mode gives a fast web-style summary and may miss details.'
    };
  }

  const maxCalls = Math.min(5, parseInt(process.env.AUTO_LEADS_FAST_SERPER_CALLS || '5', 10) || 5);
  const useQueries = queries.slice(0, Math.min(maxCalls, queries.length));
  const all = [];
  const results = await Promise.allSettled(
    useQueries.map(q => googleSearchOrganic(q, { num: 8 }))
  );
  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    const q = useQueries[i];
    if (res.status !== 'fulfilled' || !Array.isArray(res.value)) continue;
    for (const r of res.value) {
      all.push({ ...r, sourceQuery: q });
    }
  }

  const deduped = dedupeSearchResults(all)
    .filter(r => /^https?:\/\//i.test(String(r.link || '')))
    .filter(r => !isLowSignalArticle(r.link, r.title));
  const prioritized = nonTechnical
    ? deduped.filter(r => hasProjectSignal(r, brief))
    : deduped;
  const pool = prioritized.length ? prioritized : deduped;

  const uniqByUrl = new Map();
  for (const r of pool) {
    const k = normalizeUrlKey(r.link);
    if (!uniqByUrl.has(k)) uniqByUrl.set(k, r);
  }

  const candidate_sources = sortCandidateSources(
    [...uniqByUrl.values()].slice(0, 8).map(r => ({
      title: r.title || 'Source',
      url: r.link,
      snippet: String(r.snippet || '').slice(0, 400),
      sourceQuery: r.sourceQuery
    }))
  );

  return {
    intent: { mode: 'fast', ...(intent || {}) },
    machine_parameters: machineParameters,
    search_queries_used: useQueries,
    results_pooled: pool.length,
    candidate_sources,
    preview_note: candidate_sources.length ? null : 'Fast scout found weak sources; try adding city/state + permit type.',
    disclaimer: 'Quick mode is a fast, chat-style web summary. Use full extract only when you need strict structured output.'
  };
}

module.exports = { runAgentFindFast };

