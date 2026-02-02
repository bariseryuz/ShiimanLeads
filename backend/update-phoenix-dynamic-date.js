const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'shiiman-leads.db');
const db = new Database(dbPath);

console.log(`📝 Updating Phoenix to use dynamic date placeholder...\n`);

// Get Phoenix source
const phoenix = db.prepare(`
  SELECT id, user_id, source_data
  FROM user_sources
  WHERE json_extract(source_data, '$.name') = 'Phoenix Issued Permits'
`).get();

if (!phoenix) {
  console.log('❌ Phoenix source not found');
  process.exit(1);
}

const currentData = JSON.parse(phoenix.source_data);

// Update with dynamic date placeholder
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

STEP 3: Enter date (automatically calculated as 365 days ago)
- Action: fill
- Selector: #txtStartDate
- Value: {{DATE_365_DAYS_AGO}}

STEP 4: Click "Struct Class" radio
- Action: click
- Selector: #option4

STEP 5: Click "Create List" button
- Action: click
- Selector: #btnSearch

STEP 6: Say "done" (pagination will be handled automatically)
- Action: done
- Reasoning: Form filled, ready for extraction`
};

// Update in database
db.prepare(`
  UPDATE user_sources
  SET source_data = ?
  WHERE id = ?
`).run(JSON.stringify(updatedData), phoenix.id);

console.log(`✅ Updated Phoenix AI instructions (ID: ${phoenix.id})`);
console.log(`📅 Date will now be dynamically calculated as 365 days ago from today`);
console.log(`🔄 No more hardcoded dates!\n`);

db.close();
