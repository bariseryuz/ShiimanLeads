# Viewing URL Configuration Guide

## How It Works

The system now supports **flexible viewing URLs** for all sources. When clients click "View" on a lead, they can see the original permit details on the official website.

## Configuration Options

### Option 1: View URL Template (Recommended)
Add a `viewUrlTemplate` field with placeholders:

```json
{
  "name": "Nashville Building Permits",
  "url": "https://services2.arcgis.com/.../FeatureServer/0/query",
  "viewUrlTemplate": "https://data.nashville.gov/datasets/2576bfb2d74f418b8ba8c4538e4f729f_0/explore?showTable=true&Permit_Number={permit_number}"
}
```

**Available placeholders:**
- `{permit_number}` - Replaced with the permit number
- `{address}` - Replaced with the property address
- `{Permit_Number}` - For ArcGIS fields (case-sensitive)

### Option 2: Public URL (Simple)
If all permits go to the same page:

```json
{
  "name": "Nashville Building Permits",
  "url": "https://services2.arcgis.com/.../FeatureServer/0/query",
  "publicUrl": "https://data.nashville.gov/datasets/2576bfb2d74f418b8ba8c4538e4f729f_0/explore?showTable=true"
}
```

### Option 3: No Config (Default)
If not specified, uses the source URL (API endpoint):

```json
{
  "name": "Nashville Building Permits",
  "url": "https://services2.arcgis.com/.../FeatureServer/0/query"
}
```
Result: clients see the API endpoint (not ideal)

## Example: Nashville

**Current Issue**: Nashville source points to visualization page (slow, times out)

**Solution**:
1. Change `url` to the fast API endpoint
2. Add `viewUrlTemplate` for clients to view permits

```json
{
  "name": "Nashville Building Permits",
  "url": "https://services2.arcgis.com/HdUhOrHbPq5yhfTh/arcgis/rest/services/Building_Permits_in_Davidson_County/FeatureServer/0/query",
  "type": "json",
  "method": "GET",
  "params": {
    "where": "Date_Issued >= CURRENT_TIMESTAMP - INTERVAL '7' DAY",
    "outFields": "*",
    "f": "json"
  },
  "viewUrlTemplate": "https://data.nashville.gov/datasets/2576bfb2d74f418b8ba8c4538e4f729f_0/explore?showTable=true"
}
```

**Benefits**:
- ✅ API scraping: ~1 second (vs 2-3 minutes timeout)
- ✅ All data fields: 27 columns populated
- ✅ Client links: Direct to Nashville open data portal
- ✅ Professional: No hardcoded city logic

## How to Update Your Source

1. Go to "My Sources" page
2. Edit your Nashville source
3. Change the URL to the API endpoint
4. Add `viewUrlTemplate` field (optional but recommended)
5. Save
6. Click "Scrape Now"

## For Other Cities

This works for ANY source:
- **Phoenix**: Add template with permit number
- **Austin**: Add template linking to their portal
- **Your Client's City**: Configure per client

No code changes needed - just configure the source!
