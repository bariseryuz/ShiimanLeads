# Engine & Prompts Reference

Quick reference for where the lead-generation "engine" and AI prompts live. **No conflicting prompt definitions.** This doc clarifies ArcGIS, JSON API, and other source types.

---

## Source types and which path they use

| Source type | Code path |                                Uses AI prompts?               | Uses `aiPrompt`? |
|-------------|-----------|------------------|------------------|
| **ArcGIS** (`type === 'arcgis'`) | `legacyScraper.js` → `fetchArcGISRecords()` (arcgis.js) | No | No |
| **JSON API** (`type === 'json'`) | `legacyScraper.js` → axios HTTP request | No | No |
| **Playwright / AI Website** | `legacyScraper.js` → Playwright → `navigateAutonomously()` + `extractFromScreenshot()` | Yes | Yes (user instructions) |

- **ArcGIS** and **JSON API** never use the navigation or extraction prompts, and the UI hides the "AI Prompt" section for them (`my-sources.html`: `aiPromptSection` hidden when `isJsonApi || isArcGIS`).
- **ArcGIS** uses optional **navigation instructions** in **structured JSON** (click, fill, wait with selectors), not natural-language `aiPrompt`. Stored in `source.navigationInstructions`, edited in the "ArcGIS Hub Setup" → "Navigation Instructions (JSON)" field.

So: **ArcGIS or other (e.g. JSON) option = different pipeline, no conflict with prompts.**

---

## Engine (scraper) flow

| Role | File(s) | Notes |
|------|--------|--------|
| **Main entry** | `backend/legacyScraper.js` | Branches by source type: ArcGIS first, then JSON API, then Playwright. Uses `source.aiPrompt` only in Playwright branch. |
| **ArcGIS** | `backend/services/scraper/arcgis.js` | `fetchArcGISRecords()`, `extractArcGISApiInfo()`. Uses `source.navigationInstructions` (JSON), not prompts. |
| **Scraper helpers** | `backend/services/scraper/` | Progress, rate limit, screenshots, validation, helpers. |
| **AI bridge** | `backend/services/ai/index.js` | Exposes `navigateAutonomously`, `extractFromScreenshot`, `isAIAvailable`. |
| **Navigation agent** | `backend/services/ai/navigator.js` | Uses **prompts from** `backend/prompts/navigation.js`. |
| **Extraction agent** | `backend/services/ai/extractor.js` | Uses **prompts from** `backend/prompts/extraction.js`. |
| **Summarizer** | `backend/services/ai/Alsummarize.js` | Builds its own prompts inline (lead summaries only). |

---

## Where prompts are defined

| Purpose | Definition | Used by |
|--------|------------|---------|
| **Navigation** (screenshot → JSON actions) | `backend/prompts/navigation.js` | `services/ai/navigator.js` only |
| **Extraction** (screenshot → JSON records) | `backend/prompts/extraction.js` | `services/ai/extractor.js` only |
| **Summarization** (lead → text summary) | `backend/services/ai/Alsummarize.js` (`buildPrompt`) | Summarizer only |

ArcGIS and JSON API do not use these files.

---

## User-facing “AI instructions” vs ArcGIS instructions

| Source type | UI field(s) | Backend field(s) | Used by |
|-------------|-------------|------------------|---------|
| **AI Website Scraper** | "AI Prompt" (my-sources) or "AI Navigation Prompts" (manage-sources) | `source.aiPrompt` | `navigateAutonomously()` in Playwright path |
| **ArcGIS** | "Navigation Instructions (JSON)" | `source.navigationInstructions` | `extractArcGISApiInfo(..., navigationInstructions)` in arcgis.js |
| **JSON API** | (none for navigation) | — | Axios only |

So: **ArcGIS or other option** (JSON, etc.) use their own config; only the Playwright/AI path uses `aiPrompt` and the prompt templates.
