/**
 * Google search results via Serper.dev (official API — no scraping google.com).
 * Get key: https://serper.dev — set SERPER_API_KEY in .env
 */

const axios = require('axios');
const logger = require('../utils/logger');

function hasSerper() {
  return !!(process.env.SERPER_API_KEY && String(process.env.SERPER_API_KEY).trim());
}

/**
 * @param {string} query
 * @param {{ num?: number }} [opts]
 * @returns {Promise<Array<{ title: string, link: string, snippet: string }>>}
 */
async function googleSearchOrganic(query, opts = {}) {
  const key = process.env.SERPER_API_KEY;
  if (!key || !String(key).trim()) {
    throw new Error('SERPER_API_KEY is not set — add it to .env to use Google-backed discovery (https://serper.dev)');
  }
  const q = String(query || '').trim();
  if (!q) return [];

  const num = Math.min(Math.max(parseInt(opts.num || 10, 10) || 10, 1), 20);

  const { data } = await axios.post(
    'https://google.serper.dev/search',
    { q, num },
    {
      headers: {
        'X-API-KEY': key.trim(),
        'Content-Type': 'application/json'
      },
      timeout: 20000,
      validateStatus: s => s < 500
    }
  );

  if (data?.message && typeof data.message === 'string' && data.organic == null) {
    logger.warn(`[Serper] ${data.message}`);
    throw new Error(data.message);
  }

  const organic = Array.isArray(data?.organic) ? data.organic : [];
  return organic
    .map(o => ({
      title: String(o.title || '').trim(),
      link: String(o.link || o.url || '').trim(),
      snippet: String(o.snippet || '').trim()
    }))
    .filter(r => r.link && /^https?:\/\//i.test(r.link));
}

function normalizeUrlKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'gclid', 'fbclid'].forEach(p =>
      u.searchParams.delete(p)
    );
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, '') || ''}`;
  } catch {
    return url;
  }
}

/**
 * Dedupe by host+path; keep first occurrence (usually higher rank).
 * @param {Array<{ link: string, title?: string, snippet?: string }>} rows
 */
function dedupeSearchResults(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = normalizeUrlKey(r.link);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  hasSerper,
  googleSearchOrganic,
  dedupeSearchResults,
  normalizeUrlKey,
  sleep
};
