/**
 * LEGACY SCRAPER WRAPPER - Simplified Working Version
 * 
 * Restored from commit f4025cc but simplified to work with refactored codebase.
 * Uses only the helper functions that exist in services/.
 * 
 * Handles:
 * - JSON API scraping (ArcGIS, Socrata, etc.)
 * - Puppeteer browser automation
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
const puppeteer = require('puppeteer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { ProxyAgent } = require('undici');

// Import extracted modules
const logger = require('./utils/logger');
const { dbGet, dbAll, dbRun } = require('./db');
const { insertLeadIfNew } = require('./services/leadInsertion');
const { trackSourceReliability } = require('./services/reliability');
const { createNotification } = require('./services/notifications');
const { extractLeadWithAI } = require('./services/ai');
const { captureEntirePage } = require('./services/scraper/screenshot');
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

// Initialize Google Gemini
let geminiModel = null;
if (process.env.GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
  logger.info('Google Gemini AI initialized');
}

/**
 * Main scraping function - restored from old index.js but simplified
 * to work with refactored codebase helper modules.
 */
async function scrapeForUser(userId, userSources) {
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
      
      let data;
      let usedPuppeteer = false;
      let aiExtractionUsed = false;
      let newLeads = 0;
      
      // Puppeteer scraping for dynamic sites
      if (source.usePuppeteer || source.method === 'puppeteer') {
        logger.info(`Using Puppeteer for ${source.name}`);
        logger.info(`🔧 AI extraction enabled: ${source.useAI ? 'YES' : 'NO'}`);
        logger.info(`📸 Screenshot capture will be used for AI vision`);
        
        let browser, page;
        
        try {
          // Launch browser with anti-detection
          const launchOptions = {
            headless: process.env.PUPPETEER_HEADLESS === 'false' ? false : 'new',
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-blink-features=AutomationControlled'
            ]
          };
          
          if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
            logger.info(`🚀 Using custom Chromium: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
          }
          
          logger.info(`🎬 Launching browser (headless: ${launchOptions.headless})...`);
          browser = await puppeteer.launch(launchOptions);
          page = await browser.newPage();
          await page.setViewport({ width: 2560, height: 1440 });
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
          
          // Navigate to page
          await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
          logger.info(`Loaded: ${source.url}`);
          
          // Wait for initial content
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          // === PAGINATION & FULL SCROLL SUPPORT ===
          if (source.useAI && geminiModel) {
            aiExtractionUsed = true;
            logger.info(`📸 Starting multi-page AI extraction with full scrolling...`);
            
            let pageNumber = 1;
            let hasMorePages = true;
            const maxPages = source.maxPages || 10; // Configurable max pages
            
            while (hasMorePages && pageNumber <= maxPages) {
              logger.info(`📄 Processing page ${pageNumber}/${maxPages}...`);
              
              // === AUTO-SCROLL TO LOAD ALL CONTENT ===
              logger.info(`🔄 Auto-scrolling to load lazy content...`);
              await page.evaluate(async () => {
                await new Promise((resolve) => {
                  let totalHeight = 0;
                  const distance = 500; // Scroll 500px at a time
                  const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if (totalHeight >= scrollHeight) {
                      clearInterval(timer);
                      window.scrollTo(0, 0); // Scroll back to top for screenshot
                      resolve();
                    }
                  }, 200); // Scroll every 200ms
                });
              });
              
              logger.info(`✅ Scrolling complete, page loaded`);
              
              // Wait for any final lazy-loaded content
              await new Promise(resolve => setTimeout(resolve, 2000));
              
              // === CAPTURE FULL-PAGE SCREENSHOT ===
              logger.info(`📸 Capturing full-page screenshot (page ${pageNumber})...`);
              const screenshot = await captureEntirePage(page);
              
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
                  fs.writeFileSync(screenshotPath, screenshot);
                  logger.info(`💾 Screenshot saved: ${screenshotPath}`);
                  logger.info(`📊 Screenshot size: ${Math.round(screenshot.length / 1024)}KB`);
                }
              } catch (screenshotError) {
                logger.error(`❌ Failed to save screenshot: ${screenshotError.message}`);
                logger.error(`Stack: ${screenshotError.stack}`);
              }
              
              // === EXTRACT WITH AI ===
              logger.info(`🤖 Extracting leads from page ${pageNumber} with AI...`);
              logger.info(`📊 Screenshot size: ${Math.round(screenshot.length / 1024)}KB`);
              logger.info(`🔍 Field schema: ${source.fieldSchema ? Object.keys(source.fieldSchema).join(', ') : 'default'}`);
              
              const aiLeads = await extractLeadWithAI(screenshot, source.name, source.fieldSchema);
              
              if (aiLeads && Array.isArray(aiLeads)) {
                logger.info(`✅ AI extracted ${aiLeads.length} leads from page ${pageNumber}`);
                
                // Log first lead for debugging
                if (aiLeads.length > 0) {
                  logger.info(`🔍 First lead sample: ${JSON.stringify(aiLeads[0])}`);
                }
                
                for (const lead of aiLeads) {
                  if (await insertLeadIfNew({
                    raw: JSON.stringify(lead),
                    sourceName: source.name,
                    lead,
                    extractedData: lead,  // FIX: Pass extractedData parameter
                    userId,
                    sourceId: source._sourceId || source.id,
                    sourceUrl: source.url
                  })) {
                    newLeads++;
                  }
                }
              } else {
                logger.warn(`⚠️ No leads extracted from page ${pageNumber}`);
                logger.warn(`⚠️ AI returned: ${JSON.stringify(aiLeads)}`);
              }
              
              // === CHECK FOR NEXT PAGE ===
              const nextPageFound = await page.evaluate(() => {
                // Try multiple selectors for "Next" button - many sites use different conventions
                const selectors = [
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
            
            if (pageNumber > maxPages) {
              logger.warn(`⚠️ Reached max page limit (${maxPages})`);
            }
            
            logger.info(`✅ Multi-page extraction complete: ${newLeads} total leads from ${pageNumber} page(s)`);
            
          } else {
            // Get HTML (non-AI mode)
            data = await page.content();
            usedPuppeteer = true;
          }
          
        } catch (err) {
          logger.error(`Puppeteer failed for ${source.name}: ${err.message}`);
        } finally {
          if (page) await page.close().catch(() => {});
          if (browser) await browser.close().catch(() => {});
        }
      }
      
      // Axios scraping for APIs and static sites (skip if AI extraction already handled it)
      if (!aiExtractionUsed && !usedPuppeteer && !data) {
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
            extractedData: lead,  // FIX: Pass extractedData parameter
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
          if (source.useAI && geminiModel) {
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
            extractedData: lead,  // FIX: Pass extractedData parameter
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
  geminiModel,
  PROXY_ENABLED,
  PROXY_URL,
  proxyAgent,
  axiosProxyConfig
};
