/**
 * Engine Adapter: REST / JSON API
 * Fetches data via HTTP with query params. Params can use {{TODAY}}, {{DAYS_AGO_30}}, etc.
 */

const axios = require('axios');
const hydrator = require('../hydrator');
const logger = require('../../utils/logger');

/**
 * @param {string} url - Full API URL (e.g. https://api.example.com/search)
 * @param {Object} manifest - { query_params: { min_price: "{{DAYS_AGO_30}}", ... }, ... }
 * @returns {Array} Raw items (response.data.results || response.data.items || response.data or array)
 */
async function fetch(url, manifest) {
  try {
    const params = hydrator(manifest.query_params || {});
    const headers = manifest.headers || { 'User-Agent': 'Mozilla/5.0 (compatible; ShiimanLeads/1.0)' };
    const response = await axios.get(url, { params, headers, timeout: 60000 });

    const data = response.data;
    if (Array.isArray(data)) return data;
    if (data?.results) return data.results;
    if (data?.items) return data.items;
    if (data?.data && Array.isArray(data.data)) return data.data;
    if (data?.features && Array.isArray(data.features)) {
      return data.features.map(f => f.attributes || f);
    }
    return [];
  } catch (err) {
    logger.error(`[Engine REST Adapter] ${err.message}`);
    return [];
  }
}

module.exports = { fetch };
