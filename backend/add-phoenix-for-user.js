const Database = require('better-sqlite3');
const { DB_PATH } = require('./db-path.js');

const db = new Database(DB_PATH);

console.log(`📂 Using database: ${DB_PATH}\n`);

// Get user ID 1 (admin)
const user = db.prepare('SELECT id, username FROM users WHERE id = 1').get();
if (!user) {
  console.log('❌ User with ID 1 not found');
  process.exit(1);
}

console.log(`✅ Adding Phoenix source for user: ${user.username} (ID: ${user.id})\n`);

// Check if Phoenix source already exists for this user
const existing = db.prepare(`
  SELECT id, source_data FROM user_sources 
  WHERE user_id = ? AND json_extract(source_data, '$.name') = 'Phoenix Issued Permits'
`).get(user.id);

if (existing) {
  console.log(`✅ Phoenix source already exists (ID: ${existing.id})`);
  const data = JSON.parse(existing.source_data);
  console.log(`📍 URL: ${data.url}`);
  console.log(`🔧 Method: ${data.method}`);
  console.log(`🤖 AI Enabled: ${data.useAI ? 'YES' : 'NO'}`);
  console.log(`🌐 Proxy: ${data.useProxy ? 'YES' : 'NO'}`);
  process.exit(0);
}

// Phoenix source configuration
const phoenixSource = {
  name: 'Phoenix Issued Permits',
  url: 'https://apps-secure.phoenix.gov/PDD/Search/IssuedPermit',
  method: 'puppeteer',
  fieldSchema: [
    { name: 'permit_number', type: 'string' },
    { name: 'permit_type', type: 'string' },
    { name: 'address', type: 'string' },
    { name: 'structure_class', type: 'string' },
    { name: 'contractor_name', type: 'string' },
    { name: 'contractor_phone', type: 'string' },
    { name: 'value', type: 'string' },
    { name: 'issue_date', type: 'string' },
    { name: 'owner_name', type: 'string' },
    { name: 'description', type: 'string' }
  ],
  category: 'real-estate',
  useAI: true,
  aiPrompt: {
    instructions: `Follow these exact steps in order:
1. Find and select "Permit Type" dropdown, select "ALL PERMITS"
2. Find and select "Structure Class" dropdown, select "10 or More Family Units"
3. Find the "Start Date" field, calculate date 365 days ago from today and enter it in MM/DD/YYYY format
4. Find the "Sort By" dropdown, select "Structure Class"
5. Click the "Create List" button (NOT "Create File")
6. Wait for the results page to load
7. Extract all permit data from the list showing permit number, address, contractor, value, and any other visible details
8. If there are multiple pages, click "Next" button and extract from each page
9. Mark as done when all pages are extracted`
  },
  useProxy: false,
  requireProxy: false,
  aiDynamicNav: true
};

// Insert the source
const result = db.prepare(`
  INSERT INTO user_sources (user_id, source_data, created_at) 
  VALUES (?, ?, ?)
`).run(
  user.id,
  JSON.stringify(phoenixSource),
  new Date().toISOString()
);

console.log(`✅ Added Phoenix Issued Permits (ID: ${result.lastInsertRowid})`);
console.log(`📋 10 fields configured: permit_number, permit_type, address, structure_class, contractor_name, contractor_phone, value, issue_date, owner_name, description`);
console.log(`🤖 AI Dynamic Navigation: ENABLED`);
console.log(`🌐 Proxy: DISABLED (direct connection)`);
console.log(``);
console.log(`Next steps:`);
console.log(`1. Go to dashboard (client-portal.html)`);
console.log(`2. Click "Scrape Now" on Phoenix source`);
console.log(`3. Watch AI complete the 5-step form workflow`);
console.log(`4. Verify all data fields are extracted`);

db.close();
