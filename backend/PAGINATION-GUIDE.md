# Pagination & Full-Page Scrolling Guide

The scraper now automatically handles **pagination** and **vertical scrolling** when using AI extraction mode.

## ✅ What It Does Automatically

### 1. **Full Vertical Scrolling**
- Scrolls down 500px at a time
- Triggers lazy-loading for dynamic content
- Captures the entire scrollable height
- Scrolls back to top before taking screenshot

### 2. **Pagination Detection**
- Automatically detects "Next" buttons using:
  - `<a title="Next">` or `<button title="Next">`
  - `<a aria-label="Next Page">`
  - `.pagination a.next`
  - Text content: "Next", "›", ">", "→"
  - `<img alt="Next">`

### 3. **Multi-Page Extraction**
- Extracts leads from **each page** separately
- Saves screenshots for debugging: `source_name-page1-timestamp.png`
- Continues until no more "Next" button found
- Respects `maxPages` limit (default: 10)

## 📝 Source Configuration

### Example: Enable Pagination

```json
{
  "name": "My Source",
  "url": "https://example.com/permits",
  "usePuppeteer": true,
  "useAI": true,
  "maxPages": 5,
  "fieldSchema": {
    "permit_number": "Permit #",
    "address": "Address",
    "value": "Est. Cost"
  }
}
```

### Configuration Options

| Field | Type | Description | Default |
|-------|------|-------------|---------|
| `usePuppeteer` | boolean | Enable browser automation | `false` |
| `useAI` | boolean | Enable AI vision extraction | `false` |
| `maxPages` | number | Maximum pages to scrape | `10` |
| `fieldSchema` | object | Field mappings for AI extraction | `{}` |

## 🎯 How It Works

### Step-by-Step Process

1. **Load Page** → Opens the URL in Puppeteer
2. **Wait** → Waits 3 seconds for initial load
3. **Scroll Down** → Auto-scrolls from top to bottom (500px steps)
4. **Scroll Up** → Returns to top for clean screenshot
5. **Wait** → Waits 2 seconds for final lazy-loaded content
6. **Screenshot** → Captures full-page (not just viewport)
7. **Extract** → AI analyzes screenshot and extracts leads
8. **Save** → Inserts new leads into database
9. **Check Next** → Looks for "Next" button
10. **Repeat** → If found, clicks and goes to step 2

### Logs to Watch For

```
📸 Starting multi-page AI extraction with full scrolling...
📄 Processing page 1/10...
🔄 Auto-scrolling to load lazy content...
✅ Scrolling complete, page loaded
📸 Capturing full-page screenshot (page 1)...
💾 Screenshot saved: My_Source-page1-2026-02-08T12-30-45.png
🤖 Extracting leads from page 1 with AI...
✅ AI extracted 25 leads from page 1
➡️ Found Next button (a[title*="Next"]), navigating to page 2...
✅ Navigated to page 2
```

## 🔧 Customization

### Change Max Pages

Edit in your source config:
```json
{
  "maxPages": 20  // Scrape up to 20 pages
}
```

### Adjust Scroll Speed

Edit `legacyScraper.js` line ~195:
```javascript
const distance = 500; // Change from 500px to 300px for slower scroll
// ...
}, 200); // Change from 200ms to 300ms for slower intervals
```

### Custom Next Button Selector

If the auto-detection fails, you can add custom pagination logic in the `nextPageFound` evaluation (line ~233):

```javascript
const selectors = [
  'a.your-custom-next-class',  // Add your selector here
  'button#nextPageBtn',
  // ... existing selectors
];
```

## 🐛 Troubleshooting

### Screenshots Missing Content

**Problem:** Screenshot doesn't show all data  
**Solution:** Increase scroll wait time:

```javascript
// Line ~209 - increase from 2000ms to 5000ms
await new Promise(resolve => setTimeout(resolve, 5000));
```

### Pagination Not Working

**Problem:** "No more pages found" on first page  
**Solution:** Check the actual HTML for the Next button and add its selector manually.

**Debug:** Look at the screenshot to see if Next button is visible.

### Too Many Pages

**Problem:** Scraping takes too long  
**Solution:** Reduce `maxPages`:

```json
{
  "maxPages": 3  // Only scrape first 3 pages
}
```

## 📊 Example Output

```
✅ Multi-page extraction complete: 127 total leads from 5 page(s)
```

Each page's screenshot is saved to:
```
backend/data/screenshots/
├── My_Source-page1-2026-02-08T12-30-45.png
├── My_Source-page2-2026-02-08T12-32-18.png
├── My_Source-page3-2026-02-08T12-33-51.png
├── My_Source-page4-2026-02-08T12-35-24.png
└── My_Source-page5-2026-02-08T12-36-57.png
```

## ⚙️ Performance Tips

1. **Test with `maxPages: 1` first** to verify extraction works
2. **Check screenshots** in `backend/data/screenshots/` to debug
3. **Increase timeouts** for slow-loading sites
4. **Use residential proxy** if getting rate-limited

---

**Note:** This only works with `useAI: true` and `usePuppeteer: true` enabled.
