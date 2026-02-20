const axios = require('axios');
const { chromium } = require('playwright');

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
};

function isArcGISApiUrl(url) {
  if (!url) return false;
  return url.includes('FeatureServer') || url.includes('/rest/services/') || url.includes('arcgis.com');
}

function extractApiUrlFromHtml(html) {
  if (!html) return null;
  const featureServerMatch = html.match(/(https?:\/\/[^"']+\/FeatureServer\/\d+)/i);
  if (featureServerMatch) return featureServerMatch[1];

  const servicesMatch = html.match(/(https?:\/\/services\d*\.arcgis\.com\/[^"']+\/arcgis\/rest\/services\/[^"']+\/FeatureServer\/\d+)/i);
  if (servicesMatch) return servicesMatch[1];

  return null;
}

function cleanDashboardUrl(url) {
  // Remove problematic dashboard aggregation parameters
  try {
    const parsed = new URL(url);
    const params = parsed.searchParams;

    // Remove aggregation/statistics parameters
    params.delete('outStatistics');
    params.delete('cacheHint');
    params.delete('orderByFields');
    params.delete('outSR');
    params.delete('spatialRel');
    
    // Rebuild with clean parameters
    if (!params.has('where')) params.set('where', '1=1');
    if (!params.has('outFields')) params.set('outFields', '*');
    if (!params.has('f')) params.set('f', 'json');
    if (!params.has('resultRecordCount')) params.set('resultRecordCount', '1000');

    parsed.search = params.toString();
    return parsed.toString();
  } catch (err) {
    return url;
  }
}

function normalizeArcGISApiUrl(rawUrl) {
  if (!rawUrl) return null;
  
  // Clean dashboard URLs first
  const cleanedUrl = cleanDashboardUrl(rawUrl);
  
  if (cleanedUrl.includes('/query')) {
    return ensureArcGISParams(cleanedUrl);
  }
  return ensureArcGISParams(`${cleanedUrl.replace(/\/$/, '')}/query`);
}

function ensureArcGISParams(url) {
  try {
    const parsed = new URL(url);
    const params = parsed.searchParams;

    if (!params.has('where')) params.set('where', '1=1');
    if (!params.has('outFields')) params.set('outFields', '*');
    if (!params.has('f')) params.set('f', 'json');
    if (!params.has('resultRecordCount')) params.set('resultRecordCount', '1000');

    parsed.search = params.toString();
    return parsed.toString();
  } catch (err) {
    return url;
  }
}

async function extractArcGISApiInfo(hubUrl, logger, navigationInstructions = []) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const candidateRequests = [];

  page.on('request', (req) => {
    const reqUrl = req.url();
    if (isArcGISApiUrl(reqUrl) && reqUrl.includes('FeatureServer')) {
      candidateRequests.push({ url: reqUrl, headers: req.headers() });
    }
  });

  try {
    await page.goto(hubUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    logger.warn(`ArcGIS key grabber navigation warning: ${err.message}`);
  }

  // Execute optional navigation instructions
  for (const instruction of navigationInstructions) {
    try {
      if (instruction.type === 'click') {
        const element = await page.$(instruction.selector);
        if (element) {
          await element.click();
          await page.waitForTimeout(instruction.waitAfter || 2000);
        }
      } else if (instruction.type === 'wait') {
        await page.waitForSelector(instruction.selector, { timeout: 10000 }).catch(() => {});
      } else if (instruction.type === 'fill') {
        await page.fill(instruction.selector, instruction.value);
        if (instruction.waitAfter) await page.waitForTimeout(instruction.waitAfter);
      }
    } catch (err) {
      logger.warn(`ArcGIS navigation instruction failed: ${err.message}`);
    }
  }

  await page.waitForTimeout(5000);

  let html = '';
  try {
    html = await page.content();
  } catch (err) {
    logger.warn(`ArcGIS key grabber HTML read warning: ${err.message}`);
  }

  const cookies = await context.cookies();
  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  const cookieHeader = cookies.length > 0
    ? cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    : '';

  const requestMatch = candidateRequests.find((req) => req.url.includes('/query')) || candidateRequests[0];
  const headerSeed = requestMatch?.headers || {};

  const apiUrlFromRequest = requestMatch?.url ? normalizeArcGISApiUrl(requestMatch.url) : null;
  const apiUrlFromHtml = extractApiUrlFromHtml(html);
  const apiUrl = apiUrlFromRequest || normalizeArcGISApiUrl(apiUrlFromHtml);

  const headers = { ...DEFAULT_HEADERS, Referer: hubUrl };

  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }

  if (headerSeed.authorization) {
    headers.Authorization = headerSeed.authorization;
  }

  if (headerSeed['x-arcgis-token']) {
    headers['X-ArcGIS-Token'] = headerSeed['x-arcgis-token'];
  }

  return { apiUrl, headers };
}

async function fetchArcGISRecords(source, logger) {
  const sourceUrl = source?.url;
  if (!sourceUrl) {
    throw new Error('ArcGIS source URL is missing');
  }

  const navigationInstructions = source?.navigationInstructions || [];
  const { apiUrl, headers } = await extractArcGISApiInfo(sourceUrl, logger, navigationInstructions);

  if (!apiUrl) {
    throw new Error('ArcGIS API endpoint not found');
  }

  logger.info(`   ✅ ArcGIS API endpoint resolved: ${apiUrl}`);

  const allRecords = [];
  let offset = 0;
  const pageSize = 1000;
  let hasMoreRecords = true;

  // Pagination loop: fetch all records in batches of 1000
  while (hasMoreRecords) {
    try {
      const paginatedUrl = new URL(apiUrl);
      paginatedUrl.searchParams.set('resultOffset', offset.toString());
      paginatedUrl.searchParams.set('resultRecordCount', pageSize.toString());

      const response = await axios.get(paginatedUrl.toString(), { headers, timeout: 30000 });
      const jsonData = response.data;

      let records = [];

      // Parse response based on expected format
      if (jsonData?.features && Array.isArray(jsonData.features)) {
        records = jsonData.features.map((feature) => {
          if (feature.attributes) {
            return { ...feature.attributes };
          }
          return feature;
        });
      } else if (Array.isArray(jsonData)) {
        records = jsonData;
      } else if (jsonData?.data && Array.isArray(jsonData.data)) {
        records = jsonData.data;
      } else if (jsonData?.records && Array.isArray(jsonData.records)) {
        records = jsonData.records;
      } else if (jsonData?.results && Array.isArray(jsonData.results)) {
        records = jsonData.results;
      }

      if (records.length === 0) {
        hasMoreRecords = false;
      } else {
        allRecords.push(...records);
        
        // Check if API indicates more records available
        if (jsonData?.exceededTransferLimit === false || records.length < pageSize) {
          hasMoreRecords = false;
        } else {
          offset += pageSize;
        }
      }
    } catch (err) {
      logger.warn(`ArcGIS pagination error at offset ${offset}: ${err.message}`);
      hasMoreRecords = false;
    }
  }

  logger.info(`   ✅ ArcGIS fetched ${allRecords.length} total records`);
  return { apiUrl, records: allRecords };
}

module.exports = {
  fetchArcGISRecords
};
