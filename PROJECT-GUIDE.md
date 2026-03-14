# Shiiman Leads – Project Guide (Everything in One Place)

This doc explains **where everything lives** and **how it works**, so you keep full control. There is **no folder named "engine"** – the "engine" is the **backend**: the server, the scraper, and the AI services together.

---

## 1. Where the "Engine" Lives

The **engine** = the code that runs when you add sources and click "Scrape". You now have a dedicated **backend/engine/** folder (Universal Pipeline) plus the rest spread across:

| What you might call "the engine" | Where it actually lives |
|----------------------------------|--------------------------|
| **Main scraper** (decides ArcGIS vs JSON vs browser) | `backend/legacyScraper.js` |
| **Universal Engine** (filter + map any API: JSON, ArcGIS, AI) | `backend/engine/` |
| **Browser + AI flow** (screenshots, navigation, extraction) | `backend/services/scraper/` + `backend/services/ai/` |
| **AI prompt text** (what we tell the AI) | `backend/prompts/` |
| **Saving leads, dedup, reliability** | `backend/services/` (leadInsertion, deduplication, reliability) |

So: **you have not lost control.** Everything is under `backend/`. This guide maps every important folder and file. See **ENGINE-BLUEPRINT.md** for the Universal Engine design.

---

## 2. Backend Folder Structure (What You Care About)

```
backend/
├── index.js              ← Server entry: starts Express, mounts routes
├── start.js              ← Script to run the server
├── legacyScraper.js      ← THE MAIN SCRAPER (orchestrates everything)
├── .env                  ← Secrets (API keys, DB path) – do not commit
├── package.json          ← Dependencies
│
├── config/               ← Settings (paths, limits, env)
│   ├── paths.js          ← Where DB, screenshots, logs live
│   ├── environment.js    ← Env vars
│   └── extractionLimits.js
│
├── db/                   ← Database
│   ├── connection.js
│   ├── database.js
│   ├── schema.js
│   └── index.js
│
├── middleware/           ← Auth, error handling (runs before routes)
│   ├── auth.js
│   └── errorHandler.js
│
├── models/               ← How we read/write User, Source, Lead
│   ├── User.js
│   ├── Source.js
│   ├── Lead.js
│   └── index.js
│
├── routes/               ← API endpoints (what the frontend calls)
│   ├── auth.js           ← Login, register
│   ├── scrape.js         ← Start/stop scrape, progress
│   ├── sources.js        ← CRUD for sources
│   ├── leads.js          ← List/export leads
│   ├── leads-api.js
│   ├── profile.js
│   ├── admin.js
│   ├── stats.js
│   ├── screenshots.js
│   └── summarize.js      ← AI summarization for a lead
│
├── prompts/              ← AI PROMPT TEXT (single source of truth)
│   ├── navigation.js     ← "How to turn user instructions into actions"
│   └── extraction.js     ← "How to turn a screenshot into JSON records"
│
├── engine/               ← UNIVERSAL PIPELINE (sector-agnostic: permits, jobs, real estate)
│   ├── index.js          ← Switchboard: runUniversalPipeline, shouldUseEngine
│   ├── hydrator.js       ← Date tokens: {{TODAY}}, {{DAYS_AGO_30}}
│   ├── transformer.js    ← Map API fields → your field names
│   ├── validator.js      ← Rule engine: >, <, ==, contains, etc.
│   ├── LogicEngine.js    ← Same as validator (blueprint API: rule.op, rule.val)
│   └── adapters/
│       ├── rest.js       ← JSON API fetch + hydrator
│       ├── arcgis.js     ← ArcGIS where clause + query
│       └── ai-vision.js  ← Playwright + screenshot + extractor
│
├── services/             ← Business logic (the real "engine" pieces)
│   ├── ai/               ← AI (Gemini) – navigation + extraction + summarize
│   │   ├── index.js      ← Bridge: exposes navigateAutonomously, extractFromScreenshot
│   │   ├── geminiClient.js
│   │   ├── navigator.js  ← Uses prompts/navigation.js
│   │   ├── extractor.js  ← Uses prompts/extraction.js
│   │   └── Alsummarize.js
│   │
│   ├── scraper/          ← Browser, screenshots, ArcGIS, API intercept
│   │   ├── arcgis.js     ← ArcGIS Hub + FeatureServer
│   │   ├── screenshot.js
│   │   ├── gridScrollScraper.js
│   │   ├── apiInterceptor.js
│   │   ├── stealth.js
│   │   ├── preventPopup.js
│   │   ├── progress.js
│   │   ├── rateLimiter.js
│   │   ├── helpers.js
│   │   ├── validation.js
│   │   └── ...
│   │
│   ├── leadInsertion.js   ← Insert lead + dedup
│   ├── deduplication.js
│   ├── sourceTable.js
│   ├── reliability.js
│   ├── notifications.js
│   └── scheduler/
│       └── cron.js       ← Auto-scrape schedule
│
├── utils/
│   ├── logger.js
│   └── validators.js
│
├── data/                 ← SQLite DB files (created at runtime)
└── logs/                 ← Log files
```

---

## 3. What Each Part Does (Plain English)

### Server & entry

- **index.js** – Starts Express, loads `.env`, connects DB, mounts all routes (auth, scrape, sources, leads, etc.), starts cron if enabled. This is the single process that runs when you `npm start`.
- **start.js** – Small script that runs `index.js` (or used by your start command).

### The main scraper (legacyScraper.js)

- **legacyScraper.js** – The **orchestrator**. For each source it:
  1. **If type = ArcGIS** → calls `services/scraper/arcgis.js` (no AI prompts).
  2. **Else if type = JSON (or ArcGIS-style URL)** → uses **axios** to hit the API and parse JSON (no browser, no AI).
  3. **Else** → launches **Playwright** (browser), optionally runs **AI navigation** (your `aiPrompt`), then **AI extraction** from screenshots, and inserts leads.

So one file decides **which path** each source takes. All "engine" behavior either lives here or is called from here.

### Config

- **config/** – Paths to DB/screenshots, extraction limits, env. Change behavior (e.g. max rows per source) here.

### Database

- **db/** – How we connect to SQLite and what tables exist. **models/** use this to read/write users, sources, and leads.

### Routes (API)

- **routes/** – Each file is a group of endpoints. Examples: `POST /api/scrape/start`, `GET /api/my-sources`, `GET /api/leads`. The frontend (HTML/JS) calls these.

### Prompts (AI text)

- **prompts/navigation.js** – System + user prompt that tell the AI how to turn "user instructions" into a list of actions (click, fill, select, etc.).
- **prompts/extraction.js** – Prompt that tells the AI how to turn a **screenshot** into a **JSON array of records** (using your field schema).

Only these two files define that AI behavior. **You did not lose control** – they are small and in one place.

### Services (the real "engine" logic)

- **services/ai/** – Talks to Gemini. **navigator** = follow user instructions on the page. **extractor** = get structured data from a screenshot. **Alsummarize** = summarize one lead (for the "Instant Analyze" button). **index.js** is the single bridge the scraper uses.
- **services/scraper/** – Playwright launch, stealth, screenshots, ArcGIS discovery, API interception, progress, rate limiting, helpers. **arcgis.js** is the full ArcGIS path (Hub URL → discover API → fetch records).
- **services/leadInsertion.js** – Inserts one lead and uses **deduplication** so we don’t store duplicates.
- **services/reliability.js** – Tracks success/failure per source.
- **services/scheduler/cron.js** – Runs automatic scrapes on a schedule if enabled.

---

## 4. What Happens When You Click "Scrape"

1. Frontend calls **POST /api/scrape/start** (or similar) → **routes/scrape.js**.
2. **scrape.js** loads the user’s sources and calls **legacyScraper.scrapeForUser(userId, sources, limits)**.
3. **legacyScraper.js** loops over each source:
   - **ArcGIS** → `fetchArcGISRecords()` in **services/scraper/arcgis.js** (uses `navigationInstructions` if set; no AI prompts).
   - **JSON** → **axios** request, parse response, map fields, **leadInsertion** for each record.
   - **Playwright** → Launch browser → optional **navigateAutonomously** (uses **prompts/navigation.js** + your **aiPrompt**) → take screenshots → **extractFromScreenshot** (uses **prompts/extraction.js**) → **leadInsertion** for each record.
4. Progress is updated via **services/scraper/progress.js**; frontend can poll for status.

So: **one entry (legacyScraper), three paths (ArcGIS / JSON / Playwright+AI).** All details are in the folders above.

---

## 5. Quick Reference: "I Want to Change…"

| I want to… | Edit this |
|------------|-----------|
| Change what the AI does for **navigation** (e.g. action types, tone) | `backend/prompts/navigation.js` |
| Change what the AI does for **extraction** (e.g. fields, rules) | `backend/prompts/extraction.js` |
| Change how **lead summarization** works (Instant Analyze) | `backend/services/ai/Alsummarize.js` |
| Change **ArcGIS** behavior (Hub, cookies, pagination) | `backend/services/scraper/arcgis.js` |
| Change **JSON API** parsing / field mapping | `backend/legacyScraper.js` (JSON block) and/or **routes/sources.js** |
| Change **scrape flow** (order of steps, when we use AI) | `backend/legacyScraper.js` |
| Change **rate limits**, **delays**, **max rows** | `backend/config/extractionLimits.js`, **services/scraper/rateLimiter.js** |
| Change **screenshots** (size, tiling, scroll) | `backend/services/scraper/screenshot.js`, **gridScrollScraper.js** |
| Change **deduplication** rules | `backend/services/deduplication.js` |
| Change **Universal Engine** rules (operators, dates) | `backend/engine/validator.js`, `backend/engine/hydrator.js` |
| Change **Engine adapters** (REST / ArcGIS / AI) | `backend/engine/adapters/*.js` |
| Change **API endpoints** (URLs, auth) | `backend/routes/*.js` |
| Change **DB schema** or tables | `backend/db/schema.js` |

---

## 6. Summary

- **Universal Engine** lives in **backend/engine/** (hydrator, transformer, validator, adapters). It runs when a source has `query_params`, `where_clause`, or manifest rules.
- **One main scraper**: `legacyScraper.js`; it runs the engine first when applicable, then falls back to ArcGIS / JSON / Playwright+AI per source.
- **AI prompts** live only in **backend/prompts/** (navigation + extraction); summarization is in **Alsummarize.js**.
- **ArcGIS** and **JSON** can use either the **engine** (with rules) or the legacy path (unchanged).

You have not lost control: everything is in this tree, and this file is your map. See **ENGINE-BLUEPRINT.md** for engine details.
