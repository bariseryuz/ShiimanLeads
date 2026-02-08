# Backend Services

This directory contains business logic services extracted from the monolithic `index.js`.

## Services Overview

### ✅ notifications.js
**Notification System**
- `createNotification(userId, type, message)` - Create user notifications

### ✅ reliability.js
**Source Reliability Tracking**
- `trackSourceReliability(sourceId, sourceName, success, extractedCount)` - Track scraping success/failure
- **Features:**
  - Confidence score calculation (success rate)
  - Average leads per run tracking
  - Alerts when confidence drops below 70%
  - Last success/failure timestamps

### ✅ sourceTable.js
**Dynamic Table Management**
- `createSourceTable(sourceId, fieldSchema)` - Create source-specific tables with custom fields
- `insertIntoSourceTableSync(sourceId, userId, rawText, lead, extractedData)` - Insert into source table
- **Features:**
  - Dynamic column creation based on field schema
  - Auto-creates tables if missing
  - Transaction-safe synchronous insertion
  - Hash-based duplicate detection per table

### ✅ leadInsertion.js
**Universal Lead Insertion & Deduplication**
- `insertLeadIfNew({ raw, sourceName, lead, userId, extractedData, sourceId })` - Smart lead insertion
- `generateLeadHash(leadData, userId)` - Generate deduplication hash

**Deduplication Strategies (in order of priority):**
1. **Permit Number** - Construction/building permits (`permit_number`, `permitNumber`, `Permit Number`)
2. **Address** - Location-based leads (`address`, `location`, `street_address`)
3. **Business + Phone** - Company leads (`company_name` + `phone`)
4. **Contact** - Email/website leads (`email`, `website`, `url`)
5. **Data Hash** - Fallback for any lead type

**Features:**
- Universal ID generation for any lead type
- Cross-source deduplication using seen table
- Inserts into both unified `leads` table and source-specific table
- Outbox pattern for JSONL export
- Transaction-safe with rollback on failure

### ✅ ai.js
**Google Gemini AI Integration**
- `extractLeadWithAI(input, sourceName, fieldSchema, isRetry)` - Extract leads from screenshots/text
- `buildGenConfig()` - Build Gemini generation configuration
- `isGeminiAvailable()` - Check if AI is configured
- `getGeminiModel()` - Get Gemini model instance

**Features:**
- Vision-based extraction from screenshots
- Text-based extraction fallback
- Field schema validation
- Configurable AI "thinking level" (low/medium/high)
- Automatic JSON cleanup and repair
- Retry support with enhanced prompts
- Column header matching for table data

**AI Thinking Levels:**
- `low` (default): temperature=0.2, topP=0.8, max=8192 tokens
- `medium`: temperature=0.5, topP=0.9, max=12288 tokens
- `high`: temperature=0.7, topP=0.95, max=16384 tokens

## Architecture

### Service Dependencies

```
routes/
  ├─> services/notifications.js
  ├─> services/sourceTable.js
  ├─> services/leadInsertion.js
  ├─> services/reliability.js
  └─> services/ai.js

services/leadInsertion.js
  └─> services/sourceTable.js (for source-specific insert)

services/ai.js
  └─> (independent, uses Google Gemini API)
```

### Database Integration

All services use promisified database wrappers from `db/`:
- `dbGet()` - Single row query
- `dbAll()` - Multiple rows query  
- `dbRun()` - INSERT/UPDATE/DELETE
- `db` - Direct better-sqlite3 instance for transactions

## Still in index.js

The following complex services remain in index.js (to be extracted next):

### 🔜 scraper/ (Main Orchestration)
- `scrapeForUser(userId, userSources)` - Main scraping orchestrator (~800 lines)
- Browser/Puppeteer setup and configuration
- Screenshot capture functions
- Field validation logic
- Progress tracking and stop flags
- Pagination detection and handling
- Rate limiting and retry logic

### 🔜 scheduler/ (Auto-Scraping)
- Cron job setup for scheduled scraping
- Source scheduling logic
- User scheduling based on preferences

### 🔜 Additional Helpers
- `loadSources()` - Load sources from sources.json
- `validateExtractedFields()` - Field validation
- `replaceDynamicDates()` - Date placeholder replacement
- Screenshot functions: `captureEntirePage()`, `captureFullPageScreenshot()`

## Progress

**Phase 5: Services Extraction**
- ✅ notifications.js (20 lines)
- ✅ reliability.js (67 lines)
- ✅ sourceTable.js (150 lines)
- ✅ leadInsertion.js (301 lines)
- ✅ ai.js (280 lines)
- 🔜 scraper/ (scraper service - most complex, ~1000 lines)
- 🔜 scheduler/ (cron scheduling)
- 🔜 helpers/ (utility functions)

**Total Extracted:** ~820 lines of service logic

**Next:** Extract scraper orchestration (largest and most complex service)
