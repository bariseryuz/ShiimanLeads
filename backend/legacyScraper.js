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
 * NOTE: This function is ~1500 lines and should be broken down into:
 * - services/scraper/jsonApi.js
 * - services/scraper/puppeteerScraper.js
 * - services/scraper/htmlParser.js
 * - services/scraper/aiExtractor.js
 * 
 * For now, it remains here as a monolithic function for stability.
 * Routes can import this file: const { scrapeForUser } = require('./legacyScraper');
 */
async function scrapeForUser(userId, userSources) {
  logger.info(`Starting scrape cycle for user ${userId}...`);
  
  // TODO: Copy the full scrapeForUser implementation from index.js here
  // For now, just log a warning
  logger.warn('⚠️ scrapeForUser() implementation needs to be copied from index.js');
  logger.warn('⚠️ This is a placeholder - scraping will not work until function is copied');
  
  return 0;
}

module.exports = {
  scrapeForUser,
  geminiModel,
  PROXY_ENABLED,
  PROXY_URL,
  proxyAgent,
  axiosProxyConfig
};
