const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'shiiman-leads.db');
const db = new Database(dbPath);

// List of source names that REQUIRE proxy (will fail without it)
const requireProxySources = [
  // Add source names here as needed
  // Example: 'Phoenix - Multi-Family Permits'
];

console.log('📋 Setting requireProxy flag for specified sources...\n');

for (const sourceName of requireProxySources) {
  const source = db.prepare(`
    SELECT id, name, source_data FROM user_sources WHERE name = ? AND user_id = 1
  `).get(sourceName);
  
  if (source) {
    const sourceData = JSON.parse(source.source_data);
    sourceData.requireProxy = true;
    
    db.prepare(`
      UPDATE user_sources 
      SET source_data = ? 
      WHERE id = ?
    `).run(JSON.stringify(sourceData), source.id);
    
    console.log(`✅ Updated "${sourceName}" - requireProxy: true`);
  } else {
    console.log(`❌ Source "${sourceName}" not found`);
  }
}

console.log('\n✅ Done! Sources with requireProxy will NEVER retry without proxy.');
console.log('\n📝 Current configuration flags:');
console.log('   • useProxy: false → Disable proxy for this source');
console.log('   • requireProxy: true → Proxy REQUIRED, fail if proxy fails');
console.log('   • (default) → Use proxy if enabled, retry without if it fails');

db.close();
