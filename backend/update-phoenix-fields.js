const Database = require('better-sqlite3');
const { DB_PATH } = require('./db-path.js');

const db = new Database(DB_PATH);

console.log(`📂 Updating Phoenix field schema to 5 fields only...\n`);

const correctFieldSchema = [
  { name: 'number', type: 'string' },
  { name: 'type', type: 'string' },
  { name: 'valuation', type: 'string' },
  { name: 'contractor', type: 'string' },
  { name: 'contractor_phone', type: 'string' }
];

const source = db.prepare(`
  SELECT id, source_data FROM user_sources 
  WHERE user_id = 1 AND json_extract(source_data, '$.name') LIKE '%Phoenix%'
`).get();

if (!source) {
  console.log('❌ Phoenix source not found');
  process.exit(1);
}

const sourceData = JSON.parse(source.source_data);
sourceData.fieldSchema = correctFieldSchema;

db.prepare(`
  UPDATE user_sources 
  SET source_data = ?
  WHERE id = ?
`).run(JSON.stringify(sourceData), source.id);

console.log(`✅ Updated Phoenix field schema (ID: ${source.id})`);
console.log(`\n📋 New fields (${correctFieldSchema.length}):`);
correctFieldSchema.forEach(f => console.log(`   - ${f.name} (${f.type})`));

db.close();
