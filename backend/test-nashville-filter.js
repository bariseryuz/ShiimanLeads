const axios = require('axios');

(async () => {
  const url = 'https://services2.arcgis.com/HdTo6HJqh92wn4D8/arcgis/rest/services/Building_Permits_Issued_2/FeatureServer/0/query';
  
  const params = {
    where: "Permit_Type_Description='Building Residential - New' AND (Permit_Subtype_Description='Multifamily, Tri-Plex, Quad, Apartments' OR Permit_Subtype_Description='Multifamily, Townhome')",
    outFields: '*',
    f: 'json',
    resultRecordCount: 3
  };
  
  const res = await axios.get(url, { params });
  
  console.log('✅ Filtered API Test Results');
  console.log('Total records found:', res.data.features.length);
  console.log('');
  
  res.data.features.forEach((f, i) => {
    const a = f.attributes;
    console.log(`=== RECORD ${i + 1} ===`);
    console.log('Permit:', a.Permit__);
    console.log('Type:', a.Permit_Type_Description);
    console.log('Subtype:', a.Permit_Subtype_Description);
    console.log('Address:', a.Address);
    console.log('City:', a.City);
    console.log('Cost:', a.Const_Cost);
    console.log('Contractor:', a.Contact);
    console.log('');
  });
})();
