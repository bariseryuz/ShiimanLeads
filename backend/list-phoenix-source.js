const Database = require('better-sqlite3');
const { DB_PATH } = require('./db-path.js');

const db = new Database(DB_PATH);

console.log(`📂 Using database: ${DB_PATH}\n`);

const phoenix = db.prepare(`
  SELECT 
    id,
    name,
    url,
    method,
    category,
    useAI,
    useProxy,
    requireProxy,
    aiDynamicNav,
    fieldSchema,
    aiPrompt
  FROM sources 
  WHERE name LIKE '%Phoenix%'
`).all();

if (phoenix.length === 0) {
  console.log('❌ No Phoenix source found');
  process.exit(1);
}

phoenix.forEach(source => {
  console.log(`✅ Phoenix Issued Permits (ID: ${source.id})`);
  console.log(`📍 URL: ${source.url}`);
  console.log(`🔧 Method: ${source.method}`);
  console.log(`🏷️  Category: ${source.category}`);
  console.log(`🤖 AI Enabled: ${source.useAI ? 'YES' : 'NO'}`);
  console.log(`🤖 AI Dynamic Nav: ${source.aiDynamicNav ? 'YES' : 'NO'}`);
  console.log(`🌐 Proxy: ${source.useProxy ? 'YES' : 'NO'}`);
  console.log(`🌐 Require Proxy: ${source.requireProxy ? 'YES' : 'NO'}`);
  console.log(``);
  
  const schema = JSON.parse(source.fieldSchema);
  console.log(`📋 Field Schema (${schema.length} fields):`);
  schema.forEach(field => {
    console.log(`   - ${field.name} (${field.type})`);
  });
  console.log(``);
  
  const aiPrompt = JSON.parse(source.aiPrompt);
  console.log(`🤖 AI Instructions:`);
  console.log(aiPrompt.instructions);
});

db.close();
