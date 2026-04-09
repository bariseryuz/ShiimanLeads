/**
 * Agent B — READ: open-data / ArcGIS cheap paths, then Playwright deep extract.
 * Uses manifest from Agent C so the browser knows what columns to fill.
 */

const logger = require('../../utils/logger');
const { tryArcgisSampleRows } = require('../ai/nlLeadIntent');
const { runExtractNowForUrl } = require('../discoverExtractRun');
const { fetchOpenDataSampleRows } = require('../openDataDirectSample');
const { discoverEmbeddedDatasetUrls } = require('../portalDatasetDiscovery');
const { sortUrls } = require('../candidateUrlSort');
const { runAgentVerifyFilterBatch } = require('./agentVerifyShape');
const { AGENT_READ } = require('./agentConstants');

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

/**
 * @param {{
 *   brief: string,
 *   userId: number,
 *   req: import('express').Request,
 *   manifest: object,
 *   candidates: Array<{ url: string, title?: string }>,
 *   maxLeads: number,
 *   maxSites: number
 * }} opts
 * @returns {Promise<{ collected: object[], urlsAttempted: string[] }>}
 */
async function runAgentRead(opts) {
  const b = String(opts.brief || '').trim();
  const manifest = opts.manifest;
  const candidates = opts.candidates || [];
  const maxLeads = opts.maxLeads;
  const maxSites = opts.maxSites;

  const collected = [];
  const urlsAttempted = [];

  const perUrlBudget = Math.max(5, Math.ceil(maxLeads / maxSites));

  logger.info(`[agent:${AGENT_READ}] start — up to ${maxSites} primary URL(s), manifest-driven extract`);

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
            logger.info(`[agent:${AGENT_READ}] portal expand → ${innerUrl.slice(0, 90)}`);
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
                logger.info(`[agent:${AGENT_READ}] portal expand ArcGIS REST ${innerUrl.slice(0, 90)}`);
                break;
              }
            } catch (e) {
              logger.debug(`[agent:${AGENT_READ}] expand ArcGIS ${innerUrl.slice(0, 50)}: ${e.message}`);
            }
          }
        }
      }
      if (directRows && directRows.length) {
        const { leads: filtered, applied } = await runAgentVerifyFilterBatch(
          b,
          manifest.strict_match_rules,
          directRows
        );
        const slice = (filtered && filtered.length ? filtered : directRows).slice(0, perUrlBudget);
        for (const row of slice) {
          collected.push(row);
          if (collected.length >= maxLeads) break;
        }
        logger.info(`[agent:${AGENT_READ}] open-data ${url.slice(0, 72)} → ${slice.length} rows (filter ${applied})`);
        if (collected.length >= maxLeads) break;
        continue;
      }
    } catch (e) {
      logger.warn(`[agent:${AGENT_READ}] open-data direct ${url.slice(0, 60)}: ${e.message}`);
    }

    if (/featureserver\/\d+|\/mapserver\//i.test(url)) {
      try {
        const n = Math.min(maxLeads - collected.length, 25, perUrlBudget);
        const arcRows = await tryArcgisSampleRows(url, Math.max(n, 5));
        if (arcRows && arcRows.length) {
          const { leads: filtered, applied } = await runAgentVerifyFilterBatch(
            b,
            manifest.strict_match_rules,
            arcRows
          );
          const slice = (filtered && filtered.length ? filtered : arcRows).slice(0, perUrlBudget);
          for (const row of slice) {
            collected.push(row);
            if (collected.length >= maxLeads) break;
          }
          logger.info(`[agent:${AGENT_READ}] ArcGIS ${url.slice(0, 80)} → ${slice.length} rows (filter ${applied})`);
        }
      } catch (e) {
        logger.warn(`[agent:${AGENT_READ}] ArcGIS failed ${url}: ${e.message}`);
      }
      continue;
    }

    if (isCatalogStubUrl(url)) {
      logger.info(`[agent:${AGENT_READ}] skip Playwright for catalog/map stub ${url.slice(0, 90)}`);
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
      logger.info(`[agent:${AGENT_READ}] browser extract ${url.slice(0, 80)} → ${(out.leads || []).length} rows`);
    } catch (e) {
      logger.warn(`[agent:${AGENT_READ}] browser extract failed ${url}: ${e.message}`);
    }
  }

  if (collected.length === 0 && candidates.length > maxSites) {
    const extra = candidates.slice(maxSites, Math.min(maxSites + 5, candidates.length));
    logger.info(`[agent:${AGENT_READ}] second pass — ${extra.length} extra URL(s) (browser only)`);
    for (const c of extra) {
      if (collected.length >= maxLeads) break;
      const url = c.url;
      urlsAttempted.push(url);
      if (isCatalogStubUrl(url)) continue;
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
        logger.info(`[agent:${AGENT_READ}] second-pass browser ${url.slice(0, 80)} → ${(out.leads || []).length} rows`);
      } catch (e) {
        logger.warn(`[agent:${AGENT_READ}] second-pass browser failed ${url}: ${e.message}`);
      }
    }
  }

  logger.info(`[agent:${AGENT_READ}] done — ${collected.length} row(s) collected`);
  return { collected, urlsAttempted };
}

module.exports = { runAgentRead };
