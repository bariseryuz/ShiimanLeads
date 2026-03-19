# Shiiman Leads — Master Guide

**One document that explains everything in your tool, one by one.**  
Use this to get back on track after building with an AI assistant.

---

## Table of contents

1. [What This Tool Is](#1-what-this-tool-is)
2. [How to Run It](#2-how-to-run-it)
3. [Project Layout (Folders)](#3-project-layout-folders)
4. [Backend: Piece by Piece](#4-backend-piece-by-piece)
5. [Frontend: What Each Page Does](#5-frontend-what-each-page-does)
6. [The Three Source Types](#6-the-three-source-types)
7. [Universal Engine (Filter & Map)](#7-universal-engine-filter--map)
8. [What Happens When You Click “Scrape”](#8-what-happens-when-you-click-scrape)
9. [AI: Prompts and Summarization](#9-ai-prompts-and-summarization)
10. [Find Endpoint (URL → API)](#10-find-endpoint-url--api)
11. [Configuration & Environment](#11-configuration--environment)
12. [Copy-Paste Reference](#12-copy-paste-reference)
13. [Where to Change What](#13-where-to-change-what)

---

## 1. What This Tool Is

**Shiiman Leads** is a **lead generation and data acquisition platform**. It:

- Lets users **add data sources** (APIs, ArcGIS, or websites).
- **Scrapes or fetches** data from those sources on a schedule or on demand.
- **Filters and maps** the data (e.g. “only last 30 days”, “rename API fields”).
- **Stores leads** in a database, with deduplication.
- Can **summarize** leads with AI (e.g. “Instant Analyze”).
- Exposes a **web UI** (login, sources, leads, scrape, profile) and **REST APIs**.

So: **add sources → run scrape → get qualified leads in one place.** It works for permits, jobs, real estate, or any sector where you pull structured data from URLs or APIs.

---

## 2. How to Run It

| Step | Command / Action |
|------|-------------------|
| Install backend deps | `cd backend` then `npm install` |
| Set secrets | Create `backend/.env` (see [Configuration](#11-configuration--environment)) |
| Start server | `npm start` or `node start.js` from `backend` |
| Open app | In browser: `http://localhost:3000` (or your deployed URL) |
| Login / Signup | Use the login and signup pages to create or use a user |

The backend serves both **API routes** (e.g. `/api/sources`, `/api/leads`) and **static frontend files** (HTML, JS, CSS).

---

## 3. Project Layout (Folders)

```
shiiman-leads/
├── backend/          ← All server logic, scraper, engine, DB, APIs
├── frontend/          ← HTML pages and static assets (login, my-sources, leads, etc.)
├── MASTER-GUIDE.md    ← This file
├── PROJECT-GUIDE.md   ← Short “where is what” reference
├── ENGINE-BLUEPRINT.md ← Universal Engine design
└── RAILWAY-DEPLOY.md  ← Deployment notes (e.g. Railway)
```

Everything that “runs” (scraping, saving leads, AI) lives under **backend/**.

---

## 4. Backend: Piece by Piece

### 4.1 Root files

| File | Role |
|------|------|
| **index.js** | Main server: loads `.env`, connects DB, mounts all routes (auth, scrape, sources, leads, profile, admin, stats, screenshots, summarize). Single entry point when you run the app. |
| **start.js** | Script that starts the server (often `node start.js` or `npm start`). |
| **legacyScraper.js** | **The main scraper.** Loops over each user source and decides: Universal Engine, ArcGIS, JSON API, or Playwright (browser + AI or API interception). All scraping flows go through here. |
| **.env** | Secrets and config: `GEMINI_API_KEY`, `DB_PATH`, `SESSION_SECRET`, etc. Not committed to git. |
| **package.json** | Node dependencies and scripts. |

### 4.2 config/

| File | Role |
|------|------|
| **paths.js** | Paths for database file, sessions DB, screenshots directory, logs. |
| **environment.js** | Reads `process.env` and exposes config (e.g. `NODE_ENV`, DB path). |
| **extractionLimits.js** | Default limits (e.g. max pages per source, max total rows). Used to cap how much we scrape per run. |

### 4.3 db/

| File | Role |
|------|------|
| **connection.js** | Creates the SQLite database connection. |
| **database.js** | DB setup and initialization. |
| **schema.js** | Defines tables: `users`, `user_sources`, `leads`, `notifications`, `source_reliability`, etc. Creates tables if they don’t exist. |
| **index.js** | Exports `db`, `dbRun`, `dbAll`, `dbGet`, and session DB for the rest of the app. |

### 4.4 middleware/

| File | Role |
|------|------|
| **auth.js** | Session-based auth: attaches the current user to the request (e.g. `req.session.user`). Protects routes that require login. |
| **errorHandler.js** | Global error handler for the Express app (e.g. log errors, return 500 JSON). |

### 4.5 models/

| File | Role |
|------|------|
| **User.js** | User model (find by id, email, create user, etc.). |
| **Source.js** | Source model (create, update, validate source config). |
| **Lead.js** | Lead model (access to lead data per user/source). |
| **index.js** | Re-exports models. |

### 4.6 routes/

These are the **API endpoints** the frontend calls.

| File | Role |
|------|------|
| **auth.js** | Login, signup, logout. Also serves login/signup HTML pages. |
| **scrape.js** | Start scrape, stop scrape, get progress. Loads user’s sources and calls `legacyScraper.scrapeForUser(...)`. |
| **sources.js** | CRUD for sources: list, get one, add, update, delete. Also **discover-endpoint** (find API URL from a page URL) and **sample** (fetch sample data for a source). |
| **leads.js** | List leads, export, filter by source. |
| **leads-api.js** | Additional lead-related API (if any). |
| **summarize.js** | AI summarization for a lead (e.g. “Instant Analyze” button). Calls the AI summarizer service. |
| **profile.js** | Get/update user profile. |
| **admin.js** | Admin-only routes (e.g. list users, manage sources for a user). |
| **stats.js** | Stats and notifications for the current user. |
| **screenshots.js** | Serve or list screenshots saved during scraping (for debugging or UI). |

### 4.7 prompts/

| File | Role |
|------|------|
| **navigation.js** | **AI prompt text** for “navigation” agent: turns user instructions (e.g. “click Search”) into a list of Playwright actions (click, fill, select, wait). Used when the AI drives the browser. |
| **extraction.js** | **AI prompt text** for “extraction” agent: tells the AI how to turn a **screenshot** into a **JSON array of records** (with field names from your schema). Used when we take a screenshot and ask the AI to extract table-like data. |

Only these two files define that AI behavior; no prompts are hardcoded elsewhere for nav/extraction.

### 4.8 engine/ (Universal Pipeline)

Sector-agnostic **fetch → transform → validate** pipeline. Used when a source has `query_params`, `where_clause`, or `manifest` with rules.

| File | Role |
|------|------|
| **index.js** | **Switchboard:** `runUniversalPipeline(source)` and `shouldUseEngine(source)`. Picks adapter (rest, arcgis, ai-vision) and runs transform + validate. |
| **hydrator.js** | Replaces date tokens in params: `{{TODAY}}`, `{{DATE_30_DAYS_AGO}}`, `{{DAYS_AGO_30}}`, etc. |
| **transformer.js** | Maps API field names to your names using `field_mapping` (e.g. `EST_COST_AMT` → `budget`). |
| **validator.js** | **Rule engine:** checks each lead against `filters` (e.g. `budget > 50000`, `days_ago` on a date field). Only leads that pass all rules are kept. |
| **LogicEngine.js** | Thin wrapper around the validator for the “blueprint” API (e.g. `rule.op`, `rule.val`). Same logic as validator. |
| **adapters/rest.js** | Fetches from JSON/REST APIs. GET or POST; supports `query_params` (or body for POST). Hydrates params and returns array from response (e.g. `data.Data`, `data.results`). |
| **adapters/arcgis.js** | Builds ArcGIS `where` from `where_clause` or `rules`; GET `.../query` with `f=json`, `outFields=*`; returns `features[].attributes`. Hydrator runs on params so `{{DATE_30_DAYS_AGO}}` works in where clause. |
| **adapters/ai-vision.js** | For “no API” websites: launches Playwright, goes to URL, takes screenshot, calls **services/ai** `extractFromScreenshot`, returns array of records. |

### 4.9 services/

Business logic used by routes and the scraper.

| File | Role |
|------|------|
| **leadInsertion.js** | Inserts one lead (with deduplication). Used after every successful scrape record. |
| **deduplication.js** | Decides if a lead is “new” or duplicate (e.g. by hash, unique_id, source). |
| **sourceTable.js** | Creates per-source tables (`source_1`, `source_2`, …) and inserts rows. Optional; main lead storage is the universal `leads` table. |
| **reliability.js** | Tracks success/failure per source (e.g. for “reliability %” in UI). |
| **notifications.js** | Creates in-app notifications for the user (e.g. “Source added”, “Scrape completed”). |
| **endpointDiscovery.js** | **Find endpoint from URL:** given a page or API URL, detects if it’s already an endpoint, or resolves ArcGIS Hub to query URL, or opens the page in Playwright and listens for XHR/fetch to `_Get*`, `/query`, etc. Returns the discovered endpoint URL. Used by the “Find endpoint” button. |

### 4.10 services/ai/

| File | Role |
|------|------|
| **index.js** | Bridge: exposes `isAIAvailable`, `extractFromScreenshot`, `navigateAutonomously`, etc. Used by legacyScraper and engine. |
| **geminiClient.js** | Talks to Google Gemini API (API key, model selection). |
| **navigator.js** | **Navigation agent:** takes user instructions + screenshot, uses **prompts/navigation.js**, returns a list of Playwright actions; can execute them on the page. |
| **extractor.js** | **Extraction agent:** takes screenshot + field schema, uses **prompts/extraction.js**, returns JSON array of records. |
| **Alsummarize.js** | **Summarization:** takes one lead (object), builds a text prompt, calls Gemini, returns a short summary. Used by “Instant Analyze” and optionally for “gold” leads. |

### 4.11 services/scraper/

| File | Role |
|------|------|
| **arcgis.js** | Full ArcGIS path: open Hub URL in Playwright, capture API URL and cookies (`extractArcGISApiInfo`), then fetch records from that API. Also exports `discoverArcGISEndpoint` for the universal “Find endpoint” flow. |
| **screenshot.js** | Captures full-page or tiled screenshots (for AI extraction). |
| **gridScrollScraper.js** | For wide tables: scroll and capture multiple screenshots, then extract from each. |
| **apiInterceptor.js** | Listens for XHR/fetch on a page (e.g. `_GetIssuedPermitData`); when the right request is seen, captures the response and extracts records. Used for “Playwright + API interception” (e.g. Phoenix permit page). |
| **stealth.js** | Playwright launch options and scripts to reduce “bot” detection. |
| **preventPopup.js** | Handles popups and cookie banners (e.g. ArcGIS cookie acceptance). |
| **progress.js** | Tracks scrape progress (current source, errors) so the UI can show “Scraping source X”. |
| **rateLimiter.js** | Per-source rate limiting and backoff (e.g. after 429 or block). |
| **helpers.js** | Shared helpers: `replaceDynamicDates`, `parseDate`, `textPassesFilters`, `getNestedProp`, etc. |
| **validation.js** | Validates extracted data (e.g. required fields, format). |
| **timings.js** | Timeouts and wait durations used across the scraper. |

### 4.12 services/scheduler/

| File | Role |
|------|------|
| **cron.js** | Optional scheduled scrapes (e.g. run scrape for all users on a schedule). |

### 4.13 utils/

| File | Role |
|------|------|
| **logger.js** | App-wide logger (e.g. to console and log files). |
| **validators.js** | Input validation helpers. |

---

## 5. Frontend: What Each Page Does

| Page | Purpose |
|------|---------|
| **login.html** | User login. |
| **signup.html** | User registration. |
| **index.html** | Landing or home (e.g. marketing). |
| **my-sources.html** | **Main UI:** list sources, add/edit/delete source, set source type (AI Website, ArcGIS, JSON API), Query Parameters, Universal Engine (field mapping, filters, where clause), Find endpoint button, run scrape, view leads. |
| **manage-sources.html** | Alternative/simpler source management (add source with method, AI prompts, etc.). |
| **client-portal.html** | Client-facing portal (sources, leads, scrape). |
| **profile.html** | User profile and settings. |
| **admin-dashboard.html** | Admin: users, sources, support. |

The **primary** place to manage sources and run scrapes is **my-sources.html**.

---

## 6. The Three Source Types

When you add a source, you pick one of three **scraping methods**:

| Type | What it is | When it’s used |
|------|------------|----------------|
| **AI Website Scraper** | No direct API: open URL in a browser, optionally run AI navigation from your instructions, take screenshots, extract data with AI. | Any normal website (e.g. permit search pages, directories) where you don’t have an API. |
| **ArcGIS Hub (Auto API)** | You paste an ArcGIS Hub/datasets/explore URL. The app opens it, finds the real ArcGIS API URL and cookies, then fetches data via that API. | Government or org sites that use ArcGIS Hub. |
| **JSON API** | You paste a direct API URL (e.g. REST or ArcGIS `.../query`). The app sends HTTP GET (or POST with body) and parses JSON. | When you already have an endpoint (or used “Find endpoint” to get it). |

**Important:** If you set type to **ArcGIS** but the URL doesn’t look like ArcGIS (e.g. Phoenix `_GetIssuedPermitData`), the app **automatically** uses **Playwright + API interception** instead of the ArcGIS Hub pipeline, so the right request is still captured.

---

## 7. Universal Engine (Filter & Map)

The **Universal Engine** is optional. When enabled for a source, it:

1. **Fetches** data (via the right adapter: REST, ArcGIS, or AI vision).
2. **Transforms** using **field mapping** (API key → your key).
3. **Validates** using **filters** (e.g. `budget > 50000`, `days_ago` on a date).
4. Only **saves** leads that pass all filters.

**Where you set it (in Add/Edit Source):**

- **Use Universal Engine for this source** — checkbox.
- **Field mapping (JSON)** — e.g. `{"EST_COST_AMT": "budget", "ADDR": "address"}`. Do **not** put request params (like `StartDate`) here.
- **Filters (JSON)** — e.g. `[{"field": "budget", "operator": ">", "value": 50000}, {"field": "IssueDate", "operator": "days_ago", "value": 30}]`.
- **ArcGIS where clause** — only for ArcGIS: SQL-like condition, e.g. `ApplicationDate >= '{{DATE_30_DAYS_AGO}}'`.

**Request params (e.g. last 30 days) for JSON API** go in **Query Parameters (JSON)** in the JSON API section, e.g. `{"StartDate": "{{DATE_30_DAYS_AGO}}", "EndDate": "{{TODAY}}"}`.

---

## 8. What Happens When You Click “Scrape”

1. Frontend calls **POST /api/scrape/start** (or equivalent).
2. **scrape.js** loads the current user’s sources from the DB and calls **legacyScraper.scrapeForUser(userId, sources, limits)**.
3. **legacyScraper.js** loops over each source:
   - If **engine.shouldUseEngine(source)** → run **engine.runUniversalPipeline(source)** and insert each returned lead; then next source.
   - Else if **source.type === 'arcgis'** and URL **looks like** ArcGIS → run **fetchArcGISRecords** (Hub → API + fetch).
   - Else if **source.type === 'arcgis'** but URL **does not** look like ArcGIS → use **Playwright + API interception** (open page, trigger request, capture response).
   - Else if **source** is **JSON API** (and not engine) → **axios** GET/POST to URL with params; parse response; insert leads.
   - Else **Playwright**: open URL, optionally run AI navigation from `aiPrompt`, take screenshots, run AI extraction, insert leads. Or use API interception if no AI prompt and force Playwright.
4. For each inserted lead, **leadInsertion** + **deduplication** decide if it’s new; **reliability** and **progress** are updated.
5. When done, the UI can show “Scrape complete” and updated lead counts.

---

## 9. AI: Prompts and Summarization

- **Navigation:** User instructions (e.g. “Click Search”) are sent with a screenshot to Gemini. The **prompt** is built in **prompts/navigation.js**. The **navigator** (services/ai/navigator.js) turns the reply into Playwright actions (click, fill, select, wait).
- **Extraction:** A screenshot and your **field schema** are sent to Gemini. The **prompt** is built in **prompts/extraction.js**. The **extractor** (services/ai/extractor.js) parses the reply into a JSON array of records.
- **Summarization:** A single lead (object) is sent to Gemini with a text prompt built in **services/ai/Alsummarize.js**. Used for “Instant Analyze” (and optionally for high-value leads). No separate prompt file; the prompt is inside that class.

All of this requires **GEMINI_API_KEY** in `.env`.

---

## 10. Find Endpoint (URL → API)

- **Where:** “Find endpoint” button next to the **Website URL** field on the Add/Edit Source form (**my-sources.html**).
- **What it does:** Sends the current URL to **POST /api/sources/discover-endpoint**. The backend (**services/endpointDiscovery.js**):
  - If the URL already looks like an API (e.g. `_Get`, `/query`, FeatureServer) → returns it as-is.
  - If it looks like an ArcGIS Hub URL → uses **discoverArcGISEndpoint** to resolve the real query URL.
  - Otherwise → opens the URL in Playwright, listens for XHR/fetch to `_Get*`, `/query`, `/api/*`, and returns the first matching request URL.
- **Result:** The URL field is updated to the discovered endpoint (if any), and the source type may be set to ArcGIS or JSON based on the response.

---

## 11. Configuration & Environment

**backend/.env** (create from `.env.example` if present):

| Variable | Purpose |
|----------|---------|
| **GEMINI_API_KEY** | Required for AI (navigation, extraction, summarization). |
| **DB_PATH** | Path to main SQLite DB (e.g. `./data/leads.db`). |
| **SESSIONS_DB_PATH** | Path to sessions DB (e.g. `./data/sessions.db`). |
| **SESSION_SECRET** | Secret for signing session cookies. Use a long random string in production. |
| **SCREENSHOTS_DIR** | Directory to save screenshots (optional). |
| **NODE_ENV** | `production` or `development`. |
| **AUTO_SCRAPE_ON_ADD** | If `true`, run a scrape when a new source is added (optional). |

Other config (paths, limits) is in **config/** and may read from `process.env`.

---

## 12. Copy-Paste Reference

**Date tokens (in Query Parameters or ArcGIS where clause):**

- `{{TODAY}}` — today’s date (YYYY-MM-DD).
- `{{DATE_30_DAYS_AGO}}` or `{{DAYS_AGO_30}}` — date 30 days ago.
- `{{DATE_7_DAYS_AGO}}`, `{{DATE_365_DAYS_AGO}}` — 7 days ago, 365 days ago.

**Query Parameters (JSON) for “last 30 days”:**

```json
{"StartDate": "{{DATE_30_DAYS_AGO}}", "EndDate": "{{TODAY}}"}
```

**Filters (last 30 days on a date field):**

```json
[{"field": "IssueDate", "operator": "days_ago", "value": 30}]
```

**Filter operators:** `>`, `<`, `>=`, `<=`, `==`, `!=`, `contains`, `in`, `between`, `days_ago`.

**Field mapping (API → your name):**

```json
{"EST_COST_AMT": "budget", "ADDR": "address"}
```

**ArcGIS where clause (optional):**

```text
ApplicationDate >= '{{DATE_30_DAYS_AGO}}'
```

---

## 13. Where to Change What

| If you want to… | Edit this |
|-----------------|-----------|
| Change AI navigation behavior | **backend/prompts/navigation.js** |
| Change AI extraction behavior | **backend/prompts/extraction.js** |
| Change lead summary prompt | **backend/services/ai/Alsummarize.js** |
| Change Universal Engine rules (operators, dates) | **backend/engine/validator.js**, **backend/engine/hydrator.js** |
| Change how we call JSON/ArcGIS/AI APIs | **backend/engine/adapters/rest.js**, **arcgis.js**, **ai-vision.js** |
| Change main scrape flow (order, when to use engine) | **backend/legacyScraper.js** |
| Change “Find endpoint” logic | **backend/services/endpointDiscovery.js** |
| Change source/lead APIs | **backend/routes/sources.js**, **leads.js** |
| Change Add Source form or Find endpoint button | **frontend/my-sources.html** |
| Change DB schema or tables | **backend/db/schema.js** |
| Change limits (pages, rows per source) | **backend/config/extractionLimits.js** |

---

**You’re done.** This document plus **PROJECT-GUIDE.md** and **ENGINE-BLUEPRINT.md** give you full coverage of what the tool does and where everything lives. Use **MASTER-GUIDE.md** as your main “learn everything one by one” reference.
