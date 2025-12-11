require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const CryptoJS = require('crypto-js');
const fs = require('fs');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const winston = require('winston');
const puppeteer = require('puppeteer');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
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
  const minLength = Number.isFinite(source?.minLength) ? source.minLength : 20;
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
  while (attempt <= retries) {
    try {
      return await axios.get(url, options);
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
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

async function insertLeadIfNew({ raw, sourceName, lead, hashSalt = '', userId }) {
  const hash = CryptoJS.MD5(raw + hashSalt).toString();
  const row = await dbGet(`SELECT hash FROM seen WHERE hash = ? AND user_id = ?`, [hash, userId]);
  if (row) return false;

  await dbRun(`INSERT INTO seen (hash, user_id) VALUES (?, ?)`, [hash, userId]);
  await dbRun(
    `INSERT INTO leads (user_id, hash, raw_text, permit_number, address, value, description, source, date_added, phone, page_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
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
      lead.page_url
    ]
  );
  fs.appendFileSync('output/latest_leads.jsonl', JSON.stringify({
    hash,
    raw_text: raw,
    ...lead,
    source: sourceName,
    date_added: new Date().toISOString()
  }) + '\n');
  logger.info(`NEW LEAD → ${lead.permit_number} | ${lead.address} | ${lead.value}`);
  return true;
}

// === DATABASE ===
const db = new sqlite3.Database('leads.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS seen (hash TEXT, user_id INTEGER, PRIMARY KEY(hash, user_id))`);
  db.run(`CREATE TABLE IF NOT EXISTS leads (
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
    UNIQUE(hash, user_id)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_leads_user ON leads(user_id)`);
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'client',
    created_at TEXT
  )`);
  // Per-user source configuration (JSON stored as text)
  db.run(`CREATE TABLE IF NOT EXISTS user_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    source_data TEXT NOT NULL,
    created_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  // Simple contact/inquiry storage for landing page form
  db.run(`CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    company TEXT,
    message TEXT,
    created_at TEXT
  )`);
  // Attempt to add columns if missing (safe migrations)
  db.get("PRAGMA table_info(inquiries)", (err) => {
    if (!err) {
      db.all("PRAGMA table_info(inquiries)", (e, cols) => {
        if (!e && cols && !cols.find(c => c.name === 'ip')) {
          db.run('ALTER TABLE inquiries ADD COLUMN ip TEXT');
        }
      });
    }
  });
  // Add user_id to existing leads if missing
  db.all("PRAGMA table_info(leads)", (e, cols) => {
    if (!e && cols) {
      if (!cols.find(c => c.name === 'user_id')) {
        db.run('ALTER TABLE leads ADD COLUMN user_id INTEGER DEFAULT 1');
        logger.info('Added user_id column to leads table');
      }
      if (!cols.find(c => c.name === 'phone')) {
        db.run('ALTER TABLE leads ADD COLUMN phone TEXT');
        logger.info('Added phone column to leads table');
      }
      if (!cols.find(c => c.name === 'page_url')) {
        db.run('ALTER TABLE leads ADD COLUMN page_url TEXT');
        logger.info('Added page_url column to leads table');
      }
    }
  });
});

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
  const SOURCES = userSources;
  for (const source of SOURCES) {
    try {
      logger.info(`Checking → ${source.name} for user ${userId}`);
      let data; // can be JSON array or HTML string
      let axiosResponse;
      let usedPuppeteer = false;
      let newLeads = 0; // Track new leads for this source

      // If source explicitly requests Puppeteer (dynamic rendering / JS required)
      if (source.usePuppeteer === true) { 
        try {
          const browser = await puppeteer.launch({
            headless: process.env.PUPPETEER_HEADLESS === 'false' ? false : 'new',
            args: ['--no-sandbox','--disable-setuid-sandbox']
          });
          const page = await browser.newPage();
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
          await page.setRequestInterception(true);
          page.on('request', req => {
            // Abort resources we don't need for scraping text to speed up
            if (['image','font','media','stylesheet'].includes(req.resourceType())) {
              req.abort();
            } else {
              req.continue();
            }
          });
          const navOpts = { waitUntil: ['domcontentloaded','networkidle2'], timeout: 60000 };
          await page.goto(source.url, navOpts);
          if (source.waitSelector) {
            try { await page.waitForSelector(source.waitSelector, { timeout: 15000 }); } catch { /* ignore */ }
          }
          data = await page.content();
          await browser.close();
          usedPuppeteer = true;
        } catch (e) {
          logger.error(`Puppeteer failed for ${source.name}: ${e.message} – falling back to axios`);
        }
      }

      // If not forced puppeteer OR puppeteer failed, use axios
      if (!data) {
        axiosResponse = await getWithRetry(source.url, {
          timeout: 30000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        data = axiosResponse.data;
      }

      // ─────────────── JSON API SUPPORT (Austin, Chicago, etc.) ───────────────
      if (!usedPuppeteer && typeof data === 'object' && Array.isArray(data)) {
        // Field-based status/date filters for JSON APIs
        const cutoff = (() => {
          if (Number.isFinite(source?.sinceDays) && source?.dateField) {
            const ms = Number(source.sinceDays) * 24 * 60 * 60 * 1000;
            return new Date(Date.now() - ms);
          }
          return null;
        })();

        const jsonItems = data.filter(item => {
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
          const lead = {
            permit_number: item.permit_number || item.permit_num || item.job__ || item.Title || item.DisplayName || 'N/A',
            address: item.address || item.location?.address || item.permit_location || [item.Street, item.City, item.State, item.Zip].filter(Boolean).join(', ') || 'N/A',
            value: item.permit_value || item.estimated_cost || item.declared_valuation || item.valuation || item.value || item.total_job_cost || item.job_cost || 'N/A',
            description: item.description || item.work_class || item.permit_type || item.Details || 'N/A',
            phone: item.Phone || item.telephone || item.phone || null,
            page_url: source.url
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
            page_url: source.url
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
                  page_url: source.url
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

      // Auto-enable AI if no selector provided (for simple user experience)
      if (!source.selector && !source.useAI && geminiModel) {
        source.useAI = true;
        logger.info(`Auto-enabled AI extraction for ${source.name} (no selector provided)`);
      }

      const matches = source.selector ? $(source.selector) : [];
      
      // If no selector, try full-page AI extraction
      if (!source.selector && source.useAI && geminiModel) {
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
        
        // Try AI extraction if enabled for this source
        if (source.useAI && geminiModel) {
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
            page_url: source.url
          };
        }
        
        if (await insertLeadIfNew({ raw, sourceName: source.name, lead, hashSalt: source.url, userId })) newLeads++;
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
  logger.info(`Scrape cycle finished for user ${userId}.\n`);
}

// === SCRAPER ORCHESTRATOR (runs for all users) ===
async function scrapeAllUsers() {
  try {
    logger.info('=== Starting scrape cycle for all users ===');
    const users = await dbAll('SELECT id, username, role FROM users');
    
    // Also scrape sources.json for all users
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
  app.use(session({
    secret: process.env.SESSION_SECRET || 'change-me-in-.env',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true }
  }));
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
      logger.info(`SMTP configured host=${process.env.SMTP_HOST} port=${process.env.SMTP_PORT||'587'} secure=${process.env.SMTP_SECURE||'false'} user=${process.env.SMTP_USER} notify_to=${process.env.NOTIFY_TO}`);
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
        from: `Aurora Leads <${process.env.SMTP_USER}>`,
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
    } catch (e) {
      logger.error(`Admin seed error: ${e.message}`);
    }
  })();

  // --- Auth routes ---
  app.get('/login', (req, res) => {
    if (req.session?.user) return res.redirect('/dashboard');
    res.sendFile(path.join(__dirname, '../frontend/login.html'));
  });
  app.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    try {
      const user = await dbGet('SELECT * FROM users WHERE username = ?', [String(username || '')]);
      if (!user) return res.status(401).redirect('/login?error=Invalid+credentials');
      const ok = await bcrypt.compare(String(password || ''), user.password_hash);
      if (!ok) return res.status(401).redirect('/login?error=Invalid+credentials');
      req.session.user = { id: user.id, username: user.username, role: user.role };
      res.redirect('/dashboard');
    } catch (e) {
      logger.error(`Login error: ${e.message}`);
      res.status(500).redirect('/login?error=Server+error');
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
        return res.status(400).send('All fields required');
      }
      if (password !== confirmPassword) {
        return res.status(400).send('Passwords do not match');
      }
      
      // Check if user exists
      const existing = await dbGet('SELECT * FROM users WHERE username = ? OR email = ?', [username, email]);
      if (existing) {
        return res.status(400).send('Username or email already exists');
      }
      
      // Create user
      const hash = await bcrypt.hash(password, 10);
      await dbRun('INSERT INTO users (username, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)', 
        [username, email, hash, 'client', new Date().toISOString()]);
      
      // Auto-login
      const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
      req.session.user = { id: user.id, username: user.username, role: user.role };
      res.redirect('/dashboard');
    } catch (e) {
      logger.error(`Signup error: ${e.message}`);
      res.status(500).send('Server error');
    }
  });

  // --- Client Dashboard Route ---
  app.get('/dashboard', (req, res) => {
    // Check if logged in
    if (!req.session.user) return res.redirect('/login');
    // Serve your client-portal.html
    res.sendFile(path.join(__dirname, '../frontend/client-portal.html'));
  });

  // --- My Sources Page ---
  app.get('/my-sources', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
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

  // Simple leads API with optional filters: ?limit=200&source=...&q=...&days=7
  // Returns { data: [...] } for frontend convenience
  app.get('/api/leads', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
      const source = req.query.source ? String(req.query.source) : null;
      const q = req.query.q ? String(req.query.q) : null;
      const days = req.query.days ? parseInt(req.query.days, 10) : null;

      const where = [];
      const params = [];
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
                   FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
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
      const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
      const source = req.query.source ? String(req.query.source) : null;
      const q = req.query.q ? String(req.query.q) : null;
      const days = req.query.days ? parseInt(req.query.days, 10) : null;
      const where = [];
      const params = [];
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
                   FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY id DESC LIMIT ?`;
      params.push(limit);
      const rows = await dbAll(sql, params);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Sources list for frontend dropdown
  app.get('/api/sources', async (req, res) => {
    try {
      const rows = await dbAll('SELECT DISTINCT source FROM leads ORDER BY source');
      res.json({ data: rows.map(r => ({ name: r.source })) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get current user's configured sources
  app.get('/api/sources/mine', async (req, res) => {
    try {
      if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const userId = req.session.user.id;
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

  // Add a new source for current user
  app.post('/api/sources/add', express.json(), async (req, res) => {
    try {
      if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const userId = req.session.user.id;
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
      
      res.json({ success: true, id: result.lastID });
    } catch (e) {
      logger.error(`Add source error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Update an existing source
  app.put('/api/sources/:id', express.json(), async (req, res) => {
    try {
      if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const userId = req.session.user.id;
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
      if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const userId = req.session.user.id;
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
  
  // Serve frontend static bundle (internal app demo)
  app.use('/frontend', express.static(path.resolve(__dirname, '../frontend')));
  
  // Serve CSS and JS at root level too for easier access
  app.use('/style.css', express.static(path.resolve(__dirname, '../frontend/style.css')));
  app.use('/app.js', express.static(path.resolve(__dirname, '../frontend/app.js')));

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
  startListening(parseInt(process.env.PORT || '4000', 10));
}

// === START ===
startServer();
cron.schedule('*/5 * * * *', scrapeAllUsers);
scrapeAllUsers();

logger.info('SHIIMAN LEADS IS LIVE – Multi-tenant scraper running every 5 minutes');
logger.info('Each user sees only their own leads!');