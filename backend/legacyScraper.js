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
      let newLeads = 0;
      
      // Puppeteer scraping for dynamic sites
      if (source.usePuppeteer || source.method === 'puppeteer') {
        logger.info(`Using Puppeteer for ${source.name}`);
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
          }
          
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
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
              const screenshotPath = path.join(SCREENSHOT_DIR, `${source.name.replace(/[^a-z0-9]/gi, '_')}-page${pageNumber}-${timestamp}.png`);
              fs.writeFileSync(screenshotPath, screenshot);
              logger.info(`💾 Screenshot saved: ${screenshotPath}`);
              
              // === EXTRACT WITH AI ===
              logger.info(`🤖 Extracting leads from page ${pageNumber} with AI...`);
              const aiLeads = await extractLeadWithAI(screenshot, source.name, source.fieldSchema);
              
              if (aiLeads && Array.isArray(aiLeads)) {
                logger.info(`✅ AI extracted ${aiLeads.length} leads from page ${pageNumber}`);
                for (const lead of aiLeads) {
                  if (await insertLeadIfNew({
                    raw: JSON.stringify(lead),
                    sourceName: source.name,
                    lead,
                    userId,
                    sourceId: source._sourceId || source.id
                  })) {
                    newLeads++;
                  }
                }
              } else {
                logger.warn(`⚠️ No leads extracted from page ${pageNumber}`);
              }
              
              // === CHECK FOR NEXT PAGE ===
              const nextPageFound = await page.evaluate(() => {
                // Try multiple selectors for "Next" button
                const selectors = [
                  'a[title*="Next" i]',
                  'button[title*="Next" i]',
                  'a[aria-label*="Next" i]',
                  'button[aria-label*="Next" i]',
                  'a:contains("Next")',
                  'button:contains("Next")',
                  '.pagination a:not(.disabled)',
                  'a.next:not(.disabled)',
                  'button.next:not(:disabled)',
                  'img[alt="Next"]'
                ];
                
                for (const sel of selectors) {
                  try {
                    const elem = document.querySelector(sel);
                    if (elem && elem.offsetParent !== null) {
                      const isDisabled = elem.disabled || 
                                       elem.classList.contains('disabled') || 
                                       elem.getAttribute('aria-disabled') === 'true';
                      
                      if (!isDisabled) {
                        return { found: true, selector: sel };
                      }
                    }
                  } catch(e) {}
                }
                
                // Text-based search as fallback
                const links = Array.from(document.querySelectorAll('a, button'));
                const next = links.find(e => {
                  const text = e.textContent.trim().toLowerCase();
                  return (text === 'next' || text === '›' || text === '>' || text === '→') &&
                         e.offsetParent !== null && 
                         !e.disabled && 
                         !e.classList.contains('disabled');
                });
                
                return next ? { found: true, selector: 'text-based' } : { found: false };
              });
              
              if (nextPageFound.found) {
                logger.info(`➡️ Found Next button (${nextPageFound.selector}), navigating to page ${pageNumber + 1}...`);
                
                try {
                  // Click next button
                  if (nextPageFound.selector === 'text-based') {
                    await page.evaluate(() => {
                      const links = Array.from(document.querySelectorAll('a, button'));
                      const next = links.find(e => {
                        const text = e.textContent.trim().toLowerCase();
                        return (text === 'next' || text === '›' || text === '>' || text === '→') &&
                               e.offsetParent !== null;
                      });
                      if (next) next.click();
                    });
                  } else {
                    await page.click(nextPageFound.selector);
                  }
                  
                  // Wait for navigation or content change
                  await Promise.race([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null),
                    new Promise(resolve => setTimeout(resolve, 3000))
                  ]);
                  
                  logger.info(`✅ Navigated to page ${pageNumber + 1}`);
                  pageNumber++;
                  
                  // Wait for new page to load
                  await new Promise(resolve => setTimeout(resolve, 2000));
                  
                } catch (navErr) {
                  logger.warn(`⚠️ Failed to navigate to next page: ${navErr.message}`);
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
      
      // Axios scraping for APIs and static sites
      if (!usedPuppeteer && !data) {
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
            userId,
            sourceId: source._sourceId || source.id
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
            userId,
            sourceId: source._sourceId || source.id
          })) {
            newLeads++;
          }
        }
      }
      
      totalInserted += newLeads;
      logger.info(`✅ ${source.name}: ${newLeads} new leads`);
      
      // Track reliability
      await trackSourceReliability(source._sourceId || source.id, source.name, true, newLeads);
      
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
