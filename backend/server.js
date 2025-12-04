const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const app = express();

// Simple CORS (adjust origins as needed)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// SQLite connection (read-only usage)
const dbPath = path.join(__dirname, 'leads.db');
const db = new sqlite3.Database(dbPath);

// Helper: build WHERE clause based on query params
function buildFilters(query) {
  const clauses = [];
  const params = [];
  if (query.source) {
    clauses.push('source = ?');
    params.push(query.source);
  }
  if (query.search) {
    clauses.push('(raw_text LIKE ? OR address LIKE ? OR description LIKE ? OR permit_number LIKE ?)');
    const term = `%${query.search}%`;
    params.push(term, term, term, term);
  }
  if (query.sinceDays) {
    const d = new Date(Date.now() - Number(query.sinceDays) * 24 * 60 * 60 * 1000).toISOString();
    clauses.push('date_added >= ?');
    params.push(d);
  }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}

// GET /api/leads?limit=100&offset=0&source=...&search=...&sinceDays=7
app.get('/api/leads', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const offset = Number(req.query.offset) || 0;
  const { where, params } = buildFilters(req.query);
  const sql = `SELECT permit_number, address, value, description, source, date_added FROM leads ${where} ORDER BY date_added DESC LIMIT ? OFFSET ?`;
  db.all(sql, [...params, limit, offset], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ data: rows });
  });
});

// GET /api/sources (reads sources.json)
app.get('/api/sources', (req, res) => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf-8');
    res.json({ data: JSON.parse(raw) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve latest_leads.jsonl as raw (stream)
app.get('/api/latest-jsonl', (req, res) => {
  const p = path.join(__dirname, 'output', 'latest_leads.jsonl');
  if (!fs.existsSync(p)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/plain');
  fs.createReadStream(p).pipe(res);
});

// Static frontend (../frontend)
const publicDir = path.join(__dirname, '..', 'frontend');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
} else {
  console.warn('Frontend directory not found, static hosting skipped.');
}

const port = process.env.FRONTEND_PORT || 3000;
app.listen(port, () => {
  console.log(`Frontend/API server listening on http://localhost:${port}`);
});
