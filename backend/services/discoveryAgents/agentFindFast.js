/**
 * Fast scout for quick-only mode.
 * Goal: return candidate source snippets quickly (no deep query expansion, no browser).
 */

const { hasSerper, googleSearchOrganic, dedupeSearchResults, normalizeUrlKey } = require('../serperSearch');
const { sortCandidateSources } = require('../candidateUrlSort');

function buildFastQueries(brief) {
  const b = String(brief || '').trim().replace(/\s+/g, ' ');
  if (!b) return [];
  return [
    `${b} permits OR construction projects OR open data`,
    `${b} site:gov permits OR data portal`
  ].map(q => q.slice(0, 220));
}

function isLowSignalArticle(link, title) {
  const u = String(link || '').toLowerCase();
  const t = String(title || '').toLowerCase();
  if (/medium\.com|substack\.com|wordpress|blogspot|wixsite/.test(u)) return true;
  if (/\.pdf($|\?)/.test(u)) return true;
  if (/\/(report|whitepaper|ebook|brochure)\//.test(u)) return true;
  if (/\/(blog|news|article|guide|insight|press-release)\//.test(u)) return true;
  if (/(guide|cost per sq ft|how to|tips|market report|quarterly report|pipeline report)/.test(t)) return true;
  return false;
}

async function runAgentFindFast(brief) {
  const queries = buildFastQueries(brief);
  if (!hasSerper() || !queries.length) {
    return {
      intent: { mode: 'fast' },
      search_queries_used: [],
      results_pooled: 0,
      candidate_sources: [],
      preview_note: 'Fast mode needs SERPER_API_KEY.',
      disclaimer: 'Quick mode uses search snippets and may be incomplete.'
    };
  }

  const maxCalls = Math.min(2, parseInt(process.env.AUTO_LEADS_FAST_SERPER_CALLS || '2', 10) || 2);
  const all = [];
  for (let i = 0; i < Math.min(maxCalls, queries.length); i++) {
    const rows = await googleSearchOrganic(queries[i], { num: 8 }).catch(() => []);
    rows.forEach(r => all.push({ ...r, sourceQuery: queries[i] }));
  }

  const deduped = dedupeSearchResults(all)
    .filter(r => /^https?:\/\//i.test(String(r.link || '')))
    .filter(r => !isLowSignalArticle(r.link, r.title));

  const uniqByUrl = new Map();
  for (const r of deduped) {
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
    intent: { mode: 'fast' },
    search_queries_used: queries.slice(0, Math.min(maxCalls, queries.length)),
    results_pooled: deduped.length,
    candidate_sources,
    preview_note: candidate_sources.length ? null : 'Fast scout found weak sources; try adding city/state + permit type.',
    disclaimer: 'Quick mode is a fast read from search snippets; use full extract for validated row-level data.'
  };
}

module.exports = { runAgentFindFast };

