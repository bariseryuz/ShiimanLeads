# How to Use AI Auto-Scraping (Client Guide)

## What is AI Auto-Scraping?

Instead of manually configuring selectors and navigation steps, you simply **tell the AI what you want in plain English**, and it figures out how to navigate the website, find buttons, extract data, and handle multiple pages automatically.

## Step-by-Step Guide

### 1. Access Your Dashboard
- Log in to your Shiiman Leads account
- Click on **"My Sources"** in the navigation menu

### 2. Add a New Source
- Click the **"+ Add Source"** button
- You'll see a form with several fields

### 3. Fill in Basic Information
- **Source Name**: Give it a descriptive name (e.g., "Miami Building Permits")
- **Website URL**: Paste the URL where the data is located

### 4. The Magic Part: AI Instructions 🤖

You'll see a purple highlighted box that says **"AI Instructions (Describe What You Want)"**

This is where you simply describe what you want in natural language!

#### Example Instructions:

**Simple extraction:**
```
Extract all building permits from the table
```

**If you need to open a table first:**
```
Find and click the "Show Table" button, then extract all permit information
```

**For multiple pages:**
```
Extract all building permits from the table across all pages
```

**Complex multi-step:**
```
Click the "Building Permits" tab, then open the table view, and extract all permit data including addresses, contractor names, and values from every page
```

### 5. Specify What Fields You Want (Optional)

In the **"What fields do you want to extract?"** box, list the data fields:
```
permit number, address, contractor name, phone number, permit value, issue date
```

### 6. Save and Run

- Click **"Save Source"**
- Click **"Scrape Now"** to start immediately
- Watch the progress indicator as AI navigates and extracts

## Real Examples

### Example 1: Simple Table
**URL:** `https://citydata.gov/permits`  
**AI Instructions:**
```
Extract all construction permits from the main table
```

### Example 2: Hidden Table
**URL:** `https://permits.example.com`  
**AI Instructions:**
```
Click the "View All Permits" button to open the table, then extract all permit data
```

### Example 3: Multi-Page with Filters
**URL:** `https://city.gov/construction-data`  
**AI Instructions:**
```
Select "Commercial" from the permit type dropdown, click Search, then extract all permits from the results table across all pages
```

### Example 4: Complex Navigation
**URL:** `https://permits.bigcity.gov`  
**AI Instructions:**
```
1. Click the "Building Permits" tab at the top
2. Click "Show Advanced Search"
3. Click the "Show All" button to display the table
4. Extract all permit information from every page
```

## What the AI Does Automatically

✅ **Finds elements** - Locates buttons, tables, links automatically  
✅ **Clicks buttons** - Opens tables, clicks "Show More", etc.  
✅ **Handles pagination** - Automatically clicks "Next" and extracts from all pages  
✅ **Extracts data** - Identifies and extracts the data you requested  
✅ **Cleans data** - Formats and structures data properly  

## Tips for Best Results

### Be Specific
❌ Bad: "Get data"  
✅ Good: "Extract all building permits from the table including addresses and contractor information"

### Mention Navigation
❌ Bad: "Extract permits"  
✅ Good: "Click 'View Permits' button, then extract all permit data"

### Specify Multi-Page
❌ Bad: "Get permits"  
✅ Good: "Extract all permits from every page of the table"

### Break Down Complex Tasks
Instead of:
```
Get everything
```

Use:
```
1. Click the Building Permits tab
2. Click Show Table
3. Extract all permits from all pages
```

## Troubleshooting

### "AI didn't find the button"
**Solution:** Be more specific about the button name or appearance
```
Click the blue "View All" button at the top right
```

### "Only got one page of data"
**Solution:** Explicitly mention pagination
```
Extract all permits from the table, clicking Next to get all pages
```

### "Wrong data extracted"
**Solution:** Be more specific about what fields you want
```
Extract: permit number, property address, contractor name, phone number, project value
```

### "AI stopped early"
**Solution:** The default limit is 10 steps. For complex sites, mention this:
```
Navigate through all pages and extract all data (may take multiple steps)
```

## Monitoring Progress

When scraping starts, you'll see a progress indicator showing:
- Current source being processed
- Number of leads found
- Any errors encountered

The AI logs each step it takes, so you can see:
- What buttons it clicked
- What tables it found
- How many pages it processed
- How many leads it extracted

## Cost & Performance

- Each AI navigation step uses one Gemini Vision API call
- Typical scrape uses 3-10 steps depending on complexity
- Fully automated - runs in background
- Can be scheduled to run automatically (hourly, daily, etc.)

## Need Help?

If the AI isn't working as expected:
1. Try making your instructions more specific
2. Check the logs to see what the AI is doing
3. Contact support with your source URL and instructions
4. We can help refine the prompt for your specific site

## Advanced: Combining AI with Manual Config

For power users, you can combine AI navigation with manual configuration for complex scenarios. See [AI-NAVIGATION-EXAMPLE.md](backend/AI-NAVIGATION-EXAMPLE.md) for advanced examples.

---

**Remember:** The simpler and more specific your instructions, the better the AI will perform! 🚀
