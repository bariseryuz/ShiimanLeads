const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'shiiman-leads.db');
const db = new Database(dbPath);

console.log('📊 Checking Phoenix leads in database...\n');

const count = db.prepare(`
  SELECT COUNT(*) as total FROM source_25
`).get();

console.log(`Total Phoenix leads in source_25: ${count.total}\n`);

if (count.total > 0) {
  const recent = db.prepare(`
    SELECT * FROM source_25 ORDER BY id DESC LIMIT 5
  `).all();
  
  console.log('Latest 5 leads:\n');
  recent.forEach(lead => {
    console.log(`ID: ${lead.id}`);
    console.log(`Number: ${lead.number}`);
    console.log(`Type: ${lead.type}`);
    console.log(`Valuation: ${lead.valuation}`);
    console.log(`Contractor: ${lead.contractor}`);
    console.log(`Phone: ${lead.contractor_phone}`);
    console.log(`Owner: ${lead.owner}`);
    console.log(`Description: ${lead.description}`);
    console.log(`Source ID: ${lead._source_id}`);
    console.log('---\n');
  });
}

db.close();
