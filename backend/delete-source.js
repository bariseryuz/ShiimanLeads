const db = require('better-sqlite3')('./shiiman-leads.db');

// Find all sources
const sources = db.prepare('SELECT id, source_data FROM user_sources ORDER BY id DESC').all();
console.log('All sources:');
sources.forEach(s => {
  const data = JSON.parse(s.source_data);
  console.log(`  ID ${s.id}: ${data.sourceName}`);
});

// Find and delete 'hhh' source
const hhhSource = sources.find(s => JSON.parse(s.source_data).sourceName === 'hhh');

if (hhhSource) {
  console.log('\nDeleting source ID:', hhhSource.id);
  db.prepare('DELETE FROM user_sources WHERE id = ?').run(hhhSource.id);
  db.exec(`DROP TABLE IF EXISTS source_${hhhSource.id}`);
  console.log(`✅ Deleted source 'hhh' and table source_${hhhSource.id}`);
} else {
  console.log('\nSource "hhh" not found');
}

db.close();
