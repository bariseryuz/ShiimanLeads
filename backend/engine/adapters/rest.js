/**
 * Engine Adapter: REST / JSON API
 * Fetches data via HTTP with query params. Params can use {{TODAY}}, {{DAYS_AGO_30}}, etc.
 */

const axios = require('axios');
const hydrator = require('../hydrator');
const hydrateString = typeof hydrator.hydrateString === 'function' ? hydrator.hydrateString : s => s;
const { mergeRequestHeaders } = require('../requestDefaults');
const { extractRowsFromApiJson } = require('../jsonResponseRows');
const logger = require('../../utils/logger');

const TIMEOUT_MS = Math.min(
  Math.max(parseInt(process.env.REST_ADAPTER_TIMEOUT_MS || '120000', 10) || 120000, 5000),
  600000
);

const PROBE_TIMEOUT_MS = Math.min(
  Math.max(parseInt(process.env.REST_PROBE_TIMEOUT_MS || '15000', 10) || 15000, 3000),
  120000
);

function warnIfLikelyCapped(rowCount, manifest) {
  const cap = Math.max(parseInt(manifest.limit, 10) || 1000, 1);
  if (rowCount > 0 && rowCount === cap) {
    logger.warn(
      `[Engine REST Adapter] Warning: Data likely capped (${rowCount} rows === limit ${cap}). ` +
        `If the dataset is larger, raise "limit", add pagination params, or use legacy_arcgis / Playwright for full coverage.`
    );
  }
}

function returnRows(rows, manifest) {
  const list = Array.isArray(rows) ? rows : [];
  warnIfLikelyCapped(list.length, manifest);
  return list;
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
 * Low-level HTTP execution (used by fetch and endpoint probing). Does not parse rows or log per-request errors.
 * @param {string} url
 * @param {Object} manifest
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function executeRestRequest(url, manifest, opts = {}) {
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : TIMEOUT_MS;
  const params = hydrator(manifest.query_params || manifest.params || {});
  const mergedHeaders = mergeRequestHeaders(manifest, url);
  const method = (manifest.method || 'GET').toUpperCase();

  if (method === 'POST') {
    const postFmt = String(manifest.post_body_format || manifest.postBodyFormat || 'json').toLowerCase();
    const ct = mergedHeaders['Content-Type'] || mergedHeaders['content-type'] || '';
    const isForm =
      postFmt === 'form' ||
      postFmt === 'urlencoded' ||
      postFmt === 'application/x-www-form-urlencoded' ||
      String(ct).toLowerCase().includes('x-www-form-urlencoded');

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

      return axios.post(url, bodyPayload, { headers: mergedHeaders, timeout: timeoutMs });
    }

    const bodyRaw = manifest.body !== undefined ? manifest.body : params;
    let body;
    if (typeof bodyRaw === 'string') {
      body = JSON.parse(bodyRaw);
    } else {
      body = hydrator(bodyRaw);
    }
    if (!mergedHeaders['Content-Type'] && !mergedHeaders['content-type']) {
      mergedHeaders['Content-Type'] = 'application/json';
    }
    return axios.post(url, body, { headers: mergedHeaders, timeout: timeoutMs });
  }

  return axios.get(url, { params, headers: mergedHeaders, timeout: timeoutMs });
}

/**
 * Silent row-count probe for endpoint discovery (short timeout, no error spam).
 * @returns {Promise<{ rowCount: number, data?: * }>}
 */
async function probeRowCount(url, manifest) {
  try {
    const response = await executeRestRequest(url, manifest, { timeoutMs: PROBE_TIMEOUT_MS });
    const data = response.data;
    if (data && typeof data === 'object' && data.error) {
      return { rowCount: 0, data };
    }
    const rows = extractRowsFromApiJson(data);
    return { rowCount: rows.length, data };
  } catch {
    return { rowCount: 0 };
  }
}

/**
 * @param {string} url - Full API URL (e.g. https://api.example.com/search)
 * @param {Object} manifest - { query_params, params, method, body, headers, post_body_format }
 * @returns {Array} Raw items (response.data.results || response.data.items || response.data or array)
 */
async function fetch(url, manifest) {
  try {
    const mergedHeaders = mergeRequestHeaders(manifest, url);
    const method = (manifest.method || 'GET').toUpperCase();
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
          bodyPayload = objectToUrlEncodedString(hydrator(manifest.query_params || manifest.params || {}));
        }

        if (!bodyPayload || !String(bodyPayload).trim()) {
          logger.warn(
            `[Engine REST Adapter] POST (form) body is empty — paste Payload from DevTools (same as browser: application/x-www-form-urlencoded).`
          );
        } else {
          const s = String(bodyPayload);
          logger.info(`[Engine REST Adapter] POST (form) body length=${s.length} preview=${s.slice(0, 140)}${s.length > 140 ? '…' : ''}`);
        }
      } else {
        const bodyRaw = manifest.body !== undefined ? manifest.body : hydrator(manifest.query_params || manifest.params || {});
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
      }
    }

    const response = await executeRestRequest(url, manifest);
    const data = response.data;

    if (Array.isArray(data)) {
      warnIfLikelyCapped(data.length, manifest);
      return data;
    }

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

    const rows = extractRowsFromApiJson(data);
    if (rows.length > 0) {
      return returnRows(rows, manifest);
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

module.exports = { fetch, executeRestRequest, probeRowCount };
