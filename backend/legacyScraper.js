/**
 * LEGACY SCRAPER WRAPPER - Updated for New AI Architecture
 * 
 * Handles:
 * - JSON API scraping (ArcGIS, Socrata, etc.)
 * - Playwright browser automation
 * - HTML parsing with Cheerio
 * - AI vision extraction (using new architecture)
 * - Smart Grid Scraper (12-tile progressive capture)
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

// ✅ NEW: AI services from new architecture
const { 
  isAIAvailable,
  navigateAutonomously,
  extractFromScreenshot 
} = require('./services/ai');

// ✅ SMART GRID SCRAPER (12-tile progressive capture)
const { scrapeWithSmartGrid } = require('./services/scraper/smartGridScraper');
// ✅ SCREENSHOT CAPTURE SERVICE
const { captureTiledScreenshots } = require('./services/scraper/screenshot');


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
const { SCREENSHOT_DIR } = require('./config/paths');

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

/**
 * Main scraping function
 */
async function scrapeForUser(userId, userSources, extractionLimits) {
  logger.info(`Starting scrape cycle for user ${userId}...`);
  
  // Initialize progress tracking
  initProgress(userId, userSources);
  
  // Mark all existing "new" leads as old
  try {
    const result = await dbRun('UPDATE leads SET is_new = 0 WHERE user_id = ? AND is_new = 1', [userId]);
    logger.info(`Marked ${result.changes} existing leads as old for user ${userId}`);
  } catch (err) {
    logger.error(`Failed to mark old leads: ${err.message}`);
  }
  
  let totalInserted = 0;
  const SOURCES = userSources;
  
  logger.info(`\n📊 Starting scrape for user ${userId}`);
  logger.info(`Found ${SOURCES.length} sources to scrape\n`);
  
  for (const sourceRow of SOURCES) {
    // ========================================
    // 🐛 DEBUG: INSPECT SOURCE STRUCTURE
    // ========================================
    logger.info(`\n🔍 ========================================`);
    logger.info(`🔍 DEBUG: RAW SOURCE FROM DATABASE`);
    logger.info(`🔍 ========================================`);
    logger.info(`Source ID: ${sourceRow.id}`);
    logger.info(`Raw source keys: ${Object.keys(sourceRow).join(', ')}`);
    
    let source;
    
    // Check if source_data field exists
    if (sourceRow.source_data) {
      logger.info(`✅ Has source_data field`);
      logger.info(`   Type: ${typeof sourceRow.source_data}`);
      
      if (typeof sourceRow.source_data === 'string') {
        logger.info(`   Attempting to parse JSON...`);
        try {
          source = JSON.parse(sourceRow.source_data);
          logger.info(`   ✅ Parsed successfully!`);
          logger.info(`   Parsed keys: ${Object.keys(source).join(', ')}`);
          logger.info(`   Name: ${source.name}`);
          logger.info(`   URL: ${source.url}`);
          logger.info(`   Has fieldSchema: ${!!source.fieldSchema}`);
          logger.info(`   Has field_mapping: ${!!source.field_mapping}`);
          logger.info(`   Has field_schema: ${!!source.field_schema}`);
          
          if (source.fieldSchema) {
            logger.info(`   fieldSchema type: ${typeof source.fieldSchema}`);
            if (typeof source.fieldSchema === 'object') {
              logger.info(`   fieldSchema keys: ${Object.keys(source.fieldSchema).join(', ')}`);
            }
          }
          if (source.field_mapping) {
            logger.info(`   field_mapping type: ${typeof source.field_mapping}`);
          }
          
          // Add back database IDs
          source._sourceId = sourceRow.id;
          source._userId = sourceRow.user_id;
          source.id = sourceRow.id;
          
        } catch (parseErr) {
          logger.error(`   ❌ Parse failed: ${parseErr.message}`);
          logger.error(`   First 300 chars: ${sourceRow.source_data.substring(0, 300)}`);
          continue; // Skip this source
        }
      } else if (typeof sourceRow.source_data === 'object') {
        logger.info(`   Already an object!`);
        source = sourceRow.source_data;
        source._sourceId = sourceRow.id;
        source._userId = sourceRow.user_id;
        source.id = sourceRow.id;
        logger.info(`   Keys: ${Object.keys(source).join(', ')}`);
      }
    } else {
      logger.info(`❌ No source_data field - using source as-is`);
      source = sourceRow;
      logger.info(`   Direct keys: ${Object.keys(source).join(', ')}`);
      logger.info(`   Has name: ${!!source.name}`);
      logger.info(`   Has fieldSchema: ${!!source.fieldSchema}`);
      logger.info(`   Has field_mapping: ${!!source.field_mapping}`);
    }
    
    logger.info(`🔍 ========================================\n`);
    
    // Check if user requested stop
    if (shouldStopScraping(userId)) {
      logger.info(`🛑 Scraping stopped by user ${userId} request`);
      updateProgress(userId, { 
        status: 'stopped',
        currentSource: 'Stopped by user'
      });
      break;
    }
    
    // Apply extraction limits
    const sourceLimits = source.extractionLimits || {};
    const limits = mergeLimits(sourceLimits, extractionLimits);
    logLimits(limits, source.name);
    
    // Update progress
    updateProgress(userId, { currentSource: source.name });
    
    // Get rate limiter
    const rateLimiter = getRateLimiter(source);
    
    try {
      // Random delay between sources
      const delayBetweenSources = Math.random() * 20000 + 10000;
      if (SOURCES.indexOf(sourceRow) > 0) {
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
      if (source.fieldSchema && Object.keys(source.fieldSchema).length > 0) {
        logger.info(`   Field Schema: ${Object.keys(source.fieldSchema).join(', ')}`);
      }
      
      let data;
      let usedPlaywright = false;
      let aiExtractionUsed = false;
      let newLeads = 0;
      
      // ============================================================
      // PLAYWRIGHT SCRAPING
      // ============================================================
      if (source.usePlaywright || source.method === 'playwright') {
        logger.info(`Using Playwright for ${source.name}`);
        logger.info(`🔧 AI extraction enabled: ${source.useAI ? 'YES' : 'NO'}`);
        
        // ✅ CHECK IF SMART GRID MODE IS ENABLED
        const useSmartGrid = source.useSmartGrid !== false; // Default to true
        
        if (useSmartGrid) {
          logger.info(`🎯 Using SMART GRID SCRAPER (12-tile mode)`);
        } else {
          logger.info(`📸 Using legacy screenshot capture`);
        }
        
        let browser, context, page;
        
        try {
          // Launch browser
          const baseArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
          ];
          
          const launchOptions = {
            headless: true,
            args: baseArgs
          };
          
          const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
                                 process.env.PLAYWRIGHT_EXECUTABLE_PATH;
          if (executablePath) {
            launchOptions.executablePath = executablePath;
            logger.info(`🚀 Using custom Chromium: ${executablePath}`);
          }
          
          logger.info(`🎬 Launching browser...`);
          browser = await chromium.launch(launchOptions);
          context = await browser.newContext({
            viewport: { width: 1920, height: 1080 }, // Optimized for 12 tiles
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            ignoreHTTPSErrors: true
          });
          page = await context.newPage();
          
          // Block pop-ups
          await setupPopupBlocking(page);
          
          // ============================================================
          // SMART GRID SCRAPER MODE
          // ============================================================
          if (useSmartGrid && source.useAI) {
            logger.info(`\n🚀 ========================================`);
            logger.info(`🚀 SMART GRID SCRAPER (12-TILE)`);
            logger.info(`🚀 ========================================\n`);
            
            // Use smart grid scraper
            const gridResult = await scrapeWithSmartGrid(page, source, {
              // Tile configuration (12 tiles for high accuracy)
              columns: 3,
              rows: 4,
              totalTiles: 12,
              tileWidth: 640,
              tileHeight: 270,
              
              // Target & limits
              targetLeadCount: limits.maxTotalRows || 500,
              maxScrolls: 50,
              
              // Scrolling behavior
              scrollAmount: 1080,
              waitAfterScroll: 2000,
              stableChecks: 3,
              
              // Performance
              delayBetweenTiles: 400,
              screenshotTimeout: 3000
            });
            
            if (gridResult.success) {
              logger.info(`\n✅ Smart grid scraper completed successfully`);
              logger.info(`   Valid leads: ${gridResult.records.length}`);
              logger.info(`   Duration: ${gridResult.stats.duration}s`);
              logger.info(`   Success rate: ${gridResult.stats.successRate}%`);
              
              // Insert leads into database
              let inserted = 0;
              for (const lead of gridResult.records) {
                // Remove metadata fields before saving
                const cleanLead = { ...lead };
                delete cleanLead._metadata;
                delete cleanLead._tile;
                delete cleanLead._tileIndex;
                delete cleanLead._fillRate;
                
                if (await insertLeadIfNew({
                  raw: JSON.stringify(cleanLead),
                  sourceName: source.name,
                  lead: cleanLead,
                  extractedData: cleanLead,
                  userId,
                  sourceId: source._sourceId || source.id,
                  sourceUrl: source.url
                })) {
                  inserted++;
                  newLeads++;
                }
              }
              
              logger.info(`💾 Inserted ${inserted} new leads (${gridResult.records.length - inserted} duplicates skipped)`);
              
              aiExtractionUsed = true;
              
            } else {
              logger.error(`❌ Smart grid scraper failed: ${gridResult.error}`);
              logger.warn(`⚠️ Falling back to legacy scraping method...`);
              // Will fall through to legacy method below
            }
            
          }
          
          // ============================================================
          // LEGACY SCRAPING MODE (fallback or if smart grid disabled)
          // ============================================================
          if (!useSmartGrid || !aiExtractionUsed) {
            logger.info(`\n📸 Using legacy multi-page extraction...`);
            
            // Navigate
            logger.info(`🌐 Navigating to ${source.url}...`);
            await page.goto(source.url, { 
              waitUntil: 'domcontentloaded',
              timeout: 30000
            });
            logger.info(`✅ Page loaded`);
            
            await page.waitForTimeout(3000);
            await preventAllPopups(page);
            
            // === AI AUTONOMOUS NAVIGATION ===
            const aiPrompts = source.aiNavigationPrompts || (source.aiPrompt ? [source.aiPrompt] : null);
            
            if (aiPrompts && aiPrompts.length > 0 && isAIAvailable()) {
              const navigationPrompt = aiPrompts.join('\n');
              logger.info(`🤖 AI Navigation: ${aiPrompts.length} steps`);
              
              const navResult = await navigateAutonomously(page, navigationPrompt, {
                maxRetries: 1,
                takeScreenshot: true
              });
              
              if (navResult.success) {
                logger.info(`✅ AI navigation complete`);
              } else {
                logger.warn(`⚠️ AI navigation issues: ${navResult.error}`);
              }
              
              await page.waitForTimeout(2000);
            } else if (aiPrompts && aiPrompts.length > 0) {
              logger.warn(`⚠️ AI prompts provided but Gemini not configured`);
            }
            
            // === MULTI-PAGE EXTRACTION (LEGACY) ===
            if (source.useAI) {
              aiExtractionUsed = true;
              logger.info(`📸 Starting legacy multi-page extraction...`);
              
              let pageNumber = 1;
              let hasMorePages = true;
              let totalRowsExtracted = 0;
              
              while (hasMorePages && !isPageLimitReached(pageNumber, limits)) {
                logger.info(`📄 Processing page ${pageNumber}/${limits.maxPages}...`);
                
                // Capture screenshot
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
                
                const screenshot = screenshotData?.compositeBuffer || 
                                  screenshotData?.tiles?.[0]?.buffer || 
                                  screenshotData;
                
                // Save screenshot
                try {
                  if (!fs.existsSync(SCREENSHOT_DIR)) {
                    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
                  }
                  
                  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
                  const screenshotPath = path.join(
                    SCREENSHOT_DIR, 
                    `${source.name.replace(/[^a-z0-9]/gi, '_')}-page${pageNumber}-${timestamp}.png`
                  );
                  
                  fs.writeFileSync(screenshotPath, screenshot);
                  logger.info(`💾 Screenshot saved: ${screenshotPath}`);
                } catch (screenshotError) {
                  logger.error(`❌ Failed to save screenshot: ${screenshotError.message}`);
                }
                
                // Extract with AI
                logger.info(`🤖 Extracting leads from page ${pageNumber}...`);
                const aiLeads = await extractFromScreenshot(
                  screenshot,
                  source.name,
                  source.fieldSchema || source.field_mapping || source.field_schema || {}
                );
                
                if (aiLeads && Array.isArray(aiLeads)) {
                  logger.info(`✅ AI extracted ${aiLeads.length} leads from page ${pageNumber}`);
                  
                  let rowsThisPage = 0;
                  for (const lead of aiLeads) {
                    if (isRowLimitReached(rowsThisPage, limits)) {
                      logger.info(`⚠️ Per-page limit reached: ${rowsThisPage} rows`);
                      break;
                    }
                    
                    if (isTotalRowLimitReached(totalRowsExtracted, limits)) {
                      logger.info(`⚠️ Total limit reached: ${totalRowsExtracted} rows`);
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
                    }
                  }
                  
                  logger.info(`✅ Page ${pageNumber}: ${rowsThisPage} rows (total: ${totalRowsExtracted})`);
                } else {
                  logger.warn(`⚠️ No leads extracted from page ${pageNumber}`);
                }
                
                if (isTotalRowLimitReached(totalRowsExtracted, limits)) {
                  break;
                }
                
                // === CHECK FOR NEXT PAGE ===
                const nextPageFound = await page.evaluate(() => {
                  const selectors = [
                    'button[aria-label="Next page"]',
                    'button[title="Next page"]',
                    '.pagination a.next:not(.disabled)',
                    'button.next:not(:disabled)'
                  ];
                  
                  for (const sel of selectors) {
                    try {
                      const elem = document.querySelector(sel);
                      if (elem && !elem.disabled && !elem.classList.contains('disabled')) {
                        return { found: true, selector: sel };
                      }
                    } catch(e) {}
                  }
                  
                  return { found: false };
                });
                
                logger.info(`📍 Next page: ${nextPageFound.found}`);
                
                if (nextPageFound.found) {
                  try {
                    await page.click(nextPageFound.selector);
                    await page.waitForTimeout(3000);
                    logger.info(`✅ Navigated to page ${pageNumber + 1}`);
                    pageNumber++;
                  } catch (navErr) {
                    logger.warn(`⚠️ Failed to navigate: ${navErr.message}`);
                    hasMorePages = false;
                  }
                } else {
                  logger.info(`✓ No more pages (processed ${pageNumber} total)`);
                  hasMorePages = false;
                }
              }
              
              logger.info(`✅ Legacy extraction complete: ${newLeads} leads from ${pageNumber} page(s)`);
            }
          }
          
        } catch (err) {
          logger.error(`Playwright failed: ${err.message}`);
          logger.error(err.stack);
        } finally {
          if (page) await page.close().catch(() => {});
          if (context) await context.close().catch(() => {});
          if (browser) await browser.close().catch(() => {});
        }
        
        usedPlaywright = true;
      }
      
      // Track success
      totalInserted += newLeads;
      logger.info(`\n✅ ${source.name}: ${newLeads} new leads`);
      
      const isSuccess = newLeads > 0 || aiExtractionUsed;
      await trackSourceReliability(source._sourceId || source.id, source.name, isSuccess, newLeads);
      
      rateLimiter.onSuccess();
      
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
  
  updateProgress(userId, { 
    status: 'completed',
    endTime: Date.now(),
    leadsFound: totalInserted
  });
  
  if (userSources.length > 0) {
    const sourceNames = userSources.map(s => s.name || 'Unknown').join(', ');
    if (totalInserted > 0) {
      await createNotification(
        userId,
        'scrape_success',
        `✅ Scraped ${userSources.length} source(s) and found ${totalInserted} new lead(s): ${sourceNames}`
      );
    } else {
      await createNotification(
        userId,
        'scrape_no_new',
        `✓ Scraped ${userSources.length} source(s) - no new leads: ${sourceNames}`
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