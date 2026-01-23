const Database = require('better-sqlite3');
const { DB_PATH } = require('./db-path');
const db = new Database(DB_PATH);

console.log('=== USERS ===');
const users = db.prepare('SELECT id, username, email FROM users').all();
users.forEach(u => {
  console.log(`ID: ${u.id}, Username: ${u.username}, Email: ${u.email || 'N/A'}`);
});

console.log('\n=== USER SOURCES ===');
const sources = db.prepare('SELECT id, user_id, source_data, created_at FROM user_sources').all();
if (sources.length === 0) {
  console.log('❌ No sources found in database!');
} else {
  sources.forEach(s => {
    try {
      const data = JSON.parse(s.source_data);
      console.log(`\nUser ID ${s.user_id}: ${data.name}`);
      console.log(`  URL: ${data.url}`);
      console.log(`  Type: ${data.sourceType || 'html'}`);
      console.log(`  Use AI: ${data.useAI ? 'Yes' : 'No'}`);
      console.log(`  Created: ${s.created_at}`);
    } catch (e) {
      console.log(`Error parsing source ${s.id}: ${e.message}`);
    }
  });
}

console.log('\n=== RECENT LEADS ===');
const leads = db.prepare('SELECT user_id, source, COUNT(*) as count FROM leads GROUP BY user_id, source').all();
if (leads.length === 0) {
  console.log('❌ No leads found in database!');
} else {
  leads.forEach(l => {
    console.log(`User ${l.user_id}: ${l.count} leads from ${l.source}`);
  });
}

db.close();
