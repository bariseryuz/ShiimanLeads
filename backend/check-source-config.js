const Database = require('better-sqlite3');
const { DB_PATH } = require('./db-path');
const db = new Database(DB_PATH);

console.log('\n📋 Checking Source Configuration...\n');

// Get source 7 (Lauderdale)
const source = db.prepare('SELECT * FROM user_sources WHERE id = 7').get();
if (source) {
  console.log(`Source ID: ${source.id}`);
  console.log(`User ID: ${source.user_id}`);
  
  const config = JSON.parse(source.source_data);
  console.log('\nConfiguration:');
  console.log(`  Name: ${config.name}`);
  console.log(`  URL: ${config.url}`);
  console.log(`  Type: ${config.type}`);
  console.log(`  useAI: ${config.useAI}`);
  console.log(`  usePuppeteer: ${config.usePuppeteer}`);
  console.log(`  fieldSchema: ${JSON.stringify(config.fieldSchema, null, 2)}`);
  console.log(`  selector: ${config.selector}`);
} else {
  console.log('Source 7 not found');
}

// Check if source_7 table exists and has columns
console.log('\n📊 Checking source_7 Table...\n');
const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='source_7'").get();
if (tableExists) {
  console.log('✅ Table exists');
  const columns = db.prepare('PRAGMA table_info(source_7)').all();
  console.log('Columns:', columns.map(c => c.name).join(', '));
  
  const count = db.prepare('SELECT COUNT(*) as count FROM source_7').get();
  console.log(`Records: ${count.count}`);
} else {
  console.log('❌ Table does not exist');
}

db.close();
