/**
 * When Serper returns a portal/catalog HTML page, extract embedded dataset/API URLs
 * (ArcGIS Hub, Socrata resource links, FeatureServer) for a second open-data fetch pass.
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { getGlobalAxiosProxyOpts } = require('../engine/axiosProxy');

const TIMEOUT = 18000;
const MAX_URLS = 12;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function cleanHref(raw) {
  return String(raw || '')
    .replace(/^["']+|["']+$/g, '')
    .replace(/[),.;]+$/g, '')
    .split(/["'\s<>]/)[0];
}

/**
 * @param {string} portalUrl
 * @returns {Promise<string[]>} Absolute dataset/API URLs, best-effort deduped
 */
async function discoverEmbeddedDatasetUrls(portalUrl) {
  const base = String(portalUrl || '').trim();
  if (!/^https?:\/\//i.test(base)) return [];

  const axiosOpts = {
    timeout: TIMEOUT,
    maxRedirects: 5,
    validateStatus: s => s >= 200 && s < 400,
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    ...getGlobalAxiosProxyOpts()
  };

  let html = '';
  try {
    const res = await axios.get(base, axiosOpts);
    html = typeof res.data === 'string' ? res.data : String(res.data || '');
  } catch (e) {
    logger.debug(`[portalExpand] GET failed ${base.slice(0, 72)}: ${e.message}`);
    return [];
  }

  const found = new Set();

  const urlRe = /https?:\/\/[^\s"'<>]+/gi;
  let m;
  while ((m = urlRe.exec(html)) !== null) {
    let href = cleanHref(m[0]);
    if (!href.startsWith('http')) continue;
    href = href.split(/[)\]}]/)[0];
    const noQuery = href.split('?')[0];

    if (/hub\.arcgis\.com\/datasets\/[a-f0-9]{32}/i.test(href)) {
      found.add(noQuery.replace(/\/$/, ''));
      continue;
    }
    if (/\/resource\/[0-9a-z]{4}-[0-9a-z]{4}/i.test(href)) {
      found.add(noQuery.replace(/\/$/, ''));
      continue;
    }
    if (/\/dataset\/[^/]+\/[0-9a-z]{4}-[0-9a-z]{4}/i.test(href)) {
      found.add(noQuery.replace(/\/$/, ''));
      continue;
    }
    if (/rest\/services\/.+\/FeatureServer\/\d+/i.test(href)) {
      found.add(noQuery.replace(/\/$/, ''));
    }
  }

  const list = [...found].filter(u => u !== base.split('?')[0].replace(/\/$/, ''));
  const out = list.slice(0, MAX_URLS);
  if (out.length) {
    logger.info(`[portalExpand] ${base.slice(0, 64)}… → ${out.length} embedded API/dataset link(s)`);
  }
  return out;
}

module.exports = { discoverEmbeddedDatasetUrls };
