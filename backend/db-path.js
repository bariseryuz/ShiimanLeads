const path = require('path');
const fs = require('fs');

// Primary SQLite DB path - prefer environment variable (Railway volume mount)
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, 'data', 'leads.db');
const SESSIONS_DB_PATH = process.env.SQLITE_SESSIONS_DB_PATH || path.join(__dirname, 'data', 'sessions.db');
const OUTBOX_JSONL = process.env.OUTBOX_JSONL_PATH || path.join(__dirname, 'output', 'latest_leads.jsonl');

// Ensure parent directories exist when running locally
try {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(SESSIONS_DB_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(OUTBOX_JSONL), { recursive: true });
} catch (e) {
  // ignore
}

module.exports = {
  DB_PATH,
  SESSIONS_DB_PATH,
  OUTBOX_JSONL
};
