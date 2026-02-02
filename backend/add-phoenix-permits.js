const Database = require('better-sqlite3');
const db = new Database('shiiman-leads.db');

const phoenixSource = {
  name: "Phoenix Issued Permits",
  url: "https://apps-secure.phoenix.gov/PDD/Search/IssuedPermit",
  useAI: true,
  usePuppeteer: true,
  useProxy: false,  // Government site, better without proxy
  requireProxy: false,
  allowDirectConnection: true,
  aiPrompt: `Follow these exact steps in order:
1. Find and select "Permit Type" dropdown, select "ALL PERMITS"
2. Find and select "Structure Class" dropdown, select "10 or More Family Units"
3. Find the "Start Date" field, calculate date 365 days ago from today and enter it in MM/DD/YYYY format
4. Find the "Sort By" dropdown, select "Structure Class"
5. Click the "Create List" button (NOT "Create File")
6. Wait for the results page to load
7. Extract all permit data from the list showing permit number, address, contractor, value, and any other visible details
8. If there are multiple pages, click "Next" button and extract from each page
9. Mark as done when all pages are extracted`,
  fieldSchema: {
    "permit_number": "Permit/application number",
    "permit_type": "Type of permit",
    "address": "Property address",
    "structure_class": "Structure class (e.g., 10+ Family Units)",
    "contractor_name": "Contractor or builder name",
    "contractor_phone": "Contractor phone number",
    "value": "Project value",
    "issue_date": "Date permit was issued",
    "owner_name": "Property owner name",
    "description": "Project description or scope"
  }
};

try {
  // Check if Phoenix source already exists
  const existing = db.prepare(`
    SELECT id FROM user_sources 
    WHERE user_id = 1 AND source_data LIKE '%apps-secure.phoenix.gov%'
  `).get();

  if (existing) {
    console.log('⚠️  Phoenix source already exists (ID ' + existing.id + ')');
    console.log('Would you like to update it? Delete it first and run this script again.');
    db.close();
    process.exit(0);
  }

  // Insert new source
  const sourceData = JSON.stringify(phoenixSource);
  const result = db.prepare(`
    INSERT INTO user_sources (user_id, source_data, created_at)
    VALUES (?, ?, datetime('now'))
  `).run(1, sourceData);

  const newId = result.lastInsertRowid;

  console.log('✅ Phoenix Issued Permits source added successfully!');
  console.log('   Source ID:', newId);
  console.log('   URL:', phoenixSource.url);
  console.log('   AI Enabled: Yes');
  console.log('   Puppeteer: Yes');
  console.log('   Proxy: No (direct connection)');
  console.log('\n📋 Field Schema:');
  Object.entries(phoenixSource.fieldSchema).forEach(([field, desc]) => {
    console.log(`   - ${field}: ${desc}`);
  });

  console.log('\n🤖 AI Instructions:');
  console.log(phoenixSource.aiPrompt);

  console.log('\n✨ Ready to scrape! Go to "My Sources" and click "Scrape Now"');

  db.close();
} catch (error) {
  console.error('❌ Error:', error.message);
  db.close();
  process.exit(1);
}
