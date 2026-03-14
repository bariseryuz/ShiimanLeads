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
    const params = hydrator(manifest.query_params || manifest.params || {});
    const headers = manifest.headers || { 'User-Agent': 'Mozilla/5.0 (compatible; ShiimanLeads/1.0)', 'Content-Type': 'application/json' };
    const method = (manifest.method || 'GET').toUpperCase();
    let response;

    if (method === 'POST') {
      const bodyRaw = manifest.body !== undefined ? manifest.body : params;
      const body = typeof bodyRaw === 'string' ? JSON.parse(bodyRaw) : hydrator(bodyRaw);
      response = await axios.post(url, body, { headers, timeout: 60000 });
    } else {
      response = await axios.get(url, { params, headers, timeout: 60000 });
    }

    const data = response.data;
    if (Array.isArray(data)) return data;
    if (data?.results) return data.results;
    if (data?.items) return data.items;
    if (data?.data && Array.isArray(data.data)) return data.data;
    if (data?.Data && Array.isArray(data.Data)) return data.Data;
    if (data?.features && Array.isArray(data.features)) {
      return data.features.map(f => f.attributes || f);
    }
    if (data?.Errors && data.Errors.length) {
      logger.warn(`[Engine REST Adapter] API returned errors: ${JSON.stringify(data.Errors)}`);
    }
    logger.warn(`[Engine REST Adapter] No array found in response (status ${response.status}). Keys: ${Object.keys(data || {}).join(', ')}`);
    return [];
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    logger.error(`[Engine REST Adapter] ${err.message}${status ? ` (HTTP ${status})` : ''}`);
    if (body && typeof body === 'object') logger.error(`[Engine REST Adapter] Response: ${JSON.stringify(body).slice(0, 300)}`);
    return [];
  }
}

module.exports = { fetch };
