const path = require('path');

const DB_PATH = path.join(__dirname, 'shiiman-leads.db');
const SESSIONS_DB_PATH = path.join(__dirname, 'sessions.db');
const OUTBOX_JSONL = path.join(__dirname, 'output', 'latest_leads.jsonl');

module.exports = {
  DB_PATH,
  SESSIONS_DB_PATH,
  OUTBOX_JSONL
};
