const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'shiiman-leads.db');
const db = new Database(dbPath);

console.log('📋 Checking all sources for user_id=1...\n');

const sources = db.prepare(`
  SELECT id, name, source_data, created_at 
  FROM user_sources 
  WHERE user_id = 1
  ORDER BY id
`).all();

console.log(`Found ${sources.length} source(s):\n`);

sources.forEach(source => {
  const data = JSON.parse(source.source_data);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`ID: ${source.id}`);
  console.log(`Name: ${source.name}`);
  console.log(`URL: ${data.url}`);
  console.log(`Use Puppeteer: ${data.usePuppeteer}`);
  console.log(`Use AI: ${data.useAI}`);
  console.log(`Use Proxy: ${data.useProxy}`);
  console.log(`Require Proxy: ${data.requireProxy || 'false'}`);
  console.log(`Allow Direct: ${data.allowDirectConnection || 'false'}`);
  console.log(`AI Prompt: ${data.aiPrompt ? data.aiPrompt.substring(0, 80) + '...' : 'None'}`);
  console.log(`Field Schema: ${JSON.stringify(data.fieldSchema || {})}`);
  console.log(`Created: ${source.created_at}`);
  console.log('');
});

console.log(`\n✅ Total: ${sources.length} sources`);

db.close();
