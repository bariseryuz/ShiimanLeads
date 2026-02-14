# Backend Refactoring Plan - 6632 Lines → Modular Structure

## ✅ Phase 1: Foundation (COMPLETED)
- [x] Create directory structure
- [x] Extract utils/logger.js
- [x] Extract utils/hash.js
- [x] Extract utils/validators.js
- [x] Extract config/environment.js
- [x] Extract config/paths.js

## 🚧 Phase 2: Database Layer (NEXT - HIGH PRIORITY)
**Files to create:**
- [ ] db/connection.js - Database connection setup
- [ ] db/schema.js - All CREATE TABLE statements
- [ ] db/migrations.js - ALTER TABLE migrations
- [ ] db/queries.js - Common query functions (dbGet, dbAll, dbRun)

**Extract from index.js lines:**
- Lines 2287-2520: Database schema creation
- Lines 2521-2585: Migrations and indexes

## 🚧 Phase 3: Middleware (30 min)
**Files to create:**
- [ ] middleware/auth.js - requireAuth, requireAdmin
- [ ] middleware/errorHandler.js - Global error handling
- [ ] middleware/validation.js - Request validation

**Extract from index.js:**
- Lines 5740-5780: requireAuth middleware
- Error handling scattered throughout

## 🚧 Phase 4: Routes (1 hour)
**Files to create:**
- [ ] routes/auth.js - POST /api/login, /api/signup, /api/logout
- [ ] routes/sources.js - GET/POST/DELETE /api/sources/*
- [ ] routes/leads.js - GET/DELETE /api/leads/*
- [ ] routes/scrape.js - POST /api/scrape/*
- [ ] routes/screenshots.js - GET /screenshots/*

**Extract from index.js:**
- Lines 5780-6632: All Express routes

## 🚧 Phase 5: Scraper Service (2 hours - MOST COMPLEX)
**Files to create:**
- [ ] services/scraper/index.js - Main orchestration
- [ ] services/scraper/browser.js - Puppeteer setup
- [ ] services/scraper/screenshot.js - Screenshot capture
- [ ] services/scraper/validation.js - Data quality validation
- [ ] services/scraper/strategies/universal.js - Generic scraping
- [ ] services/scraper/strategies/fallback.js - Fallback methods

**Extract from index.js:**
- Lines 2586-4600: Main scrapeForUser() function
- Lines 158-241: captureEntirePage()
- Lines 445-510: validateExtractedFields()

## 🚧 Phase 6: AI Service (1 hour)
**Files to create:**
- [ ] services/ai/gemini.js - Gemini API client
- [ ] services/ai/prompt-builder.js - Build AI prompts
- [ ] services/ai/response-parser.js - Parse AI responses
- [x] services/ai/navigator.js - AI autonomous navigation ✅ IMPLEMENTED

**Extract from index.js:**
- Lines 577-1670: aiNavigateAndExtract()
- Lines 1443-1730: extractLeadWithAI()
- Lines 242-444: AI helper functions

## 🚧 Phase 7: Leads Service (30 min)
**Files to create:**
- [ ] services/leads/insert.js - insertLeadIfNew()
- [ ] services/leads/deduplicate.js - Deduplication logic
- [ ] services/leads/export.js - Export to JSONL

**Extract from index.js:**
- Lines 1958-2150: insertLeadIfNew()
- Lines 1830-1860: Hash generation

## 🚧 Phase 8: Scheduler Service (30 min)
**Files to create:**
- [ ] services/scheduler/cron.js - Cron job setup
- [ ] services/scheduler/queue.js - Job queue management

**Extract from index.js:**
- Lines 2230-2286: Cron setup

## 🚧 Phase 9: Models (30 min)
**Files to create:**
- [ ] models/User.js - User model and methods
- [ ] models/Source.js - Source model and methods
- [ ] models/Lead.js - Lead model and methods

**Currently scattered throughout index.js**

## 🚧 Phase 10: New Index.js (30 min)
**Final lean index.js structure:**
```javascript
const express = require('express');
const config = require('./config/environment');
const logger = require('./utils/logger');
const db = require('./db');
const authMiddleware = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');

// Routes
const authRoutes = require('./routes/auth');
const sourcesRoutes = require('./routes/sources');
const leadsRoutes = require('./routes/leads');
const scrapeRoutes = require('./routes/scrape');

const app = express();

// Middleware
app.use(express.json());
app.use(express.static('frontend'));
app.use(authMiddleware.session);

// Routes
app.use('/api', authRoutes);
app.use('/api/sources', sourcesRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/scrape', scrapeRoutes);

// Error handling
app.use(errorHandler);

// Start server
app.listen(config.PORT, () => {
  logger.info(`🚀 Server running on port ${config.PORT}`);
});
```

## 📊 Estimated Time: 8-10 hours total

## 🎯 Benefits After Refactoring:
- ✅ 6632 lines → ~150 lines in index.js (97% reduction!)
- ✅ Easier to find and modify code
- ✅ Testable modules
- ✅ Reusable components
- ✅ Clear separation of concerns
- ✅ Team-friendly codebase
- ✅ Easier debugging and logging

## ⚠️ Migration Strategy:
1. Create all new files alongside index.js
2. Test each module independently
3. Gradually import modules into index.js
4. Keep backup of index.js as index.BACKUP.js
5. Once verified, delete old code from index.js

## 🔥 IMMEDIATE NEXT STEPS:
1. Create db/ layer (connection, schema, queries)
2. Create middleware/auth.js
3. Start extracting routes one by one
4. Test after each major extraction
