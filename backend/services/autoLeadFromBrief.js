/**
 * Primary flow: user types lead details only → search → pick URLs → fetch rows (ArcGIS cheap path or Playwright).
 * Manual URL / strategy discovery remains optional elsewhere.
 */

const logger = require('../utils/logger');
const { runNlLeadIntentDiscovery, tryArcgisSampleRows } = require('./ai/nlLeadIntent');
const { buildManifestFromBrief } = require('./ai/deepExtractManifest');
const { filterLeadsToBrief } = require('./ai/deepExtractFilter');
const { runExtractNowForUrl } = require('./discoverExtractRun');
const { fetchOpenDataSampleRows } = require('./openDataDirectSample');
const { discoverEmbeddedDatasetUrls } = require('./portalDatasetDiscovery');
const { sortCandidateSources, sortUrls } = require('./candidateUrlSort');

function isCatalogStubUrl(url) {
  try {
    const p = new URL(String(url)).pathname.toLowerCase();
    if (p.includes('/datasets/') && p.endsWith('/about')) return true;
    if (p.includes('hub.arcgis.com') && p.includes('/maps/')) return true;
    return false;
  } catch {
    return false;
  }
}

function dedupeLeads(rows, maxLeads) {
  const seen = new Set();
  const out = [];
  for (const L of rows) {
    if (!L || typeof L !== 'object') continue;
    const sig = JSON.stringify(L).slice(0, 2500);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(L);
    if (out.length >= maxLeads) break;
  }
  return out;
}

/**
 * @param {{ userId: number, brief: string, req: import('express').Request, maxLeads?: number, maxSites?: number }} opts
 */
async function fetchLeadsFromBriefOnly(opts) {
  const b = String(opts.brief || '').trim();
  if (b.length < 12) {
    throw new Error('Describe the leads you want (location, record type, filters) in at least one sentence.');
  }

  const maxLeads = Math.min(50, Math.max(1, parseInt(opts.maxLeads, 10) || 15));
  const maxSites = Math.min(5, Math.max(1, parseInt(opts.maxSites, 10) || 3));

  const discovery = await runNlLeadIntentDiscovery(b);
  const candidates = sortCandidateSources(discovery.candidate_sources || []);

  if (!candidates.length) {
    return {
      success: true,
      mode: 'auto_leads',
      intent: discovery.intent,
      search_queries_used: discovery.search_queries_used,
      results_pooled: discovery.results_pooled,
      candidate_sources: [],
      urls_attempted: [],
      leads: [],
      field_schema: null,
      strict_match_rules: null,
      strict_filter_applied: false,
      note:
        discovery.preview_note ||
        'No candidate URLs from search. Set SERPER_API_KEY and try a more specific location or record type.',
      preview_note: discovery.preview_note,
      disclaimer: discovery.disclaimer
    };
  }

  const manifest = await buildManifestFromBrief(b);
  const collected = [];
  const urlsAttempted = [];

  const perUrlBudget = Math.max(5, Math.ceil(maxLeads / maxSites));

  for (const c of candidates.slice(0, maxSites)) {
    if (collected.length >= maxLeads) break;
    const url = c.url;
    urlsAttempted.push(url);

    try {
      const n = Math.min(maxLeads - collected.length, 25, perUrlBudget);
      const need = Math.max(n, 5);
      let directRows = await fetchOpenDataSampleRows(url, need);
      if (!directRows?.length) {
        const inner = sortUrls(await discoverEmbeddedDatasetUrls(url));
        for (const innerUrl of inner) {
          directRows = await fetchOpenDataSampleRows(innerUrl, need);
          if (directRows?.length) {
            urlsAttempted.push(innerUrl);
            logger.info(`auto-leads: portal expand → ${innerUrl.slice(0, 90)}`);
            break;
          }
        }
        if (!directRows?.length) {
          for (const innerUrl of inner) {
            if (!/featureserver\/\d+|\/mapserver\//i.test(innerUrl)) continue;
            try {
              const arcRows = await tryArcgisSampleRows(innerUrl, need);
              if (arcRows?.length) {
                directRows = arcRows;
                urlsAttempted.push(innerUrl);
                logger.info(`auto-leads: portal expand ArcGIS REST ${innerUrl.slice(0, 90)}`);
                break;
              }
            } catch (e) {
              logger.debug(`auto-leads expand ArcGIS ${innerUrl.slice(0, 50)}: ${e.message}`);
            }
          }
        }
      }
      if (directRows && directRows.length) {
        const { leads: filtered, applied } = await filterLeadsToBrief(b, manifest.strict_match_rules, directRows);
        const slice = (filtered && filtered.length ? filtered : directRows).slice(0, perUrlBudget);
        for (const row of slice) {
          collected.push(row);
          if (collected.length >= maxLeads) break;
        }
        logger.info(`auto-leads: open-data API ${url.slice(0, 72)} → ${slice.length} rows (filter ${applied})`);
        if (collected.length >= maxLeads) break;
        continue;
      }
    } catch (e) {
      logger.warn(`auto-leads open-data direct ${url.slice(0, 60)}: ${e.message}`);
    }

    if (/featureserver\/\d+|\/mapserver\//i.test(url)) {
      try {
        const n = Math.min(maxLeads - collected.length, 25, perUrlBudget);
        const arcRows = await tryArcgisSampleRows(url, Math.max(n, 5));
        if (arcRows && arcRows.length) {
          const { leads: filtered, applied } = await filterLeadsToBrief(b, manifest.strict_match_rules, arcRows);
          const slice = (filtered && filtered.length ? filtered : arcRows).slice(0, perUrlBudget);
          for (const row of slice) {
            collected.push(row);
            if (collected.length >= maxLeads) break;
          }
          logger.info(`auto-leads: ArcGIS sample from ${url.slice(0, 80)} → ${slice.length} rows (filter ${applied})`);
        }
      } catch (e) {
        logger.warn(`auto-leads ArcGIS failed ${url}: ${e.message}`);
      }
      continue;
    }

    if (isCatalogStubUrl(url)) {
      logger.info(`auto-leads: skip Playwright for catalog/map stub ${url.slice(0, 90)}`);
      continue;
    }

    try {
      const out = await runExtractNowForUrl({
        userId: opts.userId,
        brief: b,
        url,
        maxLeads: Math.min(perUrlBudget, maxLeads - collected.length),
        deleteAfter: true,
        req: opts.req,
        manifest
      });
      for (const row of out.leads || []) {
        collected.push(row);
        if (collected.length >= maxLeads) break;
      }
      logger.info(`auto-leads: browser extract ${url.slice(0, 80)} → ${(out.leads || []).length} rows`);
    } catch (e) {
      logger.warn(`auto-leads browser extract failed ${url}: ${e.message}`);
    }
  }

  const leads = dedupeLeads(collected, maxLeads);

  const note = !leads.length && urlsAttempted.length
    ? 'Search ran but no rows were extracted. Try different wording, or use “Extract to my format” on a specific URL.'
    : null;

  return {
    success: true,
    mode: 'auto_leads',
    intent: discovery.intent,
    search_queries_used: discovery.search_queries_used,
    results_pooled: discovery.results_pooled,
    candidate_sources: candidates,
    urls_attempted: urlsAttempted,
    leads,
    field_schema: manifest.field_schema,
    strict_match_rules: manifest.strict_match_rules,
    strict_filter_applied: true,
    note,
    preview_note: discovery.preview_note,
    disclaimer: discovery.disclaimer
  };
}

module.exports = { fetchLeadsFromBriefOnly };
