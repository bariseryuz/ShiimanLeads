/**
 * Engine Adapter: ArcGIS / FeatureServer
 * Builds where clause and query params; returns array of attribute objects.
 */

const axios = require('axios');
const hydrator = require('../hydrator');
const { mergeRequestHeaders } = require('../requestDefaults');
const logger = require('../../utils/logger');

/**
 * Build where clause from rules array if manifest has rules; else use manifest.where_clause.
 * Prefer manifest.where_clause for complex SQL (LIKE, OR, nested logic); use rules only for simple AND equalities.
 * @param {Object} manifest - { where_clause: "1=1" } or { rules: [ { field, api_field, operator, value } ] }
 * @returns {string} SQL-like where clause
 */
function buildWhereClause(manifest) {
  if (manifest.where_clause) return manifest.where_clause;
  const rules = manifest.rules;
  if (!rules || rules.length === 0) return '1=1';
  return rules
    .map(r => {
      const field = r.api_field || r.field;
      const op = r.operator;
      const val = r.value;
      if (op === 'equals' || op === '==') return `${field} = '${String(val).replace(/'/g, "''")}'`;
      if (op === '>') return `${field} > ${Number(val)}`;
      if (op === '<') return `${field} < ${Number(val)}`;
      if (op === '>=') return `${field} >= ${Number(val)}`;
      if (op === '<=') return `${field} <= ${Number(val)}`;
      return `${field} = '${String(val).replace(/'/g, "''")}'`;
    })
    .join(' AND ');
}

/**
 * @param {string} url - ArcGIS query URL (e.g. .../FeatureServer/0/query or .../query)
 * @param {Object} manifest - { where_clause?, rules?, query_params?, limit? }
 * @returns {Array} Raw records (attributes or flat objects)
 */
async function fetch(url, manifest) {
  try {
    let queryUrl = url.replace(/\/$/, '');
    if (!queryUrl.includes('/query')) queryUrl += '/query';

    const where = buildWhereClause(manifest);
    const params = hydrator({
      f: 'json',
      outFields: '*',
      where,
      resultRecordCount: manifest.limit || 1000,
      ...(manifest.query_params || {})
    });

    const effectiveLimit = Math.max(parseInt(params.resultRecordCount, 10) || 1000, 1);
    const headers = mergeRequestHeaders(manifest, queryUrl);

    const response = await axios.get(queryUrl, { params, headers, timeout: 90000 });
    const data = response.data;

    if (data?.features && Array.isArray(data.features)) {
      const rows = data.features.map(f => f.attributes || f);
      if (rows.length > 0 && rows.length === effectiveLimit) {
        logger.warn(
          `[Engine ArcGIS Adapter] Warning: Data likely capped (${rows.length} features === resultRecordCount ${effectiveLimit}). ` +
            `Use type "legacy_arcgis" for full pagination, or split with where_clause / date ranges.`
        );
      }
      return rows;
    }
    if (Array.isArray(data)) return data;
    return [];
  } catch (err) {
    logger.error(`[Engine ArcGIS Adapter] ${err.message}`);
    return [];
  }
}

module.exports = { fetch, buildWhereClause };
