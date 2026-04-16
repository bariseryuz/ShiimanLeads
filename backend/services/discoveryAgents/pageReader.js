'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../../utils/logger');
const { getGlobalAxiosProxyOpts } = require('../../engine/axiosProxy');

const TIMEOUT = 12000;
const MAX_TEXT_LEN = 6000;

const STRIP_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'iframe', 'nav', 'footer',
  'header', 'aside', 'form', 'button', 'select', 'option'
]);

function htmlToCleanText(html) {
  const $ = cheerio.load(html);
  STRIP_TAGS.forEach(tag => $(tag).remove());
  $('[style*="display:none"], [style*="display: none"], [hidden]').remove();

  const text = $('body').text() || $.root().text();
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_LEN);
}

async function readPageText(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    const res = await axios.get(u, {
      timeout: TIMEOUT,
      maxRedirects: 3,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      validateStatus: s => s >= 200 && s < 400,
      responseType: 'text',
      ...getGlobalAxiosProxyOpts()
    });
    const ct = String(res.headers['content-type'] || '');
    if (!ct.includes('html') && !ct.includes('text')) return null;
    const raw = typeof res.data === 'string' ? res.data : String(res.data || '');
    if (raw.length < 100) return null;
    return htmlToCleanText(raw);
  } catch (e) {
    logger.debug(`[pageReader] ${u.slice(0, 80)}: ${e.message}`);
    return null;
  }
}

async function readMultiplePages(sources, maxPages = 3) {
  const results = [];
  const urls = (Array.isArray(sources) ? sources : [])
    .map(s => ({ url: String(s?.url || '').trim(), title: String(s?.title || 'Source').slice(0, 160) }))
    .filter(s => /^https?:\/\//i.test(s.url))
    .slice(0, maxPages);

  const settled = await Promise.allSettled(
    urls.map(s => readPageText(s.url))
  );
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    const text = r.status === 'fulfilled' ? r.value : null;
    if (text && text.length > 80) {
      results.push({
        url: urls[i].url,
        title: urls[i].title,
        text: text
      });
    }
  }
  return results;
}

module.exports = { readPageText, readMultiplePages, htmlToCleanText };
