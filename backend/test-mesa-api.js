const axios = require('axios');

const url = 'https://data.mesaaz.gov/resource/2gkz-7z4f.json';
const params = {
  '$where': "issued_date >= '2024-01-01T00:00:00'",
  '$order': 'issued_date DESC',
  '$limit': 2
};

console.log('Testing Mesa API...');
console.log('URL:', url);
console.log('Params:', params);

axios.get(url, { params })
  .then(res => {
    console.log('✅ Success! Got', res.data.length, 'records');
    if (res.data.length > 0) {
      console.log('\nFields available:', Object.keys(res.data[0]).join(', '));
      console.log('\nFirst record:');
      console.log(JSON.stringify(res.data[0], null, 2));
    }
  })
  .catch(err => {
    console.error('❌ Error:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    }
  });
