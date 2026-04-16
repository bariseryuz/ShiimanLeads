/**
 * Fetch tabular rows from public open-data APIs without a browser:
 * - Socrata / Socrata partner (resource id in URL)
 * - ArcGIS Online item id (32 hex) → FeatureServer /query — from Hub dataset URLs or embedded UUIDs
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { ensureArcGISFeatureLayerQueryUrl } = require('../engine/adapters/rest');
const { getGlobalAxiosProxyOpts } = require('../engine/axiosProxy');

const TIMEOUT = 22000;
const SOCRATA_DATE_FIELDS = [
  'registration_date',
  'filed_date',
  'created_date',
  'issue_date',
  'permit_issued_date',
  'updated_at'
];

/**
 * @param {string} pageUrl
 * @returns {{ host: string, resourceId: string } | null}
 */
function parseSocrataResource(pageUrl) {
  try {
    const raw = String(pageUrl || '');
    const foundry = raw.match(
      /dev\.socrata\.com\/foundry\/([^/?#\s]+)\/([0-9a-z]{4}-[0-9a-z]{4})/i
    );
    if (foundry) {
      let dataHost = String(foundry[1] || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .split('/')[0]
        .toLowerCase();
      if (dataHost) {
        return { host: dataHost, resourceId: foundry[2] };
      }
    }

    const u = new URL(pageUrl);
    const host = u.hostname;
    let m = pageUrl.match(/\/dataset\/[^/]+\/([0-9a-z]{4}-[0-9a-z]{4})/i);
    if (!m) m = pageUrl.match(/\/resource\/([0-9a-z]{4}-[0-9a-z]{4})/i);
    if (!m) m = pageUrl.match(/\/([0-9a-z]{4}-[0-9a-z]{4})(?:\?|$|\/|\.json)/i);
    if (!m) return null;
    const likelySocrataApi =
      /socrata\.com$/i.test(host) ||
      host.includes('socrata') ||
      /^data\.[a-z0-9.-]+\.(gov|org)$/i.test(host) ||
      /\.opendata\.[a-z0-9.-]+\.(gov|org)$/i.test(host) ||
      /^opendata\.[a-z0-9.-]+\.(gov|org)$/i.test(host);
    if (!likelySocrataApi) return null;
    return { host, resourceId: m[1] };
  } catch {
    return null;
  }
}

/**
 * ArcGIS Hub dataset URL: .../datasets/{32hex}_{layer}
 */
function parseHubDatasetItemId(pageUrl) {
  const m = String(pageUrl).match(/datasets\/([a-f0-9]{32})(?:_(\d+))?(?:\/|$|\?)/i);
  if (!m) return null;
  return { itemId: m[1], layerIndex: m[2] != null ? parseInt(m[2], 10) : 0 };
}

async function fetchSocrataSample(host, resourceId, limit, opts = {}) {
  const base = `https://${host}`;
  const api = `${base.replace(/\/$/, '')}/resource/${resourceId}.json`;
  const searchText = String(opts.searchText || '').trim();
  const latestFirst = opts.latestFirst !== false;
  const baseParams = {
    $limit: limit
  };
  if (searchText) baseParams.$q = searchText.slice(0, 80);

  const orderCandidates = latestFirst ? [...SOCRATA_DATE_FIELDS, null] : [null];
  for (const orderField of orderCandidates) {
    try {
      const params = { ...baseParams };
      if (orderField) params.$order = `${orderField} DESC`;
      const res = await axios.get(api, {
        params,
        timeout: TIMEOUT,
        validateStatus: s => s === 200,
        ...getGlobalAxiosProxyOpts()
      });
      if (Array.isArray(res.data) && res.data.length) {
        return res.data.slice(0, limit);
      }
    } catch (e) {
      logger.debug(`[openDataDirect] Socrata sample order ${String(orderField || 'none')}: ${e.message}`);
    }
  }
  return null;
}

/** Common Socrata valuation / job-value field names — try SoQL $where when user wants commercial floor (e.g. > $299k). */
const SOCRATA_VALUE_FIELDS = [
  'valuation',
  'permit_valuation',
  'est_valuation',
  'estimated_cost',
  'job_value',
  'total_valuation',
  'declared_valuation',
  'construction_value',
  'project_value'
];

/**
 * @param {string} host
 * @param {string} resourceId
 * @param {number} limit
 * @param {number} minUsd
 * @returns {Promise<object[]|null>}
 */
async function fetchSocrataSampleMinValuation(host, resourceId, limit, minUsd, opts = {}) {
  const base = `https://${host}`;
  const api = `${base.replace(/\/$/, '')}/resource/${resourceId}.json`;
  const n = Number(minUsd);
  const searchText = String(opts.searchText || '').trim();
  const latestFirst = opts.latestFirst !== false;
  if (!Number.isFinite(n) || n <= 0) return null;
  const orderCandidates = latestFirst ? SOCRATA_DATE_FIELDS : [null];
  for (const field of SOCRATA_VALUE_FIELDS) {
    for (const orderField of orderCandidates) {
      try {
        const params = {
          $limit: limit,
          $where: `${field} > ${Math.floor(n)}`
        };
        if (searchText) params.$q = searchText.slice(0, 80);
        if (orderField) params.$order = `${orderField} DESC`;
        const res = await axios.get(api, {
          params,
          timeout: TIMEOUT,
          validateStatus: s => s === 200,
          ...getGlobalAxiosProxyOpts()
        });
        if (Array.isArray(res.data) && res.data.length) {
          logger.info(
            `[openDataDirect] Socrata $where ${field} > ${n}${searchText ? ` + $q "${searchText.slice(0, 30)}"` : ''} → ${res.data.length} rows`
          );
          return res.data.slice(0, limit);
        }
      } catch (e) {
        logger.debug(`[openDataDirect] Socrata where ${field} / order ${String(orderField || 'none')}: ${e.message}`);
      }
    }
  }
  return null;
}

/**
 * Item JSON → service URL → layer → /query
 */
async function fetchRowsFromArcgisItemId(itemId, layerIndex = 0, limit = 15) {
  const itemUrl = `https://www.arcgis.com/sharing/rest/content/items/${itemId}?f=json`;
  const ir = await axios.get(itemUrl, { timeout: TIMEOUT, validateStatus: () => true });
  const item = ir.data;
  if (!item || item.error) {
    logger.warn(`[openDataDirect] item ${itemId}: ${JSON.stringify(item?.error || {}).slice(0, 100)}`);
    return null;
  }

  let serviceUrl = item.url;
  if (!serviceUrl || typeof serviceUrl !== 'string') return null;
  serviceUrl = serviceUrl.replace(/\/?$/, '');

  if (/\/FeatureServer\/\d+$/i.test(serviceUrl)) {
    serviceUrl = serviceUrl.replace(/FeatureServer\/\d+$/i, `FeatureServer/${layerIndex}`);
  } else if (/\/FeatureServer$/i.test(serviceUrl)) {
    serviceUrl = `${serviceUrl}/${layerIndex}`;
  } else {
    return null;
  }

  const queryUrl = ensureArcGISFeatureLayerQueryUrl(serviceUrl);
  const qr = await axios.get(queryUrl, {
    params: {
      f: 'json',
      where: '1=1',
      outFields: '*',
      returnGeometry: false,
      resultRecordCount: limit
    },
    timeout: TIMEOUT,
    validateStatus: () => true,
    ...getGlobalAxiosProxyOpts()
  });
  const data = qr.data;
  if (data?.error) {
    logger.warn(`[openDataDirect] query: ${JSON.stringify(data.error).slice(0, 200)}`);
    return null;
  }
  const features = Array.isArray(data?.features) ? data.features : [];
  return features.slice(0, limit).map(f => f.attributes || {});
}

async function fetchHubDatasetSample(pageUrl, limit) {
  const parsed = parseHubDatasetItemId(pageUrl);
  if (!parsed) return null;
  return fetchRowsFromArcgisItemId(parsed.itemId, parsed.layerIndex, limit);
}

/**
 * Any URL that contains datasets/UUID or a standalone 32-hex item id (e.g. in query string).
 */
function tryParseItemIdFromUrl(pageUrl) {
  const hub = parseHubDatasetItemId(pageUrl);
  if (hub) return hub;
  const m = String(pageUrl).match(/([a-f0-9]{32})(?:_(\d+))?(?:\/|$|\?|&)/i);
  if (!m) return null;
  return { itemId: m[1], layerIndex: m[2] != null ? parseInt(m[2], 10) : 0 };
}

/**
 * @param {string} pageUrl
 * @param {number} maxRows
 * @param {{ minValuationUsd?: number, searchText?: string, latestFirst?: boolean }} [opts]
 * @returns {Promise<object[]|null>}
 */
async function fetchOpenDataSampleRows(pageUrl, maxRows = 15, opts = {}) {
  const limit = Math.min(Math.max(maxRows, 1), 50);
  const url = String(pageUrl || '').trim();
  const minVal = opts && opts.minValuationUsd != null ? Number(opts.minValuationUsd) : null;
  const searchText = String(opts?.searchText || '').trim();
  const latestFirst = opts?.latestFirst !== false;

  const soc = parseSocrataResource(url);
  if (soc) {
    try {
      let rows = await fetchSocrataSample(soc.host, soc.resourceId, limit);
      if ((!rows || !rows.length) && minVal != null && Number.isFinite(minVal) && minVal > 0) {
        rows = await fetchSocrataSampleMinValuation(soc.host, soc.resourceId, limit, minVal, {
          searchText,
          latestFirst
        });
      }
      if ((!rows || !rows.length) && (searchText || latestFirst)) {
        rows = await fetchSocrataSample(soc.host, soc.resourceId, limit, {
          searchText,
          latestFirst
        });
      }
      if (rows?.length) {
        logger.info(`[openDataDirect] Socrata ${soc.resourceId} → ${rows.length} rows`);
        return rows;
      }
    } catch (e) {
      logger.warn(`[openDataDirect] Socrata failed: ${e.message}`);
    }
  }

  try {
    const hubRows = await fetchHubDatasetSample(url, limit);
    if (hubRows?.length) {
      logger.info(`[openDataDirect] Hub path → ${hubRows.length} rows`);
      return hubRows;
    }
  } catch (e) {
    logger.warn(`[openDataDirect] Hub path failed: ${e.message}`);
  }

  return null;
}

module.exports = {
  fetchOpenDataSampleRows,
  parseSocrataResource,
  parseHubDatasetItemId,
  tryParseItemIdFromUrl,
  fetchRowsFromArcgisItemId,
  fetchSocrataSampleMinValuation
};
