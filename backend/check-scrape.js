const Database = require('better-sqlite3');
const db = new Database('./data/shiiman-leads.db');

// Check what tables exist
console.log('\n=== DATABASE TABLES ===');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));
console.log('');

// Total leads
try {
  const total = db.prepare('SELECT COUNT(*) as count FROM leads').get();
  console.log(`Total leads in database: ${total.count}`);
  
  // Check recent leads
  const recent = db.prepare(`
    SELECT 
      DATE(created_at) as date,
      COUNT(*) as count
    FROM leads 
    WHERE created_at >= datetime('now', '-3 days')
    GROUP BY DATE(created_at)
    ORDER BY date DESC
  `).all();
  
  console.log('\n=== LEADS BY DATE (Last 3 Days) ===');
  recent.forEach(row => {
    console.log(`${row.date}: ${row.count} leads`);
  });
  
} catch (e) {
  console.log('Error querying leads:', e.message);
}

db.close();
