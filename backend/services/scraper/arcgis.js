const axios = require('axios');
const { getChromium } = require('./stealth');
const { getStealthLaunchOptions, getStealthContextOptions, injectStealthScripts } = require('./stealth');

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
    if (!params.has('resultRecordCount')) params.set('resultRecordCount', '10000');

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
    if (!params.has('resultRecordCount')) params.set('resultRecordCount', '10000');

    parsed.search = params.toString();
    return parsed.toString();
  } catch (err) {
    return url;
  }
}

async function extractArcGISApiInfo(hubUrl, logger, navigationInstructions = []) {
  const browser = await getChromium().launch(getStealthLaunchOptions());
  const context = await browser.newContext(getStealthContextOptions());
  const page = await context.newPage();
  await injectStealthScripts(page);

  const candidateRequests = [];

  page.on('request', (req) => {
    const reqUrl = req.url();
    if (isArcGISApiUrl(reqUrl) && reqUrl.includes('FeatureServer')) {
      candidateRequests.push({ url: reqUrl, headers: req.headers() });
    }
  });

  try {
    await page.goto(hubUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
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
  const pageSize = 10000;
  let hasMoreRecords = true;
  let hitTransferLimit = false;

  // Pagination loop: fetch all records in batches of 10000
  while (hasMoreRecords) {
    try {
      const paginatedUrl = new URL(apiUrl);
      paginatedUrl.searchParams.set('resultOffset', offset.toString());
      paginatedUrl.searchParams.set('resultRecordCount', pageSize.toString());

      const response = await axios.get(paginatedUrl.toString(), { 
        headers, 
        timeout: 120000,
        validateStatus: (status) => status < 500 // Accept 4xx but not 5xx errors
      });
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
        
        // Check if API hit transfer limit (exceededTransferLimit = true means there's more data)
        if (jsonData?.exceededTransferLimit === true) {
          logger.warn(`   ⚠️ ArcGIS Transfer Limit hit at ${allRecords.length} records`);
          hitTransferLimit = true;
          hasMoreRecords = false;
        } else {
          // Continue fetching even if we get fewer records than requested
          // Only stop when we get 0 records (see above)
          offset += pageSize;
        }
      }
    } catch (err) {
      if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
        logger.error(`⏱️ Government API timeout at ${offset} records - their server is too slow or blocking scrapers`);
        logger.info(`💡 Tip: Government APIs can take 2-3 minutes. This is normal for governmental sources.`);
      } else {
        logger.warn(`ArcGIS pagination error at offset ${offset}: ${err.message}`);
      }
      hasMoreRecords = false;
    }
  }

  // If we hit the transfer limit and got fewer records than expected, warn user
  if (hitTransferLimit && source.totalRecordCount && allRecords.length < source.totalRecordCount) {
    logger.warn(`   ⚠️ ArcGIS Server Limit: Got ${allRecords.length} out of ${source.totalRecordCount} total records`);
    logger.warn(`   💡 Attempting to fetch remaining records using date-range splitting...`);
    
    // Try date-based splitting if a date field is available
    if (source.dateField) {
      try {
        const additionalRecords = await fetchWithDateSplitting(apiUrl, headers, source.dateField, allRecords.length, logger);
        if (additionalRecords.length > 0) {
          logger.info(`   ✅ Retrieved ${additionalRecords.length} additional records via date splitting`);
          allRecords.push(...additionalRecords);
        }
      } catch (splitErr) {
        logger.warn(`   ⚠️ Date splitting failed: ${splitErr.message}`);
      }
    } else {
      logger.warn(`   💡 To get all records, add 'dateField' to your source config (e.g., "created_date")`);
      logger.warn(`   💡 Or contact ArcGIS admin to increase MaxRecordCount server limit`);
    }
  }

  logger.info(`   ✅ ArcGIS fetched ${allRecords.length} total records`);
  return { apiUrl, records: allRecords };
}

/**
 * Fetch additional records using date-range splitting when transfer limit is hit
 * @param {string} baseApiUrl - Base API URL
 * @param {object} headers - Request headers
 * @param {string} dateField - Date field name for splitting
 * @param {number} alreadyFetched - Number of records already fetched
 * @param {object} logger - Logger instance
 * @returns {Promise<Array>} Additional records
 */
async function fetchWithDateSplitting(baseApiUrl, headers, dateField, alreadyFetched, logger) {
  const additionalRecords = [];
  
  // Get the date range of the data
  const statsUrl = new URL(baseApiUrl);
  statsUrl.searchParams.set('where', '1=1');
  statsUrl.searchParams.set('outStatistics', JSON.stringify([
    { statisticType: 'min', onStatisticField: dateField, outStatisticFieldName: 'min_date' },
    { statisticType: 'max', onStatisticField: dateField, outStatisticFieldName: 'max_date' }
  ]));
  statsUrl.searchParams.set('f', 'json');
  
  try {
    const statsResponse = await axios.get(statsUrl.toString(), { headers, timeout: 120000 });
    const stats = statsResponse.data?.features?.[0]?.attributes;
    
    if (!stats || !stats.min_date || !stats.max_date) {
      throw new Error('Could not retrieve date range');
    }
    
    const minDate = new Date(stats.min_date);
    const maxDate = new Date(stats.max_date);
    logger.info(`   📅 Date range: ${minDate.toISOString()} to ${maxDate.toISOString()}`);
    
    // Split into year ranges
    const yearRanges = [];
    let currentYear = minDate.getFullYear();
    const endYear = maxDate.getFullYear();
    
    while (currentYear <= endYear) {
      yearRanges.push({
        start: new Date(currentYear, 0, 1).getTime(),
        end: new Date(currentYear, 11, 31, 23, 59, 59).getTime(),
        year: currentYear
      });
      currentYear++;
    }
    
    // Fetch records for each year
    for (const range of yearRanges) {
      const whereClause = `${dateField} >= ${range.start} AND ${dateField} <= ${range.end}`;
      const rangeUrl = new URL(baseApiUrl);
      rangeUrl.searchParams.set('where', whereClause);
      rangeUrl.searchParams.set('resultRecordCount', '10000');
      rangeUrl.searchParams.set('resultOffset', '0');
      
      let rangeOffset = 0;
      let hasMore = true;
      
      while (hasMore) {
        rangeUrl.searchParams.set('resultOffset', rangeOffset.toString());
        
        const response = await axios.get(rangeUrl.toString(), { headers, timeout: 120000 });
        const jsonData = response.data;
        
        const records = jsonData?.features?.map(f => f.attributes || f) || [];
        
        if (records.length === 0) {
          hasMore = false;
        } else {
          rangeOffset += 10000;
        }
        
        additionalRecords.push(...records);
        
        // Stop if we've fetched enough to reach the total
        if (additionalRecords.length + alreadyFetched >= 140000) break;
      }
      
      if (additionalRecords.length + alreadyFetched >= 140000) break;
    }
    
  } catch (err) {
    logger.warn(`   ⚠️ Date splitting error: ${err.message}`);
  }
  
  return additionalRecords;
}

/**
 * Discover ArcGIS API endpoint from a Hub/datasets/explore URL.
 * Returns the query endpoint URL or null. Used by the universal "Find endpoint" flow.
 */
async function discoverArcGISEndpoint(hubUrl, logger, navigationInstructions = []) {
  try {
    const { apiUrl } = await extractArcGISApiInfo(hubUrl, logger, navigationInstructions);
    return apiUrl || null;
  } catch (err) {
    logger.warn(`ArcGIS endpoint discovery failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  fetchArcGISRecords,
  discoverArcGISEndpoint,
  extractArcGISApiInfo
};
