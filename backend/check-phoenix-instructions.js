const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'shiiman-leads.db');
const db = new Database(dbPath);

const phoenix = db.prepare(`
  SELECT id, source_data
  FROM user_sources
  WHERE user_id = 1 AND json_extract(source_data, '$.name') = 'Phoenix Issued Permits'
`).get();

if (!phoenix) {
  console.log('❌ Phoenix not found');
  process.exit(1);
}

const data = JSON.parse(phoenix.source_data);
console.log('\n✅ Current Phoenix AI Instructions:\n');
console.log(data.aiInstructions);

db.close();
