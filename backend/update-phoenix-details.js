const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'shiiman-leads.db');
const db = new Database(dbPath);

console.log(`📝 Updating Phoenix source with complete details...\n`);

// Get current Phoenix source
const phoenix = db.prepare(`
  SELECT id, user_id, source_data
  FROM user_sources
  WHERE user_id = 1 AND json_extract(source_data, '$.name') = 'Phoenix Issued Permits'
`).get();

if (!phoenix) {
  console.log('❌ Phoenix source not found');
  process.exit(1);
}

const currentData = JSON.parse(phoenix.source_data);

// Update with complete details
const updatedData = {
  ...currentData,
  name: 'Phoenix Issued Permits',
  url: 'https://apps-secure.phoenix.gov/PDD/Search/IssuedPermit',
  useProxy: false,
  useAI: true,
  usePuppeteer: true,
  aiInstructions: `Step 1: Select "-ALL BUILDING PERMITS-" from the Permit Type dropdown (name="PermitType")
Step 2: Select "007 - 10 OR MORE FAMILY UNITS" from the Structure Class dropdown (name="StructureClass")
Step 3: Calculate the date 365 days ago from today and enter it in the Start Date field (name="txtStartDate") in format MM/DD/YYYY
Step 4: Click the radio button for "Struct Class" (value="Struct Class")
Step 5: Click the "Create List" button (input[value="Create List"])
Step 6: Wait for results table to load
Step 7: Extract all data from the table with 7 fields: number, type, valuation, contractor, contractor_phone, owner, description
Step 8: The system will automatically handle pagination by clicking Next and extracting each page`,
  fieldSchema: [
    { name: 'number', type: 'string' },
    { name: 'type', type: 'string' },
    { name: 'valuation', type: 'string' },
    { name: 'contractor', type: 'string' },
    { name: 'contractor_phone', type: 'string' },
    { name: 'owner', type: 'string' },
    { name: 'description', type: 'string' }
  ],
  includeKeywords: '',
  excludeKeywords: '',
  displayColumns: 'number, type, valuation, contractor, contractor_phone, owner, description'
};

// Update database
db.prepare(`
  UPDATE user_sources
  SET source_data = ?
  WHERE id = ?
`).run(JSON.stringify(updatedData), phoenix.id);

console.log(`✅ Updated Phoenix source (ID: ${phoenix.id})`);
console.log(`\nDetails:`);
console.log(`  Name: ${updatedData.name}`);
console.log(`  URL: ${updatedData.url}`);
console.log(`  Proxy: ${updatedData.useProxy ? 'YES' : 'NO'}`);
console.log(`  AI Enabled: ${updatedData.useAI ? 'YES' : 'NO'}`);
console.log(`  Puppeteer: ${updatedData.usePuppeteer ? 'YES' : 'NO'}`);
console.log(`  Fields: ${updatedData.fieldSchema.map(f => f.name).join(', ')}`);
console.log(`  Display: ${updatedData.displayColumns}`);
console.log(`\nAI Instructions:`);
console.log(updatedData.aiInstructions);

db.close();
