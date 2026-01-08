const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Connect to database
const db = new Database(path.join(__dirname, 'leads.db'));

// Read the sources configuration
const sourcesConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'client-sources-config.json'), 'utf-8')
);

// User ID for bariseryuz (ID: 3)
const userId = 3;

console.log(`\n🚀 Adding ${sourcesConfig.length} sources for user ID ${userId} (bariseryuz)...\n`);

// Prepare insert statement
const insertStmt = db.prepare(`
  INSERT INTO user_sources (user_id, source_data, created_at) 
  VALUES (?, ?, ?)
`);

let successCount = 0;
let errorCount = 0;

// Add each source
for (const source of sourcesConfig) {
  try {
    const sourceJson = JSON.stringify(source);
    const result = insertStmt.run(userId, sourceJson, new Date().toISOString());
    console.log(`✅ Added: ${source.name} (ID: ${result.lastInsertRowid})`);
    successCount++;
  } catch (error) {
    console.error(`❌ Failed to add ${source.name}: ${error.message}`);
    errorCount++;
  }
}

console.log(`\n📊 Summary:`);
console.log(`   ✅ Successfully added: ${successCount}`);
console.log(`   ❌ Failed: ${errorCount}`);
console.log(`   📝 Total sources: ${sourcesConfig.length}\n`);

// Show current sources for this user
const sources = db.prepare('SELECT id, source_data FROM user_sources WHERE user_id = ?').all(userId);
console.log(`\n📋 Current sources for user ${userId}:`);
sources.forEach((row) => {
  const data = JSON.parse(row.source_data);
  console.log(`   ${row.id}. ${data.name} - ${data.enabled ? '✅ Enabled' : '❌ Disabled'}`);
});

db.close();
console.log('\n✅ Done!\n');
