const Database = require('better-sqlite3');
const db = new Database('data/leads.db');

const source = db.prepare('SELECT id, source_data FROM user_sources WHERE user_id = 5 AND source_data LIKE ?').get('%Nasville%');
const data = JSON.parse(source.source_data);

// Update WHERE clause to filter for multifamily residential new construction
data.params.where = "Permit_Type_Description='Building Residential - New' AND (Permit_Subtype_Description='Multifamily, Tri-Plex, Quad, Apartments' OR Permit_Subtype_Description='Multifamily, Townhome')";

db.prepare('UPDATE user_sources SET source_data = ? WHERE id = ?').run(JSON.stringify(data), source.id);

console.log('✅ Updated Nashville source with multifamily filters');
console.log('New WHERE clause:', data.params.where);
console.log('\nNow when you scrape Nashville, it will ONLY get:');
console.log('- Building Residential - New');
console.log('- Multifamily, Tri-Plex, Quad, Apartments OR Townhomes');
