const Database = require('better-sqlite3');
const { DB_PATH } = require('./db-path.js');

const db = new Database(DB_PATH);

console.log(`📂 Updating Phoenix source with corrected AI instructions...\n`);

// Updated AI prompt with explicit instructions
const updatedAiPrompt = {
  instructions: `CRITICAL: Follow these EXACT steps IN ORDER. Do NOT skip any step.

STEP 1: Select Permit Type dropdown → Choose "ALL PERMITS" or "-ALL BUILDING PERMITS-"
- Find the "Permit Type" dropdown
- Click to open it
- Select "ALL PERMITS" or "-ALL BUILDING PERMITS-"
- Wait for selection

STEP 2: Select Structure Class dropdown → Choose "10 or More Family Units"
- Find the "Structure Class" dropdown
- Click to open it
- Select "10 or More Family Units"
- Wait for selection

STEP 3: Enter Start Date (365 days ago)
- Find the "Issue Date From" or "Start Date" field
- Calculate: Today is ${new Date().toLocaleDateString('en-US')} so enter ${new Date(Date.now() - 365*24*60*60*1000).toLocaleDateString('en-US')}
- Enter the date in MM/DD/YYYY format
- Leave "To" date empty

STEP 4: Sort By "Structure Class" (NOT Permit Number)
- Find the "Sort By" dropdown or checkbox
- Select "Structure Class" (DO NOT select Permit Number)
- Confirm selection

STEP 5: Click "Create a List" button (CRITICAL - MUST DO THIS)
- Find the "Create a List" button (NOT "Create File")
- Click it
- Wait 5-10 seconds for results page to fully load
- IMPORTANT: Without clicking this button, NO results will be visible

STEP 6: ONLY AFTER "Create a List" is clicked - Extract data
- Wait for results table to appear
- Extract ALL visible permits with these fields:
  * permit_number
  * permit_type
  * address
  * structure_class
  * contractor_name
  * contractor_phone
  * value
  * issue_date
  * owner_name
  * description

STEP 7: Handle pagination
- Check if there's a "Next" button or page numbers
- If yes, click Next and extract from next page
- Repeat until all pages are done

CRITICAL RULES:
✓ MUST sort by "Structure Class" (NOT Permit Number)
✓ MUST click "Create a List" button before extracting
✓ Do NOT click "Create File" 
✓ Wait for results page to load after clicking "Create a List"
✓ Only extract after results are visible`
};

// Get Phoenix source for user 1
const source = db.prepare(`
  SELECT id, source_data FROM user_sources 
  WHERE user_id = 1 AND json_extract(source_data, '$.name') = 'Phoenix Issued Permits'
`).get();

if (!source) {
  console.log('❌ Phoenix source not found');
  process.exit(1);
}

const sourceData = JSON.parse(source.source_data);
sourceData.aiPrompt = updatedAiPrompt;

// Update the source
db.prepare(`
  UPDATE user_sources 
  SET source_data = ?
  WHERE id = ?
`).run(JSON.stringify(sourceData), source.id);

console.log(`✅ Updated Phoenix source (ID: ${source.id})`);
console.log(`\n🤖 New AI Instructions:`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(updatedAiPrompt.instructions);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
console.log(`✅ Key fixes applied:`);
console.log(`   1. ✓ Sort by "Structure Class" (NOT Permit Number)`);
console.log(`   2. ✓ MUST click "Create a List" before extracting`);
console.log(`   3. ✓ Wait for results page to load`);
console.log(`   4. ✓ Only extract after results are visible\n`);
console.log(`Ready to test! Start server and click "Scrape Now" on Phoenix source.`);

db.close();
