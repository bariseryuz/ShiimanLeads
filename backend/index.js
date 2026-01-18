require('dotenv').config();
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
const path = require('path');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Google Gemini client
let geminiModel = null;
if (process.env.GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
  console.log('✅ Google Gemini AI initialized for lead extraction');
} else {
  console.warn('⚠️ GEMINI_API_KEY not found in .env - AI extraction disabled');
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

// === AI EXTRACTION WITH GOOGLE GEMINI ===
async function extractLeadWithAI(htmlText, sourceName) {
  if (!geminiModel) {
    logger.warn('Google Gemini not configured, skipping AI extraction');
    return null;
  }

  try {
    // Limit text to avoid token limits (6000 chars)
    const truncatedText = htmlText.substring(0, 6000);
    
    const prompt = `Extract construction/building project lead information from the following text and return ONLY a valid JSON object with these exact fields:

- permit_number: Building permit number or project ID (string or null)
- address: Full street address of the construction/project site (string or null)
- phone: Phone number for contact (format: XXX-XXX-XXXX, do NOT put phone numbers in the value field)
- email: Email address for contact (string or null)
- company_name: Company or organization name (string or null)
- value: Project budget/cost/value as a dollar amount like "$1,500,000" (NOT phone numbers, only dollar amounts)
- description: Brief description of the project type, purpose, or scope (string or null)
- page_url: Any specific project URL found in the text (string or null)

IMPORTANT:
- "value" field should contain ONLY project budget/cost/estimated value (like "$500,000"), never phone numbers
- "phone" field should contain phone numbers (like "602-322-6100")
- "description" should explain what the project is about (office building, renovation, etc.)
- Use null for any missing fields
- Return ONLY the JSON object, no explanations or markdown formatting

Text to extract from:
${truncatedText}`;

    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Clean up response (remove markdown if present)
    let cleanedText = text.trim();
    if (cleanedText.startsWith('```json')) {
      cleanedText = cleanedText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    } else if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.replace(/```\n?/g, '');
    }
    
    const extracted = JSON.parse(cleanedText);
    logger.info(`✨ AI extracted lead from ${sourceName}`);
    return extracted;
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
  const axiosConfig = Object.assign({}, options, { url, method });
  
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

async function insertLeadIfNew({ raw, sourceName, lead, hashSalt = '', userId }) {
  const hash = crypto.createHash('md5').update(raw + hashSalt).digest('hex');
  const row = await dbGet(`SELECT hash FROM seen WHERE hash = ? AND user_id = ?`, [hash, userId]);
  if (row) return false;

  await dbRun(`INSERT INTO seen (hash, user_id) VALUES (?, ?)`, [hash, userId]);
  await dbRun(
    `INSERT INTO leads (user_id, hash, raw_text, permit_number, address, value, description, source, date_added, phone, page_url, date_issued)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
    [
      userId,
      hash,
      raw,
      lead.permit_number,
      lead.address,
      lead.value,
      lead.description,
      sourceName,
      new Date().toISOString(),
      lead.phone,
      lead.page_url,
      lead.date_issued
    ]
  );
  
  // Use async append to avoid blocking event loop
  try {
    await fs.promises.appendFile('output/latest_leads.jsonl', JSON.stringify({
      hash,
      raw_text: raw,
      ...lead,
      source: sourceName,
      date_added: new Date().toISOString()
    }) + '\n');
  } catch (e) {
    logger.warn(`Failed to append latest_leads.jsonl: ${e.message}`);
  }
  
  logger.info(`NEW LEAD → ${lead.permit_number} | ${lead.address} | ${lead.value}`);
  return true;
}

// === DATABASE ===
const db = new Database(path.join(__dirname, 'leads.db'));

// Create tables (better-sqlite3 is synchronous)
db.exec(`CREATE TABLE IF NOT EXISTS seen (hash TEXT, user_id INTEGER, PRIMARY KEY(hash, user_id))`);
db.exec(`CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    hash TEXT,
    raw_text TEXT,
    permit_number TEXT,
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
    UNIQUE(hash, user_id)
  )`);

// Add missing columns if they don't exist (for existing databases)
const newColumns = [
  'date_issued', 'phone', 'page_url', 'application_date', 'owner_name', 
  'contractor_name', 'contractor_address', 'contractor_city', 'contractor_state',
  'contractor_zip', 'contractor_phone', 'square_footage', 'units', 'floors',
  'parcel_number', 'permit_type', 'permit_subtype', 'work_description', 'purpose',
  'city', 'state', 'zip_code', 'latitude', 'longitude', 'status', 'record_type', 'project_name'
];

newColumns.forEach(col => {
  try {
    db.exec(`ALTER TABLE leads ADD COLUMN ${col} TEXT`);
  } catch (err) {
    // Column already exists, ignore
  }
});

db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_user ON leads(user_id)`);
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
    try {
      logger.info(`Checking → ${source.name} for user ${userId}`);
      logger.info(`Source type: ${source.type}, method: ${source.method}, has params: ${!!source.params}`);
      let data; // can be JSON array or HTML string
      let axiosResponse;
      let usedPuppeteer = false;
      let newLeads = 0; // Track new leads for this source

      // Auto-detect Nashville-style URLs and enable table extraction
      if (source.url && source.url.includes('data.nashville.gov') && source.url.includes('showTable=true')) {
        source.usePuppeteer = true;
        source.extractTable = true;
        logger.info(`Auto-detected Nashville table view - enabling Puppeteer + table extraction`);
      }

      // If source explicitly requests Puppeteer (dynamic rendering / JS required)
      if (source.usePuppeteer === true) {
        let browser;
        try {
          const launchOptions = {
            headless: process.env.PUPPETEER_HEADLESS === 'false' ? false : 'new',
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-blink-features=AutomationControlled',
              '--disable-dev-shm-usage'
            ]
          };
          
          // Use custom executable path if provided (for Railway/Nixpacks)
          if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
            logger.info(`Using Chromium at: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
          }
          
          const browser = await puppeteer.launch(launchOptions);
          const page = await browser.newPage();
          
          // Anti-detection
          await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
          });
          
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
          
          const navOpts = { waitUntil: 'domcontentloaded', timeout: 60000 };
          await page.goto(source.url, navOpts);
          logger.info(`Puppeteer loaded page: ${source.url}`);
          
          // Wait for page to render
          await new Promise(resolve => setTimeout(resolve, 5000));
          
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
                await new Promise(resolve => setTimeout(resolve, 5000));
              }
            } catch (err) {
              logger.info(`No "Show All" button found: ${err.message}`);
            }
            
            // Auto-scroll to load all lazy-loaded data
            logger.info(`Auto-scrolling to load all data...`);
            const totalRows = await page.evaluate(async () => {
              let previousRowCount = 0;
              let currentRowCount = 0;
              let noChangeCount = 0;
              let scrollAttempts = 0;
              const maxScrollAttempts = 300;
              
              // Find the actual scrollable container (ArcGIS Hub uses specific containers)
              const findScrollContainer = () => {
                const selectors = [
                  '.table-container',
                  '[class*="table"]',
                  '[class*="scroll"]',
                  '[class*="content"]',
                  'div[role="main"]',
                  'main'
                ];
                
                for (const selector of selectors) {
                  const elements = document.querySelectorAll(selector);
                  for (const el of elements) {
                    if (el.scrollHeight > el.clientHeight) {
                      return el;
                    }
                  }
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
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    break;
                  }
                }
                
                // Scroll the container or window
                if (scrollContainer) {
                  scrollContainer.scrollTop = scrollContainer.scrollHeight;
                } else {
                  window.scrollTo(0, document.documentElement.scrollHeight);
                }
                
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Count current rows
                currentRowCount = document.querySelectorAll('table tbody tr').length;
                
                if (currentRowCount === previousRowCount) {
                  noChangeCount++;
                } else {
                  console.log(`Loaded ${currentRowCount} rows (was ${previousRowCount})`);
                  noChangeCount = 0;
                  previousRowCount = currentRowCount;
                }
                
                scrollAttempts++;
              }
              
              return currentRowCount;
            });
            logger.info(`Finished auto-scrolling - loaded ${totalRows} total rows`);
            
            const tableData = await page.evaluate(() => {
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
                  if (await insertLeadIfNew({ raw, sourceName: source.name, lead, userId })) {
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
          data = await page.content();
          usedPuppeteer = true;
        } catch (e) {
          logger.error(`Puppeteer failed for ${source.name}: ${e.message} – falling back to axios`);
        } finally {
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
          
          // Extract fields using jsonFields config if provided
          let extractedData = {};
          if (Array.isArray(source.jsonFields) && source.jsonFields.length > 0) {
            // Use configured field mappings
            source.jsonFields.forEach((fieldPath, idx) => {
              const value = getNestedProp(item, fieldPath);
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
          
          // Fallback to auto-detection if no jsonFields or extraction failed
          const lead = {
            permit_number: extractedData.permit_number || item.permit_number || item.permit_num || item.job__ || item.Title || item.DisplayName || item.Permit_Number || 'N/A',
            address: extractedData.address || item.property_address || item.address || item.location?.address || item.permit_location || item.Full_Address || [item.Street, item.City, item.State, item.Zip].filter(Boolean).join(', ') || 'N/A',
            value: extractedData.value || item.value || item.permit_value || item.estimated_cost || item.declared_valuation || item.valuation || item.total_job_cost || item.job_cost || item.Const_Cost || 'N/A',
            description: extractedData.description || item.description || item.work_class || item.permit_type || item.Details || 'N/A',
            phone: extractedData.phone || item.Phone || item.telephone || item.phone || item.CONTACT_PHONE1 || null,
            page_url: source.viewUrl || source.publicUrl || source.url,
            date_issued: item.issued_date || item.date_issued || item.issue_date || item.Date_Issued || item.applicationdate || item.ApplicationDate || null
          };
          if (await insertLeadIfNew({ raw, sourceName: source.name, lead, userId })) inserted++;
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
          if (await insertLeadIfNew({ raw, sourceName: source.name, lead, userId })) insertedJsonLd++;
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
                if (await insertLeadIfNew({ raw, sourceName: source.name, lead, userId })) insertedAttr++;
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
      
      // Full-page AI extraction - only if explicitly enabled with useAI: true
      if (!source.selector && source.useAI === true && geminiModel) {
        logger.warn(`⚠️ AI extraction enabled for ${source.name} - this may be slow for large datasets`);
        logger.info(`Using full-page AI extraction for ${source.name}`);
        const fullPageText = $('body').text().replace(/\s+/g, ' ').trim();
        
        if (textPassesFilters(fullPageText, source)) {
          const aiLead = await extractLeadWithAI(fullPageText, source.name);
          if (aiLead) {
            const lead = {
              permit_number: aiLead.permit_number || 'N/A',
              address: aiLead.address || 'N/A',
              value: aiLead.value || 'N/A',
              description: aiLead.description || fullPageText.substring(0, 300),
              phone: aiLead.phone || null,
              page_url: aiLead.page_url || source.url
            };
            if (await insertLeadIfNew({ raw: fullPageText, sourceName: source.name, lead, hashSalt: source.url, userId })) {
              newLeads++;
              totalInserted++;
              logger.info(`✨ AI extracted lead from full page: ${source.name}`);
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
        
        // Try AI extraction if enabled for this source (WARNING: slow for many elements)
        if (source.useAI === true && geminiModel) {
          logger.warn(`⚠️ AI processing element (may be slow) - ${source.name}`);
          const aiLead = await extractLeadWithAI(raw, source.name);
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
        
        if (await insertLeadIfNew({ raw, sourceName: source.name, lead, hashSalt: source.url, userId })) {
          newLeads++;
          totalInserted++;
        }
      }
      } // Close selector-based else block

      logger.info(`Inserted ${newLeads} new leads from ${source.name}`);
      if (source.usePuppeteer) {
        logger.info(`Dynamic mode (Puppeteer) used for ${source.name}`);
      }
    } catch (err) {
      logger.error(`Failed ${source.name}: ${err.message}`);
    }
  }
  logger.info(`Scrape cycle finished for user ${userId}. Inserted ${totalInserted} total leads.\n`);
  
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
        // Get user's sources
        const sourceRows = await dbAll('SELECT source_data FROM user_sources WHERE user_id = ?', [user.id]);
        if (!sourceRows.length) {
          logger.info(`User ${user.username} (${user.id}) has no custom sources configured`);
          continue;
        }
        
        const userSources = sourceRows.map(row => {
          try {
            return JSON.parse(row.source_data);
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
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json()); // Parse JSON request bodies
  
  // SQLite session store (survives server restarts!)
  const SqliteStore = require('better-sqlite3-session-store')(session);
  const sessionDb = new Database(path.join(__dirname, 'data', 'sessions.db'));
  
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
      secure: false,
      sameSite: 'lax',
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
      if (!username || !email || !password) {
        return res.status(400).json({ error: 'All fields required' });
      }
      if (password !== confirmPassword) {
        return res.status(400).json({ error: 'Passwords do not match' });
      }
      
      // Check if user exists
      const existing = await dbGet('SELECT * FROM users WHERE username = ? OR email = ?', [username, email]);
      if (existing) {
        return res.status(400).json({ error: 'Username or email already exists' });
      }
      
      // Generate unique verification token for this user
      const verificationToken = crypto.randomBytes(32).toString('hex');
      
      // Create user
      const hash = await bcrypt.hash(password, 10);
      await dbRun('INSERT INTO users (username, email, password_hash, role, created_at, email_verified, verification_token) VALUES (?, ?, ?, ?, ?, ?, ?)', 
        [username, email, hash, 'client', new Date().toISOString(), 0, verificationToken]);
      
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
  // Returns { data: [...] } for frontend convenience
  app.get('/api/leads', async (req, res) => {
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
      const sql = `SELECT id, hash, permit_number, address, value, description, source, date_added, phone, page_url
                   FROM leads WHERE ${where.join(' AND ')}
                   ORDER BY id DESC LIMIT ?`;
      params.push(limit);
      const rows = await dbAll(sql, params);
      res.json({ data: rows });
    } catch (e) {
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
      const sql = `SELECT id, hash, permit_number, address, value, description, source, date_added, phone, page_url
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

  // Get current user's configured sources
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
      
      // Create notification for source addition
      await createNotification(
        userId,
        'source_added',
        `✅ Added new source: ${sourceData.name}`
      );
      
      // Immediately scrape the newly added source
      logger.info(`New source added by user ${userId}, triggering immediate scrape`);
      scrapeForUser(userId, [sourceData]).then((newLeads) => {
        logger.info(`Immediate scrape completed for user ${userId}: ${newLeads} new leads from new source`);
      }).catch((err) => {
        logger.error(`Immediate scrape error for user ${userId}: ${err.message}`);
      });
      
      res.json({ success: true, id: result.lastID, message: 'Source added and scraping started' });
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
      
      // Create notification for source addition
      await createNotification(
        userId,
        'source_added',
        `✅ Added new source: ${sourceData.name}`
      );
      
      // Immediately scrape the newly added source
      logger.info(`New source added by user ${userId}, triggering immediate scrape`);
      scrapeForUser(userId, [sourceData]).then((newLeads) => {
        logger.info(`Immediate scrape completed for user ${userId}: ${newLeads} new leads from new source`);
      }).catch((err) => {
        logger.error(`Immediate scrape error for user ${userId}: ${err.message}`);
      });
      
      res.json({ success: true, id: result.lastID, message: 'Source added and scraping started' });
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
      
      // Check ownership before deleting
      const existing = await dbGet('SELECT id FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
      if (!existing) {
        return res.status(404).json({ error: 'Source not found or access denied' });
      }
      
      await dbRun('DELETE FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
      res.json({ success: true });
    } catch (e) {
      logger.error(`Delete source error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Manually trigger scraping for current user
  app.post('/api/scrape/now', async (req, res) => {
    try {
      // Accept userId from request body (from server.js) or session
      const userId = req.body.userId || req.session?.user?.id || 1;
      
      // Get user's sources
      const sourceRows = await dbAll('SELECT source_data FROM user_sources WHERE user_id = ?', [userId]);
      if (!sourceRows.length) {
        return res.json({ success: true, message: 'No sources configured to scrape', leadsFound: 0 });
      }
      
      const userSources = sourceRows.map(row => {
        try {
          return JSON.parse(row.source_data);
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
}

// === START ===
startServer();
cron.schedule('0 */8 * * *', scrapeAllUsers); // Run every 8 hours
scrapeAllUsers(); // Run once on startup

logger.info('🚀 SHIIMAN LEADS IS LIVE - Unified server with web UI + scraper');
logger.info('Multi-tenant scraper running every 8 hours');
logger.info('Each user sees only their own leads!');
logger.info('Sources are scraped immediately when added and then every 8 hours');