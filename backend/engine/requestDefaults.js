/**
 * Universal request defaults for manifest-first sources (Referer, UA, Accept).
 * Manifest headers override these; Referer falls back to request URL origin when omitted.
 */

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_ACCEPT = 'application/json, text/plain, */*';

function originReferer(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    return `${new URL(urlStr).origin}/`;
  } catch {
    return null;
  }
}

/**
 * Merge manifest.headers with production defaults (browser-like UA, Accept, Referer).
 * @param {Object} manifest - May include headers, referer, referer_url
 * @param {string} requestUrl - Full URL for this HTTP request (used for Referer fallback)
 * @returns {Object} Headers for axios
 */
function mergeRequestHeaders(manifest, requestUrl) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const custom = m.headers && typeof m.headers === 'object' ? m.headers : {};
  const explicitReferer =
    custom.Referer ||
    custom.referer ||
    (typeof m.referer === 'string' && m.referer) ||
    (typeof m.referer_url === 'string' && m.referer_url) ||
    (typeof m.refererUrl === 'string' && m.refererUrl);
  const referer = explicitReferer || originReferer(requestUrl);

  return {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: DEFAULT_ACCEPT,
    ...(referer ? { Referer: referer } : {}),
    ...custom,
  };
}

module.exports = {
  mergeRequestHeaders,
  DEFAULT_USER_AGENT,
  DEFAULT_ACCEPT,
};
