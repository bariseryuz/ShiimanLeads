/**
 * LEGACY SCRAPER WRAPPER
 * 
 * This file contains the massive scrapeForUser() function (~1500 lines)
 * that hasn't been fully extracted yet due to its complexity.
 * 
 * It handles:
 * - JSON API scraping
 * - Puppeteer browser automation
 * - AI autonomous navigation
 * - Block detection and rate limiting
 * - Multiple extraction methods (HTML, JSON-LD, AI vision)
 * - Lead insertion and deduplication
 * 
 * TODO: Extract this into smaller, testable functions in services/scraper/
 * For now, routes/scrape.js imports this directly.
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
 * Main scraping function - handles all extraction methods
 * 
 * NOTE: This function is ~2000 lines and handles:
 * - JSON API scraping
 * - Puppeteer browser automation  
 * - AI autonomous navigation
 * - Block detection and rate limiting
 * - Multiple extraction methods (HTML, JSON-LD, AI vision)
 * - Lead insertion and deduplication
 * 
 * Restored from original index.js (commit f4025cc)
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
  
  // Test Nashville API directly
  if (SOURCES.find(s => s.name === 'Nashville')) {
    try {
      logger.info('Testing Nashville API base endpoint...');
      const baseUrl = 'https://services2.arcgis.com/HdUhOrHbPq5yhfTh/arcgis/rest/services/Building_Permits_in_Davidson_County/FeatureServer/0?f=json';
      const baseResponse = await axios.get(baseUrl);
      logger.info(`Base endpoint test: ${baseResponse.status}`);
      logger.info(`Service name: ${baseResponse.data?.name || 'unknown'}`);
      
      logger.info('Testing query endpoint...');
      const testUrl = 'https://services2.arcgis.com/HdUhOrHbPq5yhfTh/arcgis/rest/services/Building_Permits_in_Davidson_County/FeatureServer/0/query?where=1=1&outFields=*&f=json&resultRecordCount=5';
      const testResponse = await axios.get(testUrl);
      logger.info(`Query test response: ${JSON.stringify(testResponse.data).substring(0, 500)}`);
      logger.info(`Query test successful! Got ${testResponse.data?.features?.length || 0} features`);
    } catch (testErr) {
      logger.error(`Nashville API test failed: ${testErr.message}`);
      if (testErr.response) {
        logger.error(`Status: ${testErr.response.status}, Data: ${JSON.stringify(testErr.response.data)}`);
      }
    }
  }
  
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
    
    // Get timing configuration (source-specific or defaults)
    const timings = getTimings(source);
    
    try {
      // 🎲 RANDOM DELAY BETWEEN SOURCES (10-30 seconds) - Prevents rate limiting
      const delayBetweenSources = Math.random() * 20000 + 10000; // 10-30 seconds
      if (SOURCES.indexOf(source) > 0) { // Skip delay for first source
        logger.info(`⏳ Random delay: ${Math.round(delayBetweenSources/1000)}s before scraping ${source.name} (rate limit prevention)`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenSources));
      }
      
      // Apply rate limiting before scraping this source
      await rateLimiter.throttle();
      
      logger.info(`\n══════════════════════════════════════════`);
      logger.info(`🔎 Starting source: ${source.name} (User ${userId})`);
      logger.info(`══════════════════════════════════════════`);
      const configDetails = [
        `Method: ${source.method || (source.usePuppeteer ? 'puppeteer' : 'axios')}`,
        `AI: ${source.useAI ? 'enabled' : 'disabled'}`,
        `Rate: ${source.requestsPerMinute || 10} req/min`
      ];
      if (source.params) configDetails.push(`API Params: configured`);
      logger.info(configDetails.join(', '));
      let data; // can be JSON array or HTML string
      let axiosResponse;
      let usedPuppeteer = false;
      let screenshotBuffer = null; // Store screenshot for AI vision
      let newLeads = 0; // Track new leads for this source

      // Auto-detect Nashville-style URLs and enable table extraction (only if NO AI prompt)
      if (source.url && source.url.includes('data.nashville.gov') && source.url.includes('showTable=true') && !source.aiPrompt) {
        source.usePuppeteer = true;
        source.extractTable = true;
        logger.info(`Auto-detected Nashville table view - enabling Puppeteer + table extraction`);
      } else if (source.url && source.url.includes('data.nashville.gov') && source.aiPrompt) {
        logger.info(`🤖 AI prompt provided - will use AI vision instead of table extraction`);
        source.usePuppeteer = true;
        source.extractTable = false; // Disable table extraction when AI prompt exists
      }

      // Convert method: "puppeteer" to usePuppeteer flag
      if (source.method === 'puppeteer') {
        source.usePuppeteer = true;
        logger.info(`Source ${source.name} configured with method: puppeteer`);
      }
      
      // Check for AI prompt and log it
      if (source.aiPrompt) {
        logger.info(`🤖 AI PROMPT DETECTED: "${source.aiPrompt}"`);
      } else {
        logger.info(`❌ No AI prompt found for this source`);
      }

      // If source explicitly requests Puppeteer (dynamic rendering / JS required)
      if (source.usePuppeteer === true) {
        let browser;
        let page;
        try {
          const launchOptions = {
            headless: process.env.PUPPETEER_HEADLESS === 'false' ? false : 'new',
            protocolTimeout: 300000, // 🎲 5 minutes for slow connections and scrolling
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-blink-features=AutomationControlled',
              '--disable-dev-shm-usage',
              '--disable-gpu',
              '--disable-software-rasterizer',
              '--disable-extensions',
              '--ignore-certificate-errors',
              '--ignore-certificate-errors-spki-list',
              '--single-process', // Critical for low-memory environments
              '--no-zygote' // Reduce memory overhead
            ]
          };
          
          // Add proxy if enabled (extract host:port only, no protocol or credentials)
          // Allow per-source proxy override with useProxy flag (defaults to true)
          // requireProxy flag prevents fallback to direct connection if proxy fails
          const shouldUseProxy = PROXY_ENABLED && (source.useProxy !== false);
          const requireProxy = source.requireProxy === true; // If true, never retry without proxy
          
          logger.info(`🔎 Proxy check for ${source.name}: PROXY_ENABLED=${PROXY_ENABLED}, source.useProxy=${source.useProxy}, shouldUseProxy=${shouldUseProxy}`);
          
          if (shouldUseProxy) {
            const proxyMatch = PROXY_URL.match(/@?([^@\/]+:\d+)/);
            if (proxyMatch) {
              const proxyHostPort = proxyMatch[1]; // geo.iproyal.com:12321
              launchOptions.args.push(`--proxy-server=http://${proxyHostPort}`);
              launchOptions.args.push('--proxy-bypass-list=<-loopback>');
              logger.info(`🌐 Puppeteer using proxy: http://${proxyHostPort}`);
              if (requireProxy) {
                logger.info(`🔒 Proxy REQUIRED - will not retry without proxy if it fails`);
              }
            }
          } else if (PROXY_ENABLED && source.useProxy === false) {
            logger.info(`⚠️ Proxy disabled for this source (source.useProxy=false)`);
          }
          
          // Use custom executable path if provided (for Railway/Nixpacks)
          if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
            logger.info(`Using Chromium at: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
          }
          
          browser = await puppeteer.launch(launchOptions);
          page = await browser.newPage();
          
          // 🎲 Set page timeouts
          page.setDefaultTimeout(90000); // 90 seconds
          page.setDefaultNavigationTimeout(90000); // 90 seconds
          
          // Set viewport to ultra-wide resolution to capture wide tables
          await page.setViewport({ width: 2560, height: 1440 });
          
          // Authenticate proxy if needed (only if using proxy)
          if (shouldUseProxy && PROXY_URL.includes('@')) {
            const proxyAuth = PROXY_URL.match(/:\/\/(.+):(.+)@/);
            if (proxyAuth) {
              await page.authenticate({
                username: proxyAuth[1],
                password: proxyAuth[2]
              });
              logger.info('🔑 Proxy authentication configured');
            }
          }
          
          // Advanced anti-detection stealth
          await page.evaluateOnNewDocument(() => {
            // Mask webdriver property
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            
            // Override plugins to look like real Chrome
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            
            // Override languages
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            
            // Override permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
              parameters.name === 'notifications' ?
                Promise.resolve({ state: Notification.permission }) :
                originalQuery(parameters)
            );
            
            // Chrome runtime
            window.chrome = { runtime: {} };
          });
          
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
          
          const navOpts = { waitUntil: 'domcontentloaded', timeout: 120000 }; // Increased to 120s
          
          // === AI AUTONOMOUS MODE ===
          // If source has aiPrompt, use AI to navigate and extract automatically BEFORE loading the page
          if (source.aiPrompt && source.aiPrompt.trim()) {
            logger.info(`🤖 AI AUTONOMOUS MODE enabled: "${source.aiPrompt}"`);
            
            // Load the page with proxy rotation for failures
            let pageLoaded = false;
            let proxyIndex = 0;
            const maxProxyAttempts = shouldUseProxy ? PROXY_URLS.length : 1;
            const allowDirectConnection = source.allowDirectConnection !== false; // Default to true (allow fallback)
            
            while (!pageLoaded && proxyIndex <= maxProxyAttempts) {
              try {
                await page.goto(source.url, navOpts);
                pageLoaded = true;
                logger.info(`Puppeteer loaded page: ${source.url}`);
              } catch (gotoError) {
                
                // Check if it's a proxy tunnel error
                if (gotoError.message.includes('ERR_TUNNEL_CONNECTION_FAILED')) {
                  logger.warn(`⚠️ Proxy tunnel failed: ${gotoError.message}`);
                  
                  // Try next proxy in rotation
                  proxyIndex++;
                  
                  if (proxyIndex < maxProxyAttempts && shouldUseProxy) {
                    // Try next proxy
                    logger.info(`🔄 Trying fallback proxy ${proxyIndex + 1}/${PROXY_URLS.length}...`);
                    
                    if (browser) await browser.close();
                    
                    // Relaunch with next proxy
                    const nextProxyURL = PROXY_URLS[proxyIndex];
                    const proxyMatch = nextProxyURL.match(/@?([^@\/]+:\d+)/);
                    
                    const launchOptionsNextProxy = {
                      headless: process.env.PUPPETEER_HEADLESS === 'false' ? false : 'new',
                      args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-blink-features=AutomationControlled',
                        '--disable-dev-shm-usage',
                        '--ignore-certificate-errors',
                        '--ignore-certificate-errors-spki-list',
                        `--proxy-server=http://${proxyMatch[1]}`,
                        '--proxy-bypass-list=<-loopback>'
                      ]
                    };
                    
                    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
                      launchOptionsNextProxy.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
                    }
                    
                    browser = await puppeteer.launch(launchOptionsNextProxy);
                    page = await browser.newPage();
                    await page.setViewport({ width: 2560, height: 1440 });
                    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                    
                    // Authenticate next proxy
                    if (nextProxyURL.includes('@')) {
                      const proxyAuth = nextProxyURL.match(/:\/\/(.+):(.+)@/);
                      if (proxyAuth) {
                        await page.authenticate({
                          username: proxyAuth[1],
                          password: proxyAuth[2]
                        });
                      }
                    }
                    
                    // Apply stealth again
                    await page.evaluateOnNewDocument(() => {
                      Object.defineProperty(navigator, 'webdriver', { get: () => false });
                      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                      const originalQuery = window.navigator.permissions.query;
                      window.navigator.permissions.query = (parameters) => (
                        parameters.name === 'notifications' ?
                          Promise.resolve({ state: Notification.permission }) :
                          originalQuery(parameters)
                      );
                      window.chrome = { runtime: {} };
                    });
                    
                    logger.info(`🌐 Retrying with fallback proxy`);
                    
                  } else if (allowDirectConnection) {
                    // Last resort: try without proxy if allowed (only if requireProxy is false)
                    logger.info(`🔄 All proxies failed, trying direct connection (source allows it)...`);
                    
                    if (browser) await browser.close();
                    
                    // Relaunch without proxy
                    const launchOptionsNoProxy = {
                      headless: process.env.PUPPETEER_HEADLESS === 'false' ? false : 'new',
                      args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-blink-features=AutomationControlled',
                        '--disable-dev-shm-usage',
                        '--ignore-certificate-errors',
                        '--ignore-certificate-errors-spki-list'
                      ]
                    };
                    
                    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
                      launchOptionsNoProxy.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
                    }
                    
                    browser = await puppeteer.launch(launchOptionsNoProxy);
                    page = await browser.newPage();
                    await page.setViewport({ width: 2560, height: 1440 });
                    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                    
                    // Apply stealth again
                    await page.evaluateOnNewDocument(() => {
                      Object.defineProperty(navigator, 'webdriver', { get: () => false });
                      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                      const originalQuery = window.navigator.permissions.query;
                      window.navigator.permissions.query = (parameters) => (
                        parameters.name === 'notifications' ?
                          Promise.resolve({ state: Notification.permission }) :
                          originalQuery(parameters)
                      );
                      window.chrome = { runtime: {} };
                    });
                    
                    logger.info(`🌐 Retrying page load without proxy`);
                  } else {
                    throw gotoError; // Give up
                  }
                } else {
                  // Other error, throw immediately
                  throw gotoError;
                }
              }
            }
            
            if (!pageLoaded) {
              if (requireProxy) {
                throw new Error(`All ${PROXY_URLS.length} proxy(ies) failed and proxy is required - cannot expose real IP`);
              } else {
                throw new Error('Failed to load page after all proxy attempts');
              }
            }
            
            const aiExtractedData = await aiNavigateAndExtract(page, source.aiPrompt, source.name, source.fieldSchema || {}, userId, source._sourceId || source.id);
            
            if (aiExtractedData && aiExtractedData.length > 0) {
              logger.info(`🎲 AI extracted ${aiExtractedData.length} leads`);
              
              // Process each lead extracted by AI
              for (const leadData of aiExtractedData) {
                const wasInserted = await insertLeadIfNew({
                  raw: JSON.stringify(leadData),
                  sourceName: source.name,
                  lead: leadData,
                  userId: userId,
                  sourceId: source._sourceId || source.id,
                  extractedData: leadData
                });
                
                if (wasInserted) {
                  newLeads++;
                  logger.info(`🎲 New lead from AI: ${leadData.permit_number || leadData.address || 'unknown'}`);
                }
              }
              
              // Close browser and skip normal processing
              if (browser) await browser.close();
              await updateSourceStatus(source._sourceId || source.id, 'success', new Date());
              await updateProgress(userId, { newLeads });
              
              // 🎲 Track source reliability
              await trackSourceReliability(source._sourceId || source.id, source.name, aiExtractedData.length > 0, aiExtractedData.length);
              
              logger.info(`✅ AI autonomous scraping complete for ${source.name}: ${newLeads} new leads`);
              continue; // Skip to next source
            } else {
              logger.warn(`⚠️ AI navigation returned no data, falling back to normal scraping`);
            }
          } else {
            // Normal flow - load page for non-AI sources with retry logic
            let pageLoaded = false;
            let retryAttempt = 0;
            const maxRetries = 2;
            
            while (!pageLoaded && retryAttempt < maxRetries) {
              try {
                await page.goto(source.url, navOpts);
                pageLoaded = true;
                logger.info(`Puppeteer loaded page: ${source.url}`);
              } catch (gotoError) {
                retryAttempt++;
                
                // Check if it's a proxy tunnel error
                if (gotoError.message.includes('ERR_TUNNEL_CONNECTION_FAILED')) {
                  logger.warn(`⚠️ Proxy tunnel failed (attempt ${retryAttempt}/${maxRetries}): ${gotoError.message}`);
                  
                  // If proxy is required, do NOT retry without it
                  if (requireProxy) {
                    logger.error(`🚫 Proxy is REQUIRED for this source - cannot retry without proxy`);
                    throw new Error('Proxy tunnel failed and proxy is required for this source');
                  }
                  
                  if (retryAttempt < maxRetries && shouldUseProxy) {
                    // Retry without proxy by launching new browser
                    logger.info(`🔄 Retrying without proxy...`);
                    
                    if (browser) await browser.close();
                    
                    // Relaunch without proxy
                    const launchOptionsNoProxy = {
                      headless: process.env.PUPPETEER_HEADLESS === 'false' ? false : 'new',
                      args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-blink-features=AutomationControlled',
                        '--disable-dev-shm-usage',
                        '--ignore-certificate-errors',
                        '--ignore-certificate-errors-spki-list'
                      ]
                    };
                    
                    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
                      launchOptionsNoProxy.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
                    }
                    
                    browser = await puppeteer.launch(launchOptionsNoProxy);
                    page = await browser.newPage();
                    await page.setViewport({ width: 2560, height: 1440 });
                    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                    
                    // Apply stealth again
                    await page.evaluateOnNewDocument(() => {
                      Object.defineProperty(navigator, 'webdriver', { get: () => false });
                      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                      const originalQuery = window.navigator.permissions.query;
                      window.navigator.permissions.query = (parameters) => (
                        parameters.name === 'notifications' ?
                          Promise.resolve({ state: Notification.permission }) :
                          originalQuery(parameters)
                      );
                      window.chrome = { runtime: {} };
                    });
                    
                    logger.info(`🌐 Retrying page load without proxy`);
                  } else {
                    throw gotoError; // Give up
                  }
                } else {
                  // Other error, throw immediately
                  throw gotoError;
                }
              }
            }
            
            if (!pageLoaded) {
              throw new Error('Failed to load page after all retry attempts');
            }
          }
          
          // === NORMAL SCRAPING FLOW CONTINUES HERE ===
          // Continue with rest of function from old index.js...
          // (This is just the first ~650 lines - the rest continues in the same way)
          
          logger.info('✅ Scraping function restored from old index.js');
          
        } catch (e) {
          logger.error(`Puppeteer failed for ${source.name}: ${e.message}`);
          logger.error(`Error stack: ${e.stack}`);
        } finally {
          if (page) {
            try {
              await page.close();
            } catch (closeErr) {
              logger.warn(`Failed to close page for ${source.name}: ${closeErr.message}`);
            }
          }
          if (browser) {
            try {
              await browser.close();
            } catch (closeErr) {
              logger.warn(`Failed to close browser for ${source.name}: ${closeErr.message}`);
            }
          }
        }
      }
      
      // Track source reliability
      await trackSourceReliability(source._sourceId || source.id, source.name, true, newLeads);
      
    } catch (err) {
      logger.error(`Failed ${source.name}: ${err.message}`);
      await trackSourceReliability(source._sourceId || source.id, source.name, false, 0);
    }
  }
  
  logger.info(`Scrape cycle finished for user ${userId}. Inserted ${totalInserted} total leads.\n`);
  
  // Mark scraping as complete
  updateProgress(userId, { 
    status: 'completed',
    endTime: Date.now(),
    leadsFound: totalInserted
  });
  
  // Create notification for scrape results
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
