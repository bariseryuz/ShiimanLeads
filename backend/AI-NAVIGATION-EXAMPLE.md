# AI Autonomous Navigation - Configuration Guide

## Overview
Instead of manually configuring selectors and actions, you can now use AI to automatically navigate websites, find tables, and extract data. Just provide a natural language prompt!

## How It Works
1. AI takes screenshots of the page
2. Analyzes what it sees using vision AI
3. Decides what action to take next (click, fill form, extract data, next page)
4. Executes the action and repeats
5. Extracts all data automatically

## Configuration

### Simple Example - Just Add aiPrompt

```json
{
  "name": "Phoenix Building Permits",
  "url": "https://phoenix.gov/permits",
  "usePuppeteer": true,
  "aiPrompt": "Find and open the building permits table, then extract all permit information including permit numbers, addresses, and contractor details from all pages",
  "fieldSchema": {
    "permit_number": { "required": true },
    "address": { "required": true },
    "contractor_name": { "required": false },
    "value": { "required": false }
  }
}
```

### What the AI Can Do

**The AI will automatically:**
- Find and click buttons to open tables
- Wait for content to load
- Extract data from tables
- Click "Next Page" buttons
- Handle pagination across multiple pages
- Stop when all data is extracted

### Example Prompts

**Simple table extraction:**
```json
"aiPrompt": "Extract all building permits from the table"
```

**With navigation:**
```json
"aiPrompt": "Click the 'View Permits' button, then extract all permit data from the table across all pages"
```

**With filtering:**
```json
"aiPrompt": "Select 'Commercial' from the permit type dropdown, click Search, then extract all permits from the results table"
```

**Complex multi-step:**
```json
"aiPrompt": "1. Click the 'Building Permits' tab 2. Click 'Show Advanced Search' 3. Extract all permits from the table on every page until there are no more pages"
```

## Complete Configuration Example

```json
{
  "name": "My City Permits",
  "url": "https://example.gov/permits",
  "usePuppeteer": true,
  "aiPrompt": "Find the building permits table, open it if needed, and extract all permit information from all pages",
  "schedule": "0 */6 * * *",
  "fieldSchema": {
    "permit_number": {
      "required": true,
      "description": "The unique permit ID or number"
    },
    "address": {
      "required": true,
      "description": "Property address where work is being done"
    },
    "contractor_name": {
      "required": false,
      "description": "Name of the contractor"
    },
    "contractor_phone": {
      "required": false,
      "description": "Contractor phone number"
    },
    "value": {
      "required": false,
      "description": "Project value in dollars"
    },
    "date_issued": {
      "required": false,
      "description": "Date the permit was issued"
    }
  }
}
```

## Adding to Your System

### Via Web Interface
1. Go to "Manage Sources" in your dashboard
2. Click "Add Source"
3. Enter the URL
4. Enable "Use Puppeteer" checkbox
5. In the "AI Prompt" field, describe what you want to extract
6. Define your field schema
7. Save and test

### Via Database
Add a source directly to `user_sources` table:

```sql
INSERT INTO user_sources (user_id, source_data, created_at) VALUES (
  1,
  '{
    "name": "Test City Permits",
    "url": "https://testcity.gov/permits",
    "usePuppeteer": true,
    "aiPrompt": "Extract all building permits from the table across all pages",
    "schedule": "0 8 * * *",
    "fieldSchema": {
      "permit_number": {"required": true},
      "address": {"required": true},
      "value": {"required": false}
    }
  }',
  datetime('now')
);
```

## Benefits

✅ **No selector configuration needed** - AI figures it out
✅ **Handles complex navigation** - Multi-step processes  
✅ **Auto pagination** - Extracts from all pages
✅ **Self-healing** - Adapts if page layout changes
✅ **Natural language** - Describe what you want

## Tips for Best Results

1. **Be specific in your prompt**: Describe exactly what you want
2. **Mention table opening**: If table is hidden, say "open the table first"
3. **Specify pagination**: Mention "extract from all pages" if needed
4. **Define schema well**: Clear field descriptions help AI extract accurately
5. **Test with one page**: Start simple, then add "all pages" to prompt

## Cost Considerations

AI navigation uses Gemini Vision API:
- Each navigation step = 1 API call with screenshot
- Typical scrape = 3-10 steps (depending on complexity)
- Monitor your API usage at: https://console.cloud.google.com

## Troubleshooting

**AI not finding button:**
- Make your prompt more specific: "Click the blue 'View All' button"
- Check the page manually to see button text

**Extraction incomplete:**
- Add "extract from all pages" to prompt
- Increase maxSteps if hitting limit (default: 10)

**Wrong data extracted:**
- Improve fieldSchema descriptions
- Make field names more descriptive

## Example Log Output

```
🤖 AI autonomous navigation started for: "Extract building permits from table"
🔍 AI Navigation Step 1/10
🎯 AI Decision: click - Clicking 'Show Table' button to reveal data
✅ Clicked: button.show-table
🔍 AI Navigation Step 2/10
🎯 AI Decision: extract - Table is now visible, extracting data
📊 Extracting data from table: table.permits-data
✅ Extracted 25 leads
🔍 AI Navigation Step 3/10
🎯 AI Decision: nextPage - More pages available
➡️ Navigating to next page: button.next-page
🔍 AI Navigation Step 4/10
🎯 AI Decision: extract - Extracting page 2 data
✅ Extracted 25 leads
🎯 AI Decision: done - All pages processed
✅ AI navigation complete: Successfully extracted all permits
🎉 AI navigation finished. Extracted 50 total leads
```

## Advanced: AI + Manual Hybrid

You can combine AI navigation with manual config for complex scenarios:

```json
{
  "name": "Hybrid Example",
  "url": "https://example.com/permits",
  "usePuppeteer": true,
  "puppeteerConfig": {
    "actions": [
      {"type": "select", "selector": "#permitType", "value": "commercial"},
      {"type": "click", "selector": "button#search"}
    ]
  },
  "aiPrompt": "After the search results load, extract all permits from the table across all pages"
}
```

This runs manual actions first, then hands off to AI for extraction.
