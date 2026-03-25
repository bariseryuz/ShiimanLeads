/**
 * When a JSON/API source returns 0 rows, re-discover the data endpoint from the portal page
 * and persist a working URL (self-healing).
 */

const { dbRun } = require('../db');
const logger = require('../utils/logger');
const { discoverBestFromPage, isLikelyEndpoint } = require('./endpointDiscovery');

function mergeManifest(source) {
  const manifest = source.manifest && typeof source.manifest === 'object' ? { ...source.manifest, ...source } : { ...source };
  if (!manifest.query_params && manifest.params) manifest.query_params = manifest.params;
  return manifest;
}

function deriveDiscoveryPageUrl(source) {
  const m = mergeManifest(source);
  if (m.discovery_page_url) return String(m.discovery_page_url).trim();
  if (source.discovery_page_url) return String(source.discovery_page_url).trim();
  const ref = m.referer_url || m.refererUrl || m.referer;
  if (typeof ref === 'string' && /^https?:\/\//i.test(ref) && !isLikelyEndpoint(ref)) {
    return ref.trim();
  }
  const url = source.url || '';
  if (!url) return null;
  if (!isLikelyEndpoint(url)) return url;
  return null;
}

function shouldAutoHeal(source) {
  const m = mergeManifest(source);
  if (m.auto_discover_endpoint === false || source.auto_discover_endpoint === false) return false;
  return true;
}

async function persistSourceJson(userId, sourceId, sourceObj) {
  const json = JSON.stringify(sourceObj);
  await dbRun('UPDATE user_sources SET source_data = ? WHERE id = ? AND user_id = ?', [json, sourceId, userId]);
}

/**
 * @returns {Promise<{ healed: boolean, newUrl?: string, rowCount?: number, reason?: string, candidates?: string[] }>}
 */
async function tryHealJsonEndpoint(source, userId) {
  if (!shouldAutoHeal(source)) return { healed: false, reason: 'disabled' };
  if (!source.id || !userId) return { healed: false, reason: 'missing_ids' };

  const pageUrl = deriveDiscoveryPageUrl(source);
  if (!pageUrl) {
    logger.info(
      `[SelfHeal] Skip "${source.name}": add discovery_page_url (portal page) on the source to enable automatic API endpoint repair when the URL breaks.`
    );
    return { healed: false, reason: 'no_discovery_page' };
  }

  const manifest = mergeManifest(source);
  const prevBase = (source.url || '').split('?')[0];

  const { endpointUrl, rowCount, candidates } = await discoverBestFromPage(pageUrl, manifest, 20000);

  if (!endpointUrl || endpointUrl === prevBase) {
    return { healed: false, reason: 'no_new_endpoint', candidates, rowCount };
  }
  if (rowCount < 1) {
    return { healed: false, reason: 'probe_zero_rows', candidates };
  }

  source.url = endpointUrl;
  if (!source.manifest) source.manifest = {};
  source.manifest.discovery_page_url = source.manifest.discovery_page_url || pageUrl;

  await persistSourceJson(userId, source.id, source);
  logger.info(`[SelfHeal] Persisted new API URL for "${source.name}": ${endpointUrl} (${rowCount} rows on probe)`);
  return { healed: true, newUrl: endpointUrl, rowCount };
}

module.exports = { tryHealJsonEndpoint, deriveDiscoveryPageUrl, shouldAutoHeal };
