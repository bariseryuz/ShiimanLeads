/**
 * SHIIMAN LEADS - MASTER SCRAPER (MASTER FIX - FEB 17)
 * Fixed: SyntaxError in querySelector.
 * Fixed: Screenshot persistence for UI.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const { chromium } = require('playwright');
const axios = require('axios');
const logger = require('./utils/logger');

const { dbRun } = require('./db');
const { insertLeadIfNew } = require('./services/leadInsertion');
const { trackSourceReliability } = require('./services/reliability');
const { isAIAvailable, extractFromScreenshot, navigateAutonomously } = require('./services/ai');
const { captureTiledScreenshots } = require('./services/scraper/screenshot');
const { captureGridScrollScreenshots } = require('./services/scraper/gridScrollScraper');
const { initProgress, updateProgress, shouldStopScraping } = require('./services/scraper/progress');
const { setupPopupBlocking, preventAllPopups, setupArcGISPage } = require('./services/scraper/preventPopup');
const { fetchArcGISRecords } = require('./services/scraper/arcgis');
const { getRateLimiter } = require('./services/scraper/rateLimiter');
const { getStealthLaunchOptions, getStealthContextOptions, injectStealthScripts } = require('./services/scraper/stealth');
const { setupApiInterceptor, waitForApiResponse, extractRecordsFromApiResponse } = require('./services/scraper/apiInterceptor');
const { mergeLimits, isPageLimitReached, isTotalRowLimitReached } = require('./config/extractionLimits');
const { SCREENSHOT_DIR } = require('./config/paths');

async function scrapeForUser(userId, userSources, extractionLimits) {
  logger.info(`🚀 Starting FIXED PRODUCTION Scrape for User ${userId}`);
  initProgress(userId, userSources);

  let totalInserted = 0;

  for (const sourceRow of userSources) {
    if (shouldStopScraping(userId)) break;

    let source;
    try {
      source = sourceRow.source_data ? (typeof sourceRow.source_data === 'string' ? JSON.parse(sourceRow.source_data) : sourceRow.source_data) : sourceRow;
      source.id = sourceRow.id || source._sourceId;
    } catch (e) {
      logger.error(`Failed to parse source_data for source id ${sourceRow.id}: ${e.message}`);
      continue;
    }

    const limits = mergeLimits(source.extractionLimits || {}, extractionLimits);
    updateProgress(userId, { currentSource: source.name });
    const rateLimiter = getRateLimiter(source);

    try {
      await rateLimiter.waitIfNeeded();
      let sourceNewLeads = 0;

      // ===== ARCGIS HUB PIPELINE =====
      if (source.type === 'arcgis') {
        logger.info(`🗺️ ArcGIS Mode for: ${source.name}`);
        logger.info(`   URL: ${source.url}`);

        try {
          const { apiUrl, records } = await fetchArcGISRecords(source, logger);
          logger.info(`   📊 Found ${records.length} records`);

          const fieldMapping = source.fieldMappings || source.fieldSchema || source.fieldMapping || {};

          for (const record of records) {
            if (isTotalRowLimitReached(totalInserted, limits)) {
              logger.info(`   ⚠️ Total row limit reached: ${limits.maxTotalRows}`);
              break;
            }

            let mappedLead = {};
            if (Object.keys(fieldMapping).length > 0) {
              for (const [targetField, sourceField] of Object.entries(fieldMapping)) {
                if (sourceField && record[sourceField] !== undefined) {
                  mappedLead[targetField] = record[sourceField];
                }
              }
            } else {
              mappedLead = { ...record };
            }

            for (const [key, value] of Object.entries(mappedLead)) {
              if (typeof value === 'number' && value > 1000000000 && value < 2000000000000) {
                const date = new Date(value > 10000000000 ? value : value * 1000);
                mappedLead[key] = date.toISOString().split('T')[0];
              }
            }

            if (await insertLeadIfNew({
              raw: JSON.stringify(mappedLead),
              sourceName: source.name,
              lead: mappedLead,
              userId,
              sourceId: source.id,
              sourceUrl: apiUrl
            })) {
              sourceNewLeads++;
              totalInserted++;
            }
          }

          logger.info(`   ✅ ArcGIS scrape complete: ${sourceNewLeads} new leads`);
          await trackSourceReliability(source.id, source.name, true, sourceNewLeads);
          rateLimiter.onSuccess();
          continue;
        } catch (arcgisErr) {
          logger.error(`❌ ArcGIS error for ${source.name}: ${arcgisErr.message}`);
          await trackSourceReliability(source.id, source.name, false, 0);
          rateLimiter.onError();
          continue;
        }
      }

      // ===== AUTO-DETECT ARCGIS HUB URLS AND CONVERT TO API ENDPOINTS =====
      const isArcGISHub = source.type !== 'arcgis' && source.url && (source.url.includes('/datasets/') || source.url.includes('/explore'));
      
      if (isArcGISHub && !source.url.includes('FeatureServer') && !source.url.includes('/rest/services/')) {
        logger.info(`🔍 Detected ArcGIS Hub URL - extracting API endpoint...`);
        
        try {
          // Fetch the Hub page to extract the actual API endpoint
          const hubResponse = await axios.get(source.url, { 
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 15000 
          });
          
          const pageContent = hubResponse.data;
          
          // Extract dataset ID from URL (e.g., 2576bfb2d74f418b8ba8c4538e4f729f_0)
          const datasetIdMatch = source.url.match(/\/datasets\/([a-f0-9_]+)/i);
          
          // Try to find FeatureServer URL in page content
          let apiUrl = null;
          
          // Method 1: Look for FeatureServer URL in page content
          const featureServerMatch = pageContent.match(/(https?:\/\/[^"']+\/FeatureServer\/\d+)/i);
          if (featureServerMatch) {
            apiUrl = featureServerMatch[1] + '/query?where=1=1&outFields=*&f=json';
            logger.info(`   ✅ Found FeatureServer URL: ${apiUrl}`);
          }
          
          // Method 2: Look for services URL pattern
          if (!apiUrl) {
            const servicesMatch = pageContent.match(/(https?:\/\/services\d*\.arcgis\.com\/[^"']+\/arcgis\/rest\/services\/[^"']+\/FeatureServer\/\d+)/i);
            if (servicesMatch) {
              apiUrl = servicesMatch[1] + '/query?where=1=1&outFields=*&f=json';
              logger.info(`   ✅ Found services URL: ${apiUrl}`);
            }
          }
          
          // Method 3: Construct from dataset ID if found
          if (!apiUrl && datasetIdMatch) {
            const datasetId = datasetIdMatch[1];
            // Try common ArcGIS Online pattern
            apiUrl = `https://services.arcgis.com/0/arcgis/rest/services/${datasetId}/FeatureServer/0/query?where=1=1&outFields=*&f=json`;
            logger.info(`   ⚠️ Constructed fallback URL from dataset ID`);
          }
          
          if (apiUrl) {
            // Override the source URL with the API endpoint
            logger.info(`   🔄 Switching from Hub URL to API: ${apiUrl}`);
            source.url = apiUrl;
            source.type = 'json'; // Force JSON mode
          } else {
            logger.warn(`   ⚠️ Could not extract API endpoint - will try Playwright mode`);
          }
          
        } catch (hubErr) {
          logger.warn(`   ⚠️ Failed to extract API endpoint: ${hubErr.message}`);
          logger.info(`   📸 Falling back to Playwright screenshot mode`);
        }
      }

      // ===== JSON API SCRAPING =====
      // Auto-detect ArcGIS URLs that should use JSON API
      const isArcGISUrl = source.url && (source.url.includes('arcgis') || source.url.includes('/rest/services/') || source.url.includes('FeatureServer'));
      
      if (!source.forcePlaywrightOnly && (source.type === 'json' || source.method === 'json' || (isArcGISUrl && source.type !== 'playwright'))) {
        logger.info(`📡 JSON API Mode for: ${source.name}`);
        logger.info(`   URL: ${source.url}`);
        
        try {
          let response;
          const headers = source.headers || { 'User-Agent': 'Mozilla/5.0' };
          
          // Check if this is an ArcGIS URL that might need cookie handling
          if (source.url.includes('arcgis') || source.url.includes('esri') || source.url.includes('maps.')) {
            logger.info(`   🏗️ ArcGIS API detected - handling cookie requirements...`);
            
            try {
              // Launch browser briefly to accept cookies
              const browser = await chromium.launch(getStealthLaunchOptions());
              const context = await browser.newContext(getStealthContextOptions());
              const arcGISpage = await context.newPage();
              await injectStealthScripts(arcGISpage);
              
              // Try to load the main domain to accept cookies
              const domain = new URL(source.url).origin;
              logger.info(`   🌐 Loading ${domain} to accept cookies...`);
              
              try {
                await arcGISpage.goto(domain, { waitUntil: 'domcontentloaded', timeout: 15000 });
              } catch (navErr) {
                logger.warn(`   ⚠️ Navigation timeout (may still work): ${navErr.message}`);
              }
              
              // Handle ArcGIS cookies
              await setupArcGISPage(arcGISpage);
              
              // Get cookies from the browser session
              const cookies = await arcGISpage.context().cookies();
              logger.info(`   🍪 Extracted ${cookies.length} cookies from browser session`);
              
              // Add cookies to axios headers
              if (cookies.length > 0) {
                const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                headers['Cookie'] = cookieString;
                logger.info(`   ✅ Cookies added to API request headers`);
              }
              
              // Close browser
              await arcGISpage.close();
              await browser.close();
              
            } catch (cookieErr) {
              logger.warn(`   ⚠️ Could not extract cookies: ${cookieErr.message}`);
              logger.info(`   📡 Proceeding with API call without cookies...`);
            }
          }
          
          const isSocrata = source.url && /\/resource\/[^/]+\.json/i.test(source.url);
          const fieldMapping = source.fieldSchema || source.fieldMapping || {};

          const extractRecords = (data) => {
            if (data?.features && Array.isArray(data.features)) {
              logger.info(`   ✅ Detected ArcGIS format (features array)`);
              return data.features.map(f => (f.attributes ? { ...f.attributes } : f));
            }
            if (Array.isArray(data)) {
              logger.info(`   ✅ Detected plain array format`);
              return data;
            }
            if (data?.data && Array.isArray(data.data)) {
              logger.info(`   ✅ Detected nested data array`);
              return data.data;
            }
            if (data?.records && Array.isArray(data.records)) return data.records;
            if (data?.results && Array.isArray(data.results)) return data.results;
            return [];
          };

          const processRecords = async (records) => {
            for (const record of records) {
              if (isTotalRowLimitReached(totalInserted, limits)) {
                logger.info(`   ⚠️ Total row limit reached: ${limits.maxTotalRows}`);
                return false;
              }

              let mappedLead = {};
              if (Object.keys(fieldMapping).length > 0) {
                for (const [targetField, sourceField] of Object.entries(fieldMapping)) {
                  if (record[sourceField] !== undefined) {
                    mappedLead[targetField] = record[sourceField];
                  }
                }
              } else {
                mappedLead = { ...record };
              }

              for (const [key, value] of Object.entries(mappedLead)) {
                if (typeof value === 'number' && value > 1000000000 && value < 2000000000000) {
                  const date = new Date(value > 10000000000 ? value : value * 1000);
                  mappedLead[key] = date.toISOString().split('T')[0];
                }
              }

              if (await insertLeadIfNew({
                raw: JSON.stringify(mappedLead),
                sourceName: source.name,
                lead: mappedLead,
                userId,
                sourceId: source.id,
                sourceUrl: source.url
              })) {
                sourceNewLeads++;
                totalInserted++;
              }
            }
            return true;
          };

          let totalRecords = 0;

          if (isSocrata && source.method !== 'POST') {
            const baseParams = { ...(source.params || {}) };
            const limit = Number(baseParams['$limit'] || 10000);
            let offset = Number(baseParams['$offset'] || 0);
            baseParams['$limit'] = limit.toString();

            let pageNumber = 0;
            while (true) {
              pageNumber += 1;
              const pageParams = { ...baseParams, '$offset': offset.toString() };
              const params = new URLSearchParams();
              Object.entries(pageParams).forEach(([key, value]) => {
                params.append(key, String(value));
              });
              const pageUrl = `${source.url}?${params.toString()}`;
              logger.info(`   Method: GET Socrata page ${pageNumber} (limit=${limit}, offset=${offset})`);

              const response = await axios.get(pageUrl, { headers, timeout: 120000 });
              const records = extractRecords(response.data);
              totalRecords += records.length;

              const shouldContinue = await processRecords(records);
              if (!shouldContinue || records.length === 0) break;

              offset += limit;
            }
          } else {
            let response;

            if (source.method === 'POST' && source.params) {
              logger.info(`   Method: POST with params`);
              
              // Convert to form-urlencoded for compatibility
              const formData = new URLSearchParams();
              Object.entries(source.params).forEach(([key, value]) => {
                formData.append(key, String(value));
              });
              
              const postHeaders = {
                ...headers,
                'Content-Type': 'application/x-www-form-urlencoded'
              };
              
              response = await axios.post(source.url, formData.toString(), { 
                headers: postHeaders, 
                timeout: 120000 // 120s for slow government APIs
              });
            } else if (source.params) {
              const params = new URLSearchParams();
              Object.entries(source.params).forEach(([key, value]) => {
                params.append(key, String(value));
              });
              const url = `${source.url}?${params.toString()}`;
              logger.info(`   Method: GET with params`);
              response = await axios.get(url, { headers, timeout: 120000 });
            } else {
              logger.info(`   Method: GET (no params)`);
              response = await axios.get(source.url, { headers, timeout: 120000 });
            }

            const records = extractRecords(response.data);
            totalRecords = records.length;
            await processRecords(records);
          }

          logger.info(`   📊 Found ${totalRecords} records`);
          
          logger.info(`   ✅ JSON scrape complete: ${sourceNewLeads} new leads`);
          await trackSourceReliability(source.id, source.name, true, sourceNewLeads);
          rateLimiter.onSuccess();
          continue; // Skip to next source
        } catch (jsonErr) {
          // Provide specific error messages for common issues
          if (jsonErr.code === 'ECONNABORTED' || jsonErr.message.includes('timeout')) {
            logger.error(`⏱️ JSON API timeout for ${source.name}: ${jsonErr.message}`);
            logger.info(`💡 Government APIs can take 2-3 minutes. This is normal for governmental sources.`);
            logger.info(`💡 Timeout is currently 120 seconds. If still failing, try "Force Playwright Only" mode.`);
          } else if (jsonErr.response?.status === 403 || jsonErr.response?.status === 429) {
            logger.error(`🚫 ${source.name} API blocked request (Status ${jsonErr.response.status})`);
            logger.info(`💡 Try enabling "Force Playwright Only" to bypass API blocking.`);
          } else {
            logger.error(`❌ JSON API error for ${source.name}: ${jsonErr.message}`);
          }
          await trackSourceReliability(source.id, source.name, false, 0);
          rateLimiter.onError();
          continue;
        }
      }
      
      // ===== PLAYWRIGHT SCRAPING =====
      // Skip Playwright for ArcGIS URLs (they should use JSON API above)
      const shouldSkipPlaywright = source.url && (source.url.includes('arcgis') || source.url.includes('/rest/services/'));
      
      if ((source.usePlaywright || source.method === 'playwright' || source.useAI || source.forcePlaywrightOnly) && !shouldSkipPlaywright) {
        if (source.forcePlaywrightOnly) {
          logger.info(`🎭 Force Playwright Only mode - bypassing JSON API`);
        }
        const browser = await chromium.launch(getStealthLaunchOptions());
        const context = await browser.newContext(getStealthContextOptions());
        const page = await context.newPage();
        await injectStealthScripts(page);
        await setupPopupBlocking(page);

        try {
          // Extract search page URL from API endpoint if needed
          let pageUrl = source.url;
          
          // Handle API endpoints like /Search/IssuedPermit/_GetIssuedPermitData
          if (pageUrl.includes('/_Get') || pageUrl.includes('/api/')) {
            // Extract the base URL without the API endpoint
            const parts = pageUrl.split('/_Get')[0] || pageUrl.split('/api')[0];
            pageUrl = parts;
            logger.info(`🔧 Converted API endpoint to search page: ${pageUrl}`);
          }
          
          logger.info(`🌐 Navigating to: ${pageUrl}`);
          await page.goto(pageUrl, { waitUntil: 'commit', timeout: 90000 });
          
          // Wait for any table data to exist
          await page.locator('tr, li, .item, h3').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
          await page.waitForTimeout(5000);
          await preventAllPopups(page);

          // ===== API INTERCEPTION MODE (No AI needed) =====
          // If no AI prompt provided, try to intercept API responses
          if (!source.aiPrompt && source.forcePlaywrightOnly) {
            logger.info(`📡 API Interception Mode - capturing API responses without AI vision`);
            setupApiInterceptor(page); // Start listening for API responses
            
            // Determine which API endpoint to wait for
            let apiPattern = 'GetIssuedPermit';
            if (source.url.includes('FeatureServer') || source.url.includes('arcgis')) {
              apiPattern = 'query';
            } else if (source.url.includes('/_Get')) {
              const match = source.url.match(/\/_Get(\w+)/);
              if (match) apiPattern = match[1];
            }
            
            logger.info(`   🎯 Waiting for API response pattern: ${apiPattern}`);
            const apiCall = waitForApiResponse(page, apiPattern, 120000);
            
            // Try to find and click search button if it exists
            const searchButtons = await page.locator('button:has-text("Search"), button[type="submit"], input[type="submit"]').count();
            if (searchButtons > 0) {
              logger.info(`🔍 Clicking search button to trigger API calls...`);
              await page.locator('button:has-text("Search"), button[type="submit"], input[type="submit"]').first().click({ timeout: 10000 }).catch(() => {});
              await page.waitForTimeout(3000);
            }
            
            const apiData = await apiCall;
            if (apiData) {
              const records = extractRecordsFromApiResponse(apiData);
              
              // Insert records
              for (const record of records) {
                if (isTotalRowLimitReached(totalInserted, limits)) {
                  logger.info(`   ⚠️ Total row limit reached: ${limits.maxTotalRows}`);
                  break;
                }
                
                if (await insertLeadIfNew({ 
                  raw: JSON.stringify(record), 
                  sourceName: source.name, 
                  lead: record, 
                  userId, 
                  sourceId: source.id, 
                  sourceUrl: source.url 
                })) {
                  sourceNewLeads++;
                  totalInserted++;
                }
              }
              
              logger.info(`   ✅ API Interception complete: ${sourceNewLeads} new leads`);
              await trackSourceReliability(source.id, source.name, true, sourceNewLeads);
              await page.context().close().catch(() => {});
              await browser.close().catch(() => {});
              rateLimiter.onSuccess();
              continue; // Skip to next source
            } else {
              logger.warn(`   ⚠️ No API response captured - falling back to page parsing`);
            }
          }

          if (source.aiPrompt && isAIAvailable()) {
            await navigateAutonomously(page, Array.isArray(source.aiPrompt) ? source.aiPrompt.join('\n') : source.aiPrompt);
            await page.waitForTimeout(3000);
          }

          // MODE DETECT
          const isWide = await page.evaluate(() => document.documentElement.scrollWidth > (window.innerWidth + 100));

          if (isWide && source.useAI) {
            logger.info(`🎯 Mode: Wide Table Grid Scroll`);
            const gridResult = await captureGridScrollScreenshots(page, { selector: 'body', horizontalScrollStep: 1000, verticalScrollStep: 800 });
            for (const tile of gridResult.tiles) {
              const aiLeads = await extractFromScreenshot(tile.buffer, source.name, source.fieldSchema);
              if (aiLeads) {
                for (const lead of aiLeads) {
                  if (await insertLeadIfNew({ raw: JSON.stringify(lead), sourceName: source.name, lead, userId, sourceId: source.id, sourceUrl: source.url })) {
                    sourceNewLeads++; totalInserted++;
                  }
                }
              }
            }
          } else if (source.useAI) {
            logger.info(`🎯 Mode: Standard Pagination/Scroll`);
            let pageNumber = 1;
            let hasMorePages = true;

            while (hasMorePages && !isPageLimitReached(pageNumber, limits)) {
              const fingerprint = await page.evaluate(() => document.querySelector('tr, li, .item, h3')?.innerText?.substring(0, 40) || 'empty');
              
              const screenshotData = await captureTiledScreenshots(page, { useFullPage: true });
              const screenshot = screenshotData?.compositeBuffer || screenshotData;

              // Save screenshot for Dashboard
              try {
                const debugDir = path.join(SCREENSHOT_DIR, 'tiles-debug');
                if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
                const filename = `${source.id}_${Date.now()}_p${pageNumber}.png`;
                fs.writeFileSync(path.join(debugDir, filename), screenshot);
                logger.info(`   📸 Screenshot saved: ${filename}`);
              } catch (screenshotErr) {
                logger.error(`   ❌ Failed to save screenshot: ${screenshotErr.message}`);
              }

              const aiLeads = await extractFromScreenshot(screenshot, source.name, source.fieldSchema);
              if (aiLeads) {
                for (const lead of aiLeads) {
                  if (isTotalRowLimitReached(totalInserted, limits)) { hasMorePages = false; break; }
                  if (await insertLeadIfNew({ raw: JSON.stringify(lead), sourceName: source.name, lead, userId, sourceId: source.id, sourceUrl: source.url })) {
                    sourceNewLeads++; totalInserted++;
                  }
                }
              }

              // === FIXED NEXT BUTTON DETECTION (Safe Standard CSS only) ===
              const nextBtnSelector = await page.evaluate(() => {
                const selectors = ['button[aria-label*="Next"]', 'button.next', 'a.next', '.pagination-next', '.next-page'];
                for (const s of selectors) {
                  const el = document.querySelector(s);
                  if (el && el.offsetHeight > 0 && !el.disabled) return s;
                }
                // Fallback: search all buttons for text "Next"
                const allBtns = Array.from(document.querySelectorAll('button, a'));
                const textBtn = allBtns.find(b => b.innerText && b.innerText.toLowerCase().includes('next'));
                if (textBtn && textBtn.offsetHeight > 0) {
                    textBtn.setAttribute('data-ai-next', 'true');
                    return '[data-ai-next="true"]';
                }
                return null;
              });

              if (nextBtnSelector && hasMorePages) {
                logger.info(`🖱️ Clicking Next via ${nextBtnSelector}`);
                await page.click(nextBtnSelector);
                
                const changed = await page.waitForFunction((old) => {
                  const current = document.querySelector('tr, li, .item, h3')?.innerText?.trim()?.substring(0, 40) || 'empty';
                  return current !== old;
                }, fingerprint, { timeout: 15000 }).catch(() => false);

                if (!changed) hasMorePages = false; else { pageNumber++; await page.waitForTimeout(3000); }
              } else {
                // Infinite Scroll Fallback
                await page.evaluate(() => window.scrollBy(0, 1000));
                await page.waitForTimeout(4000);
                const scrollCheck = await page.evaluate(() => document.querySelector('tr, li, .item, h3')?.innerText?.substring(0, 40) || 'empty');
                if (scrollCheck !== fingerprint && scrollCheck !== 'empty') pageNumber++; else hasMorePages = false;
              }
            }
          }
        } finally {
          await context.close().catch(() => {});
          await browser.close().catch(() => {});
        }
      }
      await trackSourceReliability(source.id, source.name, true, sourceNewLeads);
    } catch (err) { logger.error(`❌ Source Failed: ${err.message}`); }
  }
  updateProgress(userId, { status: 'completed', endTime: Date.now(), leadsFound: totalInserted });
  return totalInserted;
}

module.exports = { scrapeForUser };