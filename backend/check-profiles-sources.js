const Database = require('better-sqlite3');
const { DB_PATH } = require('./db-path');
const db = new Database(DB_PATH);

console.log('\n👥 Checking User Profiles and Sources...\n');

// Get all users
const users = db.prepare('SELECT id, username, role FROM users').all();
console.log('Users in system:');
users.forEach(u => {
  console.log(`  ID ${u.id}: ${u.username} (${u.role})`);
});

console.log('\n📋 Sources by User:\n');

// Get all sources grouped by user
const sources = db.prepare('SELECT id, user_id, source_data FROM user_sources ORDER BY user_id, id').all();

let currentUserId = null;
sources.forEach(s => {
  if (s.user_id !== currentUserId) {
    const user = users.find(u => u.id === s.user_id);
    console.log(`\n🔹 User ${s.user_id} (${user ? user.username : 'unknown'}):`);
    currentUserId = s.user_id;
  }
  
  const config = JSON.parse(s.source_data);
  console.log(`  └─ source_${s.id}: ${config.name}`);
});

console.log('\n\n📊 Source-Specific Tables in Database:\n');

// Get all source tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'source_%' ORDER BY name").all();
console.log(`Found ${tables.length} source tables:`);
tables.forEach(t => {
  const match = t.name.match(/source_(\d+)/);
  if (match) {
    const sourceId = parseInt(match[1]);
    const source = sources.find(s => s.id === sourceId);
    if (source) {
      const config = JSON.parse(source.source_data);
      const user = users.find(u => u.id === source.user_id);
      const count = db.prepare(`SELECT COUNT(*) as count FROM ${t.name}`).get();
      console.log(`  ${t.name}: "${config.name}" (User: ${user ? user.username : 'unknown'}, Records: ${count.count})`);
    } else {
      console.log(`  ${t.name}: (orphaned table - no matching source)`);
    }
  }
});

db.close();
