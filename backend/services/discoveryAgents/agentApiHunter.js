/**
 * API-Hunter — second pass when Read returns zero rows: exhaust embedded JSON/Socrata/ArcGIS
 * before giving up (no duplicate browser extract here — Read already tried Playwright).
 * Optional Serper site: probes for FeatureServer / Socrata / resource URLs on the same host.
 */

const logger = require('../../utils/logger');
const { tryArcgisSampleRows } = require('../ai/nlLeadIntent');
const { fetchOpenDataSampleRows } = require('../openDataDirectSample');
const { discoverEmbeddedDatasetUrls } = require('../portalDatasetDiscovery');
const { sortUrls } = require('../candidateUrlSort');
const { runAgentVerifyFilterBatch } = require('./agentVerifyShape');
const { googleSearchOrganic, hasSerper, sleep } = require('../serperSearch');

const PERMIT_SIGNAL_RE =
  /curtain\s*wall|glazing|glass|window|shade|blind|interior\s*build|fenestration|storefront|curtainwall/i;

function rowTextBlob(row) {
  try {
    return JSON.stringify(row || {}).toLowerCase();
  } catch {
    return '';
  }
}

function rowMatchesPermitSignals(row) {
  return PERMIT_SIGNAL_RE.test(rowTextBlob(row));
}

/**
 * @param {string} host
 * @param {string} geography
 * @returns {Promise<string[]>}
 */
async function discoverApiUrlsViaSerper(host, geography) {
  if (!hasSerper() || !host) return [];
  const q = `site:${host} (FeatureServer OR MapServer OR Socrata OR /resource/ OR "f=json") ${geography || ''}`.slice(
    0,
    240
  );
  try {
    const rows = await googleSearchOrganic(q, { num: 8 });
    return rows.map(r => r.link).filter(u => typeof u === 'string' && /^https?:\/\//i.test(u));
  } catch (e) {
    logger.warn(`[agent:api_hunter] Serper site probe ${host}: ${e.message}`);
    return [];
  }
}

/**
 * @param {{
 *   brief: string,
 *   manifest: object,
 *   candidates: Array<{ url: string, title?: string }>,
 *   maxLeads: number,
 *   maxSites: number,
 *   intent?: object
 * }} opts
 * @returns {Promise<{ collected: object[], urlsAttempted: string[] }>}
 */
async function runAgentApiHunter(opts) {
  const brief = String(opts.brief || '').trim();
  const manifest = opts.manifest;
  const candidates = opts.candidates || [];
  const maxLeads = opts.maxLeads;
  const maxSites = Math.min(12, Math.max(1, parseInt(opts.maxSites, 10) || 8));
  const intent = opts.intent && typeof opts.intent === 'object' ? opts.intent : {};
  const geo = String(intent.geography || '').trim();
  const odcOpts = {};
  if (intent.min_project_value_usd != null && Number.isFinite(Number(intent.min_project_value_usd))) {
    odcOpts.minValuationUsd = Number(intent.min_project_value_usd);
  }

  const collected = [];
  const urlsAttempted = [];
  const perUrlBudget = Math.max(6, Math.ceil(maxLeads / Math.max(1, maxSites)));

  logger.info(`[agent:api_hunter] stubborn JSON pass — up to ${maxSites} portal(s), embedded + site: Serper`);

  const hostsSeen = new Set();

  for (const c of candidates.slice(0, maxSites)) {
    if (collected.length >= maxLeads) break;
    const url = c.url;
    urlsAttempted.push(url);

    let inner = sortUrls(await discoverEmbeddedDatasetUrls(url));

    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      if (!hostsSeen.has(host) && hostsSeen.size < 3) {
        hostsSeen.add(host);
        const extra = await discoverApiUrlsViaSerper(host, geo);
        inner = [...new Set([...inner, ...extra])].slice(0, 28);
        await sleep(400);
      }
    } catch {
      /* invalid URL */
    }

    for (const innerUrl of inner) {
      if (collected.length >= maxLeads) break;
      urlsAttempted.push(innerUrl);

      let directRows = await fetchOpenDataSampleRows(innerUrl, Math.min(perUrlBudget, 28), odcOpts);
      if (!directRows?.length && /featureserver|mapserver/i.test(innerUrl)) {
        try {
          directRows = await tryArcgisSampleRows(innerUrl, Math.min(perUrlBudget, 28));
        } catch (e) {
          logger.debug(`[agent:api_hunter] ArcGIS ${innerUrl.slice(0, 50)}: ${e.message}`);
        }
      }
      if (!directRows?.length) continue;

      const { leads: filtered } = await runAgentVerifyFilterBatch(brief, manifest.strict_match_rules, directRows);
      let slice = filtered && filtered.length ? filtered : directRows;
      slice = slice.slice(0, perUrlBudget);

      if (!slice.length && directRows.length) {
        const sig = directRows.filter(rowMatchesPermitSignals);
        if (sig.length) {
          slice = sig.slice(0, 10);
          logger.info(`[agent:api_hunter] permit-trade signal fallback (${slice.length} rows)`);
        }
      }

      for (const row of slice) {
        collected.push(row);
        if (collected.length >= maxLeads) break;
      }
      if (collected.length >= maxLeads) break;
    }
  }

  logger.info(`[agent:api_hunter] done — ${collected.length} row(s)`);
  return { collected, urlsAttempted };
}

module.exports = { runAgentApiHunter };
