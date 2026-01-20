# Data Source Setup Essentials - Critical Checklist

## 🎯 The Most Important Things When Setting Up a New Source

### 1. **Identify the Correct Data Source (API vs Webpage)**

#### ✅ BEST: Direct API Endpoint
**Why:** Fast (1-3 seconds), reliable, structured data, all fields available

**How to Find:**
1. Open browser Developer Tools (F12)
2. Go to "Network" tab
3. Visit the permit search page
4. Look for XHR/Fetch requests ending in:
   - `/query` (ArcGIS)
   - `.json` (Socrata/Open Data)
   - `/api/` (custom APIs)
   - `/search`, `/data`, etc.

**Example - Nashville:**
- ❌ BAD: `https://data.nashville.gov/datasets/...` (slow webpage, 2-3 min timeout)
- ✅ GOOD: `https://services2.arcgis.com/.../FeatureServer/0/query` (1 sec, all data)

#### ⚠️ FALLBACK: Webpage Scraping
**When:** No API available
**Method:** Use Puppeteer (for JavaScript-rendered pages)
**Warning:** Slower, less reliable, may break if page changes

---

### 2. **Get the Right Data Fields (Field Mapping)**

#### Critical Fields to Map:
```json
{
  "fieldMappings": {
    "permit_number": "Permit__",           // REQUIRED - Unique identifier
    "address": "Address",                  // REQUIRED - Property location
    "date_issued": "Date_Issued",          // REQUIRED - For deduplication
    "value": "Const_Cost",                 // Construction cost/value
    "description": "Permit_Type_Description", // What kind of permit
    "contractor_name": "Contact",          // Who's doing the work
    "phone": "Phone",                      // Contact info (if available)
    "city": "City",
    "state": "State",
    "zip_code": "ZIP"
  }
}
```

#### How to Find Field Names:
1. Look at the API response in Network tab
2. Click on the request → Preview/Response
3. Find the actual field names in the JSON

**Example - Nashville Fields:**
```json
{
  "Permit__": "2025087351",              // ← This is permit_number
  "Address": "3312 CONVISER DR",         // ← This is address
  "Date_Issued": 1736913600000,          // ← This is date_issued (timestamp)
  "Const_Cost": 0,                       // ← This is value
  "Permit_Type_Description": "Building..." // ← This is description
}
```

---

### 3. **Set Up the Correct View URL**

#### Problem: "View" Button Must Show Real Permit Details
When clients click "View" on a lead, they should see the ACTUAL permit on the city's website, not the API endpoint.

#### Solution: Add `viewUrlTemplate`

```json
{
  "name": "Nashville Building Permits",
  "url": "https://services2.arcgis.com/.../query",  // ← API for scraping
  "viewUrlTemplate": "https://data.nashville.gov/datasets/.../explore?showTable=true&Permit_Number={permit_number}"
}
```

#### Available Placeholders:
- `{permit_number}` - Replaced with actual permit number
- `{address}` - Replaced with property address
- `{Permit__}` - For ArcGIS field names (case-sensitive)

#### How to Find the View URL:
1. Go to the city's permit search page manually
2. Search for a specific permit
3. Copy the URL format
4. Replace the actual permit number with `{permit_number}`

**Example URLs:**
- Nashville: `https://data.nashville.gov/datasets/2576bfb2d74f418b8ba8c4538e4f729f_0/explore?showTable=true&Permit_Number={permit_number}`
- Phoenix: `https://apps-secure.phoenix.gov/PDD/Permit/{permit_number}`
- Generic: `https://city.gov/permits?id={permit_number}`

#### Fallback Options:
```json
{
  "publicUrl": "https://city.gov/permits"  // ← All permits go to same page
}
```
or
```json
{
  // No viewUrlTemplate → uses API endpoint (not ideal but works)
}
```

---

### 4. **Filter the Data to Get Only What You Want**

#### Use API Filters (Preferred)
```json
{
  "params": {
    "where": "Permit_Type_Description='Building Residential - New' AND Permit_Subtype_Description='Multifamily'",
    "orderByFields": "Date_Issued DESC",
    "resultRecordCount": 5000
  }
}
```

#### Date Filters (Critical!)
```json
// ArcGIS:
"where": "Date_Issued >= CURRENT_TIMESTAMP - INTERVAL '7' DAY"

// Socrata:
"$where": "issued_date >= '2024-01-01'"

// Phoenix:
"StartDate": "1/18/2025",
"EndDate": "1/18/2026"
```

#### Text Filters (Fallback)
```json
{
  "includeWords": ["multifamily", "apartment", "residential"],
  "excludeWords": ["demolition", "repair", "fence"]
}
```

---

### 5. **Verify the Data is Correct**

#### Step 1: Test the API Directly
1. Copy the API URL from your source config
2. Add the params to the URL
3. Open in browser
4. Check if you get JSON data back

**Example:**
```
https://services2.arcgis.com/HdTo6HJqh92wn4D8/arcgis/rest/services/Building_Permits_Issued_2/FeatureServer/0/query?where=Date_Issued>=CURRENT_TIMESTAMP-INTERVAL'7'DAY&outFields=*&f=json&resultRecordCount=5000
```

#### Step 2: Check Field Names Match
Look at the JSON response:
```json
{
  "features": [
    {
      "attributes": {
        "Permit__": "2025087351",    // ← Does this match your fieldMappings?
        "Address": "123 Main St",
        "Date_Issued": 1736913600000
      }
    }
  ]
}
```

#### Step 3: Run a Test Scrape
1. Save your source
2. Click "Scrape Now"
3. Check the logs in terminal
4. Look for:
   - "Found X records"
   - "Inserted Y new leads"
   - Any errors

#### Step 4: Verify in Dashboard
1. Go to Dashboard
2. Check if leads appear
3. Verify all fields are populated:
   - ✅ Permit number
   - ✅ Address
   - ✅ Date Issued (formatted properly)
   - ✅ Value
   - ✅ Description
4. **Click "View" button** - Does it go to the right page?

---

## 🚨 Common Issues and Fixes

### Issue 1: "Invalid Date" in Dashboard
**Problem:** API returns timestamps (1736913600000) instead of dates
**Solution:** Date parsing is already implemented in backend
**Verify:** 
```bash
node -e "const Database = require('better-sqlite3'); const db = new Database('./data/leads.db'); const rows = db.prepare('SELECT permit_number, date_issued FROM leads LIMIT 5').all(); console.log(rows);"
```
Should show: `date_issued: "2026-01-15"` (not numbers)

### Issue 2: "View" Button Goes to Wrong Page
**Problem:** No `viewUrlTemplate` configured
**Solution:** Add to source config:
```json
{
  "viewUrlTemplate": "https://city.gov/permit/{permit_number}"
}
```

### Issue 3: No Data Scraped
**Checklist:**
- [ ] Is the API URL correct?
- [ ] Do the params work when tested in browser?
- [ ] Is `jsonPath` correct? (e.g., `features[*].attributes`)
- [ ] Are field names spelled exactly right (case-sensitive)?
- [ ] Does the API require authentication?

### Issue 4: Wrong Data Pulled
**Check:**
- Filter settings in `params`
- `includeWords` / `excludeWords`
- Date range is correct
- Permit type filter matches what you want

### Issue 5: Timeout/Slow Scraping
**Problem:** Using webpage URL instead of API
**Solution:** 
1. Find the API endpoint in Network tab
2. Update source URL to API
3. Change type to "json"

---

## 📋 Step-by-Step Checklist for New Source

### Before Adding:
- [ ] Find the API endpoint (not webpage)
- [ ] Test API in browser - does it return JSON?
- [ ] Identify all field names in the JSON
- [ ] Find the permit detail page URL format
- [ ] Determine what filters you need

### When Configuring:
- [ ] Set correct `url` (API endpoint)
- [ ] Set `type` to "json"
- [ ] Set `method` (GET or POST)
- [ ] Configure `params` with filters
- [ ] Set `jsonPath` (e.g., `features[*].attributes`)
- [ ] Map all `fieldMappings` correctly
- [ ] Add `viewUrlTemplate` with placeholders
- [ ] Set date filters to get recent data only

### After Adding:
- [ ] Click "Scrape Now"
- [ ] Check terminal logs for errors
- [ ] Verify leads appear in dashboard
- [ ] Check all fields are populated
- [ ] **Test "View" button** - goes to right page?
- [ ] Verify dates are formatted (not "Invalid Date")
- [ ] Check for duplicates
- [ ] Confirm filters are working

---

## 🎓 Source Type Decision Tree

```
Do they have an API?
├─ YES → Use JSON method
│   ├─ Is it ArcGIS (.../FeatureServer/...)?
│   │   ├─ YES → Set jsonPath: "features[*].attributes"
│   │   └─ NO → Check response format
│   │       ├─ Array at root → jsonPath: null
│   │       └─ Nested → jsonPath: "data[*]" or "results[*]"
│   └─ Add fieldMappings, viewUrlTemplate
│
└─ NO API → Use Puppeteer
    ├─ Set usePuppeteer: true
    ├─ Add waitSelector
    ├─ Define cssSelectors for each field
    └─ Add viewUrlTemplate (usually same as scrape URL)
```

---

## 🔧 Your Current Sources Status

### ✅ Nashville (Nasville)
- **Status:** Working, but needs viewUrlTemplate
- **Issue:** API returns timestamps - FIXED ✓
- **Todo:** Add `viewUrlTemplate` so "View" goes to Nashville portal

### ✅ Mesa AZ
- **Status:** API-based, clean
- **Todo:** Add `viewUrlTemplate`

### ⚠️ Lauder Build (Fort Lauderdale)
- **Status:** Puppeteer scraping (slower)
- **Issue:** Might need login
- **Todo:** Verify cssSelectors work, add viewUrlTemplate

### ✅ Phoenix AZ
- **Status:** API-based, well configured
- **Todo:** Add `viewUrlTemplate`

---

## 📞 Testing Your Sources Right Now

Want me to:
1. Add `viewUrlTemplate` to all your sources?
2. Test each source to verify data is correct?
3. Check if "View" buttons work properly?
4. Look for any other issues?

Let me know what you want to tackle first!
