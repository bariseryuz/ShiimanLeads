const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Usage: node manage-sources.js <userId> [action]
// Examples:
//   node manage-sources.js 3           - Shows current sources for user 3
//   node manage-sources.js 3 add       - Adds all sources from client-sources.json to user 3
//   node manage-sources.js 3 replace   - Replaces all sources for user 3
//   node manage-sources.js 3 clear     - Removes all sources for user 3

const userId = parseInt(process.argv[2], 10);
const action = process.argv[3] || 'show';

if (!userId || isNaN(userId)) {
  console.error('❌ Usage: node manage-sources.js <userId> [add|replace|clear|show]');
  process.exit(1);
}

const db = new Database(path.join(__dirname, 'leads.db'));
const configFile = path.join(__dirname, 'client-sources.json');

// Read sources config
let sources = [];
try {
  const raw = fs.readFileSync(configFile, 'utf-8');
  sources = JSON.parse(raw);
  if (!Array.isArray(sources)) {
    throw new Error('client-sources.json must be an array');
  }
} catch (err) {
  console.error(`❌ Error reading ${configFile}:`, err.message);
  process.exit(1);
}

console.log(`\n📂 Managing sources for User ID: ${userId}\n`);

switch (action.toLowerCase()) {
  case 'show':
    const existing = db.prepare('SELECT id, source_data FROM user_sources WHERE user_id = ?').all(userId);
    if (existing.length === 0) {
      console.log('   No sources configured for this user.\n');
    } else {
      console.log(`📋 Current sources (${existing.length}):`);
      existing.forEach((row) => {
        const data = JSON.parse(row.source_data);
        console.log(`   ${row.id}. ${data.name} - ${data.enabled ? '✅' : '❌'}`);
      });
      console.log();
    }
    break;

  case 'clear':
    db.prepare('DELETE FROM user_sources WHERE user_id = ?').run(userId);
    console.log('✅ All sources cleared\n');
    break;

  case 'replace':
    db.prepare('DELETE FROM user_sources WHERE user_id = ?').run(userId);
    console.log('🗑️  Cleared existing sources');
    // Fall through to add
    
  case 'add':
    const insertStmt = db.prepare(`
      INSERT INTO user_sources (user_id, source_data, created_at) 
      VALUES (?, ?, ?)
    `);
    
    let added = 0;
    sources.forEach((source) => {
      try {
        const sourceJson = JSON.stringify(source);
        const result = insertStmt.run(userId, sourceJson, new Date().toISOString());
        console.log(`   ✅ ${source.name} (ID: ${result.lastInsertRowid})`);
        added++;
      } catch (err) {
        console.error(`   ❌ Failed: ${source.name} - ${err.message}`);
      }
    });
    
    console.log(`\n📊 Added ${added}/${sources.length} sources\n`);
    break;

  default:
    console.error(`❌ Unknown action: ${action}`);
    console.error('   Valid actions: add, replace, clear, show');
    process.exit(1);
}

db.close();
