# Shiiman Leads — data-based lead generation (permits, jobs, listings)

## What problem this solves
You need **fresh, qualified leads** from places that don’t offer clean exports (websites, ArcGIS portals, JSON APIs). Shiiman Leads lets you add sources, scrape/fetch them reliably, and keep everything in one place.

## Who it’s for
- Operators, agencies, and teams who need **repeatable** lead acquisition
- Anyone sourcing leads from **web pages, ArcGIS Hub, or JSON APIs**

## 3 core benefits
- **Outcome-first scraping**: add a source → click scrape → get leads (no selectors required for website sources)
- **Multiple source types**: AI Website (Playwright + Gemini), ArcGIS Hub auto-discovery, direct JSON API
- **Filter & map at ingestion**: optional Universal Engine to normalize fields and keep only leads that match your rules

## Quick start (local) — copy/paste

### 1) Install + run (backend serves the frontend)

```bash
cd shiiman-leads/backend
npm install
npm start
```

Open `http://localhost:3000`.

### 2) Required environment variables

Create `shiiman-leads/backend/.env`:

```bash
# Required for logins/sessions (set a real secret in production)
SESSION_SECRET=change-me-please-strong-random

# Required if you use AI Website scraping or AI summarization
GEMINI_API_KEY=your-gemini-key

# Optional: override SQLite locations (defaults to backend/data/*.db in dev)
# SQLITE_DB_PATH=./data/shiiman-leads.db
# SQLITE_SESSIONS_DB_PATH=./data/sessions.db

# Optional: Playwright
# PLAYWRIGHT_HEADLESS=true
```

If you want a template, see `.env.example`.

## Common source setup examples (copy/paste JSON)
These examples map to the “Add Source” UI in `frontend/my-sources.html` (source type + URL + optional engine config).

### ArcGIS (Hub URL, auto API discovery)
Use when you have a dataset/explore page and want the app to find the real API.

```json
{
  "name": "City permits (ArcGIS Hub)",
  "type": "arcgis",
  "url": "https://example-city-hub-portal.example.com/datasets/permits/explore",
  "useEngine": false
}
```

### JSON API (direct endpoint + query params)
Use when you already have an endpoint (or you used “Find endpoint”).

```json
{
  "name": "Permits API (last 30 days)",
  "type": "json",
  "url": "https://example.gov/api/permits",
  "query_params": { "StartDate": "{{DATE_30_DAYS_AGO}}", "EndDate": "{{TODAY}}" }
}
```

### AI Website (plain-English instructions + field schema)
Use when there’s no stable API and you need browser automation + extraction.

```json
{
  "name": "Permit search website (AI)",
  "type": "html",
  "url": "https://example.gov/permits/search",
  "ai_instructions": "Open the permits table, go through all pages, and extract each row.",
  "field_schema": ["permit_number", "address", "contractor_name", "phone", "issue_date"]
}
```

## Troubleshooting
- **Missing `GEMINI_API_KEY`**: AI Website scraping and “Instant Analyze” require it. Add it to `backend/.env` and restart.
- **Playwright browser not installed**: run from `shiiman-leads/backend`:

```bash
npx playwright install chromium
```

- **Empty extraction results (AI Website)**:
  - Try more explicit `ai_instructions` (“click Search”, “set rows-per-page to 100”, “extract from every page”).
  - Ensure `field_schema` matches what’s visible on the page (use fewer fields first, then expand).
- **Endpoint discovery misses**:
  - Some sites hide data behind unusual requests; try clicking the site’s “Search” once manually, then re-run “Find endpoint”.
  - If you can locate a real endpoint, use the JSON API source type and paste it directly.

## Docs (keep README short)
- **How everything works**: `MASTER-GUIDE.md`
- **Universal Engine design**: `ENGINE-BLUEPRINT.md`
- **Project layout**: `PROJECT-GUIDE.md`
- **Deploy**: `RAILWAY-DEPLOY.md`
- **Filters & limits**: `FILTERS-AND-LIMITS.md`
