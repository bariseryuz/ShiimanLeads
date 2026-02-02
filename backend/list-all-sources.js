const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'shiiman-leads.db');
const db = new Database(dbPath);

console.log(`📂 Listing all sources...\n`);

const sources = db.prepare(`
  SELECT id, user_id, source_data, created_at
  FROM user_sources
  ORDER BY id
`).all();

if (sources.length === 0) {
  console.log('❌ No sources found');
  process.exit(0);
}

console.log(`Found ${sources.length} sources:\n`);

sources.forEach(source => {
  const data = JSON.parse(source.source_data);
  console.log(`\n${'='.repeat(80)}`);
  console.log(`ID: ${source.id} | User: ${source.user_id}`);
  console.log(`Name: ${data.name || 'N/A'}`);
  console.log(`URL: ${data.url || 'N/A'}`);
  console.log(`Proxy: ${data.useProxy ? 'YES' : 'NO'}`);
  console.log(`Field Schema: ${data.fieldSchema ? JSON.stringify(data.fieldSchema) : 'N/A'}`);
  console.log(`AI Instructions: ${data.aiInstructions ? data.aiInstructions.substring(0, 150) + '...' : 'N/A'}`);
  console.log(`Created: ${source.created_at}`);
});

console.log(`\n${'='.repeat(80)}\n`);

db.close();
