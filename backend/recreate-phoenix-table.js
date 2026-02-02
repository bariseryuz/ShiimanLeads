const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'shiiman-leads.db');
const db = new Database(dbPath);

console.log('🗑️ Dropping and recreating source_25 table with correct schema...\n');

// Drop existing table
db.prepare('DROP TABLE IF EXISTS source_25').run();
console.log('✅ Dropped old source_25 table');

// Create new table with 5 fields only (removed owner, description)
db.prepare(`
  CREATE TABLE source_25 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    number TEXT,
    type TEXT,
    valuation TEXT,
    contractor TEXT,
    contractor_phone TEXT,
    raw_text TEXT,
    page_url TEXT,
    source_name TEXT,
    _source_id INTEGER DEFAULT 25,
    _scraped_at TEXT DEFAULT (datetime('now')),
    _hash TEXT,
    UNIQUE(user_id, _hash)
  )
`).run();

console.log('✅ Created new source_25 table with fields:');
console.log('   - user_id');
console.log('   - number');
console.log('   - type');
console.log('   - valuation');
console.log('   - contractor');
console.log('   - contractor_phone');
console.log('   - raw_text');
console.log('   - page_url');
console.log('   - source_name');
console.log('   - _source_id');
console.log('   - _scraped_at');
console.log('   - _hash\n');

console.log('✅ Table ready for Phoenix scraping!');

db.close();
