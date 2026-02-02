const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'shiiman-leads.db');
const db = new Database(dbPath);

console.log(`📝 Fixing Phoenix AI instructions to select correct options...\n`);

// Get Phoenix source
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

// Update with corrected explicit instructions - MUST say "done" not "extract"!
const updatedData = {
  ...currentData,
  aiInstructions: `YOUR TASK: Fill the form in Steps 1-5, then say "done" in Step 6. DO NOT extract!

STEP 1: Select "-ALL BUILDING PERMITS-"
- Action: fill
- Selector: #ddlPermitType
- Value: -ALL BUILDING PERMITS-

STEP 2: Select "007 - 10 OR MORE FAMILY UNITS"
- Action: fill
- Selector: #ddlStructureClass
- Value: 007 - 10 OR MORE FAMILY UNITS

STEP 3: Enter date
- Action: fill
- Selector: #txtStartDate
- Value: 02/10/2025

STEP 4: Click "Struct Class" radio
- Action: click
- Selector: #option4

STEP 5: Click "Create List" button
- Action: click
- Selector: #btnSearch

STEP 6: Say "done" - DO NOT EXTRACT!
- Action: done
- Reasoning: Clicked Create List button, form complete
- CRITICAL: Do NOT use "extract" action - system handles extraction automatically
- After "done", system will extract page 1, click Next (›), extract page 2, etc.`
};

// Update database
db.prepare(`
  UPDATE user_sources
  SET source_data = ?
  WHERE id = ?
`).run(JSON.stringify(updatedData), phoenix.id);

console.log(`✅ Updated Phoenix AI instructions (ID: ${phoenix.id})`);
console.log(`\nNew Instructions:\n`);
console.log(updatedData.aiInstructions);

db.close();
