/**
 * LEGACY SCRAPER WRAPPER - Simplified Working Version
 * 
 * Restored from commit f4025cc but simplified to work with refactored codebase.
 * Uses only the helper functions that exist in services/.
 * 
 * Handles:
 * - JSON API scraping (ArcGIS, Socrata, etc.)
 * - Playwright browser automation
 * - HTML parsing with Cheerio
 * - AI vision extraction  
 * - Block detection and rate limiting
 * - Lead insertion and deduplication
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const { chromium } = require('playwright');
const { ProxyAgent } = require('undici');

// Import extracted modules
const logger = require('./utils/logger');
const { dbGet, dbAll, dbRun } = require('./db');
const { insertLeadIfNew } = require('./services/leadInsertion');
const { trackSourceReliability } = require('./services/reliability');
const { createNotification } = require('./services/notifications');
const { extractLeadWithAI } = require('./services/ai');
const { captureEntirePage, captureTiledScreenshots } = require('./services/scraper/screenshot');
const { getRateLimiter } = require('./services/scraper/rateLimiter');
const { getTimings } = require('./services/scraper/timings');
const {
  initProgress,
  updateProgress,
  getProgress,
  shouldStopScraping
} = require('./services/scraper/progress');
const {
  textPassesFilters,
  buildTextForFilter,
  replaceDynamicDates,
  parseDate,
  getNestedProp,
  normalizeText
} = require('./services/scraper/helpers');
const { validateExtractedFields } = require('./services/scraper/validation');
const { setupPopupBlocking, preventAllPopups } = require('./services/scraper/preventPopup');
const { mergeLimits, logLimits, isPageLimitReached, isRowLimitReached, isTotalRowLimitReached } = require('./config/extractionLimits');
// NOTE: Deduplication system - bulletproof implementation in services/deduplication.js
const { SCREENSHOT_DIR } = require('./config/paths');
const { navigateAutonomously, clickNextPage, isNavigatorAvailable } = require('./services/ai/navigator');

// Proxy Configuration
const PROXY_ENABLED = process.env.PROXY_ENABLED === 'true';
const PROXY_URLS = process.env.PROXY_URLS 
  ? process.env.PROXY_URLS.split(',').map(p => p.trim())
  : ['http://Sk3vydHQSz93OeDz:DQeASUiiQpObLVvO@geo.iproyal.com:12321'];
const PROXY_URL = PROXY_URLS[0];

let proxyAgent = null;
if (PROXY_ENABLED) {
  proxyAgent = new ProxyAgent(PROXY_URL);
  logger.info(`Proxy enabled: ${PROXY_URLS.length} proxy(ies) configured`);
}

// Axios proxy configuration
const axiosProxyConfig = PROXY_ENABLED ? {
  proxy: {
    protocol: 'https',
    host: 'geo.iproyal.com',
    port: 12321,
    auth: {
      username: 'Sk3vydHQSz93OeDz',
      password: 'DQeASUiiQpObLVvO'
    }
  },
  httpsAgent: new (require('https').Agent)({
    rejectUnauthorized: false
  })
} : {};

// Gemini is initialized in services/geminiClient.js

/**
 * Main scraping function - restored from old index.js but simplified
 * to work with refactored codebase helper modules.
 * 
 * @param {number} userId - User ID
 * @param {Array} userSources - Sources to scrape
 * @param {Object} extractionLimits - Optional extraction limits override
 */
async function scrapeForUser(userId, userSources, extractionLimits) {
  logger.info(`Starting scrape cycle for user ${userId}...`);
  
  // Initialize progress tracking
  initProgress(userId, userSources);
  
  // Mark all existing "new" leads as old before scraping new ones
  try {
    const result = await dbRun('UPDATE leads SET is_new = 0 WHERE user_id = ? AND is_new = 1', [userId]);
    logger.info(`Marked ${result.changes} existing leads as old for user ${userId}`);
  } catch (err) {
    logger.error(`Failed to mark old leads: ${err.message}`);
  }
  
  let totalInserted = 0;
  const SOURCES = userSources;
  
  for (const source of SOURCES) {
    // Check if user requested stop
    if (shouldStopScraping(userId)) {
      logger.info(`🛑 Scraping stopped by user ${userId} request`);
      updateProgress(userId, { 
        status: 'stopped',
        currentSource: 'Stopped by user'
      });
      break;
    }
    
    // Apply extraction limits for this source
    // Merges source-level limits with per-scrape overrides
    const sourceLimits = source.extractionLimits || {};
    const limits = mergeLimits(sourceLimits, extractionLimits);
    logLimits(limits, source.name);
    
    // Update progress: starting new source
    updateProgress(userId, { currentSource: source.name });
    
    // Get rate limiter for this source
    const rateLimiter = getRateLimiter(source);
    
    // Get timing configuration
    const timings = getTimings(source);
    
    try {
      // Random delay between sources (10-30 seconds)
      const delayBetweenSources = Math.random() * 20000 + 10000;
      if (SOURCES.indexOf(source) > 0) {
        logger.info(`⏳ Random delay: ${Math.round(delayBetweenSources/1000)}s before scraping ${source.name}`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenSources));
      }
      
      // Apply rate limiting
      await rateLimiter.waitIfNeeded();
      
      logger.info(`\n══════════════════════════════════════════`);
      logger.info(`🔎 Starting source: ${source.name} (User ${userId})`);
      logger.info(`══════════════════════════════════════════`);
      logger.info(`📋 Source Configuration:`);
      logger.info(`   URL: ${source.url}`);
      logger.info(`   Method: ${source.method || 'html'}`);
      logger.info(`   Use AI: ${source.useAI}`);
      logger.info(`   Use Playwright: ${source.usePlaywright}`);
      logger.info(`   AI Prompt: ${source.aiPrompt ? `"${source.aiPrompt.substring(0, 150)}${source.aiPrompt.length > 150 ? '...' : ''}"` : 'NOT SET'}`);
      if (source.fieldSchema && Object.keys(source.fieldSchema).length > 0) {
        logger.info(`   Field Schema: ${Object.keys(source.fieldSchema).join(', ')}`);
      }
      
      let data;
      let usedPlaywright = false;
      let aiExtractionUsed = false;
      let newLeads = 0;
      
      // Playwright scraping for dynamic sites
      if (source.usePlaywright || source.method === 'playwright') {
        logger.info(`Using Playwright for ${source.name}`);
        logger.info(`🔧 AI extraction enabled: ${source.useAI ? 'YES' : 'NO'}`);
        if (source.aiPrompt) {
          logger.info(`🤖 AI Autonomous Navigation: ENABLED`);
          logger.info(`📝 User Prompt: "${source.aiPrompt.substring(0, 100)}${source.aiPrompt.length > 100 ? '...' : ''}"`);
        } else {
          logger.info(`🤖 AI Autonomous Navigation: DISABLED (no prompt provided)`);
        }
        logger.info(`📸 Screenshot capture will be used for AI vision`);
        
        let browser, context, page;
        
        try {
          // Launch browser with anti-detection
          const baseArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
          ];
          const extraArgs = (process.env.PLAYWRIGHT_CHROMIUM_ARGS || '')
            .split(',')
            .map(arg => arg.trim())
            .filter(Boolean);
          const launchOptions = {
            headless: process.env.PLAYWRIGHT_HEADLESS === 'false' ? false : true,
            args: [...baseArgs, ...extraArgs]
          };
          
          const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
            || process.env.PLAYWRIGHT_EXECUTABLE_PATH;
          if (executablePath) {
            launchOptions.executablePath = executablePath;
            logger.info(`🚀 Using custom Chromium: ${executablePath}`);
          }
          
          logger.info(`🎬 Launching browser (headless: ${launchOptions.headless})...`);
          browser = await chromium.launch(launchOptions);
          context = await browser.newContext({
            viewport: { width: 2560, height: 1440 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            extraHTTPHeaders: {
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
              'Accept-Encoding': 'gzip, deflate, br',
              'Cache-Control': 'no-cache',
              'Pragma': 'no-cache',
              'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
              'Sec-Ch-Ua-Mobile': '?0',
              'Sec-Ch-Ua-Platform': '"Windows"',
              'Sec-Fetch-Dest': 'document',
              'Sec-Fetch-Mode': 'navigate',
              'Sec-Fetch-Site': 'none',
              'Sec-Fetch-User': '?1',
              'Upgrade-Insecure-Requests': '1'
            },
            ignoreHTTPSErrors: true
          });
          page = await context.newPage();
          
          // 🛡️ BLOCK POP-UPS BEFORE NAVIGATION
          await setupPopupBlocking(page);
          
          // Quick connectivity check
          logger.info(`🔍 Testing connectivity to ${source.url}...`);
          try {
            const testResponse = await axios.head(source.url, { 
              timeout: 15000,
              validateStatus: () => true, // Accept any status
              maxRedirects: 5,
              ...axiosProxyConfig
            });
            logger.info(`✅ Site reachable (HTTP ${testResponse.status})`);
          } catch (testError) {
            logger.warn(`⚠️ Pre-flight check failed: ${testError.message}`);
            logger.warn(`⚠️ Will still attempt browser navigation...`);
          }
          
          // Navigate to page with proper wait strategy
          logger.info(`🌐 Navigating to ${source.url}...`);
          
          let navigationSuccess = false;
          let lastError = null;
          const maxRetries = 2;
          
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
              if (attempt > 1) {
                logger.info(`🔄 Navigation attempt ${attempt}/${maxRetries}...`);
                // Wait a bit before retrying
                await page.waitForTimeout(3000);
              }
              
              // Use domcontentloaded for faster, more reliable loading
              await page.goto(source.url, { 
                waitUntil: 'domcontentloaded',
                timeout: 30000  // 30s timeout
              });
              logger.info(`✅ Page loaded (domcontentloaded): ${source.url}`);
              
              // Give JS time to initialize
              await page.waitForTimeout(3000);
              
              navigationSuccess = true;
              break;
            } catch (navError) {
              lastError = navError;
              
              if (navError.message.includes('Timeout') || navError.message.includes('timeout')) {
                // Fallback: try with 'load' wait strategy for very slow sites
                logger.warn(`⚠️ domcontentloaded timeout, retrying with 'load' strategy...`);
                try {
                  await page.goto(source.url, { 
                    waitUntil: 'load',
                    timeout: 60000 
                  });
                  logger.info(`✅ Page loaded (load): ${source.url}`);
                  // Give extra time for JS to initialize
                  await page.waitForTimeout(3000);
                  navigationSuccess = true;
                  break;
                } catch (loadError) {
                  lastError = loadError;
                  logger.error(`❌ 'load' strategy also failed: ${loadError.message}`);
                  
                  if (attempt < maxRetries && !loadError.message.includes('ERR_CONNECTION')) {
                    logger.info(`🔄 Will retry navigation...`);
                    continue;
                  }
                }
              } else if (navError.message.includes('ERR_CONNECTION') || navError.message.includes('net::')) {
                logger.error(`❌ Network connection error: ${navError.message}`);
                if (attempt < maxRetries) {
                  logger.info(`⏳ Waiting 10 seconds before retry...`);
                  await page.waitForTimeout(10000);
                  continue;
                }
              } else {
                throw navError;
              }
            }
          }
          
          if (!navigationSuccess) {
            const errorMsg = lastError?.message || 'Unknown error';
            logger.error(`❌ NAVIGATION FAILED after ${maxRetries} attempts`);
            logger.error(`   URL: ${source.url}`);
            logger.error(`   Error: ${errorMsg}`);
            
            // Provide helpful diagnostics
            if (errorMsg.includes('ERR_CONNECTION_TIMED_OUT') || errorMsg.includes('ERR_CONNECTION')) {
              logger.error(`   🔍 Possible causes:`);
              logger.error(`      1. Site may be down or unreachable from this server`);
              logger.error(`      2. Site may be blocking automated access`);
              logger.error(`      3. Network firewall may be blocking the connection`);
              logger.error(`      4. Try accessing the URL in a regular browser to verify it works`);
            }
            
            throw new Error(`Failed to load page after ${maxRetries} attempts: ${errorMsg}`);
          }
          
          // Brief wait for JS-heavy sites to fully render
          await page.waitForTimeout(2000);

          // 🛡️ COMPREHENSIVE POP-UP REMOVAL (replaces manual consent handling)
          await preventAllPopups(page, {
            waitBetweenSteps: 1000,
            retries: 2
          });
          
          // === AI AUTONOMOUS NAVIGATION ===
          let paginationInfo = null;
          // Support both aiNavigationPrompts (array) and aiPrompt (string) for backward compatibility
          const aiPrompts = source.aiNavigationPrompts || (source.aiPrompt ? [source.aiPrompt] : null);
          
          if (aiPrompts && aiPrompts.length > 0 && isNavigatorAvailable()) {
            const navigationPrompt = aiPrompts.join('\n');
            logger.info(`🤖 AI Navigation prompts detected (${aiPrompts.length} steps) - starting autonomous navigation...`);
            logger.info(`📝 Prompts:\n${aiPrompts.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}`);
            
            const navResult = await navigateAutonomously(page, navigationPrompt, {
              maxRetries: 1,
              takeInitialScreenshot: true
            });
            
            if (navResult.success) {
              logger.info(`✅ AI navigation completed successfully`);
              if (navResult.paginationInfo) {
                paginationInfo = navResult.paginationInfo;
                logger.info(`📄 Pagination detected: will process up to ${paginationInfo.maxPages} pages`);
              }
            } else {
              logger.warn(`⚠️ AI navigation encountered issues: ${navResult.error || 'Unknown error'}`);
              logger.info(`📸 Will continue with screenshot extraction...`);
            }
            
            // Wait for page to stabilize after navigation
            await page.waitForTimeout(2000);
          } else if (aiPrompts && aiPrompts.length > 0 && !isNavigatorAvailable()) {
            logger.warn(`⚠️ AI Navigation prompts provided but Gemini API not configured`);
            logger.warn(`⚠️ Set GEMINI_API_KEY in .env to enable autonomous navigation`);
          }
          
          // === PAGINATION & FULL SCROLL SUPPORT ===
          if (source.useAI) {
            aiExtractionUsed = true;
            logger.info(`📸 Starting multi-page AI extraction with full scrolling...`);
            
            let pageNumber = 1;
            let hasMorePages = true;
            let totalRowsExtracted = 0;
            
            while (hasMorePages && !isPageLimitReached(pageNumber, limits)) {
              logger.info(`📄 Processing page ${pageNumber}/${limits.maxPages}...`);
              
              // === CAPTURE FULL-PAGE SCREENSHOT (handles scrolling internally) ===
              logger.info(`📸 Capturing full-page screenshot (page ${pageNumber})...`);
              const screenshotData = await captureTiledScreenshots(page, {
                maxScrolls: 25,
                scrollDelay: 2000,
                loadWaitTime: 5000,
                useFullPage: true,
                tileRows: 2,
                tileCols: 3,
                overlapPct: 0.1,
                maxTiles: 6
              });

              const tiles = Array.isArray(screenshotData?.tiles) ? screenshotData.tiles : null;
              const composite = screenshotData?.compositeBuffer || null;
              const screenshot = composite || (tiles && tiles.length > 0 ? tiles[0].buffer : screenshotData);
              
              // Save screenshot for debugging
              try {
                // Ensure screenshot directory exists
                if (!fs.existsSync(SCREENSHOT_DIR)) {
                  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
                  logger.info(`📁 Created screenshot directory: ${SCREENSHOT_DIR}`);
                }
                
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
                const screenshotPath = path.join(SCREENSHOT_DIR, `${source.name.replace(/[^a-z0-9]/gi, '_')}-page${pageNumber}-${timestamp}.png`);
                
                if (!screenshot || screenshot.length === 0) {
                  logger.error(`❌ Screenshot buffer is empty or null`);
                } else {
                  if (composite) {
                    fs.writeFileSync(screenshotPath, composite);
                    logger.info(`💾 Composite screenshot saved: ${screenshotPath}`);
                    logger.info(`📊 Composite size: ${Math.round(composite.length / 1024)}KB`);
                  }

                  if (tiles && tiles.length > 0) {
                    tiles.forEach((tile, idx) => {
                      const tilePath = screenshotPath.replace('.png', `-tile${idx + 1}.png`);
                      fs.writeFileSync(tilePath, tile.buffer);
                    });
                    const totalTileBytes = tiles.reduce((sum, t) => sum + t.buffer.length, 0);
                    logger.info(`💾 ${tiles.length} tiles saved (total: ${Math.round(totalTileBytes / 1024)}KB)`);
                  } else if (!composite) {
                    fs.writeFileSync(screenshotPath, screenshot);
                    logger.info(`💾 Screenshot saved: ${screenshotPath}`);
                    logger.info(`📊 Screenshot size: ${Math.round(screenshot.length / 1024)}KB`);
                  }
                }
              } catch (screenshotError) {
                logger.error(`❌ Failed to save screenshot: ${screenshotError.message}`);
                logger.error(`Stack: ${screenshotError.stack}`);
              }
              
              // === EXTRACT WITH AI ===
              logger.info(`🤖 Extracting leads from page ${pageNumber} with AI...`);
              if (composite) {
                logger.info(`📊 Composite size: ${Math.round(composite.length / 1024)}KB`);
              }
              if (tiles && tiles.length > 0) {
                const totalTileBytes = tiles.reduce((sum, t) => sum + t.buffer.length, 0);
                logger.info(`📊 Screenshot tiles: ${tiles.length} (${Math.round(totalTileBytes / 1024)}KB total)`);
              } else {
                logger.info(`📊 Screenshot size: ${Math.round(screenshot.length / 1024)}KB`);
              }
              logger.info(`🔍 Field schema: ${source.fieldSchema ? Object.keys(source.fieldSchema).join(', ') : 'default'}`);

              // ✅ Pass single composite buffer to AI (not the tiled object structure)
              // 'screenshot' is already properly extracted as composite or first tile
              logger.info(`📤 Passing ${Buffer.isBuffer(screenshot) ? 'Buffer' : typeof screenshot} to AI extraction`);
              const aiLeads = await extractLeadWithAI(screenshot, source.name, source.fieldSchema);
              
              if (aiLeads && Array.isArray(aiLeads)) {
                logger.info(`✅ AI extracted ${aiLeads.length} leads from page ${pageNumber}`);
                if (aiLeads.length > 0) {
                  logger.info('🔍 First 3 leads extracted:');
                  aiLeads.slice(0, 3).forEach((lead, idx) => {
                    const permit = lead?.permit_number || lead?.permitNumber || lead?.number || 'N/A';
                    const address = lead?.address || lead?.location || 'N/A';
                    logger.info(`  ${idx + 1}. Permit: ${permit}, Address: ${address}`);
                  });
                }
                
                // Log first lead for debugging
                if (aiLeads.length > 0) {
                  logger.info(`🔍 First lead sample: ${JSON.stringify(aiLeads[0])}`);
                }
                
                // Track rows extracted and apply limits
                let rowsThisPage = 0;
                for (const lead of aiLeads) {
                  // Check per-page row limit
                  if (isRowLimitReached(rowsThisPage, limits)) {
                    logger.info(`⚠️ Per-page limit reached: stopping at ${rowsThisPage} rows`);
                    break;
                  }
                  
                  // Check total row limit
                  if (isTotalRowLimitReached(totalRowsExtracted, limits)) {
                    logger.info(`⚠️ Total row limit reached: stopping at ${totalRowsExtracted} rows`);
                    hasMorePages = false;
                    break;
                  }
                  
                  if (await insertLeadIfNew({
                    raw: JSON.stringify(lead),
                    sourceName: source.name,
                    lead,
                    extractedData: lead,
                    userId,
                    sourceId: source._sourceId || source.id,
                    sourceUrl: source.url
                  })) {
                    newLeads++;
                    rowsThisPage++;
                    totalRowsExtracted++;
                    logger.debug(`Row ${totalRowsExtracted}: inserted`);
                  }
                }
                
                logger.info(`✅ Page ${pageNumber}: ${rowsThisPage} rows extracted (total: ${totalRowsExtracted})`);
              } else {
                logger.warn(`⚠️ No leads extracted from page ${pageNumber}`);
                logger.warn(`⚠️ AI returned: ${JSON.stringify(aiLeads)}`);
              }
              
              // Check if we hit total row limit
              if (isTotalRowLimitReached(totalRowsExtracted, limits)) {
                logger.info(`📊 Total row limit reached (${totalRowsExtracted}). Stopping pagination.`);
                break;
              }
              
              // === CHECK FOR NEXT PAGE (using AI navigator if available) ===
              let nextPageExists = false;
              
              if (paginationInfo) {
                // Use AI navigator's smart pagination
                logger.info(`🤖 Using AI-guided pagination...`);
                nextPageExists = await clickNextPage(page, paginationInfo);
                
                if (nextPageExists) {
                  pageNumber++;
                  logger.info(`✅ Navigated to page ${pageNumber}`);
                  continue; // Skip to next iteration
                } else {
                  logger.info(`📄 No more pages (AI navigator)`);
                  hasMorePages = false;
                  break;
                }
              }
              
              // Fallback: Traditional pagination detection
              const nextPageFound = await page.evaluate(() => {
                // Try multiple selectors for "Next" button - many sites use different conventions
                const selectors = [
                  // ArcGIS Hub pagination patterns
                  'button[data-test-id="table-pagination-next-button"]',
                  'button[aria-label="Next page"]',
                  'button[title="Next page"]',
                  'calcite-pagination button[aria-label="Next"]',
                  '[class*="pagination"] button:not([disabled])[aria-label*="next" i]',
                  
                  // Standard pagination
                  'a[title*="Next" i]',
                  'button[title*="Next" i]',
                  'a[aria-label*="Next" i]',
                  'button[aria-label*="Next" i]',
                  '.pagination a:not(.disabled)',
                  'a.next:not(.disabled)',
                  'button.next:not(:disabled)',
                  
                  // ArcGIS Hub patterns (common for government data)
                  'button[aria-label*="next" i]',
                  'a[class*="next"]:not(.disabled)',
                  '.pages a:not(.disabled)',
                  'a.page-next:not(.disabled)',
                  '[class*="pagination"] button[aria-label*="next" i]',
                  
                  // Show More / Load More patterns
                  'button:contains("Show More")',
                  'button:contains("Load More")',
                  'a:contains("Show More")',
                  'a:contains("Load More")',
                  
                  // Icon-based pagination
                  'img[alt="Next"]',
                  'a[href*="page"] img[src*="arrow"]',
                  'button svg[class*="arrow"]'
                ];
                
                // Log all pagination-related elements for debugging
                const allButtons = Array.from(document.querySelectorAll('a, button'));
                const paginationButtons = allButtons
                  .filter(b => b.offsetParent !== null)
                  .map(b => ({
                    tag: b.tagName,
                    text: b.textContent.trim().substring(0, 30),
                    class: b.className,
                    ariaLabel: b.getAttribute('aria-label'),
                    disabled: b.disabled || b.classList.contains('disabled')
                  }))
                  .filter(b => 
                    b.text.toLowerCase().includes('next') ||
                    b.text.toLowerCase().includes('more') ||
                    b.text.toLowerCase().includes('load') ||
                    b.text === '›' || b.text === '>' ||
                    (b.ariaLabel && (b.ariaLabel.toLowerCase().includes('next') || b.ariaLabel.toLowerCase().includes('page')))
                  );
                
                console.log('📊 Found potential pagination buttons:', paginationButtons);
                
                for (const sel of selectors) {
                  try {
                    // Skip :contains() since it's jQuery - handle separately
                    if (!sel.includes(':contains')) {
                      const elems = document.querySelectorAll(sel);
                      for (const elem of elems) {
                        if (elem && elem.offsetParent !== null) {
                          const isDisabled = elem.disabled || 
                                           elem.classList.contains('disabled') || 
                                           elem.getAttribute('aria-disabled') === 'true';
                          
                          if (!isDisabled) {
                            return { found: true, selector: sel, buttons: paginationButtons };
                          }
                        }
                      }
                    }
                  } catch(e) {}
                }
                
                // Text-based search as fallback (enhanced to find "Show More" / "Load More")
                const links = Array.from(document.querySelectorAll('a, button'));
                const next = links.find(e => {
                  const text = e.textContent.trim().toLowerCase();
                  return (text === 'next' || text === '›' || text === '>' || text === '→' || 
                          text.includes('next') || text.includes('show more') || text.includes('load more')) &&
                         e.offsetParent !== null && 
                         !e.disabled && 
                         !e.classList.contains('disabled');
                });
                
                return next ? { found: true, selector: 'text-based', buttons: paginationButtons } : { found: false, selector: null, buttons: paginationButtons };
              });
              
              logger.info(`📍 Pagination check: nextPageFound=${nextPageFound.found}, selector=${nextPageFound.selector}`);
              if (nextPageFound.buttons && nextPageFound.buttons.length > 0) {
                logger.info(`📊 Available pagination buttons: ${JSON.stringify(nextPageFound.buttons)}`);
              } else {
                logger.warn(`⚠️ No pagination buttons found on page`);
              }
              
              if (nextPageFound.found) {
                logger.info(`➡️ Found Next button (${nextPageFound.selector}), navigating to page ${pageNumber + 1}...`);
                
                try {
                  // Capture URL and content before click to verify navigation
                  const urlBefore = page.url();
                  const contentHashBefore = await page.evaluate(() => document.body.innerText.substring(0, 1000));
                  
                  // Click next button
                  if (nextPageFound.selector === 'text-based') {
                    await page.evaluate(() => {
                      const links = Array.from(document.querySelectorAll('a, button'));
                      const next = links.find(e => {
                        const text = e.textContent.trim().toLowerCase();
                        return (text === 'next' || text === '›' || text === '>' || text === '→' || 
                                text.includes('show more') || text.includes('load more')) &&
                               e.offsetParent !== null;
                      });
                      if (next) {
                        console.log('🖱️ Clicking pagination button:', next.textContent.trim());
                        next.click();
                      }
                    });
                  } else {
                    logger.info(`🖱️ Clicking selector: ${nextPageFound.selector}`);
                    await page.click(nextPageFound.selector);
                  }
                  
                  // Wait for navigation or content change
                  const navigationResult = await Promise.race([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => ({ timedOut: true })),
                    new Promise(resolve => setTimeout(resolve, 5000)).then(() => ({ waited: true }))
                  ]);
                  
                  const urlAfter = page.url();
                  const contentHashAfter = await page.evaluate(() => document.body.innerText.substring(0, 1000));
                  
                  // Check if page actually changed
                  const urlChanged = urlBefore !== urlAfter;
                  const contentChanged = contentHashBefore !== contentHashAfter;
                  
                  logger.info(`✅ Navigation result: URL changed=${urlChanged}, Content changed=${contentChanged}`);
                  logger.info(`📍 URL: ${urlBefore} → ${urlAfter}`);
                  
                  if (!urlChanged && !contentChanged) {
                    logger.warn(`⚠️ Page didn't change after clicking pagination - may have reached the end`);
                    hasMorePages = false;
                  } else {
                    logger.info(`✅ Successfully navigated to page ${pageNumber + 1}`);
                    pageNumber++;
                    
                    // Wait for new content to fully load
                    await new Promise(resolve => setTimeout(resolve, 3000));
                  }
                  
                } catch (navErr) {
                  logger.warn(`⚠️ Failed to navigate to next page: ${navErr.message}`);
                  logger.warn(`Stack trace: ${navErr.stack}`);
                  hasMorePages = false;
                }
              } else {
                logger.info(`✓ No more pages found (processed ${pageNumber} page(s) total)`);
                hasMorePages = false;
              }
            }
            
            if (isPageLimitReached(pageNumber, limits)) {
              logger.warn(`⚠️ Reached max page limit (${limits.maxPages})`);
            }
            
            logger.info(`✅ Multi-page extraction complete: ${newLeads} total leads from ${pageNumber} page(s)`);
            
          } else {
            // Get HTML (non-AI mode)
            data = await page.content();
            usedPlaywright = true;
          }
          
        } catch (err) {
          logger.error(`Playwright failed for ${source.name}: ${err.message}`);
        } finally {
          if (page) await page.close().catch(() => {});
          if (context) await context.close().catch(() => {});
          if (browser) await browser.close().catch(() => {});
        }
      }
      
      // Axios scraping for APIs and static sites (skip if AI extraction already handled it)
      // Also skip if forcePlaywrightOnly is enabled (Playwright-only mode)
      if (!aiExtractionUsed && !usedPlaywright && !data && !source.forcePlaywrightOnly) {
        try {
          const response = await axios.get(source.url, {
            timeout: 30000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
          });
          data = response.data;
          logger.info(`Axios loaded: ${source.url}`);
        } catch (err) {
          logger.error(`Axios failed for ${source.name}: ${err.message}`);
          continue;
        }
      }
      
      // If forcePlaywrightOnly but no data yet, log warning
      if (source.forcePlaywrightOnly && !data && !usedPlaywright) {
        logger.warn(`⚠️ Source ${source.name} has forcePlaywrightOnly enabled but Playwright didn't produce data. Skipping.`);
        continue;
      }
      
      // Process JSON APIs
      if (source.type === 'json' && typeof data === 'object' && Array.isArray(data)) {
        logger.info(`Processing ${data.length} JSON records from ${source.name}`);
        
        for (const item of data) {
          const lead = {
            permit_number: item.permit_number || item.Permit__ || 'N/A',
            address: item.address || item.Address || 'N/A',
            value: item.value || item.Value || 'N/A',
            description: item.description || item.Details || 'N/A',
            phone: item.phone || null,
            page_url: source.url
          };
          
          if (await insertLeadIfNew({ 
            raw: JSON.stringify(item),
            sourceName: source.name,
            lead,
            extractedData: lead,
            userId,
            sourceId: source._sourceId || source.id,
            sourceUrl: source.url
          })) {
            newLeads++;
          }
        }
      }
      
      // Process HTML
      if (typeof data === 'string' && source.selector) {
        const $ = cheerio.load(data);
        const matches = $(source.selector);
        logger.info(`Found ${matches.length} matches for ${source.selector}`);
        
        for (const el of matches.toArray()) {
          const raw = $(el).text().trim();
          
          if (!textPassesFilters(raw, source)) continue;
          
          // Try AI extraction
          let lead;
          if (source.useAI) {
            lead = await extractLeadWithAI(raw, source.name, source.fieldSchema);
          }
          
          // Fallback to pattern matching
          if (!lead) {
            const phoneMatch = raw.match(/\b(?:\+?1[\-.\s]?)?(?:\(?\d{3}\)?[\-.\s]?\d{3}[\-.\s]?\d{4})\b/);
            lead = {
              permit_number: raw.match(/[A-Z]?\d{5,12}[A-Z]?/i)?.[0] || 'N/A',
              address: raw.match(/\d{3,6}\s+.{5,70}(St|Rd|Ave|Blvd|Dr|Ln|Ct)/i)?.[0] || 'Check manually',
              value: raw.match(/\$[\d,]+/g)?.[0] || 'N/A',
              description: raw.substring(0, 300),
              phone: phoneMatch?.[0] || null,
              page_url: source.url
            };
          }
          
          if (await insertLeadIfNew({
            raw,
            sourceName: source.name,
            lead,
            extractedData: lead,
            userId,
            sourceId: source._sourceId || source.id,
            sourceUrl: source.url
          })) {
            newLeads++;
          }
        }
      }
      
      totalInserted += newLeads;
      logger.info(`✅ ${source.name}: ${newLeads} new leads`);
      
      // Track reliability - mark as success only if we extracted leads OR if using AI extraction method
      const isSuccess = newLeads > 0 || aiExtractionUsed;
      await trackSourceReliability(source._sourceId || source.id, source.name, isSuccess, newLeads);
      
      // Mark rate limiter success
      rateLimiter.onSuccess();
      
      // Update progress
      const progress = getProgress(userId);
      if (progress) {
        progress.completedSources++;
        progress.leadsFound = totalInserted;
      }
      
    } catch (err) {
      logger.error(`Failed ${source.name}: ${err.message}`);
      await trackSourceReliability(source._sourceId || source.id, source.name, false, 0);
      
      const progress = getProgress(userId);
      if (progress) {
        progress.completedSources++;
        progress.errors.push({ source: source.name, error: err.message });
      }
    }
  }
  
  logger.info(`\n✅ Scrape cycle finished for user ${userId}. Total: ${totalInserted} leads\n`);
  
  // Mark scraping as complete
  updateProgress(userId, { 
    status: 'completed',
    endTime: Date.now(),
    leadsFound: totalInserted
  });
  
  // Create notification
  if (SOURCES.length > 0) {
    const sourceNames = SOURCES.map(s => s.name).join(', ');
    if (totalInserted > 0) {
      await createNotification(
        userId,
        'scrape_success',
        `✅ Scraped ${SOURCES.length} source(s) and found ${totalInserted} new lead(s): ${sourceNames}`
      );
    } else {
      await createNotification(
        userId,
        'scrape_no_new',
        `✓ Scraped ${SOURCES.length} source(s) - no new leads (all duplicates): ${sourceNames}`
      );
    }
  }
  
  return totalInserted;
}

module.exports = {
  scrapeForUser,
  PROXY_ENABLED,
  PROXY_URL,
  proxyAgent,
  axiosProxyConfig
};
