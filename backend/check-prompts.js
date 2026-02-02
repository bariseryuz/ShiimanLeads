const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'shiiman-leads.db'));

console.log('Checking AI prompts in database...\n');

const sources = db.prepare('SELECT id, source_data FROM user_sources WHERE user_id = 1 AND id >= 16').all();

sources.forEach(s => {
  const data = JSON.parse(s.source_data);
  console.log(`Source ID ${s.id}: ${data.name}`);
  console.log(`  Has aiPrompt: ${!!data.aiPrompt}`);
  if (data.aiPrompt) {
    console.log(`  Prompt: ${data.aiPrompt.substring(0, 80)}...`);
  }
  console.log('');
});

db.close();
