const Database = require('better-sqlite3');
const path = require('path');

// Get username from command line argument
const username = process.argv[2];

if (!username) {
  console.log('Usage: node delete-user.js <username>');
  console.log('Example: node delete-user.js "jason schmuckr"');
  process.exit(1);
}

// Connect to database
const dbPath = path.join(__dirname, 'data', 'shiiman-leads.db');
const db = new Database(dbPath);

try {
  // Find user
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  
  if (!user) {
    console.log(`❌ User "${username}" not found`);
    process.exit(1);
  }
  
  console.log(`\n📋 Found user:`);
  console.log(`   ID: ${user.id}`);
  console.log(`   Username: ${user.username}`);
  console.log(`   Email: ${user.email || 'N/A'}`);
  console.log(`   Role: ${user.role}`);
  
  // Count user's data
  const sourceCount = db.prepare('SELECT COUNT(*) as count FROM user_sources WHERE user_id = ?').get(user.id);
  const leadCount = db.prepare('SELECT COUNT(*) as count FROM leads WHERE user_id = ?').get(user.id);
  
  console.log(`\n📊 User has:`);
  console.log(`   ${sourceCount.count} sources`);
  console.log(`   ${leadCount.count} leads`);
  
  console.log(`\n⚠️  WARNING: This will permanently delete:`);
  console.log(`   - The user account`);
  console.log(`   - All ${sourceCount.count} sources`);
  console.log(`   - All ${leadCount.count} leads`);
  console.log(`\nAre you sure? (This script requires manual confirmation)`);
  console.log(`\nTo proceed, uncomment the deletion code in delete-user.js\n`);
  
  // Uncomment below to actually delete (safety measure)
  /*
  console.log('\n🗑️  Deleting user data...');
  
  // Delete in correct order (respect foreign keys)
  db.prepare('DELETE FROM leads WHERE user_id = ?').run(user.id);
  console.log(`   ✅ Deleted ${leadCount.count} leads`);
  
  db.prepare('DELETE FROM user_sources WHERE user_id = ?').run(user.id);
  console.log(`   ✅ Deleted ${sourceCount.count} sources`);
  
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  console.log(`   ✅ Deleted user account`);
  
  console.log(`\n✅ User "${username}" has been completely deleted\n`);
  */
  
} catch (error) {
  console.error(`\n❌ Error: ${error.message}\n`);
  process.exit(1);
} finally {
  db.close();
}
