const Database = require('better-sqlite3');
const axios = require('axios');
const fs = require('fs');

// Read sources
const sources = JSON.parse(fs.readFileSync('client-sources.json', 'utf8'));
const mesaSource = sources[0];

console.log('Testing Mesa source with fieldMappings...\n');
console.log('Source name:', mesaSource.name);
console.log('URL:', mesaSource.url);
console.log('Params:', JSON.stringify(mesaSource.params, null, 2));
console.log('Field Mappings:', JSON.stringify(mesaSource.fieldMappings, null, 2));

// Test API call
axios.get(mesaSource.url, { params: mesaSource.params })
  .then(res => {
    console.log('\n✅ API Success! Got', res.data.length, 'records');
    
    if (res.data.length > 0) {
      const firstRecord = res.data[0];
      console.log('\nFirst record raw data:');
      console.log(JSON.stringify(firstRecord, null, 2));
      
      console.log('\n--- Field Mapping Test ---');
      for (const [dbField, sourceField] of Object.entries(mesaSource.fieldMappings)) {
        const value = firstRecord[sourceField];
        console.log(`${dbField} ← ${sourceField}: ${value !== undefined ? value : 'NOT FOUND'}`);
      }
    }
  })
  .catch(err => {
    console.error('\n❌ API Error:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    }
  });
