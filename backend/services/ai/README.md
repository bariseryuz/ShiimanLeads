# AI Autonomous Navigation

This module enables natural language-based web automation. Users can describe what they want in plain English, and the AI figures out how to navigate the website, interact with elements, and extract data.

## How It Works

1. **User provides natural language prompt** via the "AI Instructions" field in the UI
2. **AI analyzes the page** using a screenshot and the prompt
3. **Generates Playwright actions** (click, select, fill, wait, extract, paginate)
4. **Executes actions sequentially** on the live page
5. **Handles pagination** automatically based on AI understanding

## Example Prompts

### Simple Extraction
```
Extract all building permits from the table
```

### Multi-Step Navigation
```
Select "All Building Permits" from the first dropdown, 
select "10 or More Family Units" from Structure Class dropdown, 
enter start date {{DATE_365_DAYS_AGO}} in the date field, 
click Create List button, 
then extract data from current page. 
After extracting, look for page number 2 at the bottom and click it, 
then extract again. 
Repeat clicking page 3, 4, 5 and extracting until no more page numbers exist.
```

### Navigation with Tabs
```
Click the "Building Permits" tab, 
then click "Show Table" button, 
and extract all permit data from all pages
```

## Dynamic Date Placeholders

The system supports automatic date replacement:

- `{{DATE_365_DAYS_AGO}}` - 365 days ago
- `{{DATE_90_DAYS_AGO}}` - 90 days ago  
- `{{DATE_30_DAYS_AGO}}` - 30 days ago
- `{{DATE_TODAY}}` - Today's date
- `{{DATE_THIS_MONTH_START}}` - First day of current month
- `{{DATE_THIS_YEAR_START}}` - January 1st of current year

These are automatically replaced with properly formatted dates before sending to the AI or filling forms.

## Technical Details

### AI Model
- Uses Google Gemini 2.0 Flash Exp
- Processes screenshots + text prompts
- Generates structured JSON action sequences

### Action Types

**click** - Click a button or link
```json
{
  "type": "click",
  "selector": "#submitBtn",
  "description": "Click the submit button"
}
```

**select** - Choose from dropdown
```json
{
  "type": "select",
  "selector": "#permitType",
  "value": "All Building Permits",
  "description": "Select permit type"
}
```

**fill** - Enter text in input field
```json
{
  "type": "fill",
  "selector": "#startDate",
  "value": "{{DATE_365_DAYS_AGO}}",
  "description": "Enter start date"
}
```

**wait** - Wait for element or duration
```json
{
  "type": "wait",
  "selector": ".results-table",
  "description": "Wait for results to load"
}
```
or
```json
{
  "type": "wait",
  "duration": 3000,
  "description": "Wait 3 seconds"
}
```

**scroll** - Scroll the page
```json
{
  "type": "scroll",
  "distance": 1000,
  "description": "Scroll down 1000px"
}
```

**extract** - Mark point to extract data
```json
{
  "type": "extract",
  "description": "Extract data from current page"
}
```

**paginate** - Handle multi-page extraction
```json
{
  "type": "paginate",
  "nextButtonSelector": "a.next-page",
  "maxPages": 10,
  "description": "Extract from all pages"
}
```

### Integration with Scraper

The navigator integrates into `legacyScraper.js`:

1. After page loads and popups are removed
2. Check if `source.aiPrompt` exists
3. If yes, call `navigateAutonomously(page, aiPrompt)`
4. Execute generated actions
5. Use returned `paginationInfo` for multi-page extraction
6. Fall back to traditional pagination if AI doesn't specify

### Error Handling

- Actions are retried once if they fail
- Failed actions are logged but don't stop execution
- If navigation fails, scraper continues with screenshot extraction
- Graceful fallback to traditional pagination detection

## Configuration

Set `GEMINI_API_KEY` in your `.env` file:

```env
GEMINI_API_KEY=your-api-key-here
```

Without this key, the AI navigator is disabled and the system falls back to traditional scraping methods.

## Performance

- Initial navigation: 1 Gemini API call (~5-10 seconds)
- Each action: Executed via Playwright (fast)
- Pagination: Uses AI-provided selectors (no additional API calls)
- Total time: Depends on page complexity, typically 10-30 seconds for navigation

## Limitations

- Requires Google Gemini API access
- Works best with well-structured websites
- May struggle with heavily obfuscated or dynamic sites
- CAPTCHA/authentication not automatically handled
- Limited to actions Playwright can perform

## Future Enhancements

- [ ] Multi-page form filling
- [ ] File upload handling
- [ ] Authentication flows
- [ ] CAPTCHA solving integration
- [ ] Self-correction when actions fail
- [ ] Learning from successful navigation patterns
- [ ] Support for more complex conditionals

## Testing

To test the AI navigator manually:

```javascript
const { navigateAutonomously } = require('./services/ai/navigator');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto('https://your-site.com');
  
  const result = await navigateAutonomously(page, 
    'Click the "View Permits" button and extract all data',
    { takeInitialScreenshot: true }
  );
  
  console.log('Navigation result:', result);
  await browser.close();
})();
```

## Debugging

Enable detailed logging by checking the console output for:
- `🤖 Asking Gemini to interpret...` - AI prompt being sent
- `✅ Parsed X navigation steps` - Actions generated
- `🎬 Executing: action_type` - Each action as it runs
- `📄 Pagination detected` - When multi-page found

Check `logs/scraper.log` for full details of each navigation attempt.
