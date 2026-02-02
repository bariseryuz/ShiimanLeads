const Database = require('better-sqlite3');
const path = require('path');
const dbPathUtil = require('./db-path.js');

const dbPath = dbPathUtil.getDbPath();
const db = new Database(dbPath);

console.log(`📂 Using database: ${dbPath}`);

// Check if Phoenix source already exists
const existing = db.prepare(`
  SELECT id, name FROM sources WHERE name = 'Phoenix Issued Permits'
`).get();

if (existing) {
  console.log(`✅ Phoenix source already exists with ID ${existing.id}`);
  process.exit(0);
}

// Add Phoenix Issued Permits source
const result = db.prepare(`
  INSERT INTO sources (
    name,
    url,
    method,
    fieldSchema,
    category,
    useAI,
    aiPrompt,
    useProxy,
    requireProxy,
    aiDynamicNav
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'Phoenix Issued Permits',
  'https://apps-secure.phoenix.gov/PDD/Search/IssuedPermit',
  'puppeteer',
  JSON.stringify([
    { "name": "permit_number", "type": "string" },
    { "name": "permit_type", "type": "string" },
    { "name": "address", "type": "string" },
    { "name": "structure_class", "type": "string" },
    { "name": "contractor_name", "type": "string" },
    { "name": "contractor_phone", "type": "string" },
    { "name": "value", "type": "string" },
    { "name": "issue_date", "type": "string" },
    { "name": "owner_name", "type": "string" },
    { "name": "description", "type": "string" }
  ]),
  'real-estate',
  1, // useAI = true
  JSON.stringify({
    instructions: `CRITICAL: Follow these exact steps IN ORDER. Do NOT skip any step.

STEP 1: Select "ALL PERMITS" from the Permit Type dropdown
- Locate the "Permit Type" dropdown
- Click to open it
- Select "ALL PERMITS" option
- Wait for selection to register

STEP 2: Select "10 or More Family Units" from Structure Class dropdown
- Locate the "Structure Class" dropdown
- Click to open it
- Select "10 or More Family Units" option
- Wait for selection to register

STEP 3: Calculate and enter date from 365 days ago
- Find the "Issue Date From" date field
- Calculate today's date minus 365 days
- Enter that date in MM/DD/YYYY format
- Leave "Issue Date To" empty (defaults to today)

STEP 4: Click "Sort by Structure Class" checkbox or button
- Find the sort option for Structure Class
- Enable sorting by Structure Class
- Confirm selection

STEP 5: Click "Create List" button (NOT "Create File")
- Look for "Create List" button
- Click it to generate results
- Wait for results page to load completely

STEP 6: Extract data from the results table
- Once the results page loads, extract all visible permits
- Get ALL 10 fields for each permit
- Format as JSON array of objects

STEP 7: Handle pagination
- If there's a "Next" button or page number, click it
- Extract data from the new page
- Continue until no more pages

IMPORTANT:
- You MUST complete steps 1-5 before attempting to extract data
- Do NOT click "Create File" - only click "Create List"
- The system limits searches to 1 year maximum
- Make sure ALL dropdowns are selected before clicking Create List
- Extract ALL 10 fields: permit_number, permit_type, address, structure_class, contractor_name, contractor_phone, value, issue_date, owner_name, description`
  }),
  0, // useProxy = false (government site works better direct)
  0, // requireProxy = false
  1  // aiDynamicNav = true
);

console.log(`✅ Added Phoenix Issued Permits source with ID ${result.lastInsertRowid}`);
console.log(`📋 Field Schema: 10 fields configured`);
console.log(`🤖 AI Dynamic Navigation: ENABLED`);
console.log(`🌐 Proxy: DISABLED (direct connection)`);
console.log(``);
console.log(`Next steps:`);
console.log(`1. Assign this source to a user via the dashboard`);
console.log(`2. Click "Scrape Now" to test the 5-step workflow`);
console.log(`3. Verify AI completes all steps before extracting`);
console.log(`4. Check that pagination is handled correctly`);

db.close();
