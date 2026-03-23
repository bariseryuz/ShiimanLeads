/**
 * Engine Adapter: REST / JSON API
 * Fetches data via HTTP with query params. Params can use {{TODAY}}, {{DAYS_AGO_30}}, etc.
 */

const axios = require('axios');
const hydrator = require('../hydrator');
const hydrateString = typeof hydrator.hydrateString === 'function' ? hydrator.hydrateString : (s) => s;
const logger = require('../../utils/logger');

const TIMEOUT_MS = Math.min(
  Math.max(parseInt(process.env.REST_ADAPTER_TIMEOUT_MS || '120000', 10) || 120000, 5000),
  600000
);

function mergeHeaders(manifest) {
  return {
    'User-Agent': 'Mozilla/5.0 (compatible; ShiimanLeads/1.0)',
    ...(manifest.headers && typeof manifest.headers === 'object' ? manifest.headers : {}),
  };
}

/** Flat object → application/x-www-form-urlencoded (nested values JSON-stringified). */
function objectToUrlEncodedString(obj) {
  const flat = hydrator({ ...(obj || {}) });
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(flat)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      p.append(k, JSON.stringify(v));
    } else {
      p.append(k, String(v));
    }
  }
  return p.toString();
}

/**
 * @param {string} url - Full API URL (e.g. https://api.example.com/search)
 * @param {Object} manifest - { query_params, params, method, body, headers, post_body_format }
 * @returns {Array} Raw items (response.data.results || response.data.items || response.data or array)
 */
async function fetch(url, manifest) {
  try {
    const params = hydrator(manifest.query_params || manifest.params || {});
    const mergedHeaders = mergeHeaders(manifest);
    const method = (manifest.method || 'GET').toUpperCase();
    let response;

    const safeUrl = (url || '').slice(0, 160);
    logger.info(`[Engine REST Adapter] ${method} ${safeUrl}${(url || '').length > 160 ? '…' : ''} (timeout ${TIMEOUT_MS}ms)`);

    if (method === 'POST') {
      const postFmt = String(manifest.post_body_format || manifest.postBodyFormat || 'json').toLowerCase();
      const ct = mergedHeaders['Content-Type'] || mergedHeaders['content-type'] || '';
      const isForm =
        postFmt === 'form' ||
        postFmt === 'urlencoded' ||
        postFmt === 'application/x-www-form-urlencoded' ||
        String(ct).toLowerCase().includes('x-www-form-urlencoded');

      logger.info(
        `[Engine REST Adapter] POST encoding: ${isForm ? 'form-urlencoded' : 'json'} (source post_body_format=${manifest.post_body_format || 'json'})`
      );

      if (isForm) {
        if (!mergedHeaders['Content-Type'] && !mergedHeaders['content-type']) {
          mergedHeaders['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        }
        if (mergedHeaders['content-type']) delete mergedHeaders['content-type'];

        let bodyPayload;
        if (manifest.body !== undefined && manifest.body !== null) {
          if (typeof manifest.body === 'string') {
            bodyPayload = hydrateString(manifest.body);
          } else if (typeof manifest.body === 'object') {
            bodyPayload = objectToUrlEncodedString(manifest.body);
          } else {
            bodyPayload = String(manifest.body);
          }
        } else {
          bodyPayload = objectToUrlEncodedString(params);
        }

        if (!bodyPayload || !String(bodyPayload).trim()) {
          logger.warn(
            `[Engine REST Adapter] POST (form) body is empty — paste Payload from DevTools (same as browser: application/x-www-form-urlencoded).`
          );
        } else {
          const s = String(bodyPayload);
          logger.info(`[Engine REST Adapter] POST (form) body length=${s.length} preview=${s.slice(0, 140)}${s.length > 140 ? '…' : ''}`);
        }

        response = await axios.post(url, bodyPayload, { headers: mergedHeaders, timeout: TIMEOUT_MS });
      } else {
        const bodyRaw = manifest.body !== undefined ? manifest.body : params;
        let body;
        if (typeof bodyRaw === 'string') {
          body = JSON.parse(bodyRaw);
        } else {
          body = hydrator(bodyRaw);
        }
        if (
          body &&
          typeof body === 'object' &&
          !Array.isArray(body) &&
          Object.keys(body).length === 0
        ) {
          logger.warn(
            `[Engine REST Adapter] POST body is {} using JSON encoding — server will return no rows. ` +
              `Phoenix/ASP.NET endpoints use form data: open the source in My Sources → set "POST body format" to Form URL-encoded → paste the Payload string from DevTools. ` +
              `If you already use JSON APIs (ArcGIS), paste JSON into Query Parameters or POST body.`
          );
        }
        if (!mergedHeaders['Content-Type'] && !mergedHeaders['content-type']) {
          mergedHeaders['Content-Type'] = 'application/json';
        }
        response = await axios.post(url, body, { headers: mergedHeaders, timeout: TIMEOUT_MS });
      }
    } else {
      response = await axios.get(url, { params, headers: mergedHeaders, timeout: TIMEOUT_MS });
    }

    const data = response.data;
    if (Array.isArray(data)) return data;
    if (data?.results) return data.results;
    if (data?.items) return data.items;
    if (data?.data && Array.isArray(data.data)) return data.data;
    if (data?.Data && Array.isArray(data.Data)) return data.Data;
    // DataTables / legacy ASP.NET grids
    if (data?.aaData && Array.isArray(data.aaData)) return data.aaData;
    if (data?.rows && Array.isArray(data.rows)) return data.rows;
    if (data?.features && Array.isArray(data.features)) {
      return data.features.map(f => f.attributes || f);
    }
    // ArcGIS REST / GeoServices error payload (HTTP 200 with { error: { code, message, details } })
    if (data?.error) {
      const e = data.error;
      const code = e && typeof e === 'object' && e.code != null ? ` code=${e.code}` : '';
      const msg =
        e && typeof e === 'object' && e.message != null
          ? String(e.message)
          : typeof e === 'string'
            ? e
            : JSON.stringify(e);
      const details =
        e && typeof e === 'object' && e.details != null
          ? ` details=${JSON.stringify(e.details).slice(0, 500)}`
          : '';
      logger.error(`[Engine REST Adapter] ArcGIS/API error${code}: ${msg}${details}`);
      return [];
    }
    if (data?.Errors && data.Errors.length) {
      logger.warn(`[Engine REST Adapter] API returned errors: ${JSON.stringify(data.Errors)}`);
    }
    logger.warn(`[Engine REST Adapter] No array found in response (status ${response.status}). Keys: ${Object.keys(data || {}).join(', ')}`);
    return [];
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    const isTimeout =
      err.code === 'ECONNABORTED' ||
      err.code === 'ETIMEDOUT' ||
      /timeout/i.test(err.message || '');
    if (isTimeout) {
      logger.error(
        `[Engine REST Adapter] TIMEOUT after ${TIMEOUT_MS}ms — usually NOT a "needs more seconds" problem. City/portal URLs often hang or never answer this client until you use the real API (ArcGIS/open data), POST + exact browser body, or AI Website Scraper. Only raise REST_ADAPTER_TIMEOUT_MS for endpoints that are known-slow but correct.`
      );
    } else {
      logger.error(`[Engine REST Adapter] ${err.message}${status ? ` (HTTP ${status})` : ''}${err.code ? ` [code=${err.code}]` : ''}`);
    }
    if (body && typeof body === 'object') logger.error(`[Engine REST Adapter] Response: ${JSON.stringify(body).slice(0, 300)}`);
    return [];
  }
}

module.exports = { fetch };
