/**
 * Fetch tabular rows from public open-data APIs without a browser:
 * - Socrata / Socrata partner (resource id in URL)
 * - ArcGIS Online item id (32 hex) → FeatureServer /query — from Hub dataset URLs or embedded UUIDs
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { ensureArcGISFeatureLayerQueryUrl } = require('../engine/adapters/rest');

const TIMEOUT = 22000;

/**
 * @param {string} pageUrl
 * @returns {{ host: string, resourceId: string } | null}
 */
function parseSocrataResource(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const host = u.hostname;
    if (!/socrata\.com$/i.test(host) && !host.includes('socrata')) return null;

    let m = pageUrl.match(/\/dataset\/[^/]+\/([0-9a-z]{4}-[0-9a-z]{4})/i);
    if (!m) m = pageUrl.match(/\/resource\/([0-9a-z]{4}-[0-9a-z]{4})/i);
    if (!m) m = pageUrl.match(/\/([0-9a-z]{4}-[0-9a-z]{4})(?:\?|$|\/)/i);
    if (!m) return null;
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

async function fetchSocrataSample(host, resourceId, limit) {
  const base = `https://${host}`;
  const api = `${base.replace(/\/$/, '')}/resource/${resourceId}.json`;
  const res = await axios.get(api, {
    params: { $limit: limit },
    timeout: TIMEOUT,
    validateStatus: s => s === 200
  });
  if (!Array.isArray(res.data)) return null;
  return res.data.slice(0, limit);
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
    validateStatus: () => true
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
 * @returns {Promise<object[]|null>}
 */
async function fetchOpenDataSampleRows(pageUrl, maxRows = 15) {
  const limit = Math.min(Math.max(maxRows, 1), 50);
  const url = String(pageUrl || '').trim();

  const soc = parseSocrataResource(url);
  if (soc) {
    try {
      const rows = await fetchSocrataSample(soc.host, soc.resourceId, limit);
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
  fetchRowsFromArcgisItemId
};
