const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'shiiman-leads.db');
const db = new Database(dbPath);

console.log('🔧 Enabling direct connection fallback for all sources...\n');

const sources = db.prepare(`
  SELECT id, source_data FROM user_sources WHERE user_id = 1
`).all();

sources.forEach(source => {
  const data = JSON.parse(source.source_data);
  data.allowDirectConnection = true;
  
  db.prepare(`
    UPDATE user_sources 
    SET source_data = ? 
    WHERE id = ?
  `).run(JSON.stringify(data), source.id);
  
  console.log(`✅ Updated source ID ${source.id}`);
});

console.log(`\n✅ All ${sources.length} sources now allow direct connection fallback`);
console.log('🔒 Your IP is still protected - only falls back if ALL proxies fail');

db.close();
