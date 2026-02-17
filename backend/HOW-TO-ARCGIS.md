# How to Scrape ArcGIS Hub Datasets

## Problem
ArcGIS Hub pages (like `data.nashville.gov/datasets/...`) are web interfaces, not APIs. The scraper needs the direct API endpoint.

## Solution: Convert Hub URL to API Endpoint

### Step 1: Find the Dataset ID
From your Hub URL:
```
https://data.nashville.gov/datasets/2576bfb2d74f418b8ba8c4538e4f729f_0/explore
```

The dataset ID is: **`2576bfb2d74f418b8ba8c4538e4f729f_0`**

### Step 2: Build the API Endpoint
ArcGIS uses FeatureServer REST APIs. The standard format is:
```
https://maps.nashville.gov/arcgis/rest/services/[ServiceName]/FeatureServer/[LayerNumber]/query
```

For Nashville permits, the API endpoint is:
```
https://maps.nashville.gov/arcgis/rest/services/PermitsPublic/MapServer/0/query
```

### Step 3: Add Query Parameters
ArcGIS APIs require specific parameters:

| Parameter | Value | Description |
|-----------|-------|-------------|
| `where` | `1=1` | Get all records (or add filters) |
| `outFields` | `*` | Return all fields |
| `f` | `json` | Response format |
| `resultRecordCount` | `1000` | Max records per request |

**Example with filters** (Building Residential - New, Multifamily):
```
https://maps.nashville.gov/arcgis/rest/services/PermitsPublic/MapServer/0/query?where=Permit_Type_Description='Building Residential - New' AND Permit_Subtype_Description IN ('Multifamily, Tri-Plex, Quad, Apartments', 'Multifamily, Townhome')&outFields=*&f=json&resultRecordCount=1000
```

## How to Add in Shiiman Leads

### 1. Add Source
- **Name**: Nashville Building Permits - Multifamily
- **URL**: `https://maps.nashville.gov/arcgis/rest/services/PermitsPublic/MapServer/0/query`
- **Type**: JSON API
- **Method**: GET

### 2. Add Parameters (in UI or JSON)
Click "Add Parameters" and enter:

```json
{
  "where": "Permit_Type_Description='Building Residential - New' AND Permit_Subtype_Description IN ('Multifamily, Tri-Plex, Quad, Apartments', 'Multifamily, Townhome')",
  "outFields": "*",
  "f": "json",
  "resultRecordCount": 1000
}
```

### 3. Field Schema (Optional)
If you only want specific fields, map them:

```json
{
  "permit_number": "Permit_Num",
  "permit_type": "Permit_Type_Description",
  "address": "Prop_Address",
  "contractor": "Contractor_Name",
  "phone": "Contractor_Phone",
  "date_issued": "Date_Issued",
  "project_cost": "Const_Cost"
}
```

## Common ArcGIS Patterns

### Find the Service URL
1. Open browser DevTools (F12)
2. Go to Network tab
3. Load the Hub page
4. Filter by "query" or "FeatureServer"
5. Look for requests to `/query?` endpoints
6. Copy the base URL (before `/query`)

### Date Filters
ArcGIS uses Unix timestamps (milliseconds):
```
Date_Issued >= 1672531200000 AND Date_Issued <= 1704067200000
```

Or SQL date format:
```
Date_Issued >= DATE '2024-01-01' AND Date_Issued <= DATE '2024-12-31'
```

### Pagination
If you have more than 1000 records, you need to paginate:
- Add `resultOffset` parameter
- Increment by `resultRecordCount` each request
- Continue until no more records returned

Example:
```
First request:  resultOffset=0&resultRecordCount=1000
Second request: resultOffset=1000&resultRecordCount=1000
Third request:  resultOffset=2000&resultRecordCount=1000
```

## Quick Test
Test your API endpoint in a browser:
```
https://maps.nashville.gov/arcgis/rest/services/PermitsPublic/MapServer/0/query?where=1=1&outFields=*&f=json&resultRecordCount=10
```

You should see JSON like:
```json
{
  "features": [
    {
      "attributes": {
        "Permit_Num": "2024-123456",
        "Permit_Type_Description": "Building Residential - New",
        "Prop_Address": "123 Main St",
        ...
      }
    }
  ]
}
```

## Troubleshooting

### Error: "Invalid Parameters"
- Check your `where` clause syntax
- Use single quotes for strings: `'value'`
- Use `AND`, `OR`, `IN` for multiple conditions

### Error: "Token Required" or 401
- The service requires authentication
- Add API token to headers:
  ```json
  {
    "Authorization": "Bearer YOUR_TOKEN"
  }
  ```

### No Results
- Test without `where` clause first: `where=1=1`
- Check field names are correct (case-sensitive)
- Verify layer number is correct (try 0, 1, 2...)

### Slow Performance
- Reduce `resultRecordCount` (try 500 or 100)
- Add date filters to limit results
- Use specific field names instead of `*`

## Nashville Permit Services Quick Reference

| Service | URL |
|---------|-----|
| Building Permits | `https://maps.nashville.gov/arcgis/rest/services/PermitsPublic/MapServer/0/query` |
| Trade Permits | `https://maps.nashville.gov/arcgis/rest/services/PermitsPublic/MapServer/1/query` |

Test these URLs by adding `?f=json&where=1=1&resultRecordCount=1` to see if they work.
