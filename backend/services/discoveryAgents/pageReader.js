'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../../utils/logger');
const { getGlobalAxiosProxyOpts } = require('../../engine/axiosProxy');

const TIMEOUT = 12000;
const PLAYWRIGHT_TIMEOUT = 20000;
const MAX_TEXT_LEN = 6000;
const MAX_LINKS = 40;
const MIN_TEXT_OK = 400;

const STRIP_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'iframe', 'nav', 'footer',
  'header', 'aside', 'form', 'button', 'select', 'option'
]);

const JUNK_ANCHOR_RE = /\b(home|login|sign\s*in|sign\s*up|subscribe|cookie|privacy|terms|newsletter|contact|about|blog|menu|search|share|facebook|twitter|instagram|linkedin|youtube|pinterest|tiktok|reddit|whatsapp|email|next|prev|previous|page\s*\d+|\d+)\b/i;

const USE_PLAYWRIGHT = String(process.env.PAGE_READER_USE_PLAYWRIGHT ?? 'true').toLowerCase() !== 'false';
const PLAYWRIGHT_RETRY_REASONS = new Set(['http_403', 'http_429', 'http_503', 'timeout', 'empty_text', 'too_short', 'non_html', 'network_error']);

function resolveUrl(base, href) {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/i.test(u.protocol)) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function extractLinks($, baseUrl) {
  const out = [];
  const seen = new Set();
  $('a[href]').each((_, el) => {
    const href = String($(el).attr('href') || '').trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
    const abs = resolveUrl(baseUrl, href);
    if (!abs) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    const anchor = String($(el).text() || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!anchor) return;
    if (anchor.length < 3) return;
    if (JUNK_ANCHOR_RE.test(anchor) && anchor.length < 24) return;
    out.push({ url: abs, anchor });
    if (out.length >= MAX_LINKS) return false;
  });
  return out;
}

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

function htmlToTextAndLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = extractLinks($, baseUrl);
  STRIP_TAGS.forEach(tag => $(tag).remove());
  $('[style*="display:none"], [style*="display: none"], [hidden]').remove();
  const text = $('body').text() || $.root().text();
  const clean = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_LEN);
  return { text: clean, links };
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

async function readWithAxios(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) {
    return { ok: false, url: u, text: null, links: [], reason: 'invalid_url', via: 'axios' };
  }
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
    if (!ct.includes('html') && !ct.includes('text')) {
      return { ok: false, url: u, text: null, links: [], reason: 'non_html', via: 'axios' };
    }
    const raw = typeof res.data === 'string' ? res.data : String(res.data || '');
    if (raw.length < 100) {
      return { ok: false, url: u, text: null, links: [], reason: 'too_short', via: 'axios' };
    }
    const { text: clean, links } = htmlToTextAndLinks(raw, u);
    if (!clean || clean.length < 80) {
      return { ok: false, url: u, text: null, links: links || [], reason: 'empty_text', via: 'axios' };
    }
    return { ok: true, url: u, text: clean, links: links || [], reason: null, via: 'axios' };
  } catch (e) {
    const msg = String(e && e.message ? e.message : '');
    let reason = 'network_error';
    if (/timeout/i.test(msg)) reason = 'timeout';
    if (e && e.response && e.response.status) reason = `http_${e.response.status}`;
    logger.debug(`[pageReader:axios] ${u.slice(0, 80)}: ${msg}`);
    return { ok: false, url: u, text: null, links: [], reason, via: 'axios' };
  }
}

async function readWithPlaywright(url, { context } = {}) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) {
    return { ok: false, url: u, text: null, links: [], reason: 'invalid_url', via: 'playwright' };
  }
  let ownContext = false;
  let browser = null;
  let ctx = context;
  let page = null;
  try {
    if (!ctx) {
      const { getChromium, getStealthLaunchOptions, getStealthContextOptions, injectStealthScripts } = require('../scraper/stealth');
      browser = await getChromium().launch(getStealthLaunchOptions());
      ctx = await browser.newContext(getStealthContextOptions());
      ownContext = true;
      page = await ctx.newPage();
      await injectStealthScripts(page);
    } else {
      page = await ctx.newPage();
    }
    const response = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_TIMEOUT });
    const status = response ? response.status() : 0;
    if (status && status >= 400) {
      return { ok: false, url: u, text: null, links: [], reason: `http_${status}`, via: 'playwright' };
    }
    try {
      await page.waitForLoadState('networkidle', { timeout: 4000 });
    } catch {
      /* soft wait is optional */
    }
    const html = await page.content();
    if (!html || html.length < 100) {
      return { ok: false, url: u, text: null, links: [], reason: 'too_short', via: 'playwright' };
    }
    const { text: clean, links } = htmlToTextAndLinks(html, u);
    if (!clean || clean.length < 80) {
      return { ok: false, url: u, text: null, links: links || [], reason: 'empty_text', via: 'playwright' };
    }
    return { ok: true, url: u, text: clean, links: links || [], reason: null, via: 'playwright' };
  } catch (e) {
    const msg = String(e && e.message ? e.message : '');
    let reason = 'network_error';
    if (/timeout/i.test(msg)) reason = 'timeout';
    logger.debug(`[pageReader:playwright] ${u.slice(0, 80)}: ${msg}`);
    return { ok: false, url: u, text: null, links: [], reason, via: 'playwright' };
  } finally {
    if (page) { try { await page.close(); } catch { /* noop */ } }
    if (ownContext && ctx) { try { await ctx.close(); } catch { /* noop */ } }
    if (browser) { try { await browser.close(); } catch { /* noop */ } }
  }
}

async function readPageTextDetailed(url, opts = {}) {
  const first = await readWithAxios(url);
  const shouldRetry = !first.ok || (first.text && first.text.length < MIN_TEXT_OK);
  if (!USE_PLAYWRIGHT || !shouldRetry) return first;
  if (first.ok === false && !PLAYWRIGHT_RETRY_REASONS.has(first.reason)) return first;
  try {
    const second = await readWithPlaywright(url, opts);
    if (second.ok) return second;
    return first.ok ? first : second;
  } catch (e) {
    logger.debug(`[pageReader] playwright fallback unavailable: ${e.message}`);
    return first;
  }
}

async function readMultiplePagesWithDiagnostics(sources, maxPages = 3) {
  const pages = [];
  const urls = (Array.isArray(sources) ? sources : [])
    .map(s => ({ url: String(s?.url || '').trim(), title: String(s?.title || 'Source').slice(0, 160) }))
    .filter(s => /^https?:\/\//i.test(s.url))
    .slice(0, maxPages);

  if (!urls.length) {
    return { pages: [], diagnostics: { attempted: 0, readable: 0, failed: 0, failures: [] } };
  }

  // First pass: axios in parallel (cheap). Track which need Playwright.
  const axiosSettled = await Promise.allSettled(urls.map(s => readWithAxios(s.url)));
  const axiosResults = axiosSettled.map(r => (r.status === 'fulfilled' ? r.value : { ok: false, reason: 'unhandled_error', links: [], via: 'axios' }));

  const retryIdx = [];
  for (let i = 0; i < axiosResults.length; i++) {
    const d = axiosResults[i];
    const needsRetry =
      !d.ok ||
      (d.text && d.text.length < MIN_TEXT_OK);
    if (USE_PLAYWRIGHT && needsRetry && (!d.ok ? PLAYWRIGHT_RETRY_REASONS.has(d.reason) : true)) {
      retryIdx.push(i);
    }
  }

  // Second pass: one shared Playwright context for all retries.
  if (retryIdx.length) {
    let browser = null;
    let ctx = null;
    try {
      const { getChromium, getStealthLaunchOptions, getStealthContextOptions, injectStealthScripts } = require('../scraper/stealth');
      browser = await getChromium().launch(getStealthLaunchOptions());
      ctx = await browser.newContext(getStealthContextOptions());
      logger.info(`[pageReader] playwright fallback launched for ${retryIdx.length} page(s)`);
      for (const i of retryIdx) {
        const page = await ctx.newPage();
        try {
          await injectStealthScripts(page);
          const second = await (async () => {
            try {
              const resp = await page.goto(urls[i].url, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_TIMEOUT });
              const status = resp ? resp.status() : 0;
              if (status && status >= 400) {
                return { ok: false, url: urls[i].url, text: null, links: [], reason: `http_${status}`, via: 'playwright' };
              }
              try { await page.waitForLoadState('networkidle', { timeout: 4000 }); } catch { /* soft */ }
              const html = await page.content();
              if (!html || html.length < 100) {
                return { ok: false, url: urls[i].url, text: null, links: [], reason: 'too_short', via: 'playwright' };
              }
              const { text: clean, links } = htmlToTextAndLinks(html, urls[i].url);
              if (!clean || clean.length < 80) {
                return { ok: false, url: urls[i].url, text: null, links: links || [], reason: 'empty_text', via: 'playwright' };
              }
              return { ok: true, url: urls[i].url, text: clean, links: links || [], reason: null, via: 'playwright' };
            } catch (e) {
              const msg = String(e && e.message ? e.message : '');
              let reason = 'network_error';
              if (/timeout/i.test(msg)) reason = 'timeout';
              return { ok: false, url: urls[i].url, text: null, links: [], reason, via: 'playwright' };
            }
          })();
          if (second.ok) {
            axiosResults[i] = second;
          } else if (!axiosResults[i].ok) {
            axiosResults[i] = second; // keep better reason
          }
        } finally {
          try { await page.close(); } catch { /* noop */ }
        }
      }
    } catch (e) {
      logger.warn(`[pageReader] playwright pass failed: ${e.message}`);
    } finally {
      if (ctx) { try { await ctx.close(); } catch { /* noop */ } }
      if (browser) { try { await browser.close(); } catch { /* noop */ } }
    }
  }

  const failures = [];
  let readableViaPlaywright = 0;
  let readableViaAxios = 0;
  for (let i = 0; i < urls.length; i++) {
    const d = axiosResults[i];
    if (d && d.ok && d.text) {
      if (d.via === 'playwright') readableViaPlaywright += 1;
      else readableViaAxios += 1;
      pages.push({
        url: urls[i].url,
        title: urls[i].title,
        text: d.text,
        links: Array.isArray(d.links) ? d.links : [],
        via: d.via || 'axios'
      });
    } else {
      failures.push({
        url: urls[i].url,
        reason: d && d.reason ? d.reason : 'unknown',
        via: d && d.via ? d.via : 'axios'
      });
    }
  }

  return {
    pages,
    diagnostics: {
      attempted: urls.length,
      readable: pages.length,
      readable_via_axios: readableViaAxios,
      readable_via_playwright: readableViaPlaywright,
      failed: failures.length,
      failures
    }
  };
}

async function readMultiplePages(sources, maxPages = 3) {
  const out = await readMultiplePagesWithDiagnostics(sources, maxPages);
  return out.pages;
}

module.exports = {
  readPageText,
  readPageTextDetailed,
  readMultiplePages,
  readMultiplePagesWithDiagnostics,
  htmlToCleanText,
  htmlToTextAndLinks
};
