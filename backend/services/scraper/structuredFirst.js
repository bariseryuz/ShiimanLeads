/**
 * Structured-first extraction: network JSON → JSON-LD → DOM tables.
 * Vision/screenshots are a last resort (handled in legacyScraper).
 */

const logger = require('../../utils/logger');
const { extractRecordsFromApiResponse } = require('./apiInterceptor');

const SKIP_URL_SUBSTR = [
  'google-analytics',
  'googletagmanager',
  'doubleclick',
  'facebook.net',
  'hotjar',
  '/cdn-cgi/',
  '.woff',
  '.woff2',
  '.ttf',
  '.map',
  '/static/js/',
  'favicon',
  'chrome-extension'
];

function shouldConsiderUrl(url) {
  const u = String(url || '').toLowerCase();
  if (!u.startsWith('http')) return false;
  for (const s of SKIP_URL_SUBSTR) {
    if (u.includes(s)) return false;
  }
  return true;
}

function createStructuredCaptureState() {
  return {
    batches: [],
    responseCount: 0,
    maxResponses: 64,
    maxBodyChars: 500_000
  };
}

/**
 * Attach before page.goto. Collects JSON bodies that look like record sets.
 * @param {import('playwright').Page} page
 * @param {ReturnType<typeof createStructuredCaptureState>} state
 */
function looksLikeJsonEndpointUrl(url) {
  const u = String(url || '').toLowerCase();
  return (
    /\.json(\?|$)/i.test(u) ||
    /\/resource\/[0-9a-z]{4}-[0-9a-z]{4}/i.test(u) ||
    /[?&]f=json\b/i.test(u) ||
    /featureserver\/\d+\/\d+\/query/i.test(u) ||
    /\/query\?/i.test(u) ||
    /\/api\/v[0-9]\//i.test(u)
  );
}

function attachStructuredJsonListener(page, state) {
  page.on('response', async response => {
    if (state.responseCount >= state.maxResponses) return;
    try {
      const url = response.url();
      if (!shouldConsiderUrl(url)) return;
      const status = response.status();
      if (status < 200 || status >= 300) return;
      const ct = (response.headers()['content-type'] || '').toLowerCase();
      const maybeJson =
        ct.includes('json') ||
        ct.includes('javascript') ||
        ct.includes('geo+json') ||
        (ct.includes('text/plain') && looksLikeJsonEndpointUrl(url)) ||
        looksLikeJsonEndpointUrl(url);

      if (!maybeJson) return;

      state.responseCount++;
      const text = await response.text();
      if (!text || text.length > state.maxBodyChars) return;

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return;
      }

      const records = extractRecordsFromApiResponse(data);
      if (records && records.length > 0) {
        state.batches.push({ url: url.slice(0, 200), records });
        logger.info(`   📦 Structured-first: ${records.length} rows from JSON (${url.slice(-60)})`);
      }
    } catch {
      /* ignore */
    }
  });
}

function flattenAndDedupeRecordBatches(batches, maxRows) {
  const seen = new Set();
  const out = [];
  for (const batch of batches) {
    for (const r of batch.records) {
      if (!r || typeof r !== 'object') continue;
      const flat = { ...r };
      const key = JSON.stringify(flat).slice(0, 2000);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(flat);
      if (out.length >= maxRows) return out;
    }
  }
  return out;
}

function coerceRecordToSchema(raw, schemaKeys) {
  if (!schemaKeys || !schemaKeys.length) return raw;
  const out = {};
  const keys = Object.keys(raw);
  for (const sk of schemaKeys) {
    const lower = sk.toLowerCase();
    const hit =
      keys.find(k => k.toLowerCase() === lower) ||
      keys.find(k => k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()));
    const v = hit != null ? raw[hit] : null;
    out[sk] = v !== undefined && v !== null ? v : null;
  }
  return out;
}

/**
 * JSON-LD ItemList, typed entities, @graph.
 */
function extractJsonLdInPage() {
  const out = [];

  function flattenThing(o) {
    if (!o || typeof o !== 'object') return {};
    const row = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === '@type') row[k] = v;
      else if (k.startsWith('@')) continue;
      else if (v != null && typeof v === 'object' && !Array.isArray(v)) row[k] = JSON.stringify(v).slice(0, 500);
      else row[k] = v;
    }
    return row;
  }

  function walk(node) {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object') return;
    if (node['@graph'] && Array.isArray(node['@graph'])) {
      node['@graph'].forEach(walk);
      return;
    }
    if (node['@type'] === 'ItemList' && Array.isArray(node.itemListElement)) {
      for (const el of node.itemListElement) {
        const ent = el && el.item ? el.item : el;
        if (ent && typeof ent === 'object') out.push(flattenThing(ent));
      }
      return;
    }
    if (node['@type']) out.push(flattenThing(node));
  }

  document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    try {
      walk(JSON.parse(s.textContent || 'null'));
    } catch {
      /* skip */
    }
  });
  return out;
}

/**
 * Heuristic: largest table with header row (includes tables inside open shadow roots — ArcGIS / modern portals).
 */
function extractLargestTableInPage() {
  function collectTables(root) {
    const out = [];
    if (!root || !root.querySelectorAll) return out;
    root.querySelectorAll('table').forEach(t => out.push(t));
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) out.push(...collectTables(el.shadowRoot));
    });
    return out;
  }
  const tables = collectTables(document);
  let best = null;
  let bestScore = 0;
  for (const t of tables) {
    const trs = t.querySelectorAll('tr');
    if (trs.length < 2) continue;
    const ths = t.querySelectorAll('th');
    const score = trs.length * Math.max(1, ths.length || 4);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  if (!best) return [];

  const rows = Array.from(best.querySelectorAll('tr'));
  const headerCells = rows[0].querySelectorAll('th, td');
  const headers = Array.from(headerCells)
    .map(c => (c.innerText || '').trim())
    .map((h, i) => h || `col_${i}`);

  const data = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r].querySelectorAll('td, th');
    if (!cells.length) continue;
    const obj = {};
    let nonempty = 0;
    for (let i = 0; i < headers.length; i++) {
      const key = headers[i].replace(/\s+/g, '_').toLowerCase().slice(0, 64) || `col_${i}`;
      const val = (cells[i] && cells[i].innerText) ? cells[i].innerText.trim().slice(0, 2000) : '';
      if (val) nonempty++;
      obj[key] = val || null;
    }
    if (nonempty >= 2) data.push(obj);
  }
  return data;
}

/**
 * @param {import('playwright').Page} page
 * @param {ReturnType<typeof createStructuredCaptureState>} state
 * @param {{ fieldSchema?: Record<string,string>, maxRows: number }} opts
 */
async function collectStructuredRecords(page, state, opts) {
  const maxRows = Math.max(1, Math.min(opts.maxRows || 100, 500));
  const schemaKeys = opts.fieldSchema ? Object.keys(opts.fieldSchema) : null;

  const fromNetwork = flattenAndDedupeRecordBatches(state.batches, maxRows);

  let jsonLd = [];
  let domRows = [];
  try {
    jsonLd = await page.evaluate(extractJsonLdInPage);
  } catch (e) {
    logger.warn(`   Structured-first JSON-LD: ${e.message}`);
  }
  try {
    domRows = await page.evaluate(extractLargestTableInPage);
  } catch (e) {
    logger.warn(`   Structured-first DOM table: ${e.message}`);
  }

  const merged = [];
  const seen = new Set();

  function pushUnique(rec, source) {
    if (!rec || typeof rec !== 'object') return;
    const normalized = schemaKeys ? coerceRecordToSchema(rec, schemaKeys) : { ...rec };
    const sig = JSON.stringify(normalized).slice(0, 2500);
    if (seen.has(sig)) return;
    seen.add(sig);
    merged.push({ ...normalized, _structured_source: source });
    return merged.length >= maxRows;
  }

  for (const r of fromNetwork) {
    if (pushUnique(r, 'network_json')) break;
  }
  for (const r of jsonLd) {
    if (!r || typeof r !== 'object') continue;
    if (pushUnique(r, 'json_ld')) break;
  }
  for (const r of domRows) {
    if (pushUnique(r, 'dom_table')) break;
  }

  const strip = merged.map(({ _structured_source, ...rest }) => rest);

  const sources = {
    network: fromNetwork.length,
    json_ld: jsonLd.length,
    dom_table: domRows.length,
    merged: strip.length
  };
  logger.info(`   📊 Structured-first summary: network=${sources.network} json-ld=${sources.json_ld} dom=${sources.dom_table} → merged=${sources.merged}`);

  return { records: strip, sources };
}

/**
 * If we got structured rows, skip expensive vision unless user opted out.
 */
function shouldFallbackToVision(source, structuredRowCount) {
  if (!source.useAI) return false;
  if (source.structuredFirst === false) return true;
  if (structuredRowCount > 0) {
    logger.info('   ✅ Structured-first produced rows — skipping vision/screenshot extraction for this source');
    return false;
  }
  logger.info('   📷 Structured-first found 0 rows — falling back to vision extraction');
  return true;
}

module.exports = {
  createStructuredCaptureState,
  attachStructuredJsonListener,
  collectStructuredRecords,
  shouldFallbackToVision,
  coerceRecordToSchema
};
