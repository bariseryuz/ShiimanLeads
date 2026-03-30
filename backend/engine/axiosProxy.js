/**
 * Optional HTTP(S) proxy for axios (REST adapter). Configure PROXY_URLS in backend .env.
 * @see https://axios-http.com/docs/req_config — proxy: { host, port, protocol, auth }
 */

const logger = require('../utils/logger');
const envConfig = require('../config/environment');

/**
 * @param {string} proxyUrl e.g. http://user:pass@host:8080
 * @returns {import('axios').AxiosProxyConfig | null}
 */
function buildAxiosProxyConfig(proxyUrl) {
  const raw = String(proxyUrl || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const port = u.port ? parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 80;
    /** @type {import('axios').AxiosProxyConfig} */
    const cfg = {
      host: u.hostname,
      port,
      protocol: u.protocol.replace(':', '')
    };
    if (u.username || u.password) {
      cfg.auth = {
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password)
      };
    }
    return cfg;
  } catch (e) {
    logger.warn(`[axiosProxy] Invalid PROXY_URLS entry (skipped): ${e.message}`);
    return null;
  }
}

/**
 * Use first PROXY_URLS entry when the source opts in (useProxy === true).
 * @param {Object} manifest - source / engine manifest
 * @param {{ probe?: boolean }} [opts]
 * @returns {import('axios').AxiosProxyConfig | undefined}
 */
function axiosProxyFromManifest(manifest, opts = {}) {
  if (!manifest || manifest.useProxy !== true) return undefined;
  const urls = envConfig.PROXY_URLS || [];
  if (!urls.length) {
    if (!opts.probe) {
      logger.warn(
        '[Engine REST Adapter] Source has "Use Residential Proxy" enabled but PROXY_URLS is empty in server .env — using direct connection.'
      );
    }
    return undefined;
  }
  const cfg = buildAxiosProxyConfig(urls[0]);
  if (cfg && !opts.probe) {
    logger.info(`[Engine REST Adapter] Routing request via proxy ${cfg.host}:${cfg.port}`);
  }
  return cfg || undefined;
}

module.exports = { buildAxiosProxyConfig, axiosProxyFromManifest };
