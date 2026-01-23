const Database = require('better-sqlite3');
const { DB_PATH } = require('./db-path');
const db = new Database(DB_PATH);

console.log('\n📊 Checking Source-Specific Tables...\n');

// Get all source tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'source_%'").all();
console.log('Found tables:', tables);

// Check each table
tables.forEach(({ name }) => {
  const count = db.prepare(`SELECT COUNT(*) as count FROM ${name}`).get();
  console.log(`\n${name}: ${count.count} records`);
  
  if (count.count > 0) {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all();
    console.log('Columns:', columns.map(c => c.name).join(', '));
    
    const sample = db.prepare(`SELECT * FROM ${name} LIMIT 1`).get();
    console.log('Sample data:', sample);
  }
});

// Check user_sources to see what sourceIds exist
console.log('\n📝 Sources in user_sources:');
const sources = db.prepare('SELECT id, source_data FROM user_sources').all();
sources.forEach(s => {
  try {
    const data = JSON.parse(s.source_data);
    console.log(`  ID ${s.id}: ${data.name}`);
  } catch (e) {
    console.log(`  ID ${s.id}: (parse error)`);
  }
});

db.close();
console.log('\n✅ Done');
