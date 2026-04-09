/**
 * Discovery "Start monitoring" should use REST/JSON for API URLs, not Playwright + screenshots.
 * @see routes/discover.js POST /monitor
 */

const { parseSocrataResource } = require('./openDataDirectSample');

/**
 * Ensure .../FeatureServer/N or .../MapServer/N exists so ArcGIS /query works.
 * @param {string} url
 * @returns {string}
 */
function normalizeArcGisServiceUrl(url) {
  let u = String(url || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(u)) return u;
  if (/\/FeatureServer$/i.test(u)) return `${u}/0`;
  if (/\/MapServer$/i.test(u)) return `${u}/0`;
  return u;
}

/**
 * @param {string} rawUrl
 * @returns {{ url: string, sourceData: Record<string, unknown>, mode: 'arcgis'|'json'|'playwright' }}
 */
function inferMonitorSourceFromUrl(rawUrl) {
  const original = String(rawUrl || '').trim();
  const url = original;
  const lower = url.toLowerCase();

  const looksArcgisRest =
    /\/featureserver\/\d+/i.test(url) ||
    /\/mapserver\/\d+/i.test(url) ||
    /\/featureserver\/?$/i.test(url) ||
    /\/mapserver\/?$/i.test(url) ||
    (lower.includes('/rest/services/') && (lower.includes('featureserver') || lower.includes('mapserver')));

  if (looksArcgisRest) {
    const normalized = normalizeArcGisServiceUrl(url);
    return {
      url: normalized,
      mode: 'arcgis',
      sourceData: {
        type: 'arcgis',
        method: 'json',
        usePlaywright: false,
        useAI: false,
        where_clause: '1=1',
        limit: 2000,
        discoveryInferredMode: 'arcgis_rest'
      }
    };
  }

  const soc = parseSocrataResource(url);
  if (soc) {
    const jsonUrl = `https://${soc.host}/resource/${soc.resourceId}.json`;
    return {
      url: jsonUrl,
      mode: 'json',
      sourceData: {
        type: 'json',
        method: 'json',
        usePlaywright: false,
        useAI: false,
        query_params: { $limit: 1000 },
        discoveryInferredMode: 'socrata_json'
      }
    };
  }

  return {
    url: original,
    mode: 'playwright',
    sourceData: {
      method: 'playwright',
      usePlaywright: true,
      useAI: true,
      discoveryInferredMode: 'playwright_vision'
    }
  };
}

module.exports = { inferMonitorSourceFromUrl, normalizeArcGisServiceUrl };
