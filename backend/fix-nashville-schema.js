const Database = require('better-sqlite3');
const db = new Database('shiiman-leads.db');

// Get Nashville field schema
const nashville = db.prepare('SELECT id, source_data FROM user_sources WHERE id = 23').get();
const data = JSON.parse(nashville.source_data);

console.log('Current Nashville fieldSchema:');
console.log(JSON.stringify(data.fieldSchema, null, 2));

// Update with correct field names that AI is using
data.fieldSchema = {
  "permit_type": "Type of permit",
  "construction_cost": "Construction cost value",
  "adress_details": "Full property address",
  "constructor_name": "Constructor/contractor name",
  "value": "Project value",
  "phone": "Contact phone number"
};

db.prepare('UPDATE user_sources SET source_data = ? WHERE id = 23').run(JSON.stringify(data));

console.log('\n✅ Updated Nashville fieldSchema to:');
console.log(JSON.stringify(data.fieldSchema, null, 2));

// Check table columns
console.log('\n📊 Current source_23 table columns:');
const columns = db.prepare('PRAGMA table_info(source_23)').all();
columns.forEach(col => console.log(`  - ${col.name} (${col.type})`));

db.close();
