# Universal Engine – Blueprint & Integration

This is the **Universal Data Acquisition** pipeline: sector-agnostic fetch → transform → validate. It runs when a source has **query_params** (JSON), **where_clause** (ArcGIS), or **manifest** with rules.

---

## 1. When the Engine Runs

In **legacyScraper.js**, at the start of each source:

- If **engine.shouldUseEngine(source)** is true → run **engine.runUniversalPipeline(source)** and save leads; then `continue` (skip legacy path).
- Otherwise → run the existing ArcGIS / JSON / Playwright paths as before.

**Triggers for the engine:**

- `source.query_params` (object) – e.g. from “Use Universal Engine” + Query params for JSON.
- `source.where_clause` (string) – e.g. from “Use Universal Engine” for ArcGIS (use **direct query URL**, not Hub URL).
- `source.manifest` with `query_params`, `where_clause`, or `filters`.

---

## 2. Pipeline Flow

1. **Choose adapter** by `source.type`: `json` → rest, `arcgis` → arcgis, `html`/`playwright` (+ ai_instructions) → ai-vision.
2. **Fetch**: adapter uses `url` + manifest (hydrator replaces `{{TODAY}}`, `{{DAYS_AGO_30}}` in params).
3. **Transform**: map API keys to your keys via `field_mapping` (e.g. `EST_COST_AMT` → `budget`).
4. **Validate**: run **validator** with `filters` (e.g. `budget > 50000`). Only passing leads are returned.
5. **Save**: legacyScraper calls **insertLeadIfNew** for each returned lead (same as legacy).

---

## 3. Files

| File | Role |
|------|------|
| **engine/index.js** | `runUniversalPipeline(source)`, `shouldUseEngine(source)`; picks adapter and runs transform + validate. |
| **engine/hydrator.js** | Replaces `{{TODAY}}`, `{{DAYS_AGO_N}}`, `{{DATE_30_DAYS_AGO}}` etc. in params. |
| **engine/transformer.js** | Maps raw record using `field_mapping` (API key → your key). |
| **engine/validator.js** | Rule engine: `>`, `<`, `==`, `contains`, `in`, `between`, `days_ago`. |
| **engine/LogicEngine.js** | Wraps validator with blueprint API (`rule.op`, `rule.val`). |
| **engine/adapters/rest.js** | GET with `query_params` (hydrated); returns array of items. |
| **engine/adapters/arcgis.js** | Builds `where` from `where_clause` or `rules`; GET .../query; returns `features[].attributes`. |
| **engine/adapters/ai-vision.js** | Playwright → screenshot → **services/ai** extractFromScreenshot; returns array. |

---

## 4. UI Integration (my-sources.html)

For **JSON API** and **ArcGIS** sources:

- **“Universal Engine”** section:
  - Checkbox: **Use Universal Engine for this source**.
  - **Field mapping** (JSON): `{"API_FIELD": "our_field"}`.
  - **Filters** (JSON): `[{"field": "budget", "operator": ">", "value": 50000}]`.
  - **ArcGIS only**: optional **where clause** (e.g. `EST_COST > 50000`).

On save:

- **JSON**: if “Use Universal Engine” checked → set `query_params = params`, `field_mapping`, `filters` (and optionally `fieldSchema` from mapping for table creation).
- **ArcGIS**: if checked → set `where_clause`, `field_mapping`, `filters`.

On load (edit): engine checkbox, field mapping, filters, and where clause are restored from `source.data`.

---

## 5. Backend Integration

- **routes/sources.js**  
  - POST add / POST (my-sources): when saving, **createSourceTable** uses **fieldSchema** or, if missing, columns derived from **field_mapping** values so engine leads have the right columns.  
  - PUT update: same logic so table columns stay in sync with `field_mapping`.

- **legacyScraper.js**  
  - Requires **engine**; first step per source is “if engine.shouldUseEngine → run engine, insert leads, continue”.

- **scrape.js**  
  - No change: still loads sources and calls **scrapeForUser(userId, userSources, limits)**. Engine is used inside **scrapeForUser** when applicable.

---

## 6. Manifest Shape (what the engine expects)

- **query_params**: object for REST (e.g. `{ "where": "1=1", "resultRecordCount": 1000 }`). Strings can use `{{TODAY}}`, `{{DAYS_AGO_30}}`.
- **where_clause**: string for ArcGIS (e.g. `EST_COST > 50000`).
- **field_mapping**: `{ "API_KEY": "our_key" }`.
- **filters**: `[ { "field": "our_key", "operator": ">", "value": 50000 } ]`.
- **params** (legacy): for JSON, engine uses `params` as `query_params` when `query_params` is not set (inside runUniversalPipeline).
- **ai_instructions** / **aiPrompt**: for ai-vision adapter.
- **field_schema** / **fieldSchema**: for AI extraction and table creation.

---

## 7. ArcGIS Note

The engine’s ArcGIS adapter expects a **direct query URL** (e.g. `.../FeatureServer/0/query`). For **Hub URLs** (explore/datasets), keep using the **legacy** ArcGIS path (no “Use Universal Engine”); use the engine with ArcGIS when you have a query endpoint and optional **where_clause** / **field_mapping** / **filters**.

---

## 8. Summary

- **One pipeline** for any sector: Fetch → Transform → Validate.
- **Opt-in**: engine runs only when `query_params`, `where_clause`, or manifest rules are set.
- **Legacy unchanged**: sources without those use the existing ArcGIS / JSON / Playwright flows.
- **UI**: “Universal Engine” in Add/Edit Source (JSON + ArcGIS) saves and loads `query_params` / `where_clause`, `field_mapping`, `filters`.
- **Tables**: backend creates/updates source tables from **field_mapping** when **fieldSchema** is not provided.

For full project layout and “where to change what”, see **PROJECT-GUIDE.md**.
