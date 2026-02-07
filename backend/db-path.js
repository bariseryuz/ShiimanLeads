const path = require('path');
const fs = require('fs');

// ============================================
// ENVIRONMENT-AWARE DATABASE PATHS
// ============================================
const isProduction = process.env.NODE_ENV === 'production';

// Main database path
const DB_PATH = isProduction
  ? '/app/backend/data/shiiman-leads.db'  // Railway: In volume (persistent)
  : path.join(__dirname, 'shiiman-leads.db');  // Local: backend/

// Sessions database path
const SESSIONS_DB_PATH = isProduction
  ? '/app/backend/data/sessions.db'  // Railway: In volume (persistent)
  : path.join(__dirname, 'sessions.db');  // Local: backend/

// JSONL output path
const OUTBOX_JSONL = isProduction
  ? '/app/backend/data/output/latest_leads.jsonl'  // Railway: In volume
  : path.join(__dirname, 'output', 'latest_leads.jsonl');  // Local: backend/output/

// Ensure directories exist in production
if (isProduction) {
  const dataDir = '/app/backend/data';
  const outputDir = '/app/backend/data/output';
  
  [dataDir, outputDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`✅ Created directory: ${dir}`);
    }
  });
}

console.log(`📁 Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
console.log(`📁 Main DB: ${DB_PATH}`);
console.log(`📁 Sessions DB: ${SESSIONS_DB_PATH}`);
console.log(`📁 JSONL Output: ${OUTBOX_JSONL}`);

module.exports = {
  DB_PATH,
  SESSIONS_DB_PATH,
  OUTBOX_JSONL
};
