const Database = require('better-sqlite3');
const path = require('path');

// Connect to database
const db = new Database(path.join(__dirname, 'leads.db'));

// User ID for bariseryuz (ID: 3)
const userId = 3;

// Mesa source with proper multifamily filtering
const mesaSource = {
  "name": "Mesa Building Permits - Multifamily",
  "url": "https://data.mesaaz.gov/resource/2gkz-7z4f.json",
  "publicUrl": "https://data.mesaaz.gov/Development-Services/Building-Permits-RETIRED-/2gkz-7z4f/data",
  "method": "json",
  "requestMethod": "GET",
  "params": {
    // Filter: Only permits issued after Jan 1, 2024 AND has unit_number (multifamily)
    "$where": "issued_date >= '2024-01-01T00:00:00' AND unit_number IS NOT NULL",
    // Order by issued date descending (newest first)
    "$order": "issued_date DESC",
    // Limit results per request
    "$limit": 1000
  },
  "jsonFields": [
    "permit_number",
    "property_address", 
    "value",
    "description",
    "applicant",
    "contractor_name"
  ],
  // No additional filtering needed - API handles it
  "useAI": false,
  "enabled": true,
  "notes": "Mesa AZ - Multifamily only (unit_number IS NOT NULL), issued after 01/01/2024"
};

console.log('\n Adding Mesa multifamily source for user ID', userId, '...\n');

const sourceJson = JSON.stringify(mesaSource);
const insertStmt = db.prepare(`
  INSERT INTO user_sources (user_id, source_data, created_at) 
  VALUES (?, ?, ?)
`);

try {
  const result = insertStmt.run(userId, sourceJson, new Date().toISOString());
  console.log(`✅ Added: ${mesaSource.name} (ID: ${result.lastInsertRowid})`);
  console.log(`\n📋 Configuration:`);
  console.log(`   📅 Date Filter: >= 2024-01-01`);
  console.log(`   🏢 Type: Multifamily (filtered by unit_number)`);
  console.log(`   📊 Limit: 1000 records per scrape`);
  console.log(`   🔄 Sort: Newest first\n`);
} catch (error) {
  console.error(`❌ Failed to add source:`, error.message);
}

db.close();
console.log('✅ Done!\n');
