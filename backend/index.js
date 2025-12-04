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
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');

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

async function writeDashboardHTML(limit = 200) {
  try {
    const rows = await dbAll(
      `SELECT permit_number, address, value, description, source, date_added
       FROM leads ORDER BY id DESC LIMIT ?`, [limit]
    );
    const esc = s => (s == null ? '' : String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;'));

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Shiiman Leads · Dashboard</title>
  <style>
    :root { --bg:#020617; --fg:#e5e7eb; --muted:#94a3b8; --accent:#22c55e; --card:#0b1220; --border:#1f2937; }
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--fg);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial}
    header{padding:16px 24px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
    .brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--fg)}
    .logo{display:grid;place-items:center;height:32px;width:32px;border-radius:999px;background:rgba(34,197,94,.1);color:#34d399;border:1px solid rgba(34,197,94,.35)}
    .meta{font-size:12px;color:var(--muted)}
    .wrap{padding:16px 24px;max-width:1200px;margin:0 auto}
    .card{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
    table{width:100%;border-collapse:collapse}
    thead th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);background:#06101e;position:sticky;top:0;z-index:2}
    th,td{padding:12px 14px;border-bottom:1px solid var(--border);vertical-align:top}
    tbody tr:hover{background:#081224}
    .pill{display:inline-block;padding:2px 8px;border:1px solid #334155;border-radius:999px;font-size:12px;color:#cbd5e1}
    .value{color:var(--accent);font-weight:600}
    .cta{display:inline-block;padding:10px 14px;border-radius:8px;background:#22c55e;color:#041316;text-decoration:none;font-weight:600}
    footer{padding:16px 24px;color:var(--muted);font-size:12px;border-top:1px solid var(--border)}
    .sub{display:flex;gap:12px;align-items:center;color:var(--muted)}
    .grid{display:grid;grid-template-columns:1fr;gap:16px}
    @media (min-width:1000px){ .grid{grid-template-columns:3fr 1fr} }
  </style>
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
  </head>
<body>
  <header>
    <a class="brand" href="/">
      <span class="logo">S</span>
      <strong>Shiiman Leads</strong>
    </a>
    <div class="meta">Last update: ${esc(new Date().toLocaleString())} · Showing latest ${rows.length}</div>
  </header>
  <div class="wrap">
    <div class="grid">
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Source</th>
              <th>Permit #</th>
              <th>Address</th>
              <th>Value</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${esc(r.date_added || '')}</td>
                <td><span class="pill">${esc(r.source || '')}</span></td>
                <td>${esc(r.permit_number || 'N/A')}</td>
                <td>${esc(r.address || '')}</td>
                <td class="value">${esc(r.value || 'N/A')}</td>
                <td>${esc(r.description || '')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <aside class="card" style="padding:16px">
        <h3 style="margin:0 0 8px 0">Get full access</h3>
        <p class="sub">Sign in to browse all leads, filter, and view details.</p>
        <div style="margin-top:12px">
          <a class="cta" href="/login">Sign in</a>
        </div>
      </aside>
    </div>
  </div>
  <footer>
    <div class="wrap sub">
      <span>© ${new Date().getFullYear()} Shiiman Leads</span>
      <span>File: output/dashboard.html · Generated by backend/index.js</span>
    </div>
  </footer>
</body>
</html>`;
    fs.writeFileSync('output/dashboard.html', html, 'utf-8');
    logger.info(`Dashboard updated → output/dashboard.html`);
  } catch (e) {
    logger.error(`Failed to write dashboard: ${e.message}`);
  }
}

async function insertLeadIfNew({ raw, sourceName, lead, hashSalt = '' }) {
  const hash = CryptoJS.MD5(raw + hashSalt).toString();
  const row = await dbGet(`SELECT hash FROM seen WHERE hash = ?`, [hash]);
  if (row) return false;

  await dbRun(`INSERT INTO seen (hash) VALUES (?)`, [hash]);
  await dbRun(
    `INSERT INTO leads (hash, raw_text, permit_number, address, value, description, source, date_added)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)` ,
    [
      hash,
      raw,
      lead.permit_number,
      lead.address,
      lead.value,
      lead.description,
      sourceName,
      new Date().toISOString()
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
  db.run(`CREATE TABLE IF NOT EXISTS seen (hash TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT UNIQUE,
    raw_text TEXT,
    permit_number TEXT,
    address TEXT,
    value TEXT,
    description TEXT,
    source TEXT,
    date_added TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'client'
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
  // Attempt to add IP column if missing (safe no-op if already exists)
  db.get("PRAGMA table_info(inquiries)", (err) => {
    if (!err) {
      db.all("PRAGMA table_info(inquiries)", (e, cols) => {
        if (!e && cols && !cols.find(c => c.name === 'ip')) {
          db.run('ALTER TABLE inquiries ADD COLUMN ip TEXT');
        }
      });
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
async function scrape() {
  logger.info('Starting new scrape cycle...');
  const SOURCES = loadSources();
  for (const source of SOURCES) {
    try {
      logger.info(`Checking → ${source.name}`);
      let data; // can be JSON array or HTML string
      let axiosResponse;
      let usedPuppeteer = false;

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
            value: item.permit_value || item.estimated_cost || item.declared_valuation || item.valuation || item.value || item.total_job_cost || item.job_cost || item.Phone || 'N/A',
            description: item.description || item.work_class || item.permit_type || item.Details || 'N/A'
          };
          if (await insertLeadIfNew({ raw, sourceName: source.name, lead })) inserted++;
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
                  extracted.push({
                    Title: display,
                    DisplayName: display,
                    Street: street,
                    City: city,
                    State: state,
                    Zip: zip,
                    Phone: phone,
                    Details: n.description || ''
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
            value: item.permit_value || item.estimated_cost || item.Phone || 'N/A',
            description: item.description || item.Details || 'N/A'
          };
          if (await insertLeadIfNew({ raw, sourceName: source.name, lead })) insertedJsonLd++;
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
                  value: item.permit_value || item.estimated_cost || item.Phone || 'N/A',
                  description: item.description || item.Details || 'N/A'
                };
                if (await insertLeadIfNew({ raw, sourceName: source.name, lead })) insertedAttr++;
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
      let newLeads = 0;

      const matches = source.selector ? $(source.selector) : [];
      try {
        logger.info(`Selector '${source.selector}' matched ${matches.length} elements on ${source.name}`);
      } catch {}

      for (const el of matches.toArray()) {
        const raw = $(el).text().replace(/\s+/g, ' ').trim();
        if (!textPassesFilters(raw, source)) continue;

        const phoneMatch = raw.match(/\b(?:\+?1[\-.\s]?)?(?:\(?\d{3}\)?[\-.\s]?\d{3}[\-.\s]?\d{4})\b/);
        const lead = {
          permit_number: raw.match(/[A-Z]?\d{5,12}[A-Z]?/i)?.[0] || 'N/A',
          address: raw.match(/\d{3,6}\s+.{5,70}(St|Rd|Ave|Blvd|Dr|Ln|Ct|Pl|Way|Cir|Lane|Boulevard|Drive|Street|Road|Avenue)/i)?.[0] || 'Check manually',
          value: raw.match(/\$[\d,]+/g)?.[0] || phoneMatch?.[0] || 'N/A',
          description: raw.substring(0, 300)
        };
        if (await insertLeadIfNew({ raw, sourceName: source.name, lead, hashSalt: source.url })) newLeads++;
      }

      logger.info(`Inserted ${newLeads} new leads from ${source.name}`);
      if (source.usePuppeteer) {
        logger.info(`Dynamic mode (Puppeteer) used for ${source.name}`);
      }
    } catch (err) {
      logger.error(`Failed ${source.name}: ${err.message}`);
    }
  }
  await writeDashboardHTML();
  logger.info('Scrape cycle finished.\n');
}

// === SERVER ===
function startServer() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, 'views'));
  app.use(expressLayouts);
  app.set('layout', 'layout');
  app.use(express.urlencoded({ extended: true }));
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
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
    if (req.session?.user) return res.redirect('/app');
    res.render('login', { title: 'Sign In', error: null });
  });
  app.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    try {
      const user = await dbGet('SELECT * FROM users WHERE username = ?', [String(username || '')]);
      if (!user) return res.status(401).render('login', { title: 'Sign In', error: 'Invalid credentials' });
      const ok = await bcrypt.compare(String(password || ''), user.password_hash);
      if (!ok) return res.status(401).render('login', { title: 'Sign In', error: 'Invalid credentials' });
      req.session.user = { id: user.id, username: user.username, role: user.role };
      res.redirect('/app');
    } catch (e) {
      res.status(500).render('login', { title: 'Sign In', error: 'Server error' });
    }
  });
  app.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
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
  app.get('/app', ensureAuth, (req, res) => res.redirect('/app/leads'));
  app.get('/app/leads', ensureAuth, async (req, res) => {
    try {
      const page = Math.max(parseInt(req.query.page || '1', 10), 1);
      const pageSize = Math.min(parseInt(req.query.pageSize || '20', 10), 100);
      const offset = (page - 1) * pageSize;
      const q = req.query.q ? String(req.query.q) : null;
      const source = req.query.source ? String(req.query.source) : null;
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

      const countRow = await dbGet(`SELECT COUNT(1) as c FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, params);
      const total = countRow?.c || 0;
      const pages = Math.max(Math.ceil(total / pageSize), 1);

      const rows = await dbAll(
        `SELECT id, hash, permit_number, address, value, description, source, date_added
         FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]
      );

      // distinct sources for filter dropdown
      const srcRows = await dbAll('SELECT DISTINCT source FROM leads ORDER BY source');
      const sources = srcRows.map(r => r.source).filter(Boolean);

      res.render('leads_list', {
        title: 'Leads',
        rows, total, page, pages, pageSize, q, source, sources, days
      });
    } catch (e) {
      res.status(500).send('Server error');
    }
  });

  // Inquiries admin view (latest 200)
  app.get('/app/inquiries', ensureAuth, async (req, res) => {
    try {
      const rows = await dbAll('SELECT id, name, email, company, message, created_at, ip FROM inquiries ORDER BY id DESC LIMIT 200');
      res.render('inquiries_list', { title: 'Inquiries', inquiries: rows });
    } catch (e) {
      res.status(500).send('Server error');
    }
  });
  // Test email route
  app.get('/app/test-email', ensureAuth, async (req, res) => {
    try {
      await sendNotificationEmail('Test Email', 'This is a test notification from Aurora Leads.');
      res.send('Test email attempted (check logs & inbox).');
    } catch (e) {
      res.status(500).send('Failed to send test email');
    }
  });

  // CSV export using the same filters as the list view
  app.get('/app/leads.csv', ensureAuth, async (req, res) => {
    try {
      const q = req.query.q ? String(req.query.q) : null;
      const source = req.query.source ? String(req.query.source) : null;
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
      const rows = await dbAll(
        `SELECT id, permit_number, address, value, description, source, date_added
         FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY id DESC`, params
      );

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
      const header = ['id','date_added','source','permit_number','address','value','description'];
      const escapeCsv = v => {
        const s = v == null ? '' : String(v);
        if (/[",\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
        return s;
      };
      const lines = [header.join(',')].concat(rows.map(r => header.map(k => escapeCsv(r[k])).join(',')));
      res.send(lines.join('\n'));
    } catch (e) {
      res.status(500).send('Server error');
    }
  });

  // Scrape Now trigger
  app.post('/app/scrape-now', ensureAuth, async (req, res) => {
    try {
      // Fire and forget; do not await full cycle to keep UI responsive
      scrape().catch(err => logger.error('Scrape-now error: ' + err.message));
      res.redirect('/app/leads');
    } catch (e) {
      res.redirect('/app/leads');
    }
  });

  app.get('/app/leads/:id', ensureAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = await dbGet('SELECT * FROM leads WHERE id = ?', [id]);
      if (!row) return res.status(404).send('Not found');
      res.render('lead_detail', { title: `Lead ${row.permit_number || row.id}`, lead: row });
    } catch (e) {
      res.status(500).send('Server error');
    }
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
      const sql = `SELECT id, hash, permit_number, address, value, description, source, date_added
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
      const sql = `SELECT id, hash, permit_number, address, value, description, source, date_added
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

  // Landing page (marketing) – pass query params for status messages
  app.get('/', (req, res) => {
    res.render('landing', { title: 'Home', query: req.query || {} });
  });
  // Protect dashboard: only authenticated users can view
  app.get('/dashboard', ensureAuth, (req, res) => {
    try {
      res.sendFile(require('path').resolve('output/dashboard.html'));
    } catch (e) {
      res.status(500).send('Dashboard unavailable');
    }
  });
  // Serve frontend static bundle (internal app demo)
  app.use('/frontend', express.static(path.resolve(__dirname, '../frontend')));

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
cron.schedule('*/5 * * * *', scrape);
scrape();

logger.info('AURORA LEADS IS LIVE – Making you money every 5 minutes');
logger.info('Check output/latest_leads.jsonl → this is what you sell!');