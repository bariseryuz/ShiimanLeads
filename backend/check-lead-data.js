const Database = require('better-sqlite3');
const { DB_PATH } = require('./db-path');
const db = new Database(DB_PATH);

console.log('\n📊 Checking Latest Lead Data...\n');

// Check last lead in main leads table
const mainLead = db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1').get();
if (mainLead) {
  console.log('Last lead in main leads table:');
  console.log(`  Permit: ${mainLead.permit_number}`);
  console.log(`  Address: ${mainLead.address}`);
  console.log(`  Source: ${mainLead.source}`);
  console.log(`  extracted_data: ${mainLead.extracted_data}`);
}

console.log('\n📋 Checking source_7 table...\n');

// Check source_7 table
const source7Leads = db.prepare('SELECT * FROM source_7 ORDER BY id DESC').all();
console.log(`Total records: ${source7Leads.length}`);

source7Leads.forEach((lead, idx) => {
  console.log(`\nRecord ${idx + 1}:`);
  console.log(`  ID: ${lead.id}`);
  console.log(`  Permit Number: ${lead.permit_number || 'NULL'}`);
  console.log(`  Address: ${lead.address || 'NULL'}`);
  console.log(`  Company: ${lead.company_name || 'NULL'}`);
  console.log(`  Contractor: ${lead.contractor_name || 'NULL'}`);
  console.log(`  Phone: ${lead.phone || 'NULL'}`);
  console.log(`  Permit Type: ${lead.permit_type || 'NULL'}`);
  console.log(`  Date Issued: ${lead.date_issued || 'NULL'}`);
  console.log(`  Cost: ${lead.construction_cost || 'NULL'}`);
  console.log(`  Raw Text: ${lead.raw_text}`);
});

db.close();
