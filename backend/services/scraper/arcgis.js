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

function normalizeArcGISApiUrl(rawUrl) {
  if (!rawUrl) return null;
  if (rawUrl.includes('/query')) {
    return ensureArcGISParams(rawUrl);
  }
  return ensureArcGISParams(`${rawUrl.replace(/\/$/, '')}/query`);
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

async function extractArcGISApiInfo(hubUrl, logger) {
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

  const { apiUrl, headers } = await extractArcGISApiInfo(sourceUrl, logger);

  if (!apiUrl) {
    throw new Error('ArcGIS API endpoint not found');
  }

  logger.info(`   ✅ ArcGIS API endpoint resolved: ${apiUrl}`);

  const response = await axios.get(apiUrl, { headers, timeout: 30000 });
  const jsonData = response.data;

  let records = [];

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

  return { apiUrl, records };
}

module.exports = {
  fetchArcGISRecords
};
