/**
 * API Response Interceptor for Playwright
 * Captures API responses made by the page without needing AI vision
 * Useful for government sites that load data via XHR/Fetch
 */

const logger = require('../../utils/logger');

/**
 * Setup API response interception on a Playwright page
 * @param {Object} page - Playwright page object
 * @returns {Promise<Array>} Array of intercepted API responses
 */
async function setupApiInterceptor(page) {
  const capturedResponses = [];
  
  page.on('response', async (response) => {
    try {
      const url = response.url();
      const status = response.status();
      
      // XHR/Fetch: government portals often return JSON without a perfect Content-Type
      if (status !== 200) return;
      const looksApi =
        url.includes('GetIssuedPermit') ||
        url.includes('/query') ||
        url.includes('/api/') ||
        url.includes('FeatureServer') ||
        url.includes('MapServer') ||
        /\/resource\/[0-9a-z]{4}-[0-9a-z]{4}/i.test(url) ||
        /[?&]f=json\b/i.test(url) ||
        /\.json(\?|$)/i.test(url.split('?')[0]);
      if (!looksApi) return;

      logger.debug(`   📡 API-shaped response: ${url.substring(Math.max(0, url.length - 96))}`);

      try {
        const contentType = (response.headers()['content-type'] || '').toLowerCase();
        let data = null;
        if (contentType.includes('json') || contentType.includes('javascript')) {
          data = await response.json();
        } else {
          const text = await response.text();
          try {
            data = JSON.parse(text);
          } catch {
            return;
          }
        }
        if (data && typeof data === 'object') {
          capturedResponses.push({
            url: url,
            status: status,
            data: data,
            timestamp: new Date()
          });
          logger.info(`   ✅ Interceptor JSON keys: ${Array.isArray(data) ? `array(${data.length})` : Object.keys(data).slice(0, 8).join(', ')}`);
        }
      } catch (parseErr) {
        logger.warn(`   ⚠️ Could not parse API response: ${parseErr.message}`);
      }
    } catch (err) {
      // Silently ignore response capture errors
    }
  });
  
  return capturedResponses;
}

/**
 * Wait for a specific API response and extract data
 * @param {Object} page - Playwright page object
 * @param {String} urlPattern - URL pattern to match (e.g., "GetIssuedPermit")
 * @param {Number} timeout - How long to wait in ms
 * @returns {Promise<Object>} The API response data
 */
async function waitForApiResponse(page, urlPattern, timeout = 120000) {
  try {
    const response = await page.waitForResponse(
      (resp) => {
        const url = resp.url();
        const status = resp.status();
        return status === 200 && url.includes(urlPattern);
      },
      { timeout }
    );
    
    const contentType = (response.headers()['content-type'] || '').toLowerCase();
    try {
      if (contentType.includes('json') || contentType.includes('javascript')) {
        const data = await response.json();
        logger.info(`   ✅ Intercepted API response from: ${urlPattern}`);
        return data;
      }
      const text = await response.text();
      const data = JSON.parse(text);
      logger.info(`   ✅ Intercepted JSON (nonstandard Content-Type) from: ${urlPattern}`);
      return data;
    } catch {
      return null;
    }
  } catch (err) {
    logger.warn(`   ⏱️ Timeout waiting for API response: ${urlPattern}`);
    return null;
  }
}

/**
 * Extract records from various API response formats
 * @param {Object} data - API response data
 * @returns {Array} Array of records
 */
function extractRecordsFromApiResponse(data) {
  if (!data) return [];
  
  let records = [];
  
  // ArcGIS format: { features: [ { attributes: {...} } ] }
  if (data.features && Array.isArray(data.features)) {
    logger.info(`   🎯 Detected ArcGIS format (features)`);
    records = data.features.map(f => f.attributes || f);
  }
  // Plain array
  else if (Array.isArray(data)) {
    logger.info(`   🎯 Detected plain array`);
    records = data;
  }
  // Nested data formats
  else if (data.data && Array.isArray(data.data)) {
    logger.info(`   🎯 Detected nested data array`);
    records = data.data;
  }
  else if (data.records && Array.isArray(data.records)) {
    logger.info(`   🎯 Detected records array`);
    records = data.records;
  }
  else if (data.results && Array.isArray(data.results)) {
    logger.info(`   🎯 Detected results array`);
    records = data.results;
  }
  else if (data.rows && Array.isArray(data.rows)) {
    logger.info(`   🎯 Detected rows array`);
    records = data.rows;
  }
  // Phoenix-specific format
  else if (data.d && Array.isArray(data.d)) {
    logger.info(`   🎯 Detected .NET array format (d property)`);
    records = data.d;
  }
  
  logger.info(`   📊 Extracted ${records.length} records from API response`);
  return records;
}

module.exports = {
  setupApiInterceptor,
  waitForApiResponse,
  extractRecordsFromApiResponse
};
