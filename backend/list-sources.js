const db = require('better-sqlite3')('./shiiman-leads.db');

console.log('\n=== ALL SOURCES ===\n');

const sources = db.prepare('SELECT id, user_id, source_data, created_at FROM user_sources ORDER BY id').all();

if (sources.length === 0) {
  console.log('No sources found');
} else {
  sources.forEach(source => {
    console.log(`Source ID: ${source.id}`);
    console.log(`User ID: ${source.user_id}`);
    console.log(`Created: ${source.created_at}`);
    console.log(`Data:`);
    console.log(source.source_data);
    console.log('---');
  });
}

db.close();
