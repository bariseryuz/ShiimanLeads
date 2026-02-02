const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'shiiman-leads.db'));

const sources = [
  {
    name: 'Phoenix - Multi-Family Permits',
    url: 'https://apps-secure.phoenix.gov/PDD/Search/IssuedPermit',
    aiPrompt: 'Fill out the permit search form: 1) Select "ALL PERMITS" for Permit Type, 2) Select "10 or More Family Units" for Structure Class, 3) Set Start date to 365 days ago from today, 4) Click Search, 5) Sort results by Structure Class, 6) Click "Create List" to show all results, 7) Extract permit data from all pages including permit number, address, contractor information, and project value',
    fieldSchema: {
      permit_number: { required: true },
      address: { required: true },
      contractor_name: { required: false },
      contractor_phone: { required: false },
      value: { required: false },
      date_issued: { required: false },
      structure_class: { required: false }
    }
  },
  {
    name: 'Nashville - Multi-Family Permits',
    url: 'https://data.nashville.gov/datasets/2576bfb2d74f418b8ba8c4538e4f729f_0/explore?filters=eyJQZXJtaXRfVHlwZV9EZXNjcmlwdGlvbiI6WyJCdWlsZGluZyBSZXNpZGVudGlhbCAtIE5ldyJdLCJQZXJtaXRfU3VidHlwZV9EZXNjcmlwdGlvbiI6WyJNdWx0aWZhbWlseSwgVHJpLVBsZXgsIFF1YWQsIEFwYXJ0bWVudHMiLCJNdWx0aWZhbWlseSwgVG93bmhvbWUiXSwiRGF0ZV9FbnRlcmVkIjpbMTUwMTY1MDAwMDAwMCwxNzY0ODI4MDAwMDAwXSwiRGF0ZV9Jc3N1ZWQiOlsxNjcwMjIwMDAwMDAwLDE3NjUwODcyMDAwMDBdLCJDb25zdF9Db3N0IjpbMCwyMjYwNjg3NTldfQ%3D%3D&location=36.213201%2C-86.071734%2C8.14&showTable=true',
    aiPrompt: 'The filters are already applied in the URL. Click to open or show the data table if needed, then extract all multi-family building permit information from all pages including permit numbers, addresses, contractor details, construction costs, and dates',
    fieldSchema: {
      permit_number: { required: true },
      address: { required: true },
      contractor_name: { required: false },
      value: { required: false },
      date_issued: { required: false },
      permit_type: { required: false }
    }
  },
  {
    name: 'Scottsdale - Building Permits',
    url: 'https://eservices.scottsdaleaz.gov/bldgresources/BuildingPermit/reports#',
    aiPrompt: 'Find and fill out the building permit search form with: Issue Date from 01/01/2024 to today, Permit Type: All, Structure Type: Multi-Family or Apartments (10+ units). Click Search or Submit. Then extract all permit data from the results including permit numbers, addresses, contractor information, and project values from all pages',
    fieldSchema: {
      permit_number: { required: true },
      address: { required: true },
      contractor_name: { required: false },
      contractor_phone: { required: false },
      value: { required: false },
      date_issued: { required: false }
    }
  },
  {
    name: 'Mesa - Building Permits',
    url: 'https://data.mesaaz.gov/Development-Services/Building-Permits-RETIRED-/2gkz-7z4f/data_preview',
    aiPrompt: 'Apply filters to the data table: 1) Set Issue Date filter to 01/01/2024 or later, 2) Sort by Unit # column to filter out non-multifamily projects, 3) Extract all building permit data from the filtered results including permit numbers, addresses, contractor details, unit counts, and values from all pages',
    fieldSchema: {
      permit_number: { required: true },
      address: { required: true },
      contractor_name: { required: false },
      units: { required: false },
      value: { required: false },
      date_issued: { required: false }
    }
  },
  {
    name: 'Miami-Dade - Building Permits',
    url: 'https://gis-mdc.opendata.arcgis.com/datasets/MDC::building-permits-issued-by-miami-dade-county-2-previous-years-to-present/explore?filters=eyJBcHBsaWNhdGlvbkRhdGUiOlsxNjQyMTg1NDkxOTc5LjIzLDE3NjUwODM2MDAwMDBdLCJBcHBsaWNhdGlvblR5cGVDb2RlIjpbMSw0MF0sIlBlcm1pdFR5cGUiOlsiQkxERyJdLCJBcHBsaWNhdGlvblR5cGVEZXNjcmlwdGlvbiI6WyJORVciXSwiUHJvcG9zZWRVc2VDb2RlIjpbMjIwLDQwMDNdLCJQcm9wb3NlZFVzZURlc2NyaXB0aW9uIjpbIjUgVU5JVFMgT1IgTU9SRSAgLSBSRVNJREVOVElBTCJdLCJDb250cmFjdG9yQ2l0eSI6WyJNSUFNSSJdfQ%3D%3D',
    aiPrompt: 'Filters are pre-applied for multi-family residential permits (5+ units) in Miami. Open or show the data table, then extract all building permit information from all pages including permit numbers, addresses, contractor details, proposed use, application dates, and project details',
    fieldSchema: {
      permit_number: { required: true },
      address: { required: true },
      contractor_name: { required: false },
      contractor_city: { required: false },
      proposed_use: { required: false },
      application_date: { required: false }
    }
  },
  {
    name: 'Fort Lauderdale - New Multi Construction',
    url: 'https://aca-prod.accela.com/FTL/Cap/GlobalSearchResults.aspx?isNewQuery=yes&QueryText=new%20construction%20Multi',
    aiPrompt: 'The search is already performed for "new construction Multi". Extract all project data from the results table including record numbers, addresses, project names, contractor information, status, and dates from all pages',
    fieldSchema: {
      permit_number: { required: true },
      address: { required: true },
      project_name: { required: false },
      contractor_name: { required: false },
      status: { required: false },
      date_issued: { required: false }
    }
  },
  {
    name: 'Tampa - Construction Inspections',
    url: 'https://experience.arcgis.com/experience/25641c3e2dab4eff803ed286bef11bf8/#data_s=id%3AdataSource_1-ConstructionInspections_863%3A193',
    aiPrompt: 'This is an ArcGIS Experience with construction inspection data. Find and open the data table view, then extract all construction permit and inspection records including permit numbers, addresses, contractor details, project types, and inspection dates from all available pages',
    fieldSchema: {
      permit_number: { required: true },
      address: { required: true },
      contractor_name: { required: false },
      project_type: { required: false },
      inspection_date: { required: false }
    }
  }
];

console.log('🚀 Adding 7 multi-family permit sources to admin profile...\n');

try {
  const userId = 1; // Admin user
  
  sources.forEach((source, index) => {
    const sourceData = {
      name: source.name,
      url: source.url,
      type: 'html',
      usePuppeteer: true,
      useAI: true,
      aiPrompt: source.aiPrompt,
      fieldSchema: source.fieldSchema,
      useProxy: true,
      schedule: '0 */8 * * *'
    };
    
    const stmt = db.prepare('INSERT INTO user_sources (user_id, source_data, created_at) VALUES (?, ?, ?)');
    const result = stmt.run(userId, JSON.stringify(sourceData), new Date().toISOString());
    
    console.log(`✅ Added source ${index + 1}/${sources.length}: ${source.name} (ID: ${result.lastInsertRowid})`);
  });
  
  console.log('\n🎉 All 7 sources added successfully!');
  console.log('📱 Go to "My Sources" in the web interface to see them');
  console.log('▶️  Click "Scrape Now" to start extracting leads');
  console.log('\n💡 Each source uses AI autonomous navigation - no manual configuration needed!');
  
} catch (error) {
  console.error('❌ Error:', error.message);
  process.exit(1);
}

db.close();
