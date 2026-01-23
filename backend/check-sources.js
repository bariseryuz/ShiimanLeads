const Database = require('better-sqlite3');
const { DB_PATH } = require('./db-path');
const db = new Database(DB_PATH);

// Get all users
const users = db.prepare('SELECT id, username FROM users').all();
console.log('All Users:');
users.forEach(u => console.log(`  - ${u.username} (ID: ${u.id})`));

// Find Bery user
const beryUser = users.find(u => u.username.toLowerCase().includes('bery'));
if (beryUser) {
  console.log(`\n=== Sources for ${beryUser.username} (ID: ${beryUser.id}) ===`);
  const sources = db.prepare('SELECT id, source_data, created_at FROM user_sources WHERE user_id = ?').all(beryUser.id);
  
  if (sources.length === 0) {
    console.log('No sources configured!');
  } else {
    sources.forEach((s, idx) => {
      try {
        const data = JSON.parse(s.source_data);
        console.log(`\n${idx + 1}. ${data.name}`);
        console.log(`   URL: ${data.url}`);
        console.log(`   Type: ${data.type || 'html'}`);
        console.log(`   Selector: ${data.selector || 'none'}`);
        console.log(`   Use AI: ${data.useAI || false}`);
        console.log(`   Use Puppeteer: ${data.usePuppeteer || false}`);
        console.log(`   Created: ${s.created_at}`);
      } catch (e) {
        console.log(`   Error parsing source data: ${e.message}`);
      }
    });
  }
  
  // Check if any leads exist for this user
  const leadCount = db.prepare('SELECT COUNT(*) as count FROM leads WHERE user_id = ?').get(beryUser.id);
  console.log(`\n=== Leads for ${beryUser.username}: ${leadCount.count} total ===`);
  
  // Get recent leads
  const recentLeads = db.prepare('SELECT source, date_added FROM leads WHERE user_id = ? ORDER BY date_added DESC LIMIT 5').all(beryUser.id);
  if (recentLeads.length > 0) {
    console.log('Recent leads:');
    recentLeads.forEach(l => console.log(`  - ${l.source} at ${l.date_added}`));
  }
} else {
  console.log('\nBery user not found!');
}

db.close();
