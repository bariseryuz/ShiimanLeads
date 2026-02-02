const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'shiiman-leads.db'));

console.log('Updating source AI prompts for better navigation...\n');

// Update Tampa source with explicit Table click
const tampaSource = db.prepare('SELECT id, source_data FROM user_sources WHERE user_id = 1 AND id = 22').get();
if (tampaSource) {
  const tampaData = JSON.parse(tampaSource.source_data);
  tampaData.aiPrompt = 'Look at the top right of the page and click the "Table" button or "Table" icon to switch from map view to table view. Wait for the table to load. Then extract all construction permit data from the table including permit numbers, addresses, contractor details, and dates from all available pages';
  db.prepare('UPDATE user_sources SET source_data = ? WHERE id = 22').run(JSON.stringify(tampaData));
  console.log('✅ Updated Tampa source - now clicks Table button');
}

// Update Fort Lauderdale
const ftlSource = db.prepare('SELECT id, source_data FROM user_sources WHERE user_id = 1 AND id = 21').get();
if (ftlSource) {
  const ftlData = JSON.parse(ftlSource.source_data);
  ftlData.aiPrompt = 'Wait for the search results table to fully load. If you see a message about no results or an empty page, look for and click any "Search" or "Submit" button first. Then extract all project data from the results table including record numbers, addresses, project names, contractor information, status, and dates from all pages';
  db.prepare('UPDATE user_sources SET source_data = ? WHERE id = 21').run(JSON.stringify(ftlData));
  console.log('✅ Updated Fort Lauderdale source - handles empty pages');
}

db.close();
console.log('\n🎉 Sources updated! Refresh your browser and run scraping again.');
