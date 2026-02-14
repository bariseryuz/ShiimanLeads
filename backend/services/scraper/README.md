# 🤖 Scraper Service

Complete lead generation scraping system with AI-powered extraction, multi-method scraping, rate limiting, and reliability tracking.

## 📁 Structure

```
services/scraper/
├── index.js          - Main orchestration (scrapeForUser, scrapeAllUsers)
├── helpers.js        - Utility functions (text filters, date parsing, field mapping)
├── validation.js     - Field validation and confidence scoring
├── screenshot.js     - Full-page screenshot capture with lazy loading
├── rateLimiter.js    - Per-source rate limiting with exponential backoff
├── progress.js       - Progress tracking and stop flags
└── timings.js        - Configurable timing delays
```

## 🎯 Core Functions

### `scrapeForUser(userId, userSources)`
Main scraping orchestration (~1500 lines). Handles:

1. **Initialization**
   - Progress tracking setup
   - Mark existing leads as old
   - Source validation

2. **Source Loop**
   - Stop flag checking
   - Rate limiting per source
   - Random delays (10-30s between sources)
   - Source-specific timing configuration

3. **Multiple Extraction Methods** (automatic fallback chain):

#### a) JSON API Method
- Direct API requests via Axios
- Proxy support (residential/datacenter)
- Field mappings (user-configured or auto-mapping)
- Special handlers:
  - Nashville API (custom params)
  - ArcGIS/ESRI (attribute flattening)
- Date parsing (Unix timestamps, ISO, various formats)

#### b) Playwright Method (Dynamic Pages)
- **Browser Automation**:
  - Headless Chromium with stealth tactics
  - Proxy rotation with authentication
  - Anti-detection (navigator.webdriver masking)
  
- **AI Autonomous Navigation**:
  - Uses `aiPrompt` to navigate pages automatically
  - Waits for dynamic content loading
  
- **Block Detection** (6 signals):
  - CAPTCHA detection
  - "Access Denied" messages
  - Cloudflare challenges
  - Rate limiting (403/429 errors)
  - Generic "blocked" messages
  - Bot detection indicators
  
- **Rate Limiting Detection**:
  - Triggers 30-minute backoff on detection
  - Exponential backoff (2x, 4x, 8x max)
  
- **playwrightConfig Actions**:
  - `select` - Select dropdown options
  - `fill` - Fill form inputs
  - `click` - Click buttons/links
  - `wait` - Wait for selectors/navigation
  
- **Content Quality Validation** (`hasUsefulContent`):
  - Checks for permit counts
  - Looks for dollar signs ($)
  - Validates phone numbers
  - Detects table structures
  
- **Auto-Scrolling**:
  - Horizontal scrolling (reveal table columns, max 5 scrolls)
  - Vertical scrolling (load lazy content, max 10 scrolls)
  - Incremental wheel events (smooth loading)
  
- **Table Extraction**:
  - Intelligent column mapping by header names
  - Handles wide tables (20,000px width)
  - Row-by-row extraction
  
- **Screenshot Capture**:
  - Multi-page pagination support
  - Full-page screenshots (up to 50,000px height)
  - AI vision input for extraction

#### c) HTML Parsing Method (Cheerio)
- **Schema.org JSON-LD**:
  - Extracts structured data from `<script type="application/ld+json">`
  - Organization/LocalBusiness detection
  - Contact information extraction
  
- **JSON in HTML Attributes**:
  - Vue component data extraction
  - HTML entity decoding
  
- **CSS Selector-Based**:
  - User-configured selectors
  - Element-by-element extraction
  
- **Pattern Matching Fallback**:
  - Permit numbers: `/[A-Z]?\d{5,12}[A-Z]?/i`
  - Addresses: Street patterns with suffix detection
  - Phone numbers: US format with area code
  - Currency: Dollar amounts

#### d) AI Extraction Method
- **Vision Mode** (from Playwright screenshots):
  - Google Gemini Flash 2.0 model
  - Multi-page processing
  - Array-like object handling (numeric keys)
  - Confidence scoring
  
- **Text Mode** (from HTML body):
  - Full-page text extraction
  - Field schema validation
  - JSON cleanup and repair
  
- **Features**:
  - Configurable thinking levels (low/medium/high)
  - Temperature/topP/maxTokens control
  - Incomplete array handling
  - Retry logic with simpler prompts

4. **Lead Insertion**
   - Universal deduplication (5 strategies)
   - Source-specific dynamic tables
   - Transaction-safe with rollback
   - Progress updates after each lead

5. **Error Handling**
   - Per-source try/catch (failures isolated)
   - Rate limit detection → backoff
   - Reliability tracking (confidence scores)
   - Error logging to progress object

6. **Completion**
   - Notification creation (success/no_new)
   - Progress status update ('completed')
   - Total inserted count returned

### `scrapeAllUsers()`
Cron job orchestrator that:
- Fetches all users from database
- Loads user-specific sources from `user_sources` table
- Calls `scrapeForUser()` for each user
- Logs results and errors

## 🔧 Helper Modules

### helpers.js
- `normalizeText(value)` - Convert any value to string
- `buildTextForFilter(item, source)` - Build filterable text from JSON/HTML
- `textPassesFilters(text, source)` - Apply keywords/regex filters
- `getDefaultColumnsForSource(source)` - Get default columns by source type
- `parseDate(value)` - Parse dates (Unix, ISO, etc.) to YYYY-MM-DD
- `getNestedProp(obj, path)` - Get nested property by dot notation
- `formatDate(date)` - Format date to YYYY-MM-DD
- `replaceDynamicDates(text)` - Replace {{DATE_365_DAYS_AGO}} placeholders
- `loadSources()` - Load sources from sources.json

### validation.js
- `validateExtractedFields(data, sourceName, fieldSchema)` 
  - Critical field validation (link, permit_number, address)
  - Confidence scoring (40% threshold)
  - Issue reporting

### screenshot.js
- `captureEntirePage(page, options)` 
  - 7-step process:
    1. Horizontal scrolling (reveal columns)
    2. Vertical scrolling (reveal rows)
    3. Return to top-left
    4. Calculate full dimensions
    5. Set viewport (max 20000x50000)
    6. Wait for rendering
    7. Capture screenshot

### rateLimiter.js
- `RateLimiter` class
  - Per-minute request limits
  - Exponential backoff (2x, 4x, 8x)
  - Success-based recovery
- `getRateLimiter(source)` - Get or create limiter per source

### progress.js
- `initProgress(userId, sources)` - Initialize tracking
- `updateProgress(userId, updates)` - Update progress
- `getProgress(userId)` - Get current progress
- `shouldStopScraping(userId)` - Check stop flag
- `setShouldStop(userId, value)` - Set stop flag

### timings.js
- `DEFAULT_TIMINGS` - Default timing configuration
- `getTimings(source)` - Merge source-specific timings

## ⚙️ Configuration

### Source Configuration Fields

```javascript
{
  "name": "Phoenix Building Permits",
  "url": "https://example.com/permits",
  "usePlaywright": true,          // Enable browser automation
  "useAI": true,                  // Enable AI extraction
  "aiPrompt": "Navigate to permits, fill date range, click search",
  "playwrightConfig": {           // Browser actions
    "actions": [
      { "type": "select", "selector": "#dateRange", "value": "last90days" },
      { "type": "fill", "selector": "#searchBox", "value": "{{KEYWORD}}" },
      { "type": "click", "selector": "#submitBtn" },
      { "type": "wait", "selector": "table.permits" }
    ]
  },
  "fieldMappings": {              // Explicit field mappings
    "permit_number": "Permit_Number",
    "address": "Full_Address",
    "value": "Const_Cost",
    "date_issued": "Date_Issued"
  },
  "fieldSchema": [                // AI extraction schema
    "permit_number",
    "address",
    "contractor_name",
    "contractor_phone",
    "value",
    "description",
    "date_issued"
  ],
  "requestsPerMinute": 10,        // Rate limiting
  "timings": {                    // Custom timing overrides
    "networkIdleTimeout": 20000,
    "jsRenderWait": 10000
  },
  "keywords": ["permit", "construction"], // Content filters
  "includeRegex": ["permit #\\d+"],
  "excludeRegex": ["expired", "cancelled"]
}
```

### Environment Variables

```env
# Proxy Configuration
PROXY_ENABLED=true
PROXY_TYPE=residential
PROXY_USERNAME=your_username
PROXY_PASSWORD=your_password
PROXY_HOST=proxy.provider.com
PROXY_PORT=8080

# Google Gemini AI
GEMINI_API_KEY=your_gemini_api_key
AI_THINKING_LEVEL=low             # low | medium | high

# Auto-Scraping
AUTO_SCRAPE_ENABLED=true          # Enable cron jobs
AUTO_SCRAPE_ON_STARTUP=false      # Run scrape on startup
AUTO_SCRAPE_INTERVAL=0 */8 * * *  # Every 8 hours (cron format)
```

## 📊 Progress Tracking

Progress object structure:
```javascript
{
  status: 'running' | 'completed' | 'stopped',
  startTime: 1234567890,
  endTime: 1234567890,
  totalSources: 5,
  completedSources: 3,
  currentSource: 'Phoenix Permits',
  leadsFound: 42,
  errors: [
    { source: 'Nashville', error: 'Rate limited' }
  ]
}
```

## 🎯 Deduplication Strategies

Uses `insertLeadIfNew()` from leadInsertion service:

1. **Permit Strategy** - Permit number + source (for permits)
2. **Address Strategy** - Full address + city + state (for properties)
3. **Business Strategy** - Company name + phone (for businesses)
4. **Contact Strategy** - Name + phone/email (for contacts)
5. **Hash Strategy** - MD5 of raw data (universal fallback)

## 🔄 Extraction Flow

```
┌─────────────────────┐
│  scrapeAllUsers()   │  ← Cron job
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ For each user...    │
│ Load user sources   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  scrapeForUser()    │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ For each source...  │
│ Apply rate limiting │
└──────────┬──────────┘
           │
           ├─────────────┐
           │             │
           ▼             ▼
    ┌──────────┐   ┌──────────┐
    │ JSON API │   │ Puppeteer│
    └────┬─────┘   └────┬─────┘
         │              │
         │      ┌───────┘
         │      │
         ▼      ▼
    ┌──────────────┐
    │ AI Extraction│ (if enabled)
    └──────┬───────┘
           │
           ▼
    ┌──────────────┐
    │   Validate   │
    │    Fields    │
    └──────┬───────┘
           │
           ▼
    ┌──────────────┐
    │  Deduplicate │
    │ & Insert Lead│
    └──────┬───────┘
           │
           ▼
    ┌──────────────┐
    │ Track Source │
    │  Reliability │
    └──────────────┘
```

## 📝 TODO

- [ ] Extract full `scrapeForUser()` from index.js (currently ~1500 lines)
- [ ] Add retry logic for failed sources
- [ ] Implement queue system for parallel scraping
- [ ] Add webhook notifications on scrape completion
- [ ] Cache scraped data to reduce re-scraping

## 🔗 Dependencies

- **Services**: ai.js, leadInsertion.js, reliability.js, notifications.js
- **Database**: db/index.js (dbAll, dbRun, dbGet)
- **Utils**: logger.js
- **External**: axios, cheerio, puppeteer, node-cron

---

**Current Status**: Helper modules extracted (634 lines). Main orchestration (scrapeForUser ~1500 lines) still in index.js. Will be extracted in future phase.
