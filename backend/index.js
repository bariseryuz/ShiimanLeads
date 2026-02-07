const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const winston = require('winston');
const puppeteer = require('puppeteer');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jp = require('jsonpath');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { ProxyAgent } = require('undici');

// Proxy Configuration - Support multiple proxies for rotation/fallback
const PROXY_ENABLED = process.env.PROXY_ENABLED === 'true';
const PROXY_URLS = process.env.PROXY_URLS 
  ? process.env.PROXY_URLS.split(',').map(p => p.trim())
  : ['http://Sk3vydHQSz93OeDz:DQeASUiiQpObLVvO@geo.iproyal.com:12321'];

// Keep PROXY_URL for backwards compatibility (uses first proxy)
const PROXY_URL = PROXY_URLS[0];
let proxyAgent = null;

if (PROXY_ENABLED) {
  proxyAgent = new ProxyAgent(PROXY_URL);
  console.log(`✅ Proxy enabled: ${PROXY_URLS.length} proxy(ies) configured`);
  console.log(`   Primary: ${PROXY_URL.replace(/:\/\/.*@/, '://***@')}`);
  if (PROXY_URLS.length > 1) {
    console.log(`   Fallback proxies: ${PROXY_URLS.length - 1} available`);
  }
} else {
  console.log('ℹ️ Proxy disabled - set PROXY_ENABLED=true in .env to enable');
}

// Axios proxy configuration - use HTTPS for secure tunneling
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

// Rate Limiter Class - prevents getting blocked by websites
class RateLimiter {
  constructor(requestsPerMinute = 10, randomness = 0.3) {
    this.requestsPerMinute = requestsPerMinute;
    this.randomness = randomness; // ±30% variance by default
    this.lastRequestTime = 0;
    this.consecutiveErrors = 0;
  }
  
  async throttle() {
    const now = Date.now();
    const baseDelay = (60 * 1000) / this.requestsPerMinute;
    
    // Add randomness (±30% by default) to look human
    const randomFactor = 1 + (Math.random() - 0.5) * 2 * this.randomness;
    const minDelay = baseDelay * randomFactor;
    
    // Exponential backoff if errors detected
    const backoffMultiplier = Math.pow(2, Math.min(this.consecutiveErrors, 5));
    const finalDelay = minDelay * backoffMultiplier;
    
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < finalDelay) {
      const waitTime = finalDelay - timeSinceLastRequest;
      logger.info(`⏳ Rate limiting: waiting ${Math.round(waitTime/1000)}s${this.consecutiveErrors > 0 ? ` (backoff x${backoffMultiplier})` : ''}`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastRequestTime = Date.now();
  }
  
  // Call this when scraping succeeds
  onSuccess() {
    this.consecutiveErrors = 0;
  }
  
  // Call this when getting blocked/errors
  onError() {
    this.consecutiveErrors = Math.min(this.consecutiveErrors + 1, 5); // Cap at 5
  }
}

// Per-source rate limiters
const rateLimiters = new Map();

function getRateLimiter(source) {
  if (!rateLimiters.has(source.name)) {
    const rpm = source.requestsPerMinute || 10; // Default 10 requests per minute
    rateLimiters.set(source.name, new RateLimiter(rpm));
  }
  return rateLimiters.get(source.name);
}

// Scraping progress tracking
const scrapeProgress = new Map(); // userId -> progress object
const stopFlags = new Map(); // userId -> boolean (true = should stop)

function initProgress(userId, sources) {
  scrapeProgress.set(userId, {
    status: 'running',
    startTime: Date.now(),
    totalSources: sources.length,
    completedSources: 0,
    currentSource: null,
    leadsFound: 0,
    errors: []
  });
  stopFlags.set(userId, false); // Reset stop flag
}

function updateProgress(userId, updates) {
  const progress = scrapeProgress.get(userId);
  if (progress) {
    Object.assign(progress, updates);
  }
}

function getProgress(userId) {
  return scrapeProgress.get(userId) || null;
}

function shouldStopScraping(userId) {
  return stopFlags.get(userId) === true;
}

function setShouldStop(userId, value) {
  stopFlags.set(userId, value);
  logger.info(`🛑 Stop flag for user ${userId} set to: ${value}`);
}

// Default timing configuration (can be overridden per source)
const DEFAULT_TIMINGS = {
  networkIdleTimeout: 15000,    // Wait longer for complex pages to load
  jsRenderWait: 8000,            // Increased for heavy JS apps (ArcGIS, etc)
  afterScrollWait: 5000,         // More time for lazy-loaded content
  betweenScrollWait: 2000,       // Slower scrolling for better capture
  betweenSourcesWait: 500,       // Cleanup delay between sources
  pageLoadWait: 3000,            // Initial wait after page load
  aiNavigationWait: 2000         // Wait between AI navigation steps
};

// Capture entire page screenshot - handles lazy loading
async function captureEntirePage(page) {
  const { width, height } = await page.evaluate(() => ({
    width: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
    height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
  }));

  await page.setViewport({
    width: Math.min(width, 5000),
    height: Math.min(height, 10000)
  });

  await new Promise(resolve => setTimeout(resolve, 1500));

  return await page.screenshot({ fullPage: true });
}

// Initialize Google Gemini client
let geminiModel = null;
if (process.env.GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
  console.log('✅ Google Gemini AI initialized for lead extraction (gemini-3-flash-preview)');
} else {
  console.warn('⚠️ GEMINI_API_KEY not found in .env - AI extraction disabled');
}

// AI generation config — allow controlling "thinking level" via env
const AI_THINKING_LEVEL = String(process.env.AI_THINKING_LEVEL || 'low').toLowerCase();
function buildGenConfig() {
  const base = { responseMimeType: 'application/json' };
  if (AI_THINKING_LEVEL === 'low') {
    return { ...base, temperature: 0.2, topP: 0.8, maxOutputTokens: 8192 };
  }
  if (AI_THINKING_LEVEL === 'medium') {
    return { ...base, temperature: 0.5, topP: 0.9, maxOutputTokens: 12288 };
  }
  // high
  return { ...base, temperature: 0.7, topP: 0.95, maxOutputTokens: 16384 };
}

// === LOGGING ===
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(i => `${i.timestamp} [${i.level.toUpperCase()}] ${i.message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});
if (!fs.existsSync('logs')) fs.mkdirSync('logs');
if (!fs.existsSync('output')) fs.mkdirSync('output');
if (!fs.existsSync('data')) fs.mkdirSync('data');

// ============================================
// SCREENSHOT DIRECTORY CONFIGURATION
// ============================================
const isProduction = process.env.NODE_ENV === 'production';

const SCREENSHOT_DIR = isProduction
  ? '/app/backend/data/screenshots'  // Railway: Volume (persistent)
  : path.join(__dirname, 'output');   // Local: backend/output

// Ensure directory exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  console.log(`✅ Screenshots directory created: ${SCREENSHOT_DIR}`);
} else {
  console.log(`📁 Screenshots directory: ${SCREENSHOT_DIR}`);
}

// === HELPERS ===
function normalizeText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function buildTextForFilter(item, source) {
  // For JSON items: if jsonFields specified, concatenate those; else stringify
  if (typeof item === 'object') {
    const fields = Array.isArray(source?.jsonFields) ? source.jsonFields : null;
    if (fields && fields.length) {
      return fields.map(f => normalizeText(item[f])).join(' ').trim();
    }
    return normalizeText(item);
  }
  // For HTML raw strings
  return normalizeText(item);
}

//To decide if text passes the source filters

function textPassesFilters(text, source) {
  const t = (text || '').toString();
  const minLength = Number.isFinite(source?.minLength) ? source.minLength : 0;
  if (t.length < minLength) return false;

  const kws = Array.isArray(source?.keywords) ? source.keywords : [];
  const includeRegex = Array.isArray(source?.includeRegex) ? source.includeRegex : [];
  const excludeRegex = Array.isArray(source?.excludeRegex) ? source.excludeRegex : [];

  if (kws.length) {
    const hit = kws.some(k => {
      try { return new RegExp(k, 'i').test(t); } catch { return t.toLowerCase().includes(String(k).toLowerCase()); }
    });
    if (!hit) return false;
  }

  if (includeRegex.length) {
    const hit = includeRegex.some(r => {
      try { return new RegExp(r, 'i').test(t); } catch { return false; }
    });
    if (!hit) return false;
  }

  if (excludeRegex.length) {
    const bad = excludeRegex.some(r => {
      try { return new RegExp(r, 'i').test(t); } catch { return false; }
    });
    if (bad) return false;
  }
  return true;
}

// === GET DEFAULT COLUMNS FOR SOURCE TYPE ===
function getDefaultColumnsForSource(source) {
  const sourceName = (source.name || '').toLowerCase();
  const url = (source.url || '').toLowerCase();
  
  // Real Estate Agents (Zillow, Realtor, etc.)
  if (sourceName.includes('zillow') || sourceName.includes('realtor') || sourceName.includes('agent')) {
    return [
      'agent_name',
      'company_name',
      'phone',
      'email',
      'address',
      'city',
      'state',
      'source',
      'page_url',
      'date_added'
    ];
  }
  
  // Construction/Building Permits
  if (sourceName.includes('permit') || sourceName.includes('building') || url.includes('permit')) {
    return [
      'permit_number',
      'date_issued',
      'address',
      'city',
      'state',
      'value',
      'contractor_name',
      'contractor_phone',
      'owner_name',
      'square_footage',
      'permit_type',
      'permit_subtype',
      'parcel_number',
      'source',
      'page_url',
      'date_added'
    ];
  }
  
  // Default: show most common fields
  return [
    'permit_number',
    'address',
    'value',
    'contractor_name',
    'phone',
    'description',
    'source',
    'page_url',
    'date_added'
  ];
}

// === FIELD VALIDATION ===
function validateExtractedFields(data, sourceName, fieldSchema = null) {
  // If data is an array, validate the first item as a sample
  const sampleData = Array.isArray(data) ? (data[0] || {}) : data;
  
  // If it's an object with numeric keys (array-like), validate first entry
  if (!Array.isArray(data) && typeof data === 'object') {
    const keys = Object.keys(data).filter(k => !k.startsWith('_'));
    if (keys.some(k => !isNaN(k))) {
      const firstKey = keys.find(k => !isNaN(k));
      if (firstKey && data[firstKey]) {
        return validateExtractedFields(data[firstKey], sourceName, fieldSchema);
      }
    }
  }
  
  const validations = {
    hasData: false,
    confidence: 0,
    issues: []
  };

  // Count how many non-null fields we have
  const dataKeys = Object.keys(sampleData).filter(k => !k.startsWith('_'));
  const nonNullFields = dataKeys.filter(k => 
    sampleData[k] !== null && 
    sampleData[k] !== 'null' && 
    sampleData[k] !== undefined &&
    sampleData[k] !== ''
  );
  
  // If we have any data at all, consider it valid
  if (nonNullFields.length > 0) {
    validations.hasData = true;
    // Base confidence on percentage of fields filled
    const fillPercentage = (nonNullFields.length / Math.max(dataKeys.length, 1)) * 100;
    validations.confidence = Math.min(Math.round(fillPercentage), 100);
  } else {
    validations.issues.push(`No data extracted - all fields are null or empty`);
  }

  const isValid = validations.hasData && validations.confidence >= 20;

  if (!isValid) {
    logger.warn(`⚠️ Validation failed for ${sourceName}: ${validations.issues.join(', ')} (confidence: ${validations.confidence}%)`);
  }

  return { isValid, confidence: validations.confidence, issues: validations.issues };
}

// === DYNAMIC DATE REPLACEMENT ===
// Replace placeholders like {{DATE_365_DAYS_AGO}} with actual dates
function replaceDynamicDates(text) {
  if (!text) return text;
  
  const today = new Date();
  
  // {{DATE_365_DAYS_AGO}} or {{LAST_365_DAYS}} → date from 365 days ago
  if (text.includes('{{DATE_365_DAYS_AGO}}') || text.includes('{{LAST_365_DAYS}}')) {
    const date365DaysAgo = new Date(today);
    date365DaysAgo.setDate(date365DaysAgo.getDate() - 365);
    const formatted = formatDate(date365DaysAgo);
    text = text.replace(/\{\{DATE_365_DAYS_AGO\}\}/g, formatted);
    text = text.replace(/\{\{LAST_365_DAYS\}\}/g, formatted);
  }
  
  // {{DATE_30_DAYS_AGO}} or {{LAST_30_DAYS}} → date from 30 days ago
  if (text.includes('{{DATE_30_DAYS_AGO}}') || text.includes('{{LAST_30_DAYS}}')) {
    const date30DaysAgo = new Date(today);
    date30DaysAgo.setDate(date30DaysAgo.getDate() - 30);
    const formatted = formatDate(date30DaysAgo);
    text = text.replace(/\{\{DATE_30_DAYS_AGO\}\}/g, formatted);
    text = text.replace(/\{\{LAST_30_DAYS\}\}/g, formatted);
  }
  
  // {{DATE_90_DAYS_AGO}} or {{LAST_90_DAYS}} → date from 90 days ago
  if (text.includes('{{DATE_90_DAYS_AGO}}') || text.includes('{{LAST_90_DAYS}}')) {
    const date90DaysAgo = new Date(today);
    date90DaysAgo.setDate(date90DaysAgo.getDate() - 90);
    const formatted = formatDate(date90DaysAgo);
    text = text.replace(/\{\{DATE_90_DAYS_AGO\}\}/g, formatted);
    text = text.replace(/\{\{LAST_90_DAYS\}\}/g, formatted);
  }
  
  // {{TODAY}} → today's date
  if (text.includes('{{TODAY}}')) {
    const formatted = formatDate(today);
    text = text.replace(/\{\{TODAY\}\}/g, formatted);
  }
  
  // {{FIRST_DAY_OF_MONTH}} → first day of current month
  if (text.includes('{{FIRST_DAY_OF_MONTH}}')) {
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
    const formatted = formatDate(firstDay);
    text = text.replace(/\{\{FIRST_DAY_OF_MONTH\}\}/g, formatted);
  }
  
  // {{FIRST_DAY_OF_YEAR}} → January 1st of current year
  if (text.includes('{{FIRST_DAY_OF_YEAR}}')) {
    const firstDay = new Date(today.getFullYear(), 0, 1);
    const formatted = formatDate(firstDay);
    text = text.replace(/\{\{FIRST_DAY_OF_YEAR\}\}/g, formatted);
  }
  
  return text;
}

// Format date as MM/DD/YYYY
function formatDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

// === AI AUTONOMOUS NAVIGATION ===
// Uses AI vision to understand page structure and perform actions autonomously
async function aiNavigateAndExtract(page, userPrompt, sourceName, fieldSchema = {}, userId = 1, sourceId = null) {
  if (!geminiModel) {
    logger.warn('Google Gemini API not configured - skipping AI navigation');
    return null;
  }

  try {
    // Replace dynamic date placeholders in userPrompt
    userPrompt = replaceDynamicDates(userPrompt);
    
    logger.info(`🤖 AI autonomous navigation started for: "${userPrompt}"`);
    
    const maxSteps = 50; // Increased for pagination
    let currentStep = 0;
    let extractedData = [];
    let lastExtractedHash = null; // Track if we're extracting same page repeatedly
    let samePageCount = 0; // Count how many times we extracted the same page
    let downloadedData = null; // Store downloaded file data across actions
    
    // Initial wait for heavy JavaScript apps (ArcGIS, etc.) - only on first step
    logger.info(`⏳ Waiting 8 seconds for initial page load (ArcGIS/heavy JS apps)...`);
    await new Promise(resolve => setTimeout(resolve, 8000));
    
    // Wait for network to settle after initial load
    try {
      await page.waitForNetworkIdle({ timeout: 10000, idleTime: 1000 });
      logger.info(`✅ Initial page load complete - network idle`);
    } catch (e) {
      logger.info('⏳ Network still active after 10s, proceeding anyway...');
    }
    
    while (currentStep < maxSteps) {
      currentStep++;
      logger.info(`🔍 AI Navigation Step ${currentStep}/${maxSteps}`);
      
      // Wait for page to stabilize before taking screenshot
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Wait for any network activity to settle
      try {
        await page.waitForNetworkIdle({ timeout: 5000 });
      } catch (e) {
        // Timeout is ok, just continue
        logger.info('⏳ Network still active, proceeding anyway...');
      }
      
      // Take screenshot of current page state
      // Wait a moment for any animations/transitions to complete
      await new Promise(resolve => setTimeout(resolve, 1000));
      const screenshot = await page.screenshot({ fullPage: false });
      logger.info(`📸 Screenshot captured (${Math.round(screenshot.length / 1024)}KB)`);
      
      // Save screenshot to disk for debugging
      const screenshotPath = path.join(SCREENSHOT_DIR, `ai-nav-${sourceName.replace(/[^a-z0-9]/gi, '-')}-step${currentStep}.png`);
      fs.writeFileSync(screenshotPath, screenshot);
      logger.info(`💾 Screenshot saved: ${screenshotPath}`);
      
      // Get page HTML for context (including form elements with their actual IDs/names)
      const pageInfo = await page.evaluate(() => {
        // Get visible text
        const text = document.body.innerText.substring(0, 3000);
        
        // Get all form elements with their actual selectors
        const formElements = [];
        document.querySelectorAll('input, select, button, a').forEach((el, idx) => {
          if (idx < 50) { // Increased to 50 elements to capture more buttons
            const info = {
              tag: el.tagName.toLowerCase(),
              id: el.id || '',
              name: el.name || '',
              class: el.className || '',
              type: el.type || '',
              text: el.innerText?.substring(0, 100) || el.value?.substring(0, 100) || '',
              placeholder: el.placeholder || '',
              title: el.title || '',
              value: el.value?.substring(0, 50) || ''
            };
            formElements.push(info);
          }
        });
        
        return { text, formElements };
      });
      
      // Ask AI what to do next
      const navigationPrompt = `You are an autonomous web navigation AI. 

USER'S DETAILED INSTRUCTIONS:
${userPrompt}

Current page text preview:
${pageInfo.text}

Available form elements on the page (use these EXACT selectors):
${JSON.stringify(pageInfo.formElements, null, 2)}

You are viewing a screenshot of the current page state. Analyze it and determine the NEXT ACTION to accomplish the user's instructions above.

Your response MUST be a JSON object with ONE of these actions:

1. Click an element BY TEXT (preferred for buttons with visible text like "Table", "Submit", "Next"):
{"action": "click", "buttonText": "Table", "selector": "button", "reasoning": "clicking Table button to show table view"}

2. Click an element BY SELECTOR (when no visible text):
{"action": "click", "selector": "CSS selector of element to click", "reasoning": "why clicking this"}

3. Fill a form field:
{"action": "fill", "selector": "CSS selector", "value": "text to enter", "reasoning": "why"}

4. Download data file (for Export/Download buttons):
{"action": "download", "selector": "CSS selector of Export/Download button", "reasoning": "downloading data file"}

5. Extract data from table/list OR downloaded file (WAIT until after form submission/download to use this):
{"action": "extract", "tableSelector": "table CSS selector", "reasoning": "data is ready to extract"}

6. Click next page/pagination (ONLY use AFTER extracting current page):
{"action": "nextPage", "selector": "next button CSS selector", "reasoning": "more pages to process"}

7. Done - all pages extracted:
{"action": "done", "reasoning": "task completed successfully"}

CRITICAL RULES:
- Follow the USER'S DETAILED INSTRUCTIONS step by step
- Use ONLY selectors from the "Available form elements" list above
- Construct selectors as: #id, [name="..."], .classname, button, or a
- Look for button text like "Create a List", "Create List", "Submit", "Search", "Next", "Load More"
- NEVER use jQuery syntax like :contains(), :visible, :checked, etc.
- Use ONLY standard CSS selectors that work with document.querySelector()
- Return ONLY valid JSON, no explanations outside the JSON
- After filling form fields, CLICK the submit/search button
- WAIT for results to load, THEN use "extract" action
- After extracting, look for pagination: page numbers (2, 3, 4...), "Next" button, "Load More" button
- Use "nextPage" to click pagination, then "extract" again on the new page
- Repeat "nextPage" → "extract" until no more pages exist, then say "done"

VALID selector examples: #btnSearch, button, [name="search"], .search-button
INVALID selectors: button:contains('Search'), input:visible, :checked

Current step: ${currentStep}/${maxSteps}`;

      const imageData = {
        inlineData: {
          data: screenshot.toString('base64'),
          mimeType: 'image/png'
        }
      };

      const result = await geminiModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: navigationPrompt }, imageData] }],
        generationConfig: buildGenConfig()
      });

      const response = await result.response;
      let aiResponse = response.text().trim();
      
      logger.info(`📝 Raw AI response: ${aiResponse.substring(0, 500)}`);
      
      // Clean response - remove markdown code blocks
      if (aiResponse.startsWith('```json')) {
        aiResponse = aiResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      } else if (aiResponse.startsWith('```')) {
        aiResponse = aiResponse.replace(/```\n?/g, '');
      }
      
      // Remove any trailing text after JSON
      aiResponse = aiResponse.trim();
      
      // Extract JSON - find first { and last }
      const jsonStart = aiResponse.indexOf('{');
      const jsonEnd = aiResponse.lastIndexOf('}');
      
      if (jsonStart < 0 || jsonEnd < 0 || jsonEnd <= jsonStart) {
        logger.error(`❌ No valid JSON found in AI response`);
        logger.error(`Response was: ${aiResponse}`);
        throw new Error('AI did not return valid JSON');
      }
      
      aiResponse = aiResponse.substring(jsonStart, jsonEnd + 1);
      
      // Additional cleanup - remove any text after the closing brace
      const extraText = aiResponse.indexOf('}') + 1;
      if (extraText < aiResponse.length) {
        const after = aiResponse.substring(extraText).trim();
        if (after.length > 0) {
          logger.warn(`⚠️ Removing extra text after JSON: ${after.substring(0, 100)}`);
          aiResponse = aiResponse.substring(0, extraText);
        }
      }
      
      logger.info(`🧹 Cleaned JSON: ${aiResponse}`);
      
      const action = JSON.parse(aiResponse);
      logger.info(`🎯 AI Decision: ${action.action} - ${action.reasoning}`);
      
      // Execute the action
      if (action.action === 'download') {
        logger.info(`📥 Attempting to download file...`);
        
        // Set up download behavior
        const downloadPath = path.join(__dirname, 'output', 'downloads');
        if (!fs.existsSync(downloadPath)) {
          fs.mkdirSync(downloadPath, { recursive: true });
        }
        
        // Enable downloads
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: downloadPath
        });
        
        // Find and click download/export button - try multiple strategies
        try {
          let downloadButton = null;
          
          // Try user-specified selector first
          if (action.selector && action.selector !== 'a' && action.selector !== 'button') {
            downloadButton = await page.$(action.selector);
            if (downloadButton) {
              logger.info(`🔍 Using specified selector: ${action.selector}`);
            }
          }
          
          // If not found or too generic, search for Export/Download buttons by text
          if (!downloadButton) {
            logger.info(`🔍 Searching for Export/Download button...`);
            downloadButton = await page.evaluateHandle(() => {
              const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
              
              // Look for Export or Download buttons
              const exportBtn = buttons.find(btn => {
                const text = (btn.innerText || btn.textContent || '').toLowerCase().trim();
                return text === 'export' || text === 'download' || text === 'export data' || text === 'download data';
              });
              
              return exportBtn || null;
            });
            
            if (downloadButton && await downloadButton.asElement()) {
              logger.info(`✅ Found Export/Download button by text search`);
            }
          }
          
          const elementExists = downloadButton && await downloadButton.asElement();
          if (elementExists) {
            logger.info(`🔍 Found download button`);
            
            // Start waiting for download
            const downloadPromise = new Promise((resolve) => {
              client.on('Page.downloadProgress', (event) => {
                if (event.state === 'completed') {
                  logger.info(`✅ Download completed: ${event.url}`);
                  resolve(event.guid);
                }
              });
            });
            
            // Click the download button
            await downloadButton.click();
            logger.info(`✅ Clicked download button`);
            
            // Wait for download to complete (max 30 seconds)
            await Promise.race([
              downloadPromise,
              new Promise((_, reject) => setTimeout(() => reject(new Error('Download timeout')), 30000))
            ]).catch(e => logger.warn(`Download wait timeout: ${e.message}`));
            
            // Wait a bit for file to be written
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Find the downloaded file
            const files = fs.readdirSync(downloadPath);
            if (files.length > 0) {
              const downloadedFile = path.join(downloadPath, files[files.length - 1]); // Get most recent file
              logger.info(`📄 Found downloaded file: ${downloadedFile}`);
              
              // Parse the downloaded file based on extension
              const fileExt = path.extname(downloadedFile).toLowerCase();
              let parsedData = [];
              
              if (fileExt === '.csv') {
                logger.info(`📊 Parsing CSV file...`);
                const Papa = require('papaparse');
                const csvContent = fs.readFileSync(downloadedFile, 'utf8');
                const result = Papa.parse(csvContent, { header: true, skipEmptyLines: true });
                parsedData = result.data;
                logger.info(`✅ Parsed ${parsedData.length} rows from CSV`);
              } else if (fileExt === '.json') {
                logger.info(`📊 Parsing JSON file...`);
                const jsonContent = fs.readFileSync(downloadedFile, 'utf8');
                parsedData = JSON.parse(jsonContent);
                if (!Array.isArray(parsedData)) {
                  parsedData = parsedData.data || parsedData.results || [parsedData];
                }
                logger.info(`✅ Parsed ${parsedData.length} rows from JSON`);
              }
              
              // Store parsed data for next extract action
              downloadedData = parsedData;
              logger.info(`💾 Stored ${parsedData.length} rows for extraction`);
              
            } else {
              logger.warn(`⚠️ No downloaded file found`);
            }
            
          } else {
            logger.error(`❌ Export/Download button not found on page`);
            logger.info(`💡 Looking for buttons with text: Export, Download, Export Data, Download Data`);
          }
        } catch (downloadError) {
          logger.error(`❌ Download failed: ${downloadError.message}`);
        }
        
      } else if (action.action === 'click') {
        // If clicking based on text (e.g., "Table" button), search by text first
        let clickTarget = null;
        
        // Check if action has buttonText specified
        if (action.buttonText) {
          logger.info(`🔍 Searching for button with text: "${action.buttonText}"`);
          clickTarget = await page.evaluateHandle((searchText) => {
            const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], div[class*="button"]'));
            
            // Find button with exact or partial text match
            const matchingBtn = buttons.find(btn => {
              const text = (btn.innerText || btn.textContent || '').trim();
              const title = btn.getAttribute('title') || '';
              const ariaLabel = btn.getAttribute('aria-label') || '';
              
              return text === searchText || 
                     text.toLowerCase() === searchText.toLowerCase() ||
                     title.toLowerCase().includes(searchText.toLowerCase()) ||
                     ariaLabel.toLowerCase().includes(searchText.toLowerCase());
            });
            
            return matchingBtn || null;
          }, action.buttonText);
          
          if (clickTarget && await clickTarget.asElement()) {
            logger.info(`✅ Found button by text: "${action.buttonText}"`);
          } else {
            logger.warn(`⚠️ Button with text "${action.buttonText}" not found, falling back to selector`);
          }
        }
        
        // Fall back to selector if no buttonText or text search failed
        if (!clickTarget || !(await clickTarget.asElement())) {
          clickTarget = await page.$(action.selector);
        }
        
        const elementExists = clickTarget && await clickTarget.asElement();
        if (!elementExists) {
          logger.error(`❌ Selector not found: ${action.selector}`);
          logger.warn(`⚠️ AI hallucinated a selector that doesn't exist on the page`);
          logger.info(`💡 Taking screenshot to help AI re-evaluate...`);
          // Continue to next step instead of failing
        } else {
          await clickTarget.click();
          logger.info(`✅ Clicked: ${action.buttonText || action.selector}`);
          
          // Wait for page to update after click
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Wait for network to settle
          await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(() => logger.warn('Network idle timeout'));
          
          // Additional wait for any AJAX/dynamic content
          await new Promise(resolve => setTimeout(resolve, 2000));

        }
        
      } else if (action.action === 'fill') {
        // Validate selector exists before typing
        const elementExists = await page.$(action.selector);
        if (!elementExists) {
          logger.error(`❌ Selector not found: ${action.selector}`);
          logger.warn(`⚠️ AI hallucinated a selector that doesn't exist on the page`);
        } else {
          // Check if it's a select dropdown
          const isSelect = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            return el && el.tagName.toLowerCase() === 'select';
          }, action.selector);
          
          if (isSelect) {
            // For dropdowns, find option by text and select by value
            const selectedValue = await page.evaluate((sel, searchText) => {
              const select = document.querySelector(sel);
              if (!select) return null;
              
              const options = Array.from(select.options);
              
              // Log available options for debugging
              console.log('Available options:', options.map(o => o.text));
              console.log('Searching for:', searchText);
              
              // Try multiple matching strategies
              let matchingOption = null;
              
              // 1. Exact match
              matchingOption = options.find(opt => opt.text === searchText);
              
              // 2. Contains search text
              if (!matchingOption) {
                matchingOption = options.find(opt => opt.text.includes(searchText));
              }
              
              // 3. Search text contains option text
              if (!matchingOption) {
                matchingOption = options.find(opt => searchText.includes(opt.text));
              }
              
              // 4. For "007 - 10 OR MORE FAMILY UNITS", try partial matches
              if (!matchingOption && searchText.includes('007')) {
                matchingOption = options.find(opt => opt.text.includes('007') && opt.text.includes('10 OR MORE'));
              }
              
              // 5. Case-insensitive match
              if (!matchingOption) {
                const searchLower = searchText.toLowerCase();
                matchingOption = options.find(opt => 
                  opt.text.toLowerCase().includes(searchLower) || 
                  searchLower.includes(opt.text.toLowerCase())
                );
              }
              
              if (matchingOption) {
                console.log('Found matching option:', matchingOption.text);
                select.value = matchingOption.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                return matchingOption.text + ' (value: ' + matchingOption.value + ')';
              }
              
              console.log('No matching option found');
              return null;
            }, action.selector, action.value);
            
            if (selectedValue) {
              logger.info(`✅ Selected dropdown: ${action.selector} = ${selectedValue}`);
            } else {
              logger.warn(`⚠️ Could not find option matching "${action.value}" in dropdown ${action.selector}`);
            }
          } else {
            // Regular text input
            await page.type(action.selector, action.value);
            logger.info(`✅ Filled: ${action.selector} = ${action.value}`);
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
      } else if (action.action === 'extract') {
        // Check if we have downloaded data from a previous download action
        let extracted = null;
        
        if (downloadedData && downloadedData.length > 0) {
          logger.info(`📥 Using ${downloadedData.length} rows from downloaded file`);
          
          // Map downloaded data to field schema
          extracted = downloadedData.map(row => {
            const mappedRow = {};
            
            // Try to map each field in schema to downloaded data columns
            Object.keys(fieldSchema).forEach(fieldName => {
              // Try exact match first
              if (row[fieldName] !== undefined) {
                mappedRow[fieldName] = row[fieldName];
              } else {
                // Try case-insensitive match
                const matchingKey = Object.keys(row).find(k => k.toLowerCase() === fieldName.toLowerCase());
                if (matchingKey) {
                  mappedRow[fieldName] = row[matchingKey];
                } else {
                  mappedRow[fieldName] = null;
                }
              }
            });
            
            return mappedRow;
          });
          
          logger.info(`✅ Mapped ${extracted.length} rows from downloaded data to field schema`);
          
        } else {
          // Normal screenshot-based extraction
          logger.info(`📊 Extracting data from page - waiting for table to fully load`);
          
          // Wait for table to be visible and fully populated
          await page.waitForSelector('table, [id*="grid"], [class*="results"], [class*="table"]', { 
            visible: true, 
            timeout: 10000 
          }).catch(() => logger.warn('⚠️ Table selector not found'));
          
          // Wait for AJAX/dynamic content to finish loading
          await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => logger.warn('Network idle timeout'));
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Take a full page screenshot for AI vision extraction (handles lazy loading)
          const screenshot = await captureEntirePage(page);
          
          logger.info(`📸 Screenshot captured, sending to AI for extraction...`);
          extracted = await extractLeadWithAI(screenshot, sourceName, fieldSchema, false);
        }
        
        if (extracted) {
          const leadsArray = Array.isArray(extracted) ? extracted : [extracted];
          
          // Check if we're extracting the same data as last time (stuck on same page)
          const currentHash = require('crypto').createHash('md5').update(JSON.stringify(extracted)).digest('hex');
          if (currentHash === lastExtractedHash) {
            samePageCount++;
            logger.warn(`⚠️ Extracted same data as last time (${samePageCount} times) - pagination may be needed`);
            
            // If we've extracted the same page 2+ times, force pagination
            if (samePageCount >= 2) {
              logger.info(`🔄 Auto-triggering pagination - clicking next page button`);
              
              // Try to click page number or Next button
              const nextClicked = await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('a, button'));
                
                // Try to find page 2, 3, 4... (look for next sequential number)
                const currentPageEl = btns.find(b => b.classList.contains('k-state-selected') || b.classList.contains('active'));
                if (currentPageEl) {
                  const currentPageText = currentPageEl.innerText.trim();
                  const currentPageNum = parseInt(currentPageText);
                  if (!isNaN(currentPageNum)) {
                    const nextPageNum = currentPageNum + 1;
                    const nextPageBtn = btns.find(b => b.innerText.trim() === String(nextPageNum));
                    if (nextPageBtn && nextPageBtn.offsetParent) {
                      nextPageBtn.click();
                      return { success: true, page: nextPageNum };
                    }
                  }
                }
                
                // Fallback: Try clicking "2" if we're on page 1
                const page2 = btns.find(b => b.innerText.trim() === '2' && b.offsetParent && !b.disabled);
                if (page2) {
                  page2.click();
                  return { success: true, page: 2 };
                }
                
                // Fallback: Click Next button
                const next = btns.find(b => {
                  const t = (b.innerText || '').toLowerCase().trim();
                  return (t === 'next' || t === '›' || t === '>') && b.offsetParent && !b.disabled;
                });
                if (next) {
                  next.click();
                  return { success: true, page: 'next' };
                }
                
                return { success: false };
              });
              
              if (nextClicked.success) {
                logger.info(`➡️ Clicked pagination button (page ${nextClicked.page})`);
                
                // Wait for new page to load
                await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(() => logger.warn('Network idle timeout'));
                await page.waitForSelector('table, [id*="grid"], [class*="results"]', { visible: true, timeout: 10000 }).catch(() => {});
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                // Reset counter and hash since we're on a new page
                samePageCount = 0;
                lastExtractedHash = null;
                
                logger.info(`✅ New page loaded, continuing extraction...`);
                continue; // Skip the rest and go to next iteration
              } else {
                logger.info(`✓ No more pages found - pagination complete`);
                break; // Exit loop, we're done
              }
            }
          } else {
            // Different data, reset counter
            samePageCount = 0;
            lastExtractedHash = currentHash;
          }
          
          // Insert leads IMMEDIATELY into database
          for (const leadData of leadsArray) {
            const wasInserted = await insertLeadIfNew({
              raw: JSON.stringify(leadData),
              sourceName: sourceName,
              lead: leadData,
              userId: userId,
              sourceId: sourceId,
              extractedData: leadData
            });
            
            if (wasInserted) {
              logger.info(`✅ Inserted lead: ${leadData.number || leadData.permit_number || leadData.name || 'unknown'}`);
            }
          }
          
          extractedData.push(...leadsArray);
          logger.info(`✅ Extracted and inserted ${leadsArray.length} leads from screenshot`);
        } else {
          logger.warn(`⚠️ No data extracted from screenshot`);
        }
        
      } else if (action.action === 'nextPage') {
        // Validate selector exists before clicking
        const elementExists = await page.$(action.selector);
        if (!elementExists) {
          logger.error(`❌ Next page selector not found: ${action.selector}`);
          logger.warn(`⚠️ No more pages or AI hallucinated selector - treating as done`);
          break; // Exit AI loop if no pagination found
        } else {
          await page.click(action.selector);
          logger.info(`➡️ Navigating to next page: ${action.selector}`);
          
          // Wait for new page to load
          await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(() => logger.warn('Network idle timeout'));
          
          // Wait for table to appear on new page
          await page.waitForSelector('table, [id*="grid"], [class*="results"]', { 
            visible: true, 
            timeout: 10000 
          }).catch(() => logger.warn('⚠️ Results not found on new page'));
          
          // Additional wait for data to populate
          await new Promise(resolve => setTimeout(resolve, 3000));
          logger.info(`✅ New page loaded and ready`);
        }
        
      } else if (action.action === 'done') {
        logger.info(`✅ AI navigation complete: ${action.reasoning}`);
        
        // After AI finishes, check if there are more pages to scrape
        logger.info(`🔍 Checking for pagination...`);
        let pageNum = 1;
        let hasMorePages = true;
        
        while (hasMorePages && pageNum <= 50) {
          logger.info(`📄 Checking page ${pageNum} for Next button...`);
          
          // Puppeteer: Check for Next button or page number link
          const nextFound = await page.evaluate((targetPage) => {
            // First try to find page number link (2, 3, 4, etc.)
            const btns = Array.from(document.querySelectorAll('a, button, input'));
            const pageLink = btns.find(b => {
              const t = (b.innerText || b.value || '').trim();
              return t === String(targetPage) && b.offsetParent && !b.disabled;
            });
            
            if (pageLink) {
              return { found: true, type: 'pageNumber', page: targetPage };
            }
            
            // Fallback to Next button
            const next = btns.find(b => {
              const t = (b.innerText || b.value || '').toLowerCase().trim();
              return (t === 'next' || t === '>' || t === '›' || t === '→') && b.offsetParent && !b.disabled;
            });
            
            return next ? { found: true, type: 'next' } : { found: false };
          }, pageNum + 1);
          
          if (nextFound.found) {
            logger.info(`➡️ Found ${nextFound.type === 'pageNumber' ? `page ${pageNum + 1} link` : 'Next button'}, clicking...`);
            
            // Click Next or page number
            await page.evaluate((targetPage) => {
              const btns = Array.from(document.querySelectorAll('a, button, input'));
              
              // Try page number first
              const pageLink = btns.find(b => {
                const t = (b.innerText || b.value || '').trim();
                return t === String(targetPage);
              });
              
              if (pageLink) {
                pageLink.click();
                return;
              }
              
              // Fallback to Next button
              const next = btns.find(b => {
                const t = (b.innerText || b.value || '').toLowerCase().trim();
                return t === 'next' || t === '>' || t === '›' || t === '→';
              });
              if (next) next.click();
            }, pageNum + 1);
            
            // Wait for page to load
            await new Promise(r => setTimeout(r, 5000));
            
            // Take screenshot and extract with AI (handles lazy loading)
            logger.info(`📸 Taking screenshot of page ${pageNum + 1}...`);
            const pageScreenshot = await captureEntirePage(page);
            
            logger.info(`🤖 AI extracting from page ${pageNum + 1}...`);
            const pageExtracted = await extractLeadWithAI(
              pageScreenshot.toString('base64'),
              sourceName,
              fieldSchema,
              true, // isScreenshot
              'image/png'
            );
            
            if (pageExtracted && pageExtracted.length > 0) {
              const leadsArray = Array.isArray(pageExtracted) ? pageExtracted : [pageExtracted];
              
              // Insert leads IMMEDIATELY into database
              for (const leadData of leadsArray) {
                const wasInserted = await insertLeadIfNew({
                  raw: JSON.stringify(leadData),
                  sourceName: sourceName,
                  lead: leadData,
                  userId: userId,
                  sourceId: sourceId,
                  extractedData: leadData
                });
                
                if (wasInserted) {
                  logger.info(`✅ Inserted lead from page ${pageNum + 1}: ${leadData.number || leadData.permit_number || 'unknown'}`);
                }
              }
              
              extractedData.push(...leadsArray);
              logger.info(`✅ Extracted and inserted ${leadsArray.length} leads from page ${pageNum + 1}`);
            }
            
            pageNum++;
          } else {
            logger.info(`✓ No more Next button - reached end`);
            hasMorePages = false;
          }
        }
        
        break;
      }
    }
    
    logger.info(`🎉 AI navigation finished. Extracted ${extractedData.length} total leads`);
    return extractedData;
    
  } catch (error) {
    logger.error(`❌ AI navigation failed: ${error.message}`);
    return null;
  }
}

// === REMAP NUMERIC KEYS TO FIELD NAMES ===
function remapNumericKeysToFieldNames(data, fieldSchema) {
  if (!data || !fieldSchema) return data;
  
  // Get field names in order (assuming fieldSchema is array or object)
  const fieldNames = Array.isArray(fieldSchema) 
    ? fieldSchema.map(f => f.name) 
    : Object.keys(fieldSchema);
  
  // Check if data has numeric keys like "0", "1", "2"
  const hasNumericKeys = (obj) => {
    const keys = Object.keys(obj);
    return keys.some(k => /^\d+$/.test(k));
  };
  
  // Remap function
  const remapObject = (obj) => {
    if (!hasNumericKeys(obj)) return obj; // Already has proper field names
    
    const remapped = {};
    for (let i = 0; i < fieldNames.length; i++) {
      const numericKey = String(i);
      if (obj.hasOwnProperty(numericKey)) {
        remapped[fieldNames[i]] = obj[numericKey];
      }
    }
    
    // Keep any non-numeric keys
    for (const [key, value] of Object.entries(obj)) {
      if (!/^\d+$/.test(key)) {
        remapped[key] = value;
      }
    }
    
    return remapped;
  };
  
  // Handle array of objects or single object
  if (Array.isArray(data)) {
    return data.map(item => remapObject(item));
  } else {
    return remapObject(data);
  }
}

// === AI EXTRACTION WITH GOOGLE GEMINI VISION ===
async function extractLeadWithAI(input, sourceName, fieldSchema = null, isRetry = false) {
  if (!geminiModel) {
    logger.warn('Google Gemini not configured, skipping AI extraction');
    return null;
  }

  try {
    const isScreenshot = Buffer.isBuffer(input) || (typeof input === 'object' && input.inlineData);
    let prompt = '';
    let content = [];

    // Build field schema prompt with defaults if missing
    if (!fieldSchema || Object.keys(fieldSchema).length === 0) {
      logger.warn(`⚠️ No fieldSchema provided for ${sourceName}, using default schema`);
      fieldSchema = {
        permit_number: { required: true },
        address: { required: false },
        construction_cost: { required: false },
        contractor_name: { required: false },
        company_name: { required: false },
        phone: { required: false },
        date_issued: { required: false },
        permit_type: { required: false }
      };
    }

    const schemaFields = fieldSchema;
    const fieldDescriptions = Object.entries(schemaFields)
      .map(([key, desc]) => `"${key}"`)
      .join(', ');

    if (isScreenshot) {
      // Vision-based extraction
      prompt = `Extract data from this screenshot into JSON format.

REQUIRED JSON FIELDS (use EXACTLY these keys, no modifications):
${fieldDescriptions}

FIELD MATCHING INSTRUCTIONS:
🔍 Look CAREFULLY at the table column headers in the screenshot
🔍 Headers may be abbreviated or truncated (e.g., "Contr." = Contractor, "Val..." = Valuation)
🔍 Match field names by semantic meaning, not exact spelling
🔍 Extract data from matching columns for ALL visible rows
🔍 DO NOT extract by column position - match by HEADER NAME

COLUMN HEADER MATCHING EXAMPLES:
- "number" field → Match headers: "Number", "Permit Number", "Permit #", "Num", "#"
- "type" field → Match headers: "Type", "Permit Type", "Category"
- "valuation" field → Match headers: "Valuation", "Value", "Val", "Amount", "Cost", "Project Value"
- "contractor" field → Match headers: "Contractor", "Contr.", "Contractor Name", "Builder"
- "contractor_phone" field → Match headers: "Contr. Phone", "Phone", "Contact", "Contractor Phone"
- "owner" field → Match headers: "Owner", "Owner Name", "Property Owner"
- "description" field → Match headers: "Description", "Desc", "Work Description", "Project Description"

IMPORTANT FOR PHOENIX PERMITS:
- Table may have abbreviated column headers due to space constraints
- "Contr." means Contractor
- "Val..." or "Valuation" means project value
- Read the FIRST ROW of the table as column headers
- Then extract data from ALL subsequent rows

CRITICAL RULES:
✅ CORRECT field names: ${fieldDescriptions}
❌ WRONG - DO NOT concatenate or modify field names
❌ DO NOT add descriptions to field names
❌ DO NOT use underscores to join field name + description
❌ DO NOT extract by column position - ALWAYS match by header name

EXAMPLE OF CORRECT OUTPUT:
[
  {
    "company_name": "ABC Company",
    "website": "https://example.com",
    "phone": "555-1234"
  }
]

EXAMPLE OF WRONG OUTPUT (DO NOT DO THIS):
[
  {
    "company_name_name_of_the_real_estate_company": "ABC Company",
    "website_company_website_url": "https://example.com"
  }
]

EXTRACTION INSTRUCTIONS:
1. Read the table/list column headers in the screenshot
2. For each required field, find the matching column header by semantic meaning
3. Extract data from that column for all visible records
4. Extract ALL visible records from the screenshot (tables, lists, cards)
5. If you see 25 records, extract ALL 25 - do not stop early
6. For each record, use ONLY the field names listed above
7. If a field is missing or empty, use empty string "" NOT null
8. Remove any commas from numbers (e.g., "178,132" → "178132")
9. Return a JSON array if multiple records, JSON object if single record

OUTPUT REQUIREMENTS:
⚠️ Return ONLY valid JSON - no explanations, no markdown, no text
⚠️ Start with [ or {, end with ] or }
⚠️ Use the EXACT field names shown above - do not modify them
⚠️ NO CODE BLOCKS (no triple backticks)
⚠️ NO COMMENTS OR NOTES
⚠️ Use "" for empty fields, NOT null

EXAMPLE OUTPUT:
[
  {
    "permit_number": "2020006147",
    "address": "123 Main St",
    "value": "178132",
    "contractor_name": "ABC Construction",
    "contractor_phone": "615-579-8486"
  },
  {
    "permit_number": "2020006148",
    "address": "456 Oak Ave",
    "value": "",
    "contractor_name": "XYZ Builders",
    "contractor_phone": ""
  }
]

${isRetry ? '\n⚠️ RETRY: Previous extraction failed validation. Double-check field assignments. Read table headers carefully!' : ''}`;

      // Prepare image data - MUST be Base64 encoded for Gemini Vision API
      let imageData;
      if (Buffer.isBuffer(input)) {
        logger.info(`✅ Input is Buffer, converting to Base64 (${input.length} bytes)`);
        imageData = {
          inlineData: {
            data: input.toString('base64'),
            mimeType: 'image/png'
          }
        };
      } else if (input && typeof input === 'object' && input.type === 'Buffer' && Array.isArray(input.data)) {
        // Handle serialized Buffer object { type: 'Buffer', data: [...] }
        logger.info(`✅ Input is serialized Buffer, converting to Base64 (${input.data.length} bytes)`);
        const buffer = Buffer.from(input.data);
        imageData = {
          inlineData: {
            data: buffer.toString('base64'),
            mimeType: 'image/png'
          }
        };
      } else if (input && typeof input === 'object' && input.inlineData) {
        // Already in correct format
        logger.info(`✅ Input already in inlineData format`);
        imageData = input;
      } else {
        // Try to convert whatever we got to Buffer
        logger.warn(`⚠️ Unexpected input type: ${typeof input}, attempting conversion`);
        try {
          const buffer = Buffer.from(input);
          imageData = {
            inlineData: {
              data: buffer.toString('base64'),
              mimeType: 'image/png'
            }
          };
        } catch (e) {
          logger.error(`❌ Failed to convert input to Base64: ${e.message}`);
          throw new Error('Screenshot must be a Buffer or Base64-encoded image');
        }
      }

      content = [{ role: 'user', parts: [{ text: prompt }, imageData] }];
    } else {
      // Text-based extraction (fallback)
      const truncatedText = typeof input === 'string' ? input.substring(0, 6000) : String(input).substring(0, 6000);
      
      prompt = `Extract construction/building project lead information from the following text:

${fieldDescriptions}

IMPORTANT:
- "value" field should contain ONLY project budget/cost/value (like "$500,000"), never phone numbers
- "phone" field should contain phone numbers (like "602-322-6100")
- Use null for any missing fields
- Return ONLY a valid JSON object, no explanations

${isRetry ? 'RETRY ATTEMPT: Previous extraction had validation errors. Please double-check your field assignments.' : ''}

Text to extract from:
${truncatedText}`;

      content = [{ role: 'user', parts: [{ text: prompt }] }];
    }

    const result = await geminiModel.generateContent({ contents: content, generationConfig: buildGenConfig() });
    const response = await result.response;
    const text = response.text();
    
    logger.info(`📝 Raw AI response length: ${text.length} chars`);
    logger.info(`📝 Raw AI response (first 1000 chars): ${text.substring(0, 1000)}`);
    if (text.length > 1000) {
      logger.info(`📝 Raw AI response (last 500 chars): ...${text.substring(text.length - 500)}`);
    }
    
    // Clean up response (remove markdown and extract JSON)
    let cleanedText = text.trim();
    
    // Remove markdown code blocks
    if (cleanedText.startsWith('```json')) {
      cleanedText = cleanedText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    } else if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.replace(/```\n?/g, '');
    }
    
    // If AI added explanatory text, extract only the JSON part
    // Look for first { or [ and last } or ]
    const jsonStart = Math.min(
      cleanedText.indexOf('{') >= 0 ? cleanedText.indexOf('{') : Infinity,
      cleanedText.indexOf('[') >= 0 ? cleanedText.indexOf('[') : Infinity
    );
    const jsonEnd = Math.max(
      cleanedText.lastIndexOf('}'),
      cleanedText.lastIndexOf(']')
    );
    
    if (jsonStart < Infinity && jsonEnd > jsonStart) {
      cleanedText = cleanedText.substring(jsonStart, jsonEnd + 1);
    }
    
    // Final cleanup - remove any remaining non-JSON text
    cleanedText = cleanedText.trim();
    
    logger.info(`🧹 Cleaned JSON length: ${cleanedText.length} chars`);
    logger.info(`🧹 Cleaned JSON (first 1000 chars): ${cleanedText.substring(0, 1000)}`);
    
    // Try to fix incomplete JSON arrays/objects
    if (cleanedText.startsWith('[') && !cleanedText.endsWith(']')) {
      logger.warn(`⚠️ Incomplete JSON array detected, attempting to close it`);
      // Count open braces to close properly
      let openBraces = 0;
      for (const char of cleanedText) {
        if (char === '{') openBraces++;
        if (char === '}') openBraces--;
      }
      // Close any open objects
      while (openBraces > 0) {
        cleanedText += '}';
        openBraces--;
      }
      // Close the array
      cleanedText += ']';
      logger.info(`🔧 Fixed JSON: ${cleanedText.substring(cleanedText.length - 100)}`);
    }
    
    // Safer JSON parse: fix common issues like single quotes and trailing commas
    const safeParse = (txt) => {
      try { return JSON.parse(txt); } catch (e) {
        logger.warn(`❌ JSON.parse failed: ${e.message}`);
      }
      try {
        let t = txt;
        // Fix trailing commas (common AI mistake)
        t = t.replace(/,\s*([\]}])/g, '$1');
        // Replace single quotes around keys/strings with double quotes carefully
        t = t.replace(/\{\s*'([^']+)'\s*:/g, '{ "$1":');
        t = t.replace(/:\s*'([^']*)'/g, ': "$1"');
        // Fix missing quotes on keys (but be careful not to break numbers)
        t = t.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');
        // Remove any extra text after the final closing bracket
        const lastBracket = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
        if (lastBracket > 0 && lastBracket < t.length - 1) {
          t = t.substring(0, lastBracket + 1);
        }
        logger.info(`🔧 Trying to parse with fixes applied`);
        return JSON.parse(t);
      } catch (e2) {
        logger.error(`❌ Safe parse also failed: ${e2.message}`);
        logger.error(`Problem text: ${txt.substring(0, 500)}`);
      }
      throw new Error('Invalid JSON returned by AI');
    };
    const extracted = safeParse(cleanedText);
    
    // Fix numeric keys if AI returned {"0": "value", "1": "value"} instead of proper field names
    const fixedExtracted = remapNumericKeysToFieldNames(extracted, fieldSchema);
    
    // Validate extracted data
    const validation = validateExtractedFields(fixedExtracted, sourceName, fieldSchema);
    
    if (validation.isValid) {
      logger.info(`✨ AI extracted lead from ${sourceName} (confidence: ${validation.confidence}%) ${isScreenshot ? '[VISION]' : '[TEXT]'}`);
      // If extracted is an array, add confidence to each item and return the array
      if (Array.isArray(fixedExtracted)) {
        return fixedExtracted.map(item => ({ ...item, _aiConfidence: validation.confidence }));
      }
      return { ...fixedExtracted, _aiConfidence: validation.confidence };
    } else if (!isRetry) {
      // Try one more time with validation feedback
      logger.warn(`⚠️ First extraction had issues, retrying... ${validation.issues.join(', ')}`);
      return await extractLeadWithAI(input, sourceName, fieldSchema, true);
    } else {
      logger.warn(`⚠️ AI extraction validation failed after retry for ${sourceName}`);
      // If extracted is an array, add confidence to each item
      if (Array.isArray(fixedExtracted)) {
        return fixedExtracted.map(item => ({ ...item, _aiConfidence: validation.confidence, _validationIssues: validation.issues }));
      }
      return { ...fixedExtracted, _aiConfidence: validation.confidence, _validationIssues: validation.issues };
    }
    
  } catch (error) {
    logger.error(`AI extraction failed for ${sourceName}: ${error.message}`);
    return null;
  }
}

// === HTTP with retry ===
async function getWithRetry(url, options = {}, retries = 3, baseDelayMs = 500) {
  let attempt = 0;
  let lastErr;
  const method = (options.method || 'GET').toUpperCase();
  // Build axios config for request() - honors method/data/options
  const axiosConfig = Object.assign({}, axiosProxyConfig, options, { url, method });
  
  while (attempt <= retries) {
    try {
      return await axios.request(axiosConfig);
    } catch (err) {
      lastErr = err;
      attempt++;
      if (attempt > retries) break;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// === ASYNC DB HELPERS ===
// better-sqlite3 helpers (synchronous, wrapped in async for API compatibility)
function dbGet(sql, params = []) {
  return Promise.resolve(db.prepare(sql).get(...params));
}

function dbRun(sql, params = []) {
  const res = db.prepare(sql).run(...params);
  
  // Normalize better-sqlite3 response for compatibility
  return Promise.resolve({ 
    changes: res.changes, 
    lastInsertRowid: res.lastInsertRowid,
    lastID: res.lastInsertRowid // Backward compat alias
  });
}

function dbAll(sql, params = []) {
  return Promise.resolve(db.prepare(sql).all(...params));
}

// Create a notification for a user
async function createNotification(userId, type, message) {
  try {
    await dbRun(
      'INSERT INTO notifications (user_id, type, message, created_at, is_read) VALUES (?, ?, ?, ?, 0)',
      [userId, type, message, new Date().toISOString()]
    );
    logger.info(`📬 Notification created for user ${userId}: ${message}`);
  } catch (e) {
    logger.error(`Failed to create notification: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// PERMIT-BASED HASH GENERATION (Cross-Source Deduplication)
// ═══════════════════════════════════════════════════════════════════
function generateLeadHash(leadData, userId) {
  // Extract permit number (try multiple field names)
  const permitNumber = (
    leadData.permit_number || 
    leadData.permitNumber || 
    leadData['Permit Number'] ||
    leadData.permit_no ||
    leadData.number ||
    ''
  ).toString().trim().toUpperCase();
  
  if (!permitNumber) {
    // Fallback: use company + address if no permit number
    const fallback = [
      (leadData.company_name || leadData.contractor_name || '').trim(),
      (leadData.address || '').trim(),
      (leadData.value || '').toString()
    ].filter(Boolean).join('-').toLowerCase();
    
    if (!fallback) {
      // Last resort: use raw JSON
      return crypto.createHash('sha256')
        .update(JSON.stringify(leadData) + userId)
        .digest('hex');
    }
    
    return crypto.createHash('sha256')
      .update(`${fallback}-${userId}`)
      .digest('hex');
  }
  
  // Hash based on permit number + userId (cross-source deduplication)
  const hashInput = `${permitNumber}-${userId}`;
  return crypto.createHash('sha256').update(hashInput).digest('hex');
}

async function insertLeadIfNew({ raw, sourceName, lead, hashSalt = '', userId, extractedData = null, sourceId = null }) {
  if (!sourceId) {
    logger.warn(`No sourceId provided - skipping lead insertion`);
    return false;
  }

  // Use extractedData if available, otherwise fall back to lead
  const leadData = extractedData || lead;
  
  // Extract permit number (try multiple field names)
  const permitNumber = (
    leadData.permit_number || 
    leadData.permitNumber || 
    leadData['Permit Number'] ||
    leadData.permit_no ||
    leadData.number ||
    ''
  ).toString().trim();
  
  if (!permitNumber) {
    logger.warn('⚠️ Lead has no permit number, skipping');
    return false;
  }

  // Generate stable hash based on permit number
  const hash = generateLeadHash(leadData, userId);

  try {
    const tx = db.transaction(() => {
      // Check if already seen
      const seenRow = db.prepare(`
        SELECT id, seen_count, last_seen 
        FROM seen 
        WHERE lead_hash = ? AND user_id = ?
      `).get(hash, userId);
      
      if (seenRow) {
        // Update seen count and timestamp
        db.prepare(`
          UPDATE seen 
          SET seen_count = seen_count + 1, 
              last_seen = CURRENT_TIMESTAMP 
          WHERE id = ?
        `).run(seenRow.id);
        
        logger.info(`♻️ Duplicate: ${permitNumber} (seen ${seenRow.seen_count + 1} times)`);
        return { inserted: false, reason: 'duplicate', hash, permitNumber };
      }
      
      // Try to insert into unified leads table
      try {
        const insertResult = db.prepare(`
          INSERT INTO leads (
            user_id,
            source_id,
            hash,
            permit_number,
            permit_type,
            contractor_name,
            company_name,
            address,
            city,
            state,
            zip_code,
            phone,
            value,
            description,
            status,
            raw_text,
            date_issued,
            owner_name,
            contractor_phone,
            square_footage,
            parcel_number,
            work_description
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          userId,
          sourceId,
          hash,
          permitNumber,
          leadData.permit_type || leadData.permitType || null,
          leadData.contractor_name || leadData.contractor || null,
          leadData.company_name || leadData.companyName || null,
          leadData.address || null,
          leadData.city || null,
          leadData.state || null,
          leadData.zip_code || leadData.zip || null,
          leadData.phone || leadData.contractor_phone || null,
          leadData.value || leadData.construction_cost || null,
          leadData.description || leadData.work_description || null,
          leadData.status || 'new',
          JSON.stringify(leadData),
          leadData.date_issued || leadData.dateIssued || null,
          leadData.owner_name || leadData.owner || null,
          leadData.contractor_phone || null,
          leadData.square_footage || leadData.squareFootage || null,
          leadData.parcel_number || leadData.parcelNumber || null,
          leadData.work_description || leadData.workDescription || null
        );
        
        const leadId = insertResult.lastInsertRowid;
        
        // Mark as seen
        db.prepare(`
          INSERT INTO seen (lead_hash, user_id, source_id, permit_number)
          VALUES (?, ?, ?, ?)
        `).run(hash, userId, sourceId, permitNumber);
        
        // Also insert into source-specific table for backwards compatibility
        insertIntoSourceTableSync(sourceId, userId, raw, lead, extractedData);
        
        // Create outbox entry for JSONL export
        const jobId = crypto.randomBytes(8).toString('hex');
        const payload = JSON.stringify({
          leadId,
          hash,
          sourceName,
          userId,
          sourceId,
          permitNumber,
          data: leadData,
          job_id: jobId,
          ts: new Date().toISOString()
        });
        
        db.prepare(`
          INSERT INTO outbox (source_id, job_id, event_type, payload_json)
          VALUES (?, ?, ?, ?)
        `).run(sourceId, jobId, 'append-jsonl', payload);
        
        logger.info(`✅ NEW LEAD: ${permitNumber} | ${leadData.contractor_name || leadData.company_name || 'N/A'} | $${leadData.value || 0}`);
        
        return { 
          inserted: true, 
          leadId, 
          hash, 
          permitNumber 
        };
        
      } catch (dbError) {
        if (dbError.message.includes('UNIQUE constraint failed')) {
          // Permit already exists (caught by unique constraint)
          logger.info(`♻️ Duplicate (DB): ${permitNumber}`);
          
          // Still mark as seen
          db.prepare(`
            INSERT OR IGNORE INTO seen (lead_hash, user_id, source_id, permit_number)
            VALUES (?, ?, ?, ?)
          `).run(hash, userId, sourceId, permitNumber);
          
          return { inserted: false, reason: 'duplicate_db', permitNumber };
        }
        throw dbError;
      }
    });
    
    const result = tx();
    return result.inserted || false;
    
  } catch (err) {
    logger.error(`❌ Failed to insert lead: ${err.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Function: Insert into Source-Specific Table (Sync for transaction)
// ═══════════════════════════════════════════════════════════════════
function insertIntoSourceTableSync(sourceId, userId, rawText, lead, extractedData) {
  // Validate table name to prevent SQL injection
  const tableName = `source_${sourceId}`;
  if (!/^source_\d+$/.test(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
  
  try {
    // Check if table exists, create if missing
    const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
    if (!tableExists) {
      logger.warn(`Table ${tableName} doesn't exist - creating it now with source's fieldSchema`);
      
      // Fetch the source config to get fieldSchema
      const sourceRow = db.prepare(`SELECT source_data FROM user_sources WHERE id = ?`).get(sourceId);
      let fieldSchema = null;
      if (sourceRow) {
        try {
          const sourceConfig = JSON.parse(sourceRow.source_data);
          fieldSchema = sourceConfig.fieldSchema || null;
        } catch (parseErr) {
          logger.warn(`Failed to parse source config for source_${sourceId}: ${parseErr.message}`);
        }
      }
      
      createSourceTable(sourceId, fieldSchema);
    }
    
    // Get table columns to determine available fields
    const tableInfo = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const columns = tableInfo.map(col => col.name);
    
    // Build dynamic insert based on available columns
    const values = {};
    values.user_id = userId;
    values.raw_text = rawText;
    values.page_url = lead.page_url || '';
    values.source_name = lead.source_name || '';
    
    // Map extractedData to available columns
    if (extractedData) {
      for (const [key, value] of Object.entries(extractedData)) {
        if (columns.includes(key) && key !== '_aiConfidence' && key !== '_validationIssues') {
          values[key] = value;
        }
      }
    }
    
    // Generate hash for this source-specific table
    const hash = crypto.createHash('md5').update(`${rawText}${sourceId}`).digest('hex');
    if (columns.includes('_hash')) {
      values._hash = hash;
    } else if (columns.includes('hash')) {
      values.hash = hash;
    }
    
    // Build INSERT statement
    const columnNames = Object.keys(values).join(', ');
    const placeholders = Object.keys(values).map(() => '?').join(', ');
    const insertSQL = `INSERT INTO ${tableName} (${columnNames}) VALUES (${placeholders})`;
    
    const result = db.prepare(insertSQL).run(...Object.values(values));
    
    if (result.changes > 0) {
      logger.info(`✅ Inserted into ${tableName} (row ${result.lastInsertRowid})`);
      return true;
    } else {
      logger.warn(`⚠️ No rows inserted into ${tableName} - possible duplicate or constraint violation`);
      return false;
    }
  } catch (err) {
    logger.error(`Failed to insert into ${tableName}: ${err.message}`);
    return false;
  }
}

// Async wrapper for backwards compatibility
async function insertIntoSourceTable(sourceId, userId, rawText, lead, extractedData) {
  return insertIntoSourceTableSync(sourceId, userId, rawText, lead, extractedData);
}

// ═══════════════════════════════════════════════════════════════════
// DEPRECATED: Old insertIntoSourceTable (replaced above)
// ═══════════════════════════════════════════════════════════════════
async function insertIntoSourceTable_OLD(sourceId, userId, rawText, lead, extractedData) {
  const tableName = `source_${sourceId}`;
  
  // Validate table name to prevent SQL injection
  if (!/^source_\d+$/.test(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
  
  // Check if table exists
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
  if (!tableExists) {
    logger.warn(`Table ${tableName} does not exist, skipping source-specific insert`);
    return;
  }
  
  // Get all columns from the table
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const columnNames = columns.map(col => col.name).filter(name => 
    name !== 'id' && name !== 'created_at' // Auto-generated columns
  );
  
  // Build data object with all available fields
  const data = {
    user_id: userId,
    raw_text: rawText,
    page_url: lead.page_url || null,
    hash: crypto.createHash('md5').update(rawText + sourceId).digest('hex'),
    source_name: lead.source || 'Unknown',
    ...extractedData // Spread all extracted fields
  };
  
  // Build INSERT query dynamically
  const validColumns = columnNames.filter(col => data[col] !== undefined);
  const placeholders = validColumns.map(() => '?').join(', ');
  const values = validColumns.map(col => data[col]);
  
  const insertSQL = `INSERT OR IGNORE INTO ${tableName} (${validColumns.join(', ')}) VALUES (${placeholders})`;
  
  db.prepare(insertSQL).run(...values);
  logger.info(`✅ Saved to source table: ${tableName}`);
}

// ═══════════════════════════════════════════════════════════════════
// Function: Create Source-Specific Table
// ═══════════════════════════════════════════════════════════════════
function createSourceTable(sourceId, fieldSchema) {
  const tableName = `source_${sourceId}`;
  
  // Base columns that every source table has
  const baseColumns = [
    'id INTEGER PRIMARY KEY AUTOINCREMENT',
    'user_id INTEGER DEFAULT 1',
    'raw_text TEXT',
    'page_url TEXT',
    'hash TEXT UNIQUE',
    'source_name TEXT',
    'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
  ];
  
  // Add custom fields from fieldSchema
  const customColumns = [];
  if (fieldSchema && typeof fieldSchema === 'object') {
    Object.keys(fieldSchema).forEach(fieldName => {
      customColumns.push(`${fieldName} TEXT`);
    });
  }
  
  // Combine all columns
  const allColumns = [...baseColumns, ...customColumns];
  const createSQL = `CREATE TABLE IF NOT EXISTS ${tableName} (${allColumns.join(', ')})`;
  
  logger.info(`📊 Creating source table: ${tableName} with ${customColumns.length} custom fields`);
  db.exec(createSQL);
  
  return tableName;
}

// === DATABASE ===
const { DB_PATH, SESSIONS_DB_PATH } = require('./db-path');
const db = new Database(DB_PATH);

// FIX SOURCE 7 - Add fieldSchema and recreate table
try {
  const source7 = db.prepare('SELECT source_data FROM user_sources WHERE id = 7').get();
  if (source7) {
    const sourceData = JSON.parse(source7.source_data);
    if (!sourceData.fieldSchema) {
      logger.info('🔧 Fixing source 7 - Adding fieldSchema...');
      sourceData.fieldSchema = {
        "permit_number": "Permit number",
        "address": "Full address",
        "company_name": "Company name",
        "contractor_name": "Contractor name",
        "phone": "Phone number",
        "permit_type": "Permit type",
        "date_issued": "Date issued",
        "construction_cost": "Construction cost",
        "description": "Description"
      };
      db.prepare('UPDATE user_sources SET source_data = ? WHERE id = 7').run(JSON.stringify(sourceData));
      
      // Recreate table with custom columns
      db.exec('DROP TABLE IF EXISTS source_7');
      const baseColumns = [
        'id INTEGER PRIMARY KEY AUTOINCREMENT',
        'user_id INTEGER DEFAULT 1',
        'raw_text TEXT',
        'page_url TEXT',
        'hash TEXT UNIQUE',
        'source_name TEXT',
        'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
      ];
      const customColumns = Object.keys(sourceData.fieldSchema).map(field => `${field} TEXT`);
      const allColumns = [...baseColumns, ...customColumns];
      db.exec(`CREATE TABLE source_7 (${allColumns.join(', ')})`);
      logger.info('✅ Source 7 table recreated with custom columns');
    }
  }
} catch (fixErr) {
  logger.warn('Could not fix source 7:', fixErr.message);
}

// ============================================
// UNIFIED LEADS TABLE + PERMIT-BASED DEDUPLICATION
// ============================================

// Drop old seen table if it exists (will be recreated with new schema)
try {
  db.exec(`DROP TABLE IF EXISTS seen`);
} catch (e) {
  logger.warn('Could not drop old seen table:', e.message);
}

// Create new seen tracking table with statistics
db.exec(`CREATE TABLE IF NOT EXISTS seen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_hash TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  source_id INTEGER NOT NULL,
  permit_number TEXT,
  first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  seen_count INTEGER DEFAULT 1,
  UNIQUE(lead_hash, user_id)
)`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_seen_hash ON seen(lead_hash)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_seen_user ON seen(user_id)`);

// Create tables (better-sqlite3 is synchronous)
db.exec(`CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    source_id INTEGER NOT NULL,
    hash TEXT,
    raw_text TEXT,
    permit_number TEXT NOT NULL,
    address TEXT,
    value TEXT,
    description TEXT,
    source TEXT,
    date_added TEXT,
    date_issued TEXT,
    phone TEXT,
    page_url TEXT,
    application_date TEXT,
    owner_name TEXT,
    contractor_name TEXT,
    contractor_address TEXT,
    contractor_city TEXT,
    contractor_state TEXT,
    contractor_zip TEXT,
    contractor_phone TEXT,
    square_footage TEXT,
    units TEXT,
    floors TEXT,
    parcel_number TEXT,
    permit_type TEXT,
    permit_subtype TEXT,
    work_description TEXT,
    purpose TEXT,
    city TEXT,
    state TEXT,
    zip_code TEXT,
    latitude TEXT,
    longitude TEXT,
    status TEXT,
    record_type TEXT,
    project_name TEXT,
    is_new INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, permit_number)
  )`);

// Add missing columns if they don't exist (for existing databases)
try {
  db.exec(`ALTER TABLE leads ADD COLUMN source_id INTEGER`);
} catch (err) {
  // Column already exists
}
try {
  db.exec(`ALTER TABLE leads ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
} catch (err) {
  // Column already exists
}
try {
  db.exec(`ALTER TABLE leads ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
} catch (err) {
  // Column already exists
}
const newColumns = [
  'date_issued', 'phone', 'page_url', 'application_date', 'owner_name', 
  'contractor_name', 'contractor_address', 'contractor_city', 'contractor_state',
  'contractor_zip', 'contractor_phone', 'square_footage', 'units', 'floors',
  'parcel_number', 'permit_type', 'permit_subtype', 'work_description', 'purpose',
  'city', 'state', 'zip_code', 'latitude', 'longitude', 'status', 'record_type', 'project_name', 'is_new', 'extracted_data'
];

newColumns.forEach(col => {
  try {
    const columnType = col === 'is_new' ? 'INTEGER DEFAULT 1' : 'TEXT';
    db.exec(`ALTER TABLE leads ADD COLUMN ${col} ${columnType}`);
  } catch (err) {
    // Column already exists, ignore
  }
});

db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_user ON leads(user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(user_id, source_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_permit ON leads(permit_number)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_contractor ON leads(contractor_name)`);
db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'client',
    company_name TEXT,
    phone TEXT,
    website TEXT,
    created_at TEXT,    
    email_verified INTEGER DEFAULT 0,
    verification_token TEXT
  )`);

// Per-user source configuration (JSON stored as text)
db.exec(`CREATE TABLE IF NOT EXISTS user_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    source_data TEXT NOT NULL,
    created_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

// Simple contact/inquiry storage for landing page form
db.exec(`CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    company TEXT,
    message TEXT,
    created_at TEXT
  )`);

// Notifications table for user activity tracking
db.exec(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC)`);

// Attempt to add columns if missing (safe migrations with better-sqlite3)
try {
  const inquiryColumns = db.prepare("PRAGMA table_info(inquiries)").all();
  if (!inquiryColumns.find(c => c.name === 'ip')) {
    db.exec('ALTER TABLE inquiries ADD COLUMN ip TEXT');
  }
} catch (err) {
  // Column already exists or other error
}

// Add profile columns to existing users table if missing
try {
  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  if (!userColumns.find(c => c.name === 'company_name')) {
    logger.info('Adding company_name column to users table');
    db.exec('ALTER TABLE users ADD COLUMN company_name TEXT');
  }
  if (!userColumns.find(c => c.name === 'phone')) {
    logger.info('Adding phone column to users table');
    db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
  }
  if (!userColumns.find(c => c.name === 'website')) {
    logger.info('Adding website column to users table');
    db.exec('ALTER TABLE users ADD COLUMN website TEXT');
  }
  logger.info('✅ Users table migrations complete');
} catch (err) {
  logger.error('Error migrating users table: ' + err.message);
}

// Add columns to existing leads table if missing
try {
  const leadColumns = db.prepare("PRAGMA table_info(leads)").all();
  if (!leadColumns.find(c => c.name === 'user_id')) {
    db.exec('ALTER TABLE leads ADD COLUMN user_id INTEGER DEFAULT 1');
    logger.info('Added user_id column to leads table');
  }
  if (!leadColumns.find(c => c.name === 'source_id')) {
    db.exec('ALTER TABLE leads ADD COLUMN source_id INTEGER DEFAULT 0');
    logger.info('Added source_id column to leads table');
  }
  if (!leadColumns.find(c => c.name === 'canonical_hash')) {
    db.exec('ALTER TABLE leads ADD COLUMN canonical_hash TEXT');
    logger.info('Added canonical_hash column to leads table');
  }
  if (!leadColumns.find(c => c.name === 'ai_confidence')) {
    db.exec("ALTER TABLE leads ADD COLUMN ai_confidence REAL");
    logger.info('Added ai_confidence column to leads table');
  }
  if (!leadColumns.find(c => c.name === 'ai_validated')) {
    db.exec("ALTER TABLE leads ADD COLUMN ai_validated INTEGER DEFAULT 0");
    logger.info('Added ai_validated column to leads table');
  }
  if (!leadColumns.find(c => c.name === 'ai_validation_issues')) {
    db.exec("ALTER TABLE leads ADD COLUMN ai_validation_issues TEXT");
    logger.info('Added ai_validation_issues column to leads table');
  }
  // Ensure unique index on (source_id, canonical_hash)
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_leads_source_canonical ON leads(source_id, canonical_hash)');
  } catch (ixErr) {
    logger.warn('Could not create unique index ux_leads_source_canonical: ' + ixErr.message);
  }
  // Create outbox table for reliable JSONL persistence
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      job_id TEXT,
      event_type TEXT,
      payload_json TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, created_at)');
  } catch (outErr) {
    logger.warn('Could not create outbox table: ' + outErr.message);
  }
  if (!leadColumns.find(c => c.name === 'phone')) {
    db.exec('ALTER TABLE leads ADD COLUMN phone TEXT');
    logger.info('Added phone column to leads table');
  }
  if (!leadColumns.find(c => c.name === 'page_url')) {
    db.exec('ALTER TABLE leads ADD COLUMN page_url TEXT');
    logger.info('Added page_url column to leads table');
  }
  if (!leadColumns.find(c => c.name === 'date_issued')) {
    db.exec('ALTER TABLE leads ADD COLUMN date_issued TEXT');
    logger.info('Added date_issued column to leads table');
  }
} catch (err) {
  // Columns already exist or other error
}

// === LOAD SOURCES ===
function loadSources() {
  try {
    const raw = fs.readFileSync('sources.json', 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('sources.json must be an array');
    return parsed;
  } catch (e) {
    logger.error(`sources.json not found or invalid! ${e.message}`);
    return [];
  }
}

// === MAIN SCRAPER ===
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
    const timings = {
      networkIdleTimeout: source.timing?.networkIdleTimeout || DEFAULT_TIMINGS.networkIdleTimeout,
      jsRenderWait: source.timing?.jsRenderWait || DEFAULT_TIMINGS.jsRenderWait,
      afterScrollWait: source.timing?.afterScrollWait || DEFAULT_TIMINGS.afterScrollWait,
      betweenScrollWait: source.timing?.betweenScrollWait || DEFAULT_TIMINGS.betweenScrollWait,
      pageLoadWait: source.timing?.pageLoadWait || DEFAULT_TIMINGS.pageLoadWait
    };
    
    try {
      // Apply rate limiting before scraping this source
      await rateLimiter.throttle();
      
      logger.info(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      logger.info(`🔍 Starting source: ${source.name} (User ${userId})`);
      logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
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
        logger.info(`ℹ️  No AI prompt found for this source`);
      }

      // If source explicitly requests Puppeteer (dynamic rendering / JS required)
      if (source.usePuppeteer === true) {
        let browser;
        let page;
        try {
          const launchOptions = {
            headless: process.env.PUPPETEER_HEADLESS === 'false' ? false : 'new',
            protocolTimeout: 300000, // ✅ 5 minutes for slow connections and scrolling
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
          
          logger.info(`🔍 Proxy check for ${source.name}: PROXY_ENABLED=${PROXY_ENABLED}, source.useProxy=${source.useProxy}, shouldUseProxy=${shouldUseProxy}`);
          
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
          
          // ✅ Set page timeouts
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
              logger.info('🔐 Proxy authentication configured');
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
              logger.info(`✅ AI extracted ${aiExtractedData.length} leads`);
              
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
                  logger.info(`✅ New lead from AI: ${leadData.permit_number || leadData.address || 'unknown'}`);
                }
              }
              
              // Close browser and skip normal processing
              if (browser) await browser.close();
              await updateSourceStatus(source._sourceId || source.id, 'success', new Date());
              await updateProgress(userId, { newLeads });
              logger.info(`🎉 AI autonomous scraping complete for ${source.name}: ${newLeads} new leads`);
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
          // === BLOCK DETECTION ===
          const pageContent = await page.content();
          const pageTitle = await page.title();
          const responseStatus = page.url(); // Check if redirected
          
          // Check for actual Cloudflare challenge page (very specific patterns)
          const cfChallenge = /(checking your browser|enable javascript and cookies to continue|cloudflare ray id.*challenge|cf-browser-verification)/i.test(pageContent);
          const isSmallPage = pageContent.length < 50000;
          
          // Check for blocking signals
          const blockSignals = {
            captcha: /captcha|recaptcha|hcaptcha/i.test(pageContent),
            accessDenied: /access denied|forbidden|not authorized/i.test(pageContent),
            cloudflare: cfChallenge && isSmallPage,
            rateLimit: /rate limit|too many requests|slow down/i.test(pageContent),
            blocked: /blocked|banned|suspicious/i.test(pageContent),
            bot: /bot detected|automated/i.test(pageContent)
          };
          
          const isBlocked = Object.values(blockSignals).some(signal => signal);
          
          if (isBlocked && !PROXY_ENABLED) {
            logger.error(`🚫 BLOCKING DETECTED for ${source.name}!`);
            logger.error(`Block signals: ${JSON.stringify(blockSignals, null, 2)}`);
            logger.error(`Page title: ${pageTitle}`);
            logger.error(`Content preview: ${pageContent.substring(0, 500)}`);
            logger.error(`⚠️ SOLUTION: Enable residential proxy to bypass blocking`);
          } else if (isBlocked && PROXY_ENABLED) {
            logger.warn(`⚠️ Possible blocking detected but proxy is enabled - continuing anyway`);
            logger.info(`Block signals: ${JSON.stringify(blockSignals, null, 2)}`);
          } else {
            logger.info(`✅ No blocking detected - page loaded successfully`);
            logger.info(`Page title: ${pageTitle}`);
            logger.info(`Content length: ${pageContent.length} characters`);
          }
          
          // Handle puppeteerConfig actions (for Phoenix, Scottsdale, etc.)
          if (source.puppeteerConfig && source.puppeteerConfig.actions) {
            logger.info(`Executing ${source.puppeteerConfig.actions.length} puppeteer actions for ${source.name}`);
            
            // Wait for initial selector if specified
            if (source.puppeteerConfig.waitForSelector) {
              await page.waitForSelector(source.puppeteerConfig.waitForSelector, { timeout: 15000 });
            }
            
            for (const action of source.puppeteerConfig.actions) {
              try {
                if (action.type === 'select') {
                  await page.select(action.selector, action.value);
                  logger.info(`Selected "${action.value}" in ${action.selector}`);
                } else if (action.type === 'fill') {
                  // Handle dynamic date values
                  let value = action.value;
                  if (value.includes('days_ago')) {
                    const days = parseInt(value);
                    const date = new Date();
                    date.setDate(date.getDate() - days);
                    value = `${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getDate().toString().padStart(2, '0')}/${date.getFullYear()}`;
                  }
                  await page.evaluate((sel, val) => {
                    document.querySelector(sel).value = val;
                  }, action.selector, value);
                  logger.info(`Filled "${value}" into ${action.selector}`);
                } else if (action.type === 'click') {
                  await page.click(action.selector);
                  logger.info(`Clicked ${action.selector}`);
                } else if (action.type === 'wait') {
                  await new Promise(resolve => setTimeout(resolve, action.duration));
                  logger.info(`Waited ${action.duration}ms`);
                }
              } catch (actionError) {
                logger.error(`Failed action ${action.type} on ${action.selector}: ${actionError.message}`);
              }
            }
            
            logger.info(`Completed puppeteer actions for ${source.name}`);
          }
          
          // ============================================
          // UNIVERSAL WAIT FOR DATA TO LOAD
          // ============================================
          logger.info('⏳ Waiting for dynamic content to load...');
          
          // Try common data container selectors
          const dataSelectors = [
            'table tbody tr',
            '[data-row-index]',
            '[role="row"]',
            '.data-row',
            '.permit',
            '.result',
            'ul li',
            '.card'
          ];
          
          // Try each selector (short timeout)
          for (const selector of dataSelectors) {
            try {
              await page.waitForSelector(selector, { timeout: 2000 });
              const count = await page.evaluate((sel) => {
                return document.querySelectorAll(sel).length;
              }, selector);
              
              if (count > 0) {
                logger.info(`✅ Found ${count} elements with: ${selector}`);
                break;
              }
            } catch (e) {
              // Try next selector
            }
          }
          
          // Wait for network to settle
          try {
            await page.waitForNetworkIdle({ timeout: timings.networkIdleTimeout, idleTime: 1000 });
            logger.info(`✅ Network idle - page loaded`);
          } catch (e) {
            logger.warn(`Network idle timeout - continuing anyway`);
          }
          
          // Wait for initial page render
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          // Check if page is still loading
          const stillLoading = await page.evaluate(() => {
            return document.readyState !== 'complete' ||
                   document.querySelector('.loading') !== null ||
                   document.querySelector('.spinner') !== null;
          });
          
          if (stillLoading) {
            logger.info('🔄 Page still loading, waiting more...');
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
          
          // ============================================
          // VALIDATE CONTENT QUALITY
          // ============================================
          let html = await page.content();
          
          const hasUsefulContent = (htmlContent) => {
            if (!htmlContent || htmlContent.length < 1000) {
              return false;
            }
            
            // Bad signals (page wrapper only)
            const badSignals = [
              htmlContent.includes('ace_searchbox') && htmlContent.length < 5000,
              htmlContent.includes('<!DOCTYPE html>') && htmlContent.length < 2000,
              htmlContent.split('\n').length < 50
            ];
            
            if (badSignals.some(Boolean)) {
              return false;
            }
            
            // Good signals (actual data)
            const permitCount = (htmlContent.match(/permit/gi) || []).length;
            const dollarCount = (htmlContent.match(/\$[\d,]+/g) || []).length;
            const phoneCount = (htmlContent.match(/\d{3}[-.)]\d{3}[-.)]\d{4}/g) || []).length;
            const hasTable = htmlContent.includes('<table');
            const hasDataRows = htmlContent.includes('data-row');
            
            const score = 
              (permitCount > 5 ? 1 : 0) +
              (dollarCount > 3 ? 1 : 0) +
              (phoneCount > 0 ? 1 : 0) +
              (hasTable ? 1 : 0) +
              (hasDataRows ? 1 : 0);
            
            logger.info(`📊 Content score: ${score}/5 (permits:${permitCount}, $:${dollarCount}, phones:${phoneCount})`);
            
            return score >= 2;
          };
          
          if (!hasUsefulContent(html)) {
            logger.warn('⚠️ Content quality low, waiting longer and scrolling...');
            
            // Auto-scroll to trigger lazy loading
            logger.info('📜 Auto-scrolling to load lazy content...');
            await page.evaluate(async () => {
              await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 500;
                const timer = setInterval(() => {
                  const scrollHeight = document.body.scrollHeight;
                  window.scrollBy(0, distance);
                  totalHeight += distance;

                  if (totalHeight >= scrollHeight) {
                    clearInterval(timer);
                    window.scrollTo(0, 0); // Scroll back to top
                    resolve();
                  }
                }, 300);
              });
            });
            logger.info('✅ Scrolling complete');
            
            // Wait more
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Get HTML again
            html = await page.content();
            
            // Still bad?
            if (!hasUsefulContent(html)) {
              logger.error('❌ Content still looks empty after retries - will use screenshot-based extraction');
            } else {
              logger.info('✅ Content quality improved after scrolling');
            }
          } else {
            logger.info('✅ Content quality good, proceeding with extraction');
          }
          
          // Additional wait for JavaScript rendering
          await new Promise(resolve => setTimeout(resolve, timings.jsRenderWait));
          
          // Extract data using puppeteerConfig.dataSelector if provided
          if (source.puppeteerConfig && source.puppeteerConfig.dataSelector) {
            logger.info(`Extracting data using selector: ${source.puppeteerConfig.dataSelector}`);
            
            const tableData = await page.evaluate((selector) => {
              // First, get the column headers
              const headerCells = Array.from(document.querySelectorAll('table thead tr th, table tr:first-child th'));
              const headers = headerCells.map(cell => cell.innerText.trim().toLowerCase());
              
              // Then get the data rows using the provided selector
              const rows = Array.from(document.querySelectorAll(selector));
              
              return {
                headers: headers,
                rows: rows.map(row => {
                  const cells = Array.from(row.querySelectorAll('td'));
                  return cells.map(cell => cell.innerText.trim());
                })
              };
            }, source.puppeteerConfig.dataSelector);
            
            if (tableData && tableData.rows && tableData.rows.length > 0) {
              logger.info(`Extracted ${tableData.rows.length} rows from ${source.name}`);
              source.extractTable = true; // Enable table processing
              source.tableData = tableData;
            }
          }
          
          // Check if we need to extract table data (for Nashville-style sites)
          if (source.extractTable === true) {
            logger.info(`Extracting table data for ${source.name}...`);
            
            // First, check if there's a "Load More" or "Show All" button
            logger.info(`Checking for load more buttons...`);
            try {
              // Try to find and click "Show All" or similar buttons
              const loadAllClicked = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, a, span'));
                const loadAllButton = buttons.find(btn => 
                  btn.innerText && (
                    btn.innerText.toLowerCase().includes('show all') ||
                    btn.innerText.toLowerCase().includes('load all') ||
                    btn.innerText.toLowerCase().includes('view all')
                  )
                );
                if (loadAllButton) {
                  loadAllButton.click();
                  return true;
                }
                return false;
              });
              
              if (loadAllClicked) {
                logger.info(`Clicked "Show All" button - waiting for data to load...`);
                await new Promise(resolve => setTimeout(resolve, timings.afterScrollWait));
              }
            } catch (err) {
              logger.info(`No "Show All" button found: ${err.message}`);
            }
            
            // Auto-scroll to load all lazy-loaded data
            logger.info(`Auto-scrolling to load all data...`);
            const totalRows = await page.evaluate(async (preferredScrollSelector, timingsParam) => {
              let previousRowCount = 0;
              let currentRowCount = 0;
              let noChangeCount = 0;
              let scrollAttempts = 0;
              const maxScrollAttempts = 50; // Reduced from 300 to prevent 3-minute timeouts
              
              // Find the actual scrollable container (ArcGIS Hub uses specific containers)
              const isScrollable = (el) => {
                if (!el) return false;
                const cs = getComputedStyle(el);
                const canScroll = /(auto|scroll)/.test(cs.overflowY) || el.scrollHeight > el.clientHeight;
                return canScroll;
              };

              const closestScrollableAncestor = (el) => {
                let node = el;
                while (node && node !== document.body) {
                  if (isScrollable(node)) return node;
                  node = node.parentElement;
                }
                return null;
              };

              const findScrollContainer = () => {
                // Prefer explicit selector
                if (preferredScrollSelector) {
                  const el = document.querySelector(preferredScrollSelector);
                  if (isScrollable(el)) return el;
                }

                // Prefer table/grid viewport containers
                const table = document.querySelector('table')
                  || document.querySelector('[role="grid"]')
                  || document.querySelector('[aria-label*="table"]')
                  || document.querySelector('.esri-feature-table')
                  || document.querySelector('.ag-center-cols-viewport')
                  || document.querySelector('.mdc-data-table__content');
                const fromTable = closestScrollableAncestor(table);
                if (isScrollable(fromTable)) return fromTable;

                // Common scroll containers
                const candidates = [
                  '.ag-center-cols-viewport',
                  '.ag-body-viewport',
                  '.mdc-data-table__content',
                  '.sds-data-table__wrapper',
                  '.table-container',
                  '[class*="data-table"]',
                  '[class*="viewport"]',
                  '[class*="scroll"]',
                  'div[role="main"]',
                  'main'
                ];
                for (const sel of candidates) {
                  const el = document.querySelector(sel);
                  if (isScrollable(el)) return el;
                }
                return null;
              };
              
              const scrollContainer = findScrollContainer();
              console.log('Scroll container found:', scrollContainer ? scrollContainer.className : 'using window');
              
              while (noChangeCount < 12 && scrollAttempts < maxScrollAttempts) {
                // Try clicking "Load More" button if it exists
                const buttons = document.querySelectorAll('button, a[role="button"]');
                for (const btn of buttons) {
                  const text = (btn.textContent || '').toLowerCase();
                  if ((text.includes('load') || text.includes('show') || text.includes('more')) && btn.offsetParent !== null) {
                    btn.click();
                    await new Promise(resolve => setTimeout(resolve, timingsParam.betweenScrollWait));
                    break;
                  }
                }
                
                // Scroll the container or window using incremental wheel to trigger virtualization
                const doWheel = (target) => {
                  try {
                    const evt = new WheelEvent('wheel', { deltaY: 800, bubbles: true });
                    (target || window).dispatchEvent(evt);
                  } catch {}
                };
                if (scrollContainer) {
                  scrollContainer.scrollTop = Math.min(scrollContainer.scrollTop + 800, scrollContainer.scrollHeight);
                  doWheel(scrollContainer);
                } else {
                  window.scrollTo({ top: document.documentElement.scrollTop + 1000, behavior: 'instant' });
                  doWheel(window);
                }
                
                await new Promise(resolve => setTimeout(resolve, timingsParam.betweenScrollWait));
                
                // Count current items using multiple common patterns (tables, grids, lists)
                const countItems = () => {
                  const candidates = [
                    'table tbody tr',
                    '.k-grid tbody tr',
                    '.esri-feature-table__body tr',
                    '.esri-feature-table__row',
                    'div[role="row"]',
                    '[role="listitem"]',
                    'ul li',
                    '.mdc-data-table__row',
                    '.MuiDataGrid-row',
                    '.mat-row',
                    '[data-rowindex]',
                    '.grid-row',
                    '.card, .result-card, .search-result',
                    '.ag-center-cols-container .ag-row'
                  ];
                  let maxCount = 0;
                  let matchedSelector = '';
                  for (const sel of candidates) {
                    const c = document.querySelectorAll(sel).length;
                    if (c > maxCount) { maxCount = c; matchedSelector = sel; }
                  }
                  // Debug hint in console to help tuning
                  if (typeof console !== 'undefined') console.debug('Counted', maxCount, 'items using', matchedSelector);
                  return maxCount;
                };

                currentRowCount = countItems();
                
                if (currentRowCount === previousRowCount) {
                  noChangeCount++;
                } else {
                  console.log(`Loaded ${currentRowCount} rows (was ${previousRowCount})`);
                  noChangeCount = 0;
                  previousRowCount = currentRowCount;
                }
                
                scrollAttempts++;
              }
              
              // If table shows pagination controls, click Next until disabled
              const nextBtn = document.querySelector('button[aria-label*="Next"], button[title*="Next"], button');
              let safety = 0;
              while (nextBtn && !nextBtn.disabled && safety < 50) {
                const text = (nextBtn.textContent || '').toLowerCase();
                if (text.includes('next')) {
                  nextBtn.click();
                  await new Promise(r => setTimeout(r, 1200));
                  const after = countItems();
                  if (after <= currentRowCount) break;
                  currentRowCount = after;
                }
                safety++;
              }

              return currentRowCount;
            }, source.puppeteerConfig?.scrollSelector || null, timings);
            logger.info(`Finished auto-scrolling - loaded ${totalRows} total rows`);
            
            // Use pre-extracted tableData if available, otherwise extract now
            let tableData = source.tableData;
            if (!tableData) {
              tableData = await page.evaluate(() => {
                // First, get the column headers
                const headerCells = Array.from(document.querySelectorAll('table thead tr th'));
                const headers = headerCells.map(cell => cell.innerText.trim().toLowerCase());
                
                // Then get the data rows
                const rows = Array.from(document.querySelectorAll('table tbody tr'));
                
                return {
                  headers: headers,
                  rows: rows.map(row => {
                    const cells = Array.from(row.querySelectorAll('td'));
                    return cells.map(cell => cell.innerText.trim());
                  })
                };
              });
            }
            
            if (tableData && tableData.rows && tableData.rows.length > 0) {
              logger.info(`Extracted ${tableData.rows.length} rows from table`);
              logger.info(`Table headers: ${JSON.stringify(tableData.headers)}`);
              
              // Map headers to find the right columns
              const headers = tableData.headers;
              const permitIdx = headers.findIndex(h => h.includes('permit') && (h.includes('number') || h.includes('#') || h.includes('num')));
              const addressIdx = headers.findIndex(h => h.includes('address') && !h.includes('contractor'));
              const costIdx = headers.findIndex(h => h.includes('cost') || (h.includes('value') && !h.includes('icc')));
              const typeIdx = headers.findIndex(h => h.includes('permit') && h.includes('type') && !h.includes('subtype'));
              const subtypeIdx = headers.findIndex(h => h.includes('subtype') || h.includes('sub type'));
              const dateIssuedIdx = headers.findIndex(h => h.includes('issued') || (h.includes('date') && h.includes('issue')));
              const dateEnteredIdx = headers.findIndex(h => h.includes('entered') || (h.includes('date') && h.includes('enter')));
              const applicationDateIdx = headers.findIndex(h => h.includes('application') && h.includes('date'));
              const contactIdx = headers.findIndex(h => h.includes('contact') && !h.includes('contractor'));
              const phoneIdx = headers.findIndex(h => (h.includes('phone') || h.includes('telephone')) && !h.includes('contractor'));
              const ownerIdx = headers.findIndex(h => h.includes('owner') || h.includes('applicant'));
              // Try "contractor name" first, then fall back to "contact" for contractor
              const contractorNameIdx = headers.findIndex(h => h.includes('contractor') && h.includes('name'));
              const contractorFallbackIdx = contractorNameIdx === -1 ? contactIdx : -1;
              const contractorAddressIdx = headers.findIndex(h => h.includes('contractor') && h.includes('address'));
              const contractorPhoneIdx = headers.findIndex(h => h.includes('contractor') && h.includes('phone'));
              const sqFtIdx = headers.findIndex(h => h.includes('square') || h.includes('sq'));
              const unitsIdx = headers.findIndex(h => h.includes('unit'));
              const floorsIdx = headers.findIndex(h => h.includes('floor'));
              const parcelIdx = headers.findIndex(h => h.includes('parcel') || h.includes('folio'));
              const cityIdx = headers.findIndex(h => h.includes('city') && !h.includes('contractor'));
              const stateIdx = headers.findIndex(h => h.includes('state') && !h.includes('contractor'));
              const zipIdx = headers.findIndex(h => h.includes('zip'));
              const latIdx = headers.findIndex(h => h.includes('latitude') || h.includes('lat'));
              const lonIdx = headers.findIndex(h => h.includes('longitude') || h.includes('lon'));
              const statusIdx = headers.findIndex(h => h.includes('status'));
              const purposeIdx = headers.findIndex(h => h.includes('purpose') || h.includes('description') && !h.includes('type'));
              
              logger.info(`Column indices - phone:${phoneIdx}, contact:${contactIdx}, contractor:${contractorNameIdx}, contractorPhone:${contractorPhoneIdx}`);
              logger.info(`Column mapping: permit=${permitIdx}, address=${addressIdx}, cost=${costIdx}, type=${typeIdx}, subtype=${subtypeIdx}`);
              
              // Convert table rows to JSON-like objects
              data = tableData.rows.map(cells => {
                return {
                  permit_number: permitIdx >= 0 ? cells[permitIdx] : '',
                  address: addressIdx >= 0 ? cells[addressIdx] : '',
                  construction_cost: costIdx >= 0 ? cells[costIdx] : '',
                  permit_type: typeIdx >= 0 ? cells[typeIdx] : '',
                  permit_subtype: subtypeIdx >= 0 ? cells[subtypeIdx] : '',
                  date_issued: dateIssuedIdx >= 0 ? cells[dateIssuedIdx] : '',
                  date_entered: dateEnteredIdx >= 0 ? cells[dateEnteredIdx] : '',
                  application_date: applicationDateIdx >= 0 ? cells[applicationDateIdx] : '',
                  phone: phoneIdx >= 0 ? cells[phoneIdx] : '',
                  owner_name: ownerIdx >= 0 ? cells[ownerIdx] : '',
                  contractor_name: (contractorNameIdx >= 0 ? cells[contractorNameIdx] : (contractorFallbackIdx >= 0 ? cells[contractorFallbackIdx] : '')),
                  contractor_address: contractorAddressIdx >= 0 ? cells[contractorAddressIdx] : '',
                  contractor_phone: contractorPhoneIdx >= 0 ? cells[contractorPhoneIdx] : '',
                  square_footage: sqFtIdx >= 0 ? cells[sqFtIdx] : '',
                  units: unitsIdx >= 0 ? cells[unitsIdx] : '',
                  floors: floorsIdx >= 0 ? cells[floorsIdx] : '',
                  parcel_number: parcelIdx >= 0 ? cells[parcelIdx] : '',
                  city: cityIdx >= 0 ? cells[cityIdx] : '',
                  state: stateIdx >= 0 ? cells[stateIdx] : '',
                  zip_code: zipIdx >= 0 ? cells[zipIdx] : '',
                  latitude: latIdx >= 0 ? cells[latIdx] : '',
                  longitude: lonIdx >= 0 ? cells[lonIdx] : '',
                  status: statusIdx >= 0 ? cells[statusIdx] : '',
                  purpose: purposeIdx >= 0 ? cells[purposeIdx] : '',
                  all_cells: cells
                };
              });
              
              // Process as JSON array
              usedPuppeteer = true;
              
              // Insert leads directly
              for (const item of data) {
                const raw = JSON.stringify(item);
                
                // Build description from available fields
                let description = '';
                if (item.permit_type) description += item.permit_type;
                if (item.permit_subtype) description += (description ? ' - ' : '') + item.permit_subtype;
                if (item.purpose && !description) description = item.purpose;
                if (!description) description = 'N/A';
                
                const lead = {
                  permit_number: item.permit_number || 'N/A',
                  address: item.address || 'N/A',
                  value: item.construction_cost || 'N/A',
                  description: description,
                  phone: item.phone || null,
                  page_url: (() => {
                    if (source.viewUrlTemplate) {
                      let url = source.viewUrlTemplate;
                      url = url.replace('{permit_number}', encodeURIComponent(item.permit_number || ''));
                      url = url.replace('{address}', encodeURIComponent(item.address || ''));
                      return url;
                    }
                    return source.publicUrl || source.url;
                  })(),
                  date_issued: item.date_issued || null,
                  application_date: item.application_date || item.date_entered || null,
                  owner_name: item.owner_name || null,
                  contractor_name: item.contractor_name || null,
                  contractor_address: item.contractor_address || null,
                  contractor_phone: item.contractor_phone || null,
                  square_footage: item.square_footage || null,
                  units: item.units || null,
                  floors: item.floors || null,
                  parcel_number: item.parcel_number || null,
                  permit_type: item.permit_type || null,
                  permit_subtype: item.permit_subtype || null,
                  city: item.city || null,
                  state: item.state || null,
                  zip_code: item.zip_code || null,
                  latitude: item.latitude || null,
                  longitude: item.longitude || null,
                  status: item.status || null,
                  purpose: item.purpose || null
                };
                
                // Apply filters if configured
                const text = `${lead.permit_number} ${lead.address} ${lead.description} ${lead.value}`;
                if (textPassesFilters(text, source)) {
                  if (await insertLeadIfNew({ raw, sourceName: source.name, lead, userId, sourceId: source._sourceId })) {
                    newLeads++;
                  }
                }
              }
              
              logger.info(`Inserted ${newLeads} new leads from ${source.name}`);
              continue; // Skip to next source
            }
          }
          
          // Fallback: extract HTML content
          if (source.waitSelector) {
            try { await page.waitForSelector(source.waitSelector, { timeout: 15000 }); } catch { /* ignore */ }
          }
          
          // Capture screenshot for AI vision extraction (if useAI enabled)
          if (source.useAI === true && geminiModel) {
            try {
              let pageNumber = 1;
              let hasNextPage = true;
              const allScreenshots = [];
              const maxPages = 1; // TEST MODE: Only scrape first page
              
              while (hasNextPage && pageNumber <= maxPages) {
                logger.info(`📄 Processing page ${pageNumber}/${maxPages}...`);
                
                // Wait for page content to load
                await new Promise(resolve => setTimeout(resolve, timings.pageLoadWait));
                
                // Scroll page vertically AND horizontally to load all content
                logger.info(`📜 Scrolling page ${pageNumber} to load all visible content...`);
                await page.evaluate(async () => {
                  // First scroll vertically
                  await new Promise((resolve) => {
                    let totalHeight = 0;
                    const distance = 100;
                    const timer = setInterval(() => {
                      const scrollHeight = document.body.scrollHeight;
                      window.scrollBy(0, distance);
                      totalHeight += distance;

                      if(totalHeight >= scrollHeight){
                        clearInterval(timer);
                        resolve();
                      }
                    }, 100);
                  });
                  
                  // Then scroll horizontally to load any off-screen tables
                  await new Promise((resolve) => {
                    let totalWidth = 0;
                    const distance = 200;
                    const timer = setInterval(() => {
                      const scrollWidth = document.body.scrollWidth;
                      window.scrollBy(distance, 0);
                      totalWidth += distance;

                      if(totalWidth >= scrollWidth){
                        clearInterval(timer);
                        resolve();
                      }
                    }, 100);
                  });
                });
                
                // Wait for any lazy-loaded content
                await new Promise(resolve => setTimeout(resolve, timings.afterScrollWait));
                
                // Extra wait after scrolling to let any loading indicators disappear
                logger.info(`⏳ Waiting ${Math.round(timings.afterScrollWait/1000)}s for content to fully render after scrolling...`);
                await new Promise(resolve => setTimeout(resolve, timings.afterScrollWait));
                
                // Expand all scrollable containers to show full content
                logger.info(`🔧 Expanding scrollable containers to show full content...`);
                await page.evaluate(() => {

                  // Remove overflow restrictions on all elements
                  const allElements = document.querySelectorAll('*');
                  allElements.forEach(el => {
                    const style = window.getComputedStyle(el);
                    if (style.overflow === 'hidden' || style.overflow === 'scroll' || style.overflow === 'auto') {
                      el.style.overflow = 'visible';
                    }
                    if (style.overflowX === 'hidden' || style.overflowX === 'scroll' || style.overflowX === 'auto') {
                      el.style.overflowX = 'visible';
                    }
                    if (style.overflowY === 'hidden' || style.overflowY === 'scroll' || style.overflowY === 'auto') {
                      el.style.overflowY = 'visible';
                    }
                    // Remove max-width/max-height restrictions
                    if (el.style.maxWidth) el.style.maxWidth = 'none';
                    if (el.style.maxHeight) el.style.maxHeight = 'none';
                  });
                  
                  // Make tables fully visible
                  document.querySelectorAll('table').forEach(table => {
                    table.style.width = 'auto';
                    table.style.tableLayout = 'auto';
                  });
                });
                
                // Scroll back to top for complete screenshot
                await page.evaluate(() => window.scrollTo(0, 0));
                await new Promise(resolve => setTimeout(resolve, timings.betweenScrollWait));
                
                logger.info(`📸 Capturing high-quality screenshot for page ${pageNumber} (handles lazy loading)...`);
                const screenshot = await captureEntirePage(page);
                logger.info(`✅ Screenshot ${pageNumber} captured (${(screenshot.length / 1024).toFixed(0)} KB)`);
                
                // Save screenshot to disk for debugging with timestamp
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
                const screenshotPath = path.join(SCREENSHOT_DIR, `ai-screenshot-${source.name.replace(/[^a-z0-9]/gi, '_')}-page${pageNumber}-${timestamp}.png`);
                fs.writeFileSync(screenshotPath, screenshot);
                logger.info(`💾 Screenshot saved to: ${screenshotPath}`);
                
                allScreenshots.push({ pageNumber, screenshot });
                
                // Check for next page button with comprehensive detection
                const nextButtonInfo = await page.evaluate(() => {
                  // Try various selectors
                  const selectors = [
                    'a[title*="Next" i]',
                    'button[title*="Next" i]',
                    'a[aria-label*="Next" i]',
                    'button[aria-label*="Next" i]',
                    'a[title*="next page" i]',
                    '.pagination a:not(.disabled):not([aria-disabled="true"])',
                    '.pagination button:not(.disabled):not([aria-disabled="true"])',
                    'a.next:not(.disabled)',
                    'button.next:not(:disabled)',
                    'a.aca_pagination_PrevNext:not(.aca_pagination_PrevNext_Disabled)',
                    'img[alt="Next"]',
                    'img[alt="Next Page"]'
                  ];
                  
                  // Try each selector
                  for (const sel of selectors) {
                    try {
                      const elem = document.querySelector(sel);
                      if (elem && elem.offsetParent !== null) {
                        // Check if it's enabled
                        const isDisabled = elem.disabled || 
                                         elem.classList.contains('disabled') || 
                                         elem.getAttribute('aria-disabled') === 'true' ||
                                         elem.classList.contains('aca_pagination_PrevNext_Disabled');
                        
                        if (!isDisabled) {
                          // If it's an image, check parent link
                          if (elem.tagName === 'IMG' && elem.parentElement.tagName === 'A') {
                            return { selector: sel, isImage: true, found: true };
                          }
                          return { selector: sel, found: true };
                        }
                      }
                    } catch(e) {}
                  }
                  
                  // Text-based search as fallback
                  const links = Array.from(document.querySelectorAll('a, button'));
                  const next = links.find(e => {
                    const text = e.textContent.trim().toLowerCase();
                    const title = (e.title || '').toLowerCase();
                    const ariaLabel = (e.getAttribute('aria-label') || '').toLowerCase();
                    
                    return (text === 'next' || text === '›' || text === '>' || text === '→' ||
                           title.includes('next') || ariaLabel.includes('next')) &&
                           e.offsetParent !== null && 
                           !e.disabled && 
                           !e.classList.contains('disabled') &&
                           e.getAttribute('aria-disabled') !== 'true';
                  });
                  
                  return next ? { selector: 'text-based', found: true } : { found: false };
                });
                
                if (nextButtonInfo.found) {
                  logger.info(`🔄 Found Next button (${nextButtonInfo.selector}), navigating to page ${pageNumber + 1}...`);
                  try {
                    // Store current URL to verify navigation
                    const currentUrl = page.url();
                    
                    if (nextButtonInfo.isImage) {
                      // Click parent link of image
                      await page.evaluate((sel) => {
                        const img = document.querySelector(sel);
                        if (img && img.parentElement.tagName === 'A') {
                          img.parentElement.click();
                        }
                      }, nextButtonInfo.selector);
                    } else if (nextButtonInfo.selector === 'text-based') {
                      await page.evaluate(() => {
                        const links = Array.from(document.querySelectorAll('a, button'));
                        const next = links.find(e => {
                          const text = e.textContent.trim().toLowerCase();
                          const title = (e.title || '').toLowerCase();
                          const ariaLabel = (e.getAttribute('aria-label') || '').toLowerCase();
                          
                          return (text === 'next' || text === '›' || text === '>' || text === '→' ||
                                 title.includes('next') || ariaLabel.includes('next')) &&
                                 e.offsetParent !== null;
                        });
                        if (next) next.click();
                      });
                    } else {
                      await page.click(nextButtonInfo.selector);
                    }
                    
                    // Wait for navigation or content change
                    await Promise.race([
                      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => null),
                      new Promise(resolve => setTimeout(resolve, timings.afterScrollWait))
                    ]);
                    
                    const newUrl = page.url();
                    if (newUrl !== currentUrl) {
                      logger.info(`✅ Navigated to new URL: ${newUrl}`);
                    } else {
                      logger.info(`✅ Page content updated (same URL)`);
                    }
                    
                    pageNumber++;
                  } catch (navErr) {
                    logger.warn(`⚠️ Navigation to next page failed: ${navErr.message}`);
                    hasNextPage = false;
                  }
                } else {
                  logger.info(`✓ No more Next button found (completed ${pageNumber} page(s))`);
                  hasNextPage = false;
                }
              }
              
              if (pageNumber > maxPages) {
                logger.warn(`⚠️ Reached maximum page limit (${maxPages}). Stopping pagination.`);
              }
              
              screenshotBuffer = allScreenshots;
              logger.info(`✅ Captured ${allScreenshots.length} page(s) total for AI extraction`);
            } catch (screenshotErr) {
              logger.warn(`Screenshot capture failed: ${screenshotErr.message}`);
            }
          }
          
          data = await page.content();
          usedPuppeteer = true;
        } catch (e) {
          logger.error(`Puppeteer failed for ${source.name}: ${e.message}`);
          logger.error(`Error stack: ${e.stack}`);
          logger.error(`PUPPETEER_EXECUTABLE_PATH: ${process.env.PUPPETEER_EXECUTABLE_PATH || 'not set'}`);
          logger.error(`NODE_ENV: ${process.env.NODE_ENV || 'not set'}`);
          logger.error(`Falling back to axios`);
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

      // If not forced puppeteer OR puppeteer failed, use axios
      if (!data) {
        // Support REST API with parameters (GET or POST)
        if (source.type === 'json' && source.method && source.params) {
          const method = (source.method || 'GET').toUpperCase();
          if (method === 'POST') {
            // Support both form-urlencoded and JSON POST
            // Default to form-urlencoded (most common for form submissions)
            // Use contentType: 'json' in source config to send JSON instead
            const contentType = source.contentType === 'json' 
              ? 'application/json' 
              : 'application/x-www-form-urlencoded';
            
            const postData = contentType === 'application/json'
              ? source.params  // Send as JSON object
              : new URLSearchParams(source.params).toString();  // Convert to form encoding
            
            axiosResponse = await getWithRetry(source.url, {
              method: 'POST',
              data: postData,
              timeout: 30000,
              headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Content-Type': contentType
              }
            });
          } else {
            // GET with query params - build URL manually for ArcGIS
            logger.info(`Making GET request to: ${source.url}`);
            logger.info(`Params: ${JSON.stringify(source.params, null, 2)}`);
            
            try {
              // Build query string manually - preserve special chars in keys (like $ for Socrata)
              const queryString = Object.keys(source.params)
                .map(key => `${key}=${encodeURIComponent(source.params[key])}`)
                .join('&');
              const fullUrl = `${source.url}?${queryString}`;
              logger.info(`Full URL (keys preserved): ${fullUrl}`);
              
              // Use axios directly instead of getWithRetry
              axiosResponse = await axios.get(fullUrl, {
                timeout: 30000,
                headers: { 
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                  'Accept': 'application/json'
                }
              });
            } catch (apiErr) {
              logger.error(`API request failed: ${apiErr.message}`);
              logger.error(`Response data: ${JSON.stringify(apiErr.response?.data)}`);
              throw apiErr;
            }
          }
        } else {
          axiosResponse = await getWithRetry(source.url, {
            timeout: 30000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
          });
        }
        data = axiosResponse.data;
        
        // === BLOCK DETECTION FOR AXIOS ===
        if (typeof data === 'string') {
          const dataLower = data.toLowerCase();
          const blockSignals = {
            captcha: /captcha|recaptcha|hcaptcha/.test(dataLower),
            accessDenied: /access denied|forbidden|not authorized/.test(dataLower),
            cloudflare: /cloudflare|cf-ray|checking your browser/.test(dataLower),
            rateLimit: /rate limit|too many requests|slow down/.test(dataLower),
            blocked: /blocked|banned|suspicious/.test(dataLower),
            bot: /bot detected|automated/.test(dataLower),
            httpError: axiosResponse.status === 403 || axiosResponse.status === 429
          };
          
          const isBlocked = Object.values(blockSignals).some(signal => signal);
          
          if (isBlocked) {
            logger.error(`🚫 BLOCKING DETECTED (axios) for ${source.name}!`);
            logger.error(`HTTP Status: ${axiosResponse.status}`);
            logger.error(`Block signals: ${JSON.stringify(blockSignals, null, 2)}`);
            logger.error(`Response preview: ${data.substring(0, 500)}`);
            logger.error(`⚠️ SOLUTION: Enable residential proxy to bypass blocking`);
            
            // Trigger rate limiter backoff on blocking detection
            rateLimiter.onError();
          } else {
            logger.info(`✅ No blocking detected (axios)`);
            logger.info(`HTTP Status: ${axiosResponse.status}, Content length: ${data.length}`);
          }
        }
      }

      logger.info(`Data type: ${typeof data}, is array: ${Array.isArray(data)}, keys: ${typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).slice(0, 5).join(', ') : 'N/A'}`);
      if (typeof data === 'object' && data.error) {
        logger.error(`API returned error: ${JSON.stringify(data.error)}`);
      }

      // ─────────────── JSON API SUPPORT (Austin, Chicago, etc.) ───────────────
      // If JSON Path is specified, navigate to the data array
      let jsonData = data;
      if (source.type === 'json' && source.jsonPath && typeof data === 'object') {
        try {
          // Simple JSONPath implementation (supports paths like "features[*].attributes" or "data.records")
          const parts = source.jsonPath.split(/[\.\[\]]/).filter(Boolean);
          let current = data;
          let sawArrayWildcard = false;
          
          for (const part of parts) {
            if (part === '*') {
              sawArrayWildcard = true;
              continue;
            }
            if (sawArrayWildcard && Array.isArray(current)) {
              // Extract property from each array element
              current = current.map(item => item[part]).filter(Boolean);
              sawArrayWildcard = false;
            } else if (current && typeof current === 'object') {
              current = current[part];
            }
          }
          if (Array.isArray(current)) {
            jsonData = current;
            logger.info(`JSONPath extracted array of ${current.length} items`);
          }
        } catch (e) {
          logger.warn(`JSONPath extraction failed for ${source.name}: ${e.message}`);
        }
      }
      
      logger.info(`jsonData type: ${typeof jsonData}, is array: ${Array.isArray(jsonData)}, length: ${Array.isArray(jsonData) ? jsonData.length : 'N/A'}`);
      
      if (!usedPuppeteer && typeof jsonData === 'object' && Array.isArray(jsonData)) {
        // Field-based status/date filters for JSON APIs
        const cutoff = (() => {
          if (Number.isFinite(source?.sinceDays) && source?.dateField) {
            const ms = Number(source.sinceDays) * 24 * 60 * 60 * 1000;
            return new Date(Date.now() - ms);
          }
          return null;
        })();

        const jsonItems = jsonData.filter(item => {
          const text = buildTextForFilter(item, source);
          if (!textPassesFilters(text, source)) return false;

          // Status whitelist if configured
          if (source?.statusField && Array.isArray(source?.allowedStatus) && source.allowedStatus.length) {
            const rawStatus = item[source.statusField];
            const statusStr = (rawStatus == null ? '' : String(rawStatus)).toUpperCase();
            const ok = source.allowedStatus.some(s => String(s).toUpperCase() === statusStr);
            if (!ok) return false;
          }
          // Date cutoff if configured
          if (cutoff && source?.dateField) {
            const rawDate = item[source.dateField];
            if (!rawDate) return false;
            const d = new Date(rawDate);
            if (isNaN(d.getTime())) return false;
            if (d < cutoff) return false;
          }
          return true;
        });

        let inserted = 0;
        for (const item of jsonItems) {
          const raw = JSON.stringify(item);
          
          // Helper function to get nested property by dot notation
          const getNestedProp = (obj, path) => {
            if (!path) return undefined;
            return path.split('.').reduce((acc, part) => acc?.[part], obj);
          };
          
          // ArcGIS/ESRI APIs nest data inside "attributes" - flatten it for easier access
          const flatItem = item.attributes ? { ...item, ...item.attributes } : item;
          
          // Extract fields using jsonFields config if provided
          let extractedData = {};
          if (Array.isArray(source.jsonFields) && source.jsonFields.length > 0) {
            // Use configured field mappings
            source.jsonFields.forEach((fieldPath, idx) => {
              const value = getNestedProp(flatItem, fieldPath);
              if (value !== undefined && value !== null) {
                // Map to standard fields by position: [0]=permit, [1]=address, [2]=value, [3]=description, etc.
                if (idx === 0) extractedData.permit_number = value;
                else if (idx === 1) extractedData.address = value;
                else if (idx === 2) extractedData.value = value;
                else if (idx === 3) extractedData.description = value;
                else if (idx === 4) extractedData.contractor = value;
                else if (idx === 5) extractedData.phone = value;
              }
            });
          }
          
          // FIELD MAPPING: Use user-configured mappings or fall back to smart auto-mapping
          const lead = {};
          
          // Helper function to parse various date formats
          const parseDate = (value) => {
            if (!value) return null;
            
            // If it's already a valid date string in YYYY-MM-DD format, return it
            if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
              return value.split('T')[0]; // Remove time component if present
            }
            
            // Handle Unix timestamps (milliseconds)
            if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
              const timestamp = parseInt(value);
              // Check if it's in milliseconds (13 digits) or seconds (10 digits)
              const date = new Date(timestamp > 9999999999 ? timestamp : timestamp * 1000);
              if (!isNaN(date.getTime())) {
                return date.toISOString().split('T')[0];
              }
            }
            
            // Try to parse as a date string
            const date = new Date(value);
            if (!isNaN(date.getTime())) {
              return date.toISOString().split('T')[0];
            }
            
            return null;
          };
          
          if (source.fieldMappings && Object.keys(source.fieldMappings).length > 0) {
            // Use explicit field mappings configured by user
            logger.info(`Using field mappings for ${source.name}: ${JSON.stringify(source.fieldMappings)}`);
            for (const [dbColumn, sourceField] of Object.entries(source.fieldMappings)) {
              if (sourceField && sourceField !== 'none') {
                const value = flatItem[sourceField];
                if (value !== undefined && value !== null && value !== '') {
                  lead[dbColumn] = value;
                  logger.info(`Mapped ${dbColumn} = flatItem[${sourceField}] = ${value}`);
                } else {
                  lead[dbColumn] = null;
                  logger.info(`Mapped ${dbColumn} = null (source field "${sourceField}" not found or empty)`);
                }
              } else {
                lead[dbColumn] = null;
              }
            }
            
            // Parse date fields to ensure proper format
            if (lead.date_issued) {
              const parsed = parseDate(lead.date_issued);
              logger.info(`Parsing date_issued: ${lead.date_issued} -> ${parsed}`);
              lead.date_issued = parsed;
            }
            if (lead.application_date) {
              const parsed = parseDate(lead.application_date);
              lead.application_date = parsed;
            }
            
            // Always include page_url and source
            lead.page_url = source.viewUrl || source.publicUrl || source.url;
            lead.source = source.name;
          } else {
            // Fall back to SMART AUTO-MAPPING for sources without configured mappings
            lead.permit_number = extractedData.permit_number || flatItem.permit_number || flatItem.permit_num || flatItem.Permit__ || flatItem.Permit_Number || flatItem.job__ || flatItem.Title || flatItem.DisplayName || flatItem.record_number || flatItem.recordNumber || 'N/A';
            lead.address = extractedData.address || flatItem.property_address || flatItem.address || flatItem.Address || flatItem.location?.address || flatItem.permit_location || flatItem.Full_Address || flatItem.street_address || flatItem.streetAddress || [flatItem.Street, flatItem.City, flatItem.State, flatItem.Zip].filter(Boolean).join(', ') || 'N/A';
            lead.value = extractedData.value || flatItem.value || flatItem.Value || flatItem.permit_value || flatItem.estimated_cost || flatItem.Estimated_Cost || flatItem.declared_valuation || flatItem.valuation || flatItem.total_job_cost || flatItem.job_cost || flatItem.Const_Cost || flatItem.construction_cost || flatItem.project_value || 'N/A';
            lead.description = extractedData.description || flatItem.description || flatItem.Description || flatItem.work_class || flatItem.permit_type || flatItem.Permit_Type_Description || flatItem.Details || flatItem.Purpose || flatItem.work_description || 'N/A';
            lead.date_issued = flatItem.Date_Issued || flatItem.issued_date || flatItem.date_issued || flatItem.issue_date || flatItem.issueDate || flatItem.ApplicationDate || flatItem.applicationdate || null;
            lead.application_date = flatItem.Date_Entered || flatItem.application_date || flatItem.applicationDate || flatItem.app_date || flatItem.date_entered || flatItem.dateEntered || null;
            lead.owner_name = flatItem.owner_name || flatItem.Owner_Name || flatItem.ownerName || flatItem.applicant || flatItem.Applicant || null;
            lead.contractor_name = flatItem.Contact || flatItem.contractor_name || flatItem.contractorName || flatItem.Contractor_Name || flatItem.contractor || flatItem.builder_name || flatItem.builderName || flatItem.Builder || null;
            lead.contractor_phone = flatItem.contractor_phone || flatItem.contractorPhone || flatItem.Contractor_Phone || flatItem.contractor_telephone || flatItem.CONTACT_PHONE1 || flatItem.builder_phone || null;
            lead.contractor_address = flatItem.contractor_address || flatItem.contractorAddress || flatItem.Contractor_Address || flatItem.contractor_street || null;
            lead.contractor_city = flatItem.contractor_city || flatItem.contractorCity || flatItem.Contractor_City || null;
            lead.contractor_state = flatItem.contractor_state || flatItem.contractorState || flatItem.Contractor_State || null;
            lead.contractor_zip = flatItem.contractor_zip || flatItem.contractorZip || flatItem.Contractor_Zip || flatItem.contractor_zipcode || null;
            lead.square_footage = flatItem.square_feet || flatItem.squareFeet || flatItem.Square_Footage || flatItem.sq_ft || flatItem.sqft || flatItem.area || flatItem.building_area || null;
            lead.units = flatItem.unit_number || flatItem.unitNumber || flatItem.Number_of_Units || flatItem.numberOfUnits || flatItem.units || flatItem.Units || flatItem.dwelling_units || null;
            lead.floors = flatItem.Number_of_Stories || flatItem.numberOfStories || flatItem.floors || flatItem.Floors || flatItem.stories || flatItem.Stories || null;
            lead.parcel_number = flatItem.Parcel || flatItem.parcel_number || flatItem.parcelNumber || flatItem.parcel || flatItem.apn || flatItem.APN || flatItem.folio || flatItem.Folio || null;
            lead.permit_type = flatItem.Permit_Type_Description || flatItem.permit_type || flatItem.permitType || flatItem.Permit_Type || flatItem.type || flatItem.Type || flatItem.category || null;
            lead.permit_subtype = flatItem.Permit_Subtype_Description || flatItem.permit_subtype || flatItem.permitSubtype || flatItem.Permit_Subtype || flatItem.subtype || flatItem.subType || null;
            lead.work_description = flatItem.Purpose || flatItem.purpose || flatItem.work_description || flatItem.workDescription || flatItem.Work_Description || flatItem.scope || flatItem.Scope || null;
            lead.city = flatItem.City || flatItem.city || flatItem.municipality || flatItem.Municipality || null;
            lead.state = flatItem.State || flatItem.state || flatItem.ST || flatItem.st || null;
            lead.zip_code = flatItem.ZIP || flatItem.Zip || flatItem.zip_code || flatItem.zipCode || flatItem.zip || flatItem.postal_code || flatItem.postalCode || null;
            lead.latitude = flatItem.Lat || flatItem.latitude || flatItem.lat || flatItem.y || flatItem.Y || flatItem.latitude_y || null;
            lead.longitude = flatItem.Lon || flatItem.longitude || flatItem.lon || flatItem.lng || flatItem.x || flatItem.X || flatItem.longitude_x || null;
            lead.status = flatItem.status || flatItem.Status || flatItem.permit_status || flatItem.permitStatus || null;
            lead.record_type = flatItem.record_type || flatItem.recordType || flatItem.Record_Type || null;
            lead.project_name = flatItem.project_name || flatItem.projectName || flatItem.Project_Name || flatItem.development_name || null;
            lead.phone = extractedData.phone || flatItem.Phone || flatItem.phone || flatItem.telephone || flatItem.Telephone || flatItem.contact_phone || flatItem.CONTACT_PHONE1 || null;
            lead.page_url = source.viewUrl || source.publicUrl || source.url;
          }
          
          if (await insertLeadIfNew({ raw, sourceName: source.name, lead, userId, sourceId: source._sourceId })) inserted++;
        }
        logger.info(`Found ${jsonItems.length} records from ${source.name} (JSON API)`);
        logger.info(`Inserted ${inserted} new leads from ${source.name}`);
        continue; // skip HTML parsing
      }

      // ─────────────── HTML PARSING (regular websites) ───────────────
      const $ = cheerio.load(typeof data === 'string' ? data : '');
      // Optional: schema.org JSON-LD extraction for contact/office pages
      if (source.schemaLd === true) {
        let extracted = [];
        $('script[type="application/ld+json"]').each((i, el) => {
          const raw = $(el).contents().text();
          try {
            const json = JSON.parse(raw);
            const nodes = Array.isArray(json) ? json : [json];
            nodes.forEach(node => {
              // Some sites nest data under @graph
              const candidates = Array.isArray(node['@graph']) ? node['@graph'] : [node];
              candidates.forEach(n => {
                const t = (n['@type'] || '').toString();
                if (!t) return;
                if (/Organization|LocalBusiness|Corporation|Place/i.test(Array.isArray(n['@type']) ? n['@type'].join(',') : n['@type'])) {
                  const addr = n.address || n.location?.address || {};
                  const street = addr.streetAddress || addr.street || '';
                  const city = addr.addressLocality || addr.city || '';
                  const state = addr.addressRegion || addr.state || '';
                  const zip = addr.postalCode || addr.zip || '';
                  const phone = n.telephone || (Array.isArray(n.contactPoint) ? n.contactPoint.find(c=>c.telephone)?.telephone : n.contactPoint?.telephone) || '';
                  const display = n.name || n.legalName || n.alternateName || '';
                  const page_url = n.url || '';
                  const budget = n.priceRange || n.foundingDate || n.permit_value || n.estimated_cost || '';
                  extracted.push({
                    Title: display,
                    DisplayName: display,
                    Street: street,
                    City: city,
                    State: state,
                    Zip: zip,
                    Phone: phone,
                    Details: n.description || '',
                    PageURL: page_url,
                    value: budget
                  });
                }
              });
            });
          } catch {
            // ignore malformed JSON-LD blocks
          }
        });

        // Filter and insert extracted entries
        const jsonItems = extracted.filter(item => textPassesFilters(buildTextForFilter(item, source), source));
        let insertedJsonLd = 0;
        for (const item of jsonItems) {
          const raw = JSON.stringify(item);
          const lead = {
            permit_number: item.permit_number || item.permit_num || item.job__ || item.Title || item.DisplayName || 'N/A',
            address: item.address || [item.Street, item.City, item.State, item.Zip].filter(Boolean).join(', ') || 'N/A',
            value: item.permit_value || item.estimated_cost || 'N/A',
            description: item.description || item.Details || 'N/A',
            phone: item.Phone || null,
            page_url: (() => {
              if (source.viewUrlTemplate) {
                let url = source.viewUrlTemplate;
                url = url.replace('{permit_number}', encodeURIComponent(item.permit_number || item.permit_num || ''));
                url = url.replace('{address}', encodeURIComponent(item.address || ''));
                return url;
              }
              return source.publicUrl || source.url;
            })()
          };
          if (await insertLeadIfNew({ raw, sourceName: source.name, lead, userId, sourceId: source._sourceId })) insertedJsonLd++;
        }
        logger.info(`Found ${jsonItems.length} records from ${source.name} (schema.org JSON-LD)`);
        logger.info(`Inserted ${insertedJsonLd} new leads from ${source.name}`);
        if (jsonItems.length) continue;
      }
      // Support extracting JSON embedded in an HTML attribute (e.g., Vue components)
      if (source.selector && source.attribute) {
        const node = $(source.selector).first();
        const attrVal = node.attr(source.attribute);
        if (attrVal) {
          let jsonStr = String(attrVal)
            .replace(/&quot;/g, '"')
            .replace(/&apos;|&#39;/g, "'")
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>');
          try {
            const arr = JSON.parse(jsonStr);
            if (Array.isArray(arr)) {
              const jsonItems = arr.filter(item => textPassesFilters(buildTextForFilter(item, source), source));
              let insertedAttr = 0;
              for (const item of jsonItems) {
                const raw = JSON.stringify(item);
                const lead = {
                  permit_number: item.permit_number || item.permit_num || item.job__ || item.Title || item.DisplayName || 'N/A',
                  address: item.address || [item.Street, item.City, item.State, item.Zip].filter(Boolean).join(', ') || 'N/A',
                  value: item.permit_value || item.estimated_cost || 'N/A',
                  description: item.description || item.Details || 'N/A',
                  phone: item.Phone || null,
                  page_url: (() => {
                    if (source.viewUrlTemplate) {
                      let url = source.viewUrlTemplate;
                      url = url.replace('{permit_number}', encodeURIComponent(item.permit_number || item.permit_num || ''));
                      url = url.replace('{address}', encodeURIComponent(item.address || ''));
                      return url;
                    }
                    return source.publicUrl || source.url;
                  })()
                };
                if (await insertLeadIfNew({ raw, sourceName: source.name, lead, userId, sourceId: source._sourceId })) insertedAttr++;
              }
              logger.info(`Found ${jsonItems.length} records from ${source.name} (HTML attribute JSON)`);
              logger.info(`Inserted ${insertedAttr} new leads from ${source.name}`);
              continue; // handled as JSON-like
            }
          } catch (e) {
            // fall through to regular text parsing
          }
        }
      }

      // AI extraction disabled by default - must explicitly set useAI: true in source config
      // if (!source.selector && !source.useAI && geminiModel) {
      //   source.useAI = true;
      //   logger.info(`Auto-enabled AI extraction for ${source.name} (no selector provided)`);
      // }

      const matches = source.selector ? $(source.selector) : [];
      
      // Full-page AI extraction with vision - if enabled and using Puppeteer
      // When screenshots available, AI takes priority over selector-based extraction
      if (source.useAI === true && geminiModel && (screenshotBuffer || !source.selector)) {
        logger.info(`🤖 Using AI extraction for ${source.name} ${usedPuppeteer && screenshotBuffer ? '[VISION MODE]' : '[TEXT MODE]'}`);
        
        // Use screenshot(s) if available from Puppeteer
        if (usedPuppeteer && screenshotBuffer) {
          try {
            // Check if screenshotBuffer is array of pages or single screenshot
            const screenshots = Array.isArray(screenshotBuffer) ? screenshotBuffer : [{ pageNumber: 1, screenshot: screenshotBuffer }];
            logger.info(`🔍 Processing ${screenshots.length} page(s) with AI vision...`);
            
            let allLeadsToProcess = [];
            
            // Process each page's screenshot
            for (const { pageNumber, screenshot } of screenshots) {
              logger.info(`🔍 Analyzing page ${pageNumber} screenshot with AI vision...`);
              logger.info(`📊 Screenshot buffer type: ${typeof screenshot}, size: ${screenshot?.length || 0} bytes`);
              
              try {
                const aiResult = await extractLeadWithAI(screenshot, source.name, source.fieldSchema);
                logger.info(`✅ AI returned result: ${aiResult ? 'YES' : 'NULL'}, type: ${typeof aiResult}`);
                
                if (aiResult) {
                  logger.info(`📋 AI result keys: ${Object.keys(aiResult).join(', ')}`);
                }
                
                // Check if AI returned multiple leads (object with numeric keys) or single lead
                let leadsFromThisPage = [];
                if (aiResult && typeof aiResult === 'object') {
                  // Check if it's an array-like object with numeric keys
                  const keys = Object.keys(aiResult).filter(k => !k.startsWith('_'));
                  if (keys.some(k => !isNaN(k))) {
                    // It's an array-like object - extract each lead
                    leadsFromThisPage = keys.filter(k => !isNaN(k)).map(k => aiResult[k]);
                    logger.info(`🎯 AI extracted ${leadsFromThisPage.length} permit(s) from page ${pageNumber}`);
                  } else {
                    // Single lead
                    leadsFromThisPage = [aiResult];
                    logger.info(`🎯 AI extracted 1 lead from page ${pageNumber}`);
                  }
                } else {
                  logger.warn(`⚠️ AI result was null or not an object for page ${pageNumber}`);
                }
                
                allLeadsToProcess.push(...leadsFromThisPage);
              } catch (pageError) {
                logger.error(`❌ Error processing page ${pageNumber} with AI: ${pageError.message}`);
                logger.error(`Stack: ${pageError.stack}`);
              }
            }
            
            logger.info(`📦 Total permits extracted from all pages: ${allLeadsToProcess.length}`);
            
            // Insert each extracted lead
            for (const aiLead of allLeadsToProcess) {
              if (!aiLead) continue;
              
              const lead = {
                permit_number: aiLead.permit_number || 'N/A',
                address: aiLead.address || 'N/A',
                value: aiLead.value || aiLead.construction_cost || 'N/A',
                description: aiLead.description || aiLead.permit_type || 'AI extracted lead',
                phone: aiLead.phone || null,
                email: aiLead.email || null,
                company_name: aiLead.company_name || aiLead.contractor_name || null,
                page_url: aiLead.page_url || source.url
              };
              
              // Store the full AI-extracted data (individual permit)
              const extractedData = { ...aiLead };
              delete extractedData._aiConfidence;
              
              const rawHash = `AI_VISION:${source.name}:${aiLead.permit_number || aiLead.address || JSON.stringify(aiLead).substring(0, 50)}`;
              
              if (await insertLeadIfNew({ raw: rawHash, sourceName: source.name, lead, hashSalt: source.url, userId, extractedData, sourceId: source._sourceId })) {
                newLeads++;
                totalInserted++;
              }
            }
            
            if (allLeadsToProcess.length > 0) {
              logger.info(`✨ Vision AI extracted ${allLeadsToProcess.length} lead(s) total from ${screenshots.length} page(s)`);
            }
          } catch (screenshotErr) {
            logger.error(`Screenshot capture failed: ${screenshotErr.message} - falling back to text extraction`);
            // Fallback to text-based extraction
            const fullPageText = $('body').text().replace(/\s+/g, ' ').trim();
            if (textPassesFilters(fullPageText, source)) {
              const aiLead = await extractLeadWithAI(fullPageText, source.name, source.fieldSchema);
              if (aiLead) {
                const lead = {
                  permit_number: aiLead.permit_number || 'N/A',
                  address: aiLead.address || 'N/A',
                  value: aiLead.value || 'N/A',
                  description: aiLead.description || fullPageText.substring(0, 300),
                  phone: aiLead.phone || null,
                  page_url: aiLead.page_url || source.url
                };
                const extractedData = { ...aiLead };
                delete extractedData._aiConfidence;
                
                if (await insertLeadIfNew({ raw: fullPageText, sourceName: source.name, lead, hashSalt: source.url, userId, extractedData, sourceId: source._sourceId })) {
                  newLeads++;
                  totalInserted++;
                }
              }
            }
          }
        } else {
          // Text-based extraction (no Puppeteer)
          logger.warn(`⚠️ Text-based AI extraction for ${source.name} - enable Puppeteer for better accuracy`);
          const fullPageText = $('body').text().replace(/\s+/g, ' ').trim();
          
          if (textPassesFilters(fullPageText, source)) {
            const aiLead = await extractLeadWithAI(fullPageText, source.name, source.fieldSchema);
            if (aiLead) {
              const lead = {
                permit_number: aiLead.permit_number || 'N/A',
                address: aiLead.address || 'N/A',
                value: aiLead.value || 'N/A',
                description: aiLead.description || fullPageText.substring(0, 300),
                phone: aiLead.phone || null,
                page_url: aiLead.page_url || source.url
              };
              const extractedData = { ...aiLead };
              delete extractedData._aiConfidence;
              
              if (await insertLeadIfNew({ raw: fullPageText, sourceName: source.name, lead, hashSalt: source.url, userId, extractedData })) {
                newLeads++;
                totalInserted++;
                logger.info(`✨ AI extracted lead from full page: ${source.name}`);
              }
            }
          }
        }
      } else {
        // Original selector-based scraping
        try {
          logger.info(`Selector '${source.selector}' matched ${matches.length} elements on ${source.name}`);
        } catch {}

        for (const el of matches.toArray()) {
        const raw = $(el).text().replace(/\s+/g, ' ').trim();
        if (!textPassesFilters(raw, source)) continue;

        let lead;
        
        // Try AI extraction if enabled for this source with field schema
        if (source.useAI === true && geminiModel) {
          logger.info(`🤖 AI processing element for ${source.name}`);
          const aiLead = await extractLeadWithAI(raw, source.name, source.fieldSchema);
          if (aiLead) {
            lead = {
              permit_number: aiLead.permit_number || 'N/A',
              address: aiLead.address || 'N/A',
              value: aiLead.value || 'N/A',
              description: aiLead.description || raw.substring(0, 300),
              phone: aiLead.phone || null,
              page_url: aiLead.page_url || source.url
            };
            logger.info(`✨ AI extracted lead from ${source.name}`);
          }
        }
        
        // Fallback to pattern matching if AI didn't work or not enabled
        if (!lead) {
          const phoneMatch = raw.match(/\b(?:\+?1[\-.\s]?)?(?:\(?\d{3}\)?[\-.\s]?\d{3}[\-.\s]?\d{4})\b/);
          lead = {
            permit_number: raw.match(/[A-Z]?\d{5,12}[A-Z]?/i)?.[0] || 'N/A',
            address: raw.match(/\d{3,6}\s+.{5,70}(St|Rd|Ave|Blvd|Dr|Ln|Ct|Pl|Way|Cir|Lane|Boulevard|Drive|Street|Road|Avenue)/i)?.[0] || 'Check manually',
            value: raw.match(/\$[\d,]+/g)?.[0] || 'N/A',
            description: raw.substring(0, 300),
            phone: phoneMatch?.[0] || null,
            page_url: (() => {
              if (source.viewUrlTemplate) {
                let url = source.viewUrlTemplate;
                url = url.replace('{permit_number}', encodeURIComponent(lead.permit_number || ''));
                url = url.replace('{address}', encodeURIComponent(lead.address || ''));
                return url;
              }
              return source.publicUrl || source.url;
            })()
          };
        }
        
        if (await insertLeadIfNew({ raw, sourceName: source.name, lead, hashSalt: source.url, userId, sourceId: source._sourceId })) {
          newLeads++;
          totalInserted++;
        }
      }
      } // Close selector-based else block

      logger.info(`Inserted ${newLeads} new leads from ${source.name}`);
      if (source.usePuppeteer) {
        logger.info(`Dynamic mode (Puppeteer) used for ${source.name}`);
      }
      
      // Mark rate limiter success
      rateLimiter.onSuccess();
      
      // Update progress: source completed successfully
      const progress = getProgress(userId);
      if (progress) {
        progress.completedSources++;
        progress.leadsFound = totalInserted;
      }
      
      // Small delay between sources to ensure cleanup
      await new Promise(resolve => setTimeout(resolve, timings.betweenSourcesWait));
      
    } catch (err) {
      logger.error(`Failed ${source.name}: ${err.message}`);
      logger.error(`Stack trace: ${err.stack}`);
      
      // Check if it's a rate limit or block error (403, 429)
      if (err.message.includes('403') || err.message.includes('429') || err.message.includes('blocked') || err.message.includes('rate limit')) {
        logger.warn(`⚠️ Detected blocking/rate limiting - triggering backoff`);
        rateLimiter.onError();
      }
      
      // Update progress: track error
      const progress = getProgress(userId);
      if (progress) {
        progress.completedSources++;
        progress.errors.push({ source: source.name, error: err.message });
      }
      
      // Ensure cleanup even on error
      await new Promise(resolve => setTimeout(resolve, timings.betweenSourcesWait));
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
        `🎉 Scraped ${SOURCES.length} source(s) and found ${totalInserted} new lead(s): ${sourceNames}`
      );
    } else {
      await createNotification(
        userId,
        'scrape_no_new',
        `✅ Scraped ${SOURCES.length} source(s) - no new leads (all duplicates): ${sourceNames}`
      );
    }
  }
  
  return totalInserted;
}

// === SCRAPER ORCHESTRATOR (runs for all users) ===
async function scrapeAllUsers() {
  try {
    logger.info('=== Starting scrape cycle for all users ===');
    const users = await dbAll('SELECT id, username, role FROM users');
    
    // Also scrape sources.json for all users
    /* DISABLED: User wants to use only "My Sources"
    try {
      const sourcesJsonPath = path.join(__dirname, 'sources.json');
      if (fs.existsSync(sourcesJsonPath)) {
        const sourcesFromFile = JSON.parse(fs.readFileSync(sourcesJsonPath, 'utf-8'));
        if (Array.isArray(sourcesFromFile) && sourcesFromFile.length > 0) {
          logger.info(`Found ${sourcesFromFile.length} sources in sources.json - scraping for all users`);
          for (const user of users) {
            try {
              await scrapeForUser(user.id, sourcesFromFile);
            } catch (userErr) {
              logger.error(`Error scraping sources.json for user ${user.username} (${user.id}): ${userErr.message}`);
            }
          }
        }
      }
    } catch (jsonErr) {
      logger.error(`Error loading sources.json: ${jsonErr.message}`);
    }
    */
    
    // Then scrape user-specific sources from database
    for (const user of users) {
      try {
        // Get user's sources WITH their IDs
        const sourceRows = await dbAll('SELECT id, source_data FROM user_sources WHERE user_id = ?', [user.id]);
        if (!sourceRows.length) {
          logger.info(`User ${user.username} (${user.id}) has no custom sources configured`);
          continue;
        }
        
        const userSources = sourceRows.map(row => {
          try {
            const sourceData = JSON.parse(row.source_data);
            sourceData._sourceId = row.id; // Add source ID to the source object
            return sourceData;
          } catch (e) {
            logger.error(`Invalid JSON in user_sources for user ${user.id}: ${e.message}`);
            return null;
          }
        }).filter(Boolean);
        
        if (userSources.length) {
          logger.info(`Scraping ${userSources.length} custom sources for user ${user.username} (${user.id})`);
          await scrapeForUser(user.id, userSources);
        }
      } catch (userErr) {
        logger.error(`Error scraping custom sources for user ${user.username} (${user.id}): ${userErr.message}`);
      }
    }
    
    // await writeDashboardHTML(); // Disabled - using user-specific client-portal.html instead
    logger.info('=== Scrape cycle complete for all users ===');
  } catch (e) {
    logger.error(`Scraper orchestrator error: ${e.message}`);
  }
}

// === SERVER ===
function startServer() {
  const app = express();
  // Trust proxy for correct secure cookie handling behind Railway/NGINX
  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json()); // Parse JSON request bodies
  
  // SQLite session store (survives server restarts!)
  const SqliteStore = require('better-sqlite3-session-store')(session);
  const sessionDb = new Database(SESSIONS_DB_PATH);
  
  // Validate SESSION_SECRET in production
  if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
    logger.error('❌ FATAL: SESSION_SECRET must be set in production');
    logger.error('❌ Set SESSION_SECRET environment variable immediately!');
    process.exit(1);
  }
  
  app.use(session({
    store: new SqliteStore({
      client: sessionDb,
      expired: {
        clear: true,
        intervalMs: 900000 // Clear expired sessions every 15 minutes
      }
    }),
    secret: process.env.SESSION_SECRET || 'change-me-in-.env-shiiman-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { 
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      // Allow override via env: set SESSION_SECURE=true on HTTPS, false on HTTP
      secure: process.env.SESSION_SECURE === 'true' ? true : false,
      // Allow override via env: SESSION_SAMESITE=none|lax|strict (default lax)
      sameSite: (process.env.SESSION_SAMESITE || 'lax'),
      path: '/'
    },
    name: 'shiiman.sid',
    rolling: true
  }));
  
  logger.info('✅ Session store: SQLite (persistent across restarts)');
  
  // ---- Mail transporter (centralized) ----
  let mailTransport = null;
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.NOTIFY_TO) {
    try {
      const nodemailer = require('nodemailer');
      mailTransport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });
      logger.info(`SMTP configured host=${process.env.SMTP_HOST} port=${process.env.SMTP_PORT||'587'} secure=${process.env.SMTP_SECURE||'false'} notify_to=${process.env.NOTIFY_TO}`);
    } catch (e) {
      logger.warn('Failed to init mail transporter: ' + e.message);
    }
  } else {
    logger.info('SMTP not fully configured (missing one of SMTP_HOST/SMTP_USER/SMTP_PASS/NOTIFY_TO). Skipping email notifications.');
  }
  async function sendNotificationEmail(subject, text) {
    if (!mailTransport) return;
    try {
      await mailTransport.sendMail({
        from: `Shiiman Leads <${process.env.SMTP_USER}>`,
        to: process.env.NOTIFY_TO,
        subject,
        text
      });
      logger.info('Notification email sent: ' + subject);
    } catch (err) {
      logger.warn('Notification email failed: ' + err.message);
    }
  }
  // Minimal CORS for future separate frontends
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true }));

  // --- Auth helpers ---
  function ensureAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    return res.redirect('/login');
  }
  function attachUser(req, res, next) {
    res.locals.user = req.session?.user || null;
    res.locals.path = req.path;
    next();
  }
  app.use(attachUser);

  // --- Seed admin if empty ---
  (async () => {
    try {
      const row = await dbGet('SELECT COUNT(1) as c FROM users');
      if (!row || !row.c) {
        const username = process.env.ADMIN_USER || 'admin';
        const password = process.env.ADMIN_PASSWORD || 'admin123';
        const hash = await bcrypt.hash(password, 10);
        await dbRun('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [username, hash, 'admin']);
        logger.info(`Seeded admin user '${username}'. Change password via ADMIN_PASSWORD in .env`);
      }
      
      // Auto-verify all users on startup (for Railway production)
      const unverified = await dbGet('SELECT COUNT(*) as c FROM users WHERE email_verified = 0');
      if (unverified && unverified.c > 0) {
        await dbRun('UPDATE users SET email_verified = 1 WHERE email_verified = 0');
        logger.info(`✅ Auto-verified ${unverified.c} unverified user(s)`);
      }
    } catch (e) {
      logger.error(`Admin seed error: ${e.message}`);
    }
  })();

  // --- Auth routes ---
  // Check current user session
  app.get('/api/me', (req, res) => {
    if (req.session?.user) {
      logger.info(`✅ /api/me: User ${req.session.user.username} authenticated`);
      return res.json({ user: req.session.user });
    }
    logger.info(`❌ /api/me: No session found`);
    return res.status(401).json({ error: 'Not authenticated' });
  });
  
  app.get('/login', (req, res) => {
    if (req.session?.user) return res.redirect('/dashboard');
    res.sendFile(path.join(__dirname, '../frontend/login.html'));
  });
  app.post('/login', async (req, res) => {
    try {
      // Defensive: Extract and validate input
      const { username, password } = req.body || {};
      logger.info(`🔐 Login attempt: username="${username}"`);
      
      // Early return: missing credentials
      if (!username || !password) {
        logger.warn(`⚠️ Missing credentials in login request`);
        return res.status(400).json({ error: 'Username and password are required' });
      }
      
      // Defensive: Query user with explicit type checking
      const user = await dbGet('SELECT * FROM users WHERE username = ?', [String(username)]);
      
      // Early return: user not found
      if (!user) {
        logger.warn(`❌ User not found: ${username}`);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      logger.info(`👤 User found: ${user.username} (ID: ${user.id}, Role: ${user.role})`);
      
      // Early return: email verification check (DISABLED - auto-verify on signup)
      // if (user.role !== 'admin' && !user.email_verified) {
      //   logger.warn(`⚠️ Email not verified for user: ${user.username}`);
      //   return res.status(403).json({ error: 'Please verify your email first' });
      // }
      
      // Defensive: Password comparison with explicit error handling
      let passwordValid = false;
      try {
        passwordValid = await bcrypt.compare(String(password), user.password_hash || '');
      } catch (bcryptErr) {
        logger.error(`❌ Bcrypt error: ${bcryptErr.message}`);
        return res.status(500).json({ error: 'Authentication error' });
      }
      
      // Early return: invalid password
      if (!passwordValid) {
        logger.warn(`❌ Wrong password for user: ${username}`);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      logger.info(`✅ Password correct for user: ${user.username}`);
      
      // Defensive: Create session data with explicit checks
      const sessionData = {
        id: user.id,
        username: user.username,
        role: user.role
      };
      
      logger.info(`📝 Setting session.user: ${JSON.stringify(sessionData)}`);
      req.session.user = sessionData;
      
      // Defensive: Explicit session save with detailed logging
      req.session.save((err) => {
        if (err) {
          logger.error(`❌ Session save error: ${err.message}`);
          logger.error(err.stack);
          return res.status(500).json({ error: 'Session save failed' });
        }
        
        logger.info(`✅ Session saved! User ${user.username} logged in.`);
        logger.info(`📝 Session ID: ${req.session.id}, User in session: ${JSON.stringify(req.session.user)}`);
        
        // Return JSON response for client-side redirect
        res.json({ 
          success: true, 
          redirect: '/client-portal.html',
          user: { 
            id: user.id,
            username: user.username, 
            email: user.email,
            role: user.role,
            name: user.username
          }
        });
      });
      
    } catch (e) {
      // Catch-all: log full error and return safe message
      logger.error(`💥 Login error: ${e.message}`);
      logger.error(e.stack);
      return res.status(500).json({ error: 'Server error during login' });
    }
  });
  app.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });
  
  // Serve signup page
  app.get('/signup', (req, res) => {
    if (req.session?.user) return res.redirect('/dashboard');
    res.sendFile(path.join(__dirname, '../frontend/signup.html'));
  });
  
  // Handle signup form submission
  app.post('/signup', async (req, res) => {
    const { username, email, password, confirmPassword } = req.body || {};
    try {
      // Trim inputs to remove whitespace
      const trimmedUsername = String(username || '').trim();
      const trimmedEmail = String(email || '').trim().toLowerCase();
      const trimmedPassword = String(password || '').trim();
      const trimmedConfirmPassword = String(confirmPassword || '').trim();
      
      if (!trimmedUsername || !trimmedEmail || !trimmedPassword) {
        return res.status(400).json({ error: 'All fields required' });
      }
      if (trimmedPassword !== trimmedConfirmPassword) {
        return res.status(400).json({ error: 'Passwords do not match' });
      }
      
      // Check if user exists
      const existing = await dbGet('SELECT * FROM users WHERE username = ? OR email = ?', [trimmedUsername, trimmedEmail]);
      if (existing) {
        return res.status(400).json({ error: 'Username or email already exists' });
      }
      
      // Generate unique verification token for this user
      const verificationToken = crypto.randomBytes(32).toString('hex');
      
      // Create user
      const hash = await bcrypt.hash(trimmedPassword, 10);
      await dbRun('INSERT INTO users (username, email, password_hash, role, created_at, email_verified, verification_token) VALUES (?, ?, ?, ?, ?, ?, ?)', 
        [trimmedUsername, trimmedEmail, hash, 'client', new Date().toISOString(), 0, verificationToken]);
      
      // Send verification email if SMTP is configured
      const verifyLink = `${req.protocol}://${req.get('host')}/verify-email?token=${verificationToken}`;
      
      if (mailTransport) {
        try {
          await mailTransport.sendMail({
            from: `Shiiman Leads <${process.env.SMTP_USER}>`,
            to: email,
            subject: 'Verify your email - Shiiman Leads',
            html: `
              <h2>Welcome to Shiiman Leads!</h2>
              <p>Hi ${username},</p>
              <p>Please verify your email by clicking the link below:</p>
              <a href="${verifyLink}">${verifyLink}</a>
              <p>This link is unique to your account.</p>
            `
          });
          logger.info(`Verification email sent to ${email}`);
          return res.json({ success: true, message: 'Account created! Check your email to verify.', redirect: '/login.html' });
        } catch (emailErr) {
          logger.error(`Email send failed: ${emailErr.message}`);
          return res.json({ success: true, message: 'Account created but email failed. You can login now.', redirect: '/login.html' });
        }
      } else {
        logger.warn(`SMTP not configured - user ${username} created but no verification email sent`);
        return res.json({ success: true, message: 'Account created! You can login now.', redirect: '/login.html' });
      }
    } catch (e) {
      logger.error(`Signup error: ${e.message}`);
      res.status(500).json({ error: 'Server error during signup' });
    }
  });

  // Test email endpoint
  app.get('/test-email', async (req, res) => {
    if (!mailTransport) {
      return res.status(500).send('SMTP not configured. Add SMTP environment variables.');
    }
    try {
      await mailTransport.sendMail({
        from: `Shiiman Leads <${process.env.SMTP_USER}>`,
        to: 'guidebaris@outlook.com',
        subject: 'Test Email - Shiiman Leads',
        html: '<h2>Test Email</h2><p>This is a test email to verify SMTP works.</p>'
      });
      res.send('Test email sent successfully');
    } catch (e) {
      logger.error(`Test email error: ${e.message}`);
      res.status(500).send(`Test email failed: ${e.message}`);
    }
  });

  // Email verification route
  app.get('/verify-email', async (req, res) => {
    const { token } = req.query;
    
    try {
      const user = await dbGet('SELECT * FROM users WHERE verification_token = ?', [token]);
      
      if (!user) {
        return res.status(400).redirect('/login?error=Invalid+or+expired+verification+link');
      }
      
      // Mark as verified
      await dbRun('UPDATE users SET email_verified = 1, verification_token = NULL WHERE id = ?', [user.id]);
      
      // Auto-login
      req.session.user = { id: user.id, username: user.username, role: user.role };
      res.redirect('/dashboard?verified=1');
    } catch (e) {
      logger.error(`Email verification error: ${e.message}`);
      res.status(500).redirect('/login?error=Verification+failed');
    }
  });

  // Debug endpoint to check database state
  app.get('/api/debug/my-data', async (req, res) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const userId = req.session.user.id;
    
    const user = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(userId);
    const sources = db.prepare('SELECT id, source_data FROM user_sources WHERE user_id = ?').all(userId);
    const leadCount = db.prepare('SELECT COUNT(*) as count FROM leads WHERE user_id = ?').get(userId);
    const seenCount = db.prepare('SELECT COUNT(*) as count FROM seen WHERE user_id = ?').get(userId);
    
    res.json({
      user: user,
      sources: sources.map(s => ({
        id: s.id,
        config: JSON.parse(s.source_data)
      })),
      stats: {
        leads: leadCount.count,
        seen_hashes: seenCount.count
      }
    });
  });

  // Debug endpoint to check file paths and persistence
  app.get('/api/debug/paths', (req, res) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    res.json({
      environment: process.env.NODE_ENV || 'development',
      paths: {
        db: DB_PATH,
        sessionsDb: SESSIONS_DB_PATH,
        jsonl: OUTBOX_JSONL,
        screenshots: SCREENSHOT_DIR
      },
      exists: {
        db: fs.existsSync(DB_PATH),
        sessionsDb: fs.existsSync(SESSIONS_DB_PATH),
        jsonlDir: fs.existsSync(path.dirname(OUTBOX_JSONL)),
        screenshots: fs.existsSync(SCREENSHOT_DIR)
      },
      volumeCheck: {
        dataDir: process.env.NODE_ENV === 'production' ? fs.existsSync('/app/backend/data') : 'N/A (local)'
      },
      proxy: {
        enabled: PROXY_ENABLED,
        proxyCount: PROXY_URLS.length,
        primaryProxy: PROXY_ENABLED ? PROXY_URL.replace(/:\/\/.*@/, '://***@') : 'N/A'
      }
    });
  });

  // --- Client Dashboard Route ---
  app.get('/dashboard', (req, res) => {
    // Debug logging
    logger.info(`Dashboard access attempt. Session exists: ${!!req.session}, User: ${req.session?.user?.username || 'none'}`);
    
    // Check if logged in
    if (!req.session.user) return res.redirect('/login');
    // Serve your client-portal.html
    res.sendFile(path.join(__dirname, '../frontend/client-portal.html'));
  });

  // --- My Sources Page ---
  app.get('/my-sources', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/my-sources.html'));
  });

  // --- Contact form submission (public) ---
  app.post('/contact', express.urlencoded({ extended: true }), async (req, res) => {
    try {
      const { name, email, company, message, website } = req.body || {};
      // Honeypot field 'website' should stay empty; if filled treat as spam silently
      if (website) return res.redirect('/?ok=1');
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
      // Simple rate limit: max 3 inquiries per email/IP in last 10 minutes
      const cutoff = new Date(Date.now() - 10*60*1000).toISOString();
      const recent = await dbAll('SELECT COUNT(1) as c FROM inquiries WHERE (email = ? OR ip = ?) AND created_at >= ?', [String(email||''), String(ip||''), cutoff]);
      if (recent?.[0]?.c >= 3) return res.redirect('/?err=rate');
      if (!email || !message) return res.status(400).redirect('/?err=missing');
      await dbRun(`INSERT INTO inquiries (name, email, company, message, created_at, ip) VALUES (?,?,?,?,?,?)`, [
        String(name||'').substring(0,120),
        String(email||'').substring(0,200),
        String(company||'').substring(0,160),
        String(message||'').substring(0,2000),
        new Date().toISOString(),
        String(ip||'').substring(0,100)
      ]);
      logger.info(`Inquiry received from ${email}`);
      await sendNotificationEmail('New Inquiry Received', `Name: ${name}\nEmail: ${email}\nCompany: ${company}\nIP: ${ip}\nMessage:\n${message}`);
      res.redirect('/?ok=1');
    } catch (e) {
      res.redirect('/?err=server');
    }
  });

  // --- App UI (protected) ---

  // API: Get current logged-in user info
  app.get('/api/user', (req, res) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    res.json({
      username: req.session.user.username,
      role: req.session.user.role,
      id: req.session.user.id
    });
  });

  // API: Get user profile
  app.get('/api/profile', (req, res) => {
    if (!req.session || !req.session.user) {
      logger.error('❌ Profile request - No session or user');
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    logger.info(`📋 Fetching profile for user ID: ${req.session.user.id}`);
    
    try {
      if (!db) {
        logger.error('❌ Database is null');
        return res.status(500).json({ error: 'Database not initialized' });
      }
      
      const user = db.prepare('SELECT id, username, email, company_name, phone, website, created_at FROM users WHERE id = ?').get(req.session.user.id);
      
      if (!user) {
        logger.error(`❌ User not found in database: ${req.session.user.id}`);
        return res.status(404).json({ error: 'User not found' });
      }
      
      logger.info(`✅ Profile loaded for: ${user.username}`);
      res.json(user);
    } catch (error) {
      logger.error(`❌ Error fetching profile: ${error.message}`);
      logger.error(`❌ Stack trace: ${error.stack}`);
      res.status(500).json({ error: 'Failed to fetch profile: ' + error.message });
    }
  });

  // API: Update user profile
  app.put('/api/profile', express.json(), async (req, res) => {
    if (!req.session || !req.session.user) {
      logger.error('❌ Profile update - No session or user');
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const userId = req.session.user.id;
    const { company_name, phone, website } = req.body;
    
    logger.info(`📝 Updating profile for user ID: ${userId}`);
    logger.info(`📝 Data: company_name="${company_name}", phone="${phone}", website="${website}"`);
    
    try {
      if (!db) {
        logger.error('❌ Database is null');
        return res.status(500).json({ error: 'Database not initialized' });
      }
      
      // Update profile fields (username and email cannot be changed via profile update)
      await dbRun(
        'UPDATE users SET company_name = ?, phone = ?, website = ? WHERE id = ?',
        [company_name || null, phone || null, website || null, userId]
      );
      
      // Fetch updated user data
      const user = db.prepare('SELECT id, username, email, company_name, phone, website, created_at FROM users WHERE id = ?').get(userId);
      
      if (!user) {
        logger.error(`❌ User not found after update: ${userId}`);
        return res.status(404).json({ error: 'User not found' });
      }
      
      logger.info(`✅ Profile updated successfully for: ${user.username}`);
      res.json({ success: true, user });
    } catch (error) {
      logger.error(`❌ Error updating profile: ${error.message}`);
      logger.error(`❌ Stack trace: ${error.stack}`);
      res.status(500).json({ error: 'Failed to update profile: ' + error.message });
    }
  });

  // Simple leads API with optional filters: ?limit=200&source=...&q=...&days=7
  // Returns canonical leads from `leads` table for the authenticated user
  app.get('/api/leads', async (req, res) => {
    try {
      const userId = req.session?.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
      const sourceId = req.query.source_id ? parseInt(req.query.source_id, 10) : null;
      const q = req.query.q ? String(req.query.q) : null;
      const days = req.query.days ? parseInt(req.query.days, 10) : null;

      // Get all user sources to query their tables
      const userSources = db.prepare('SELECT id, source_data FROM user_sources WHERE user_id = ?').all(userId);
      let allLeads = [];

      for (const sourceRow of userSources) {
        // Skip if filtering by specific source
        if (sourceId && sourceRow.id !== sourceId) continue;

        const tableName = `source_${sourceRow.id}`;
        
        // Check if table exists
        const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
        if (!tableExists) continue;

        // Get all columns from this source table
        const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
        const columnNames = columns.map(col => col.name);

        // Build dynamic query
        const where = ['user_id = ?'];
        const params = [userId];

        // Search across all text columns if query provided
        if (q) {
          const textCols = columnNames.filter(col => !['id', 'user_id', 'created_at'].includes(col));
          const searchConditions = textCols.map(col => `${col} LIKE ?`).join(' OR ');
          if (searchConditions) {
            where.push(`(${searchConditions})`);
            const like = `%${q}%`;
            textCols.forEach(() => params.push(like));
          }
        }

        if (Number.isFinite(days) && days > 0 && columnNames.includes('created_at')) {
          const cutoff = new Date(Date.now() - days*24*60*60*1000).toISOString();
          where.push('created_at >= ?');
          params.push(cutoff);
        }

        const sql = `SELECT * FROM ${tableName} WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`;
        params.push(limit);
        
        try {
          const rows = db.prepare(sql).all(...params);
          // Add source info to each row
          const sourceData = JSON.parse(sourceRow.source_data);
          rows.forEach(row => {
            row._source_id = sourceRow.id;
            row._source_name = sourceData.name;
          });
          allLeads.push(...rows);
        } catch (queryErr) {
          logger.error(`Error querying ${tableName}: ${queryErr.message}`);
        }
      }

      // Sort by ID desc and limit
      allLeads.sort((a, b) => b.id - a.id);
      allLeads = allLeads.slice(0, limit);

      res.json({ data: allLeads });
    } catch (e) {
      logger.error(`Error fetching leads: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Legacy raw array response if needed
  app.get('/api/leads.raw', async (req, res) => {
    try {
      // CRITICAL: Filter by user_id from session
      const userId = req.session?.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
      const source = req.query.source ? String(req.query.source) : null;
      const q = req.query.q ? String(req.query.q) : null;
      const days = req.query.days ? parseInt(req.query.days, 10) : null;
      
      const where = ['user_id = ?'];
      const params = [userId];
      
      if (source) { where.push('source = ?'); params.push(source); }
      if (q) {
        where.push('(permit_number LIKE ? OR address LIKE ? OR description LIKE ? OR raw_text LIKE ?)');
        const like = `%${q}%`;
        params.push(like, like, like, like);
      }
      if (Number.isFinite(days) && days > 0) {
        const cutoff = new Date(Date.now() - days*24*60*60*1000).toISOString();
        where.push('date_added >= ?');
        params.push(cutoff);
      }
      const sql = `SELECT id, hash, permit_number, address, city, state, zip_code, value, description,
                   contractor_name, contractor_address, owner_name, phone, contractor_phone,
                   square_footage, units, permit_type, permit_subtype, status, parcel_number,
                   source, date_issued, date_added, page_url, raw_text, is_new
                   FROM leads WHERE ${where.join(' AND ')}
                   ORDER BY id DESC LIMIT ?`;
      params.push(limit);
      const rows = await dbAll(sql, params);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Sources list for frontend dropdown - now includes configured sources
  app.get('/api/sources', async (req, res) => {
    try {
      const userId = req.session?.user?.id || 1;
      
      // Get all configured sources for the user
      const userSources = await dbAll('SELECT source_data FROM user_sources WHERE user_id = ? ORDER BY id DESC', [userId]);
      const sourceNames = new Set();
      
      userSources.forEach(row => {
        try {
          const data = JSON.parse(row.source_data);
          if (data.name) sourceNames.add(data.name);
        } catch (e) {}
      });
      
      // Also get sources that have leads (in case some were scraped)
      const leadsRows = await dbAll('SELECT DISTINCT source FROM leads WHERE user_id = ? ORDER BY source', [userId]);
      leadsRows.forEach(r => sourceNames.add(r.source));
      
      const uniqueSources = Array.from(sourceNames).map(name => ({ name }));
      res.json({ data: uniqueSources });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get current user's configured sources (MUST come before /:id route)
  app.get('/api/sources/mine', async (req, res) => {
    try {
      // Use user ID from session, or default to 1 if not logged in
      const userId = req.session?.user?.id || 1;
      const rows = await dbAll('SELECT id, source_data, created_at FROM user_sources WHERE user_id = ? ORDER BY id DESC', [userId]);
      const sources = rows.map(row => {
        try {
          return {
            id: row.id,
            data: JSON.parse(row.source_data),
            created_at: row.created_at
          };
        } catch (e) {
          return null;
        }
      }).filter(Boolean);
      res.json({ data: sources });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get a specific source by ID (MUST come after /mine route)
  app.get('/api/sources/:id', async (req, res) => {
    try {
      const userId = req.session?.user?.id || 1;
      const sourceId = req.params.id;
      
      const row = await dbGet('SELECT id, source_data, created_at FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
      
      if (!row) {
        return res.status(404).json({ error: 'Source not found' });
      }
      
      const sourceData = JSON.parse(row.source_data);
      res.json({
        id: row.id,
        name: sourceData.name,
        url: sourceData.url,
        fieldSchema: sourceData.fieldSchema || {},
        method: sourceData.method,
        aiEnabled: sourceData.aiEnabled,
        created_at: row.created_at
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Alias for backward compatibility
  app.get('/api/my-sources', async (req, res) => {
    try {
      const userId = req.session?.user?.id || 1;
      const rows = await dbAll('SELECT id, source_data, created_at FROM user_sources WHERE user_id = ? ORDER BY id DESC', [userId]);
      const sources = rows.map(row => {
        try {
          return {
            id: row.id,
            data: JSON.parse(row.source_data),
            created_at: row.created_at
          };
        } catch (e) {
          return null;
        }
      }).filter(Boolean);
      res.json({ data: sources });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Update a source
  app.put('/api/my-sources/:id', express.json(), async (req, res) => {
    try {
      const userId = req.session?.user?.id || 1;
      const sourceId = parseInt(req.params.id, 10);
      const sourceData = req.body;
      
      if (!sourceData || !sourceData.name || !sourceData.url) {
        return res.status(400).json({ error: 'Missing required fields: name, url' });
      }
      
      await dbRun('UPDATE user_sources SET source_data = ? WHERE id = ? AND user_id = ?', 
        [JSON.stringify(sourceData), sourceId, userId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Delete a source
  app.delete('/api/my-sources/:id', async (req, res) => {
    try {
      const userId = req.session?.user?.id || 1;
      const sourceId = parseInt(req.params.id, 10);
      
      // Get source name before deleting for notification
      const existing = await dbGet('SELECT source_data FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
      let sourceName = 'Unknown';
      if (existing) {
        try {
          const data = JSON.parse(existing.source_data);
          sourceName = data.name || 'Unknown';
        } catch (e) {}
      }
      
      await dbRun('DELETE FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
      
      // Create notification for source deletion
      await createNotification(
        userId,
        'source_deleted',
        `🗑️ Removed source: ${sourceName}`
      );
      
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get dashboard statistics for current user
  app.get('/api/stats', async (req, res) => {
    try {
      const userId = req.session?.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      // Total leads for this user
      const totalLeadsRow = await dbGet('SELECT COUNT(*) as count FROM leads WHERE user_id = ?', [userId]);
      const totalLeads = totalLeadsRow?.count || 0;

      // Active sources (configured sources)
      const sourcesRow = await dbGet('SELECT COUNT(*) as count FROM user_sources WHERE user_id = ?', [userId]);
      const activeSources = sourcesRow?.count || 0;

      // Leads by source
      const leadsBySource = await dbAll(
        'SELECT source, COUNT(*) as count FROM leads WHERE user_id = ? GROUP BY source ORDER BY count DESC',
        [userId]
      );

      // Recent activity (last 7 days)
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const recentLeadsRow = await dbGet(
        'SELECT COUNT(*) as count FROM leads WHERE user_id = ? AND date_added >= ?',
        [userId, sevenDaysAgo]
      );
      const recentLeads = recentLeadsRow?.count || 0;

      res.json({
        totalLeads,
        activeSources,
        recentLeads,
        leadsBySource
      });
    } catch (e) {
      logger.error(`Stats API error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Get notifications for current user
  app.get('/api/notifications', async (req, res) => {
    try {
      const userId = req.session?.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const limit = parseInt(req.query.limit || '50', 10);
      const notifications = await dbAll(
        'SELECT id, type, message, created_at, is_read FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
        [userId, limit]
      );

      res.json({ data: notifications || [] });
    } catch (e) {
      logger.error(`Notifications API error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Mark notification as read
  app.post('/api/notifications/:id/read', async (req, res) => {
    try {
      const userId = req.session?.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const notificationId = parseInt(req.params.id, 10);
      await dbRun(
        'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
        [notificationId, userId]
      );

      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Mark all notifications as read
  app.post('/api/notifications/mark-all-read', async (req, res) => {
    try {
      const userId = req.session?.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      await dbRun('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [userId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Test AI Status - Check if Gemini is working
  app.get('/api/test-ai', async (req, res) => {
    try {
      if (!geminiModel) {
        return res.json({
          status: 'disabled',
          message: 'GEMINI_API_KEY not configured',
          working: false
        });
      }

      // Test with a simple prompt
      const testResult = await geminiModel.generateContent({
        contents: [{
          role: 'user',
          parts: [{ text: 'Extract this data as JSON: {"name": "John Doe", "phone": "555-1234"}. Return only the JSON.' }]
        }],
        generationConfig: buildGenConfig()
      });
      
      const response = await testResult.response;
      const text = response.text();
      
      res.json({
        status: 'active',
        message: 'Gemini AI is working correctly',
        working: true,
        model: 'gemini-3-flash-preview',
        testResponse: text.substring(0, 200)
      });
      
    } catch (error) {
      const isQuotaError = error.message?.includes('quota') || error.message?.includes('429');
      res.json({
        status: 'error',
        message: isQuotaError ? 'API quota exceeded - limit reached' : error.message,
        working: false,
        expired: isQuotaError
      });
    }
  });

  // Agent: Screenshot a URL, analyze with AI, and save lead(s)
  app.post('/api/agent/analyze-url', express.json(), async (req, res) => {
    try {
      const userId = req.session?.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const { url, name, fieldSchema } = req.body || {};
      if (!url) return res.status(400).json({ error: 'url is required' });

      // Find or create a dedicated source for this agent run
      const sourceName = name || (new URL(url).hostname + ' (Agent)');
      let sourceRow = await dbGet('SELECT id FROM user_sources WHERE user_id = ? AND source_data LIKE ?', [userId, `%"name":"${sourceName}"%`]);
      let sourceId;
      if (!sourceRow) {
        const sourceData = { name: sourceName, url, useAI: true, usePuppeteer: true, fieldSchema: fieldSchema || null };
        const insert = await dbRun('INSERT INTO user_sources (user_id, source_data, created_at) VALUES (?, ?, ?)', [userId, JSON.stringify(sourceData), new Date().toISOString()]);
        sourceId = insert.lastID;
        createSourceTable(sourceId, fieldSchema || null);
      } else {
        sourceId = sourceRow.id;
      }

      // Capture the page with Puppeteer
      const browser = await puppeteer.launch({ headless: process.env.PUPPETEER_HEADLESS || 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 900 });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      // Try to scroll to load content
      try {
        await page.evaluate(async () => { window.scrollTo(0, document.body.scrollHeight); await new Promise(r => setTimeout(r, 1000)); });
      } catch {}
      const screenshot = await captureEntirePage(page);
      const rawText = await page.evaluate(() => document.body.innerText || document.body.textContent || '');
      await browser.close();

      // Analyze with AI
      const aiResult = await extractLeadWithAI(screenshot, sourceName, fieldSchema || null);
      if (!aiResult) {
        return res.status(500).json({ error: 'AI extraction failed or disabled' });
      }

      const items = Array.isArray(aiResult) ? aiResult : [aiResult];
      let inserted = 0; let duplicates = 0;
      for (const item of items) {
        const ok = await insertLeadIfNew({ raw: rawText, sourceName, lead: item, userId, extractedData: item, sourceId });
        if (ok && ok.inserted) inserted++; else duplicates++;
      }

      return res.json({ success: true, count: inserted, duplicates, sourceId, sample: items[0] });
    } catch (e) {
      logger.error(`Agent analyze-url error: ${e.message}`);
      return res.status(500).json({ error: e.message });
    }
  });

  // Create a new source (alias for /api/sources/add)
  app.post('/api/my-sources', express.json(), async (req, res) => {
    try {
      const userId = req.session?.user?.id || 1;
      const sourceData = req.body;
      
      // Validate required fields
      if (!sourceData.name || !sourceData.url) {
        return res.status(400).json({ error: 'Source name and URL are required' });
      }
      
      // Store as JSON string
      const sourceJson = JSON.stringify(sourceData);
      const result = await dbRun(
        'INSERT INTO user_sources (user_id, source_data, created_at) VALUES (?, ?, ?)',
        [userId, sourceJson, new Date().toISOString()]
      );
      
      const newSourceId = result.lastID;
      
      // ✨ CREATE SOURCE-SPECIFIC TABLE
      const tableName = createSourceTable(newSourceId, sourceData.fieldSchema);
      logger.info(`✅ Created dedicated table: ${tableName} for "${sourceData.name}"`);
      
      // Create notification for source addition
      await createNotification(
        userId,
        'source_added',
        `✅ Added new source: ${sourceData.name} with table ${tableName}`
      );
      
      // Optional: Auto-scrape when source is added (controlled by env variable)
      const AUTO_SCRAPE_ON_ADD = process.env.AUTO_SCRAPE_ON_ADD === 'true';
      
      if (AUTO_SCRAPE_ON_ADD) {
        logger.info(`New source added by user ${userId}, triggering immediate scrape`);
        scrapeForUser(userId, [sourceData]).then((newLeads) => {
          logger.info(`Immediate scrape completed for user ${userId}: ${newLeads} new leads from new source`);
        }).catch((err) => {
          logger.error(`Immediate scrape error for user ${userId}: ${err.message}`);
        });
        res.json({ success: true, id: result.lastID, message: 'Source added and scraping started' });
      } else {
        logger.info(`New source added by user ${userId}. Auto-scrape disabled - use "Scrape Now" to start.`);
        res.json({ success: true, id: result.lastID, message: 'Source added. Click "Scrape Now" to extract leads.' });
      }
    } catch (e) {
      logger.error(`Add source error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Add a new source for current user
  app.post('/api/sources/add', express.json(), async (req, res) => {
    try {
      // Use user ID from session, or default to 1 if not logged in
      const userId = req.session?.user?.id || 1;
      const sourceData = req.body;
      
      // Validate required fields
      if (!sourceData.name || !sourceData.url) {
        return res.status(400).json({ error: 'Source name and URL are required' });
      }
      
      // Store as JSON string
      const sourceJson = JSON.stringify(sourceData);
      const result = await dbRun(
        'INSERT INTO user_sources (user_id, source_data, created_at) VALUES (?, ?, ?)',
        [userId, sourceJson, new Date().toISOString()]
      );
      
      const newSourceId = result.lastID;
      
      // ✨ CREATE SOURCE-SPECIFIC TABLE
      const tableName = createSourceTable(newSourceId, sourceData.fieldSchema);
      logger.info(`✅ Created dedicated table: ${tableName} for "${sourceData.name}"`);
      
      // Create notification for source addition
      await createNotification(
        userId,
        'source_added',
        `✅ Added new source: ${sourceData.name} with table ${tableName}`
      );
      
      // Optional: Auto-scrape when source is added (controlled by env variable)
      const AUTO_SCRAPE_ON_ADD = process.env.AUTO_SCRAPE_ON_ADD === 'true';
      
      if (AUTO_SCRAPE_ON_ADD) {
        logger.info(`New source added by user ${userId}, triggering immediate scrape`);
        scrapeForUser(userId, [sourceData]).then((newLeads) => {
          logger.info(`Immediate scrape completed for user ${userId}: ${newLeads} new leads from new source`);
        }).catch((err) => {
          logger.error(`Immediate scrape error for user ${userId}: ${err.message}`);
        });
        res.json({ success: true, id: result.lastID, message: 'Source added and scraping started' });
      } else {
        logger.info(`New source added by user ${userId}. Auto-scrape disabled - use "Scrape Now" to start.`);
        res.json({ success: true, id: result.lastID, message: 'Source added. Click "Scrape Now" to extract leads.' });
      }
    } catch (e) {
      logger.error(`Add source error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Update an existing source
  app.put('/api/sources/:id', express.json(), async (req, res) => {
    try {
      const userId = req.session?.user?.id || 1;
      const sourceId = parseInt(req.params.id, 10);
      const sourceData = req.body;
      
      // Validate required fields
      if (!sourceData.name || !sourceData.url) {
        return res.status(400).json({ error: 'Source name and URL are required' });
      }
      
      // Check ownership
      const existing = await dbGet('SELECT id FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
      if (!existing) {
        return res.status(404).json({ error: 'Source not found or access denied' });
      }
      
      const sourceJson = JSON.stringify(sourceData);
      await dbRun('UPDATE user_sources SET source_data = ? WHERE id = ? AND user_id = ?', [sourceJson, sourceId, userId]);
      
      res.json({ success: true });
    } catch (e) {
      logger.error(`Update source error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Delete a source
  app.delete('/api/sources/:id', async (req, res) => {
    try {
      const userId = req.session?.user?.id || 1;
      const sourceId = parseInt(req.params.id, 10);
      
      logger.info(`Delete request for source ${sourceId} by user ${userId}`);
      
      // Check ownership before deleting
      const existing = await dbGet('SELECT id FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
      if (!existing) {
        logger.warn(`Source ${sourceId} not found or access denied for user ${userId}`);
        return res.status(404).json({ error: 'Source not found or access denied' });
      }
      
      logger.info(`Deleting source ${sourceId} for user ${userId}`);
      await dbRun('DELETE FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
      logger.info(`Successfully deleted source ${sourceId}`);
      res.json({ success: true });
    } catch (e) {
      logger.error(`Delete source error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Get sample data from a source for field mapping
  app.get('/api/sources/:id/sample', async (req, res) => {
    try {
      const userId = req.session?.user?.id || 1;
      const sourceId = parseInt(req.params.id, 10);
      
      // Get source config
      const sourceRow = await dbGet('SELECT source_data FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
      if (!sourceRow) {
        return res.status(404).json({ error: 'Source not found or access denied' });
      }
      
      const sourceConfig = JSON.parse(sourceRow.source_data);
      logger.info(`Fetching sample data for source: ${sourceConfig.name}`);
      
      // Fetch sample data based on source type
      let sampleData = [];
      
      if (sourceConfig.type === 'json') {
        let url = sourceConfig.url;
        let response;
        
        if (sourceConfig.method === 'POST' && sourceConfig.params) {
          // For POST requests, send params in body
          const sampleParams = { ...sourceConfig.params };
          // Try to limit records for sample
          if (sampleParams.pageSize) sampleParams.pageSize = '10';
          if (sampleParams.resultRecordCount) sampleParams.resultRecordCount = 10;
          
          response = await axios.post(url, sampleParams, {
            headers: {
              'Content-Type': 'application/json',
              ...(sourceConfig.headers || {})
            }
          });
        } else if (sourceConfig.params) {
          // For GET requests, add params to URL
          const sampleParams = { ...sourceConfig.params };
          
          // Try to limit records for sample (different APIs use different params)
          if (sampleParams['$limit']) {
            // Socrata API
            sampleParams['$limit'] = '10';
          } else if (sampleParams.resultRecordCount) {
            // ArcGIS API
            sampleParams.resultRecordCount = 10;
          } else if (sampleParams.limit) {
            // Generic limit
            sampleParams.limit = '10';
          }
          
          const params = new URLSearchParams();
          Object.entries(sampleParams).forEach(([key, value]) => {
            params.append(key, String(value));
          });
          url = `${url}?${params.toString()}`;
          
          response = await axios.get(url, {
            headers: sourceConfig.headers || {}
          });
        } else {
          response = await axios.get(url, {
            headers: sourceConfig.headers || {}
          });
        }
        
        let jsonData = response.data;
        
        // Apply JSONPath if specified
        if (sourceConfig.jsonPath) {
          const result = jp.query(jsonData, sourceConfig.jsonPath);
          if (Array.isArray(result) && result.length > 0) {
            jsonData = result;
          }
        }
        
        // Get first 10 records for better sampling
        if (Array.isArray(jsonData)) {
          sampleData = jsonData.slice(0, 10);
        } else if (jsonData.features && Array.isArray(jsonData.features)) {
          // ArcGIS format - flatten attributes like we do in scraper
          sampleData = jsonData.features.slice(0, 10).map(f => {
            const item = f.attributes || f;
            // Flatten: merge attributes into top level
            return item.attributes ? {...item, ...item.attributes} : item;
          });
        } else if (jsonData.Data && Array.isArray(jsonData.Data)) {
          sampleData = jsonData.Data.slice(0, 10);
        }
        
      } else if (sourceConfig.type === 'html') {
        // For HTML sources, use Puppeteer to get sample
        const browser = await puppeteer.launch({
          headless: true,
          protocolTimeout: 180000,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();
        page.setDefaultTimeout(90000);
        page.setDefaultNavigationTimeout(90000);
        await page.goto(sourceConfig.url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        const selector = sourceConfig.selector || 'table tr, .result, .item';
        const elements = await page.$$(selector);
        
        // Extract text from first 10 elements
        for (let i = 0; i < Math.min(10, elements.length); i++) {
          const text = await page.evaluate(el => el.textContent, elements[i]);
          sampleData.push({ _text: text.trim() });
        }
        
        await browser.close();
      }
      
      // Get available field names from first record
      const availableFields = sampleData.length > 0 ? Object.keys(sampleData[0]) : [];
      
      res.json({ 
        success: true, 
        sampleData,
        availableFields,
        sourceName: sourceConfig.name
      });
      
    } catch (e) {
      logger.error(`Fetch sample data error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Get source-specific column configuration
  app.get('/api/sources/columns', async (req, res) => {
    try {
      const userId = req.session?.user?.id || 1;
      const sourceFilter = req.query.source;
      
      // Get all sources for this user
      const userSourcesRows = await dbAll('SELECT source_data FROM user_sources WHERE user_id = ?', [userId]);
      const globalSources = loadSources();
      const allSources = [...globalSources, ...userSourcesRows.map(r => JSON.parse(r.source_data))];
      
      // Build column configuration for each source
      const sourceColumns = {};
      
      allSources.forEach(source => {
        if (source.displayColumns && Array.isArray(source.displayColumns)) {
          sourceColumns[source.name] = source.displayColumns;
        } else {
          // Default columns based on source type
          sourceColumns[source.name] = getDefaultColumnsForSource(source);
        }
      });
      
      if (sourceFilter) {
        res.json({ columns: sourceColumns[sourceFilter] || [] });
      } else {
        res.json({ sourceColumns });
      }
      
    } catch (e) {
      logger.error(`Get source columns error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Save field mappings for a source
  app.post('/api/sources/:id/mappings', express.json(), async (req, res) => {
    try {
      const userId = req.session?.user?.id || 1;
      const sourceId = parseInt(req.params.id, 10);
      const { fieldMappings } = req.body;
      
      if (!fieldMappings || typeof fieldMappings !== 'object') {
        return res.status(400).json({ error: 'Field mappings are required' });
      }
      
      // Get existing source config
      const sourceRow = await dbGet('SELECT source_data FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
      if (!sourceRow) {
        return res.status(404).json({ error: 'Source not found or access denied' });
      }
      
      const sourceConfig = JSON.parse(sourceRow.source_data);
      sourceConfig.fieldMappings = fieldMappings;
      
      // Update source with new mappings
      await dbRun('UPDATE user_sources SET source_data = ? WHERE id = ? AND user_id = ?', 
        [JSON.stringify(sourceConfig), sourceId, userId]);
      
      logger.info(`Saved field mappings for source ${sourceConfig.name} (user ${userId})`);
      
      res.json({ success: true, message: 'Field mappings saved successfully' });
      
    } catch (e) {
      logger.error(`Save field mappings error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Clear all leads for current user (keeps sources intact)
  app.delete('/api/leads/clear', async (req, res) => {
    try {
      if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const userId = req.session.user.id;
      
      // Get user's sources to find their source-specific tables
      const userSources = await dbAll('SELECT id FROM user_sources WHERE user_id = ?', [userId]);
      
      let totalLeadsDeleted = 0;
      
      // Clear each source-specific table
      for (const source of userSources) {
        const tableName = `source_${source.id}`;
        
        // Validate table name to prevent SQL injection
        if (!/^source_\d+$/.test(tableName)) {
          logger.warn(`Invalid table name: ${tableName}`);
          continue;
        }
        
        try {
          // Check if table exists
          const tableExists = await dbGet(
            `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
            [tableName]
          );
          
          if (tableExists) {
            const countResult = await dbGet(`SELECT COUNT(*) as count FROM ${tableName}`, []);
            await dbRun(`DELETE FROM ${tableName}`, []);
            totalLeadsDeleted += countResult.count;
            logger.info(`🗑️ Cleared ${countResult.count} leads from ${tableName}`);
          }
        } catch (tableErr) {
          logger.warn(`Could not clear ${tableName}: ${tableErr.message}`);
        }
      }
      
      const seenCount = await dbGet('SELECT COUNT(*) as count FROM seen WHERE user_id = ?', [userId]);
      await dbRun('DELETE FROM seen WHERE user_id = ?', [userId]);
      
      logger.info(`🗑️ User ${userId} cleared ${totalLeadsDeleted} leads from ${userSources.length} source tables and ${seenCount.count} seen hashes`);
      
      res.json({ 
        success: true, 
        deleted: {
          leads: totalLeadsDeleted,
          seen: seenCount.count,
          sourceTables: userSources.length
        }
      });
    } catch (e) {
      logger.error(`Clear leads error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Manually trigger scraping for current user
  app.post('/api/scrape/now', async (req, res) => {
    try {
      // Accept userId from request body (from server.js) or session
      const userId = req.body.userId || req.session?.user?.id || 1;
      
      // Get user's sources WITH their IDs
      const sourceRows = await dbAll('SELECT id, source_data FROM user_sources WHERE user_id = ?', [userId]);
      if (!sourceRows.length) {
        return res.json({ success: true, message: 'No sources configured to scrape', leadsFound: 0 });
      }
      
      const userSources = sourceRows.map(row => {
        try {
          const sourceData = JSON.parse(row.source_data);
          sourceData._sourceId = row.id; // Attach source ID for table saving
          
          // Ensure method field is set based on usePuppeteer flag
          if (sourceData.usePuppeteer === true && !sourceData.method) {
            sourceData.method = 'puppeteer';
          }
          // Also set usePuppeteer if method is puppeteer
          if (sourceData.method === 'puppeteer' && sourceData.usePuppeteer !== true) {
            sourceData.usePuppeteer = true;
          }
          // Default to puppeteer if useAI is enabled (AI extraction needs screenshots)
          if (sourceData.useAI === true && !sourceData.usePuppeteer) {
            sourceData.usePuppeteer = true;
            sourceData.method = 'puppeteer';
          }
          
          return sourceData;
        } catch (e) {
          return null;
        }
      }).filter(Boolean);
      
      if (!userSources.length) {
        return res.json({ success: true, message: 'No valid sources found', leadsFound: 0 });
      }
      
      logger.info(`Manual scrape triggered by user ${userId} for ${userSources.length} sources`);
      
      // Scrape in background and respond immediately
      scrapeForUser(userId, userSources).then((newLeads) => {
        logger.info(`Manual scrape completed for user ${userId}: ${newLeads} new leads`);
      }).catch((err) => {
        logger.error(`Manual scrape error for user ${userId}: ${err.message}`);
      });
      
      res.json({ 
        success: true, 
        message: `Scraping started for ${userSources.length} source(s). Check back in a few moments.`,
        sourcesCount: userSources.length
      });
    } catch (e) {
      logger.error(`Manual scrape error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Stop ongoing scraping for current user
  app.post('/api/scrape/stop', async (req, res) => {
    try {
      const userId = req.session?.user?.id || 1;
      
      logger.info(`🛑 Stop request received from user ${userId}`);
      
      // Set the stop flag
      setShouldStop(userId, true);
      
      // Update progress to show stopped status
      updateProgress(userId, { 
        status: 'stopped',
        currentSource: 'Stopped by user'
      });
      
      res.json({ 
        success: true, 
        message: 'Scraping will stop after current source completes'
      });
    } catch (e) {
      logger.error(`Stop scrape error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Get metrics/statistics for current user
  app.get('/api/metrics', async (req, res) => {
    try {
      const userId = req.session?.user?.id || 1;
      
      // Total leads count
      const totalLeads = await dbGet('SELECT COUNT(*) as count FROM leads WHERE user_id = ?', [userId]);
      
      // New leads count (last scrape)
      const newLeads = await dbGet('SELECT COUNT(*) as count FROM leads WHERE user_id = ? AND is_new = 1', [userId]);
      
      // Total sources
      const totalSources = await dbGet('SELECT COUNT(*) as count FROM user_sources WHERE user_id = ?', [userId]);
      
      // Leads per source breakdown
      const leadsPerSource = await dbAll(`
        SELECT source, COUNT(*) as count 
        FROM leads 
        WHERE user_id = ? 
        GROUP BY source 
        ORDER BY count DESC
      `, [userId]);
      
      // Recent activity (last 7 days) - using date_added if available
      let recentActivity = [];
      try {
        recentActivity = await dbAll(`
          SELECT DATE(date_added) as date, COUNT(*) as count 
          FROM leads 
          WHERE user_id = ? AND date_added IS NOT NULL AND date_added >= datetime('now', '-7 days')
          GROUP BY DATE(date_added)
          ORDER BY date DESC
        `, [userId]);
      } catch (e) {
        // Column might not exist, just skip recent activity
        logger.warn(`Recent activity query failed: ${e.message}`);
      }
      
      // Last scrape time - use date_added as proxy
      let lastScrape = null;
      try {
        lastScrape = await dbGet(`
          SELECT MAX(date_added) as last_scrape 
          FROM leads 
          WHERE user_id = ?
        `, [userId]);
      } catch (e) {
        logger.warn(`Last scrape query failed: ${e.message}`);
      }
      
      res.json({
        success: true,
        metrics: {
          totalLeads: totalLeads.count || 0,
          newLeads: newLeads.count || 0,
          totalSources: totalSources.count || 0,
          leadsPerSource: leadsPerSource || [],
          recentActivity: recentActivity || [],
          lastScrape: lastScrape?.last_scrape || null
        }
      });
    } catch (e) {
      logger.error(`Metrics error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Get scraping progress for current user
  app.get('/api/scrape/progress', (req, res) => {
    try {
      const userId = req.session?.user?.id || 1;
      const progress = getProgress(userId);
      
      if (!progress) {
        return res.json({ 
          success: true, 
          progress: null,
          message: 'No active scraping session'
        });
      }
      
      res.json({ 
        success: true, 
        progress: {
          status: progress.status,
          currentSource: progress.currentSource,
          completedSources: progress.completedSources,
          totalSources: progress.totalSources,
          leadsFound: progress.leadsFound,
          errors: progress.errors,
          startTime: progress.startTime,
          endTime: progress.endTime,
          elapsedTime: Date.now() - progress.startTime
        }
      });
    } catch (e) {
      logger.error(`Progress error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Scrape a single source by ID
  app.post('/api/scrape/:id', async (req, res) => {
    try {
      const userId = req.session?.user?.id || 1;
      const sourceId = parseInt(req.params.id, 10);
      
      // Get the specific source WITH its ID
      const sourceRow = await dbGet('SELECT id, source_data FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
      if (!sourceRow) {
        return res.status(404).json({ error: 'Source not found or access denied' });
      }
      
      const sourceConfig = JSON.parse(sourceRow.source_data);
      sourceConfig._sourceId = sourceRow.id; // Attach source ID for table saving
      logger.info(`Manual scrape triggered for source "${sourceConfig.name}" (ID: ${sourceId}) by user ${userId}`);
      
      // Scrape in background and respond immediately
      scrapeForUser(userId, [sourceConfig]).then((newLeads) => {
        logger.info(`Manual scrape completed for source "${sourceConfig.name}": ${newLeads} new leads`);
      }).catch((err) => {
        logger.error(`Manual scrape error for source "${sourceConfig.name}": ${err.message}`);
      });
      
      res.json({ 
        success: true, 
        message: `Scraping started for "${sourceConfig.name}". Check back in a few moments.`,
        sourceName: sourceConfig.name
      });
    } catch (e) {
      logger.error(`Single source scrape error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // === ADMIN ENDPOINTS ===
  
  // Middleware to check admin role
  function ensureAdmin(req, res, next) {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  }

  // Admin: Get all users
  app.get('/api/admin/users', ensureAdmin, async (req, res) => {
    try {
      const users = await dbAll('SELECT id, username, email, role, created_at FROM users ORDER BY id');
      res.json(users);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Get sources for a specific user
  app.get('/api/admin/sources/:userId', ensureAdmin, async (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      const sourceRows = await dbAll('SELECT id, source_data, created_at FROM user_sources WHERE user_id = ? ORDER BY id DESC', [userId]);
      
      const sources = sourceRows.map(row => {
        try {
          return {
            id: row.id,
            data: JSON.parse(row.source_data),
            created_at: row.created_at
          };
        } catch (e) {
          return null;
        }
      }).filter(Boolean);
      
      res.json({ data: sources });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Add source for any user
  app.post('/api/admin/sources/:userId', ensureAdmin, express.json(), async (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      const sourceData = req.body;
      
      // Validate required fields
      if (!sourceData.name || !sourceData.url) {
        return res.status(400).json({ error: 'Source name and URL are required' });
      }
      
      // Auto-enable AI if no selector provided
      if (!sourceData.selector) {
        sourceData.useAI = true;
      }
      
      // Store as JSON string
      const sourceJson = JSON.stringify(sourceData);
      const result = await dbRun(
        'INSERT INTO user_sources (user_id, source_data, created_at) VALUES (?, ?, ?)',
        [userId, sourceJson, new Date().toISOString()]
      );
      
      logger.info(`Admin added source "${sourceData.name}" for user ID ${userId}`);
      res.json({ success: true, id: result.lastID });
    } catch (e) {
      logger.error(`Admin add source error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Delete source for any user
  app.delete('/api/admin/sources/:userId/:sourceId', ensureAdmin, async (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      const sourceId = parseInt(req.params.sourceId, 10);
      
      const existing = await dbGet('SELECT id FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
      if (!existing) {
        return res.status(404).json({ error: 'Source not found' });
      }
      
      await dbRun('DELETE FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
      logger.info(`Admin deleted source ID ${sourceId} for user ID ${userId}`);
      res.json({ success: true });
    } catch (e) {
      logger.error(`Admin delete source error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Serve admin sources page
  app.get('/admin/sources', ensureAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
      return res.status(403).send('Admin access required');
    }
    res.sendFile(path.join(__dirname, '../frontend/admin-sources.html'));
  });

  // ============================================
  // SCREENSHOT VIEWER API
  // ============================================
  
  // Middleware to check authentication
  function requireAuth(req, res, next) {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }
  
  // List all screenshots
  app.get('/api/screenshots', requireAuth, (req, res) => {
    try {
      const files = fs.readdirSync(SCREENSHOT_DIR)
        .filter(file => file.endsWith('.png') || file.endsWith('.jpg'))
        .map(file => {
          const filepath = path.join(SCREENSHOT_DIR, file);
          const stats = fs.statSync(filepath);
          return {
            filename: file,
            url: `/api/screenshots/view/${encodeURIComponent(file)}`,
            downloadUrl: `/api/screenshots/download/${encodeURIComponent(file)}`,
            size: stats.size,
            sizeFormatted: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
            created: stats.birthtime,
            modified: stats.mtime
          };
        })
        .sort((a, b) => b.created - a.created);
  
      res.json({
        success: true,
        count: files.length,
        directory: SCREENSHOT_DIR,
        screenshots: files
      });
    } catch (error) {
      console.error('Error reading screenshots:', error);
      res.status(500).json({ error: 'Failed to load screenshots' });
    }
  });
  
  // View specific screenshot
  app.get('/api/screenshots/view/:filename', requireAuth, (req, res) => {
    try {
      const filename = decodeURIComponent(req.params.filename);
      
      // Security: prevent directory traversal attacks
      if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).send('Invalid filename');
      }
      
      const filepath = path.join(SCREENSHOT_DIR, filename);
      
      if (!fs.existsSync(filepath)) {
        return res.status(404).send('Screenshot not found');
      }
      
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.sendFile(filepath);
    } catch (error) {
      console.error('Error serving screenshot:', error);
      res.status(500).send('Error loading screenshot');
    }
  });
  
  // Download screenshot
  app.get('/api/screenshots/download/:filename', requireAuth, (req, res) => {
    try {
      const filename = decodeURIComponent(req.params.filename);
      
      if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).send('Invalid filename');
      }
      
      const filepath = path.join(SCREENSHOT_DIR, filename);
      
      if (!fs.existsSync(filepath)) {
        return res.status(404).send('Screenshot not found');
      }
      
      res.download(filepath);
    } catch (error) {
      console.error('Error downloading screenshot:', error);
      res.status(500).send('Error downloading screenshot');
    }
  });
  
  // Delete screenshot (optional)
  app.delete('/api/screenshots/:filename', requireAuth, (req, res) => {
    try {
      const filename = decodeURIComponent(req.params.filename);
      
      if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Invalid filename' });
      }
      
      const filepath = path.join(SCREENSHOT_DIR, filename);
      
      if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'Screenshot not found' });
      }
      
      fs.unlinkSync(filepath);
      console.log(`🗑️ Deleted screenshot: ${filename}`);
      res.json({ success: true, message: 'Screenshot deleted' });
    } catch (error) {
      console.error('Error deleting screenshot:', error);
      res.status(500).json({ error: 'Failed to delete screenshot' });
    }
  });

  // Landing page – serve index.html
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
  });
  
  // Dashboard route - redirect to client portal
  app.get('/dashboard', (req, res) => {
    if (req.session?.user) {
      return res.redirect('/client-portal.html');
    }
    res.redirect('/login.html');
  });
  
  // Serve frontend static files
  app.use(express.static(path.resolve(__dirname, '../frontend')));

  // Automatic port fallback: tries preferred then increments until a free port is found
  function startListening(preferredPort) {
    const net = require('net');
    const maxPort = preferredPort + 20; // search range
    (function tryPort(p) {
      if (p > maxPort) {
        logger.error(`No free port found in range ${preferredPort}-${maxPort}`);
        process.exit(1);
      }
      const tester = net.createServer()
        .once('error', err => {
          if (err.code === 'EADDRINUSE') {
            logger.warn(`Port ${p} in use; trying ${p + 1}...`);
            tryPort(p + 1);
          } else {
            logger.error(`Port check error on ${p}: ${err.message}`);
            process.exit(1);
          }
        })
        .once('listening', () => {
          tester.close(() => {
            app.listen(p, () => logger.info(`HTTP server listening on http://localhost:${p}`));
          });
        })
        .listen(p);
    })(preferredPort);
  }
  startListening(parseInt(process.env.PORT || '3000', 10));

  // AUTO-SCRAPING CONFIGURATION
  const AUTO_SCRAPE_ENABLED = process.env.AUTO_SCRAPE_ENABLED === 'true'; // Set to 'true' in .env to enable
  const AUTO_SCRAPE_ON_STARTUP = process.env.AUTO_SCRAPE_ON_STARTUP === 'true';
  const AUTO_SCRAPE_INTERVAL = process.env.AUTO_SCRAPE_INTERVAL || '0 */8 * * *'; // Default: every 8 hours

  if (AUTO_SCRAPE_ENABLED) {
    cron.schedule(AUTO_SCRAPE_INTERVAL, scrapeAllUsers);
    logger.info(`✅ Auto-scraping ENABLED - Running every 8 hours`);
  } else {
    logger.info(`⏸️  Auto-scraping DISABLED - Use "Scrape Now" button or API endpoint /api/scrape/now`);
  }

  if (AUTO_SCRAPE_ON_STARTUP) {
    scrapeAllUsers(); // Run once on startup
    logger.info('Running initial scrape on startup...');
  }

  logger.info('🚀 SHIIMAN LEADS IS LIVE - Unified server with web UI + scraper');
  logger.info('Multi-tenant scraper with manual control');
  logger.info('Each user sees only their own leads!');
  logger.info('Sources can be scraped manually via "Scrape Now" button');
}

// === START ===
startServer();
