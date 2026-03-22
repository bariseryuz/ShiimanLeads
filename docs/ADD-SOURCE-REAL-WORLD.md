# Adding a source: real-world scenarios (what to type where)

This doc is the **plain-English** companion to [FILTERING-ARCHITECTURE.md](./FILTERING-ARCHITECTURE.md).  
It walks through **My Sources → + Add Source** as if you’re doing it for a real customer.

---

## First: picture three “doors” (so the jargon clicks)

| Door | Plain English | Where in the app |
|------|----------------|------------------|
| **① Ask the API for less** | “Server, only send me rows from the last 30 days” or “only permits over $50k” | **Query Parameters (JSON)** and/or **ArcGIS where clause** |
| **② Rename & keep only good rows** | “Call this column `budget`, then **don’t save** the row unless my rules pass” | **Universal Engine** → Field mapping + Filters (JSON) |
| **③ Browse what you already saved** | “Show me only this source / last 7 days / search ‘Phoenix’” | **Dashboard** (Client portal) — does **not** change scraping |

**②** only runs when the **Universal Engine** is in play (JSON API / ArcGIS with engine fields).  
**AI Website** mode mostly uses **①** in a different way: your **AI Instructions** tell the bot what to click and what to extract — there is no separate “Filters JSON” path for that mode in the same way.

---

## Scenario A — “City permit API” (JSON): big budgets only, last 90 days

**Story:** Riverside County has a public ArcGIS **query** URL (or any JSON API) that returns permits. You want:

- Only records from roughly the **last 90 days** (at the API level, to save bandwidth).
- Only saves leads where **project value &gt; $75,000** (your business rule, after field names are normalized).

### Step-by-step — what you type where

1. **Source Name**  
   `Riverside County — building permits`

2. **Website URL**  
   Paste the **full API URL** (often ends in `/query` for ArcGIS FeatureServer).  
   *Example shape:* `https://gis.county.gov/arcgis/rest/services/Permits/FeatureServer/0/query`

3. **Scraping Method**  
   Select **📡 JSON API (ArcGIS, REST APIs)**.

4. **HTTP Method**  
   Usually **GET** (sometimes POST — match what the API docs say).

5. **Query Parameters (JSON)** — *this is door ①*  
   You’re telling the **remote server** what slice of data to return. Example for a typical ArcGIS query layer:

   ```json
   {
     "where": "PermitDate >= date '2024-01-01'",
     "outFields": "*",
     "f": "json",
     "resultRecordCount": 2000
   }
   ```

   For **rolling dates**, you can use **tokens** that get filled in at scrape time (see [hydrator](../backend/engine/hydrator.js)):

   ```json
   {
     "where": "1=1",
     "outFields": "*",
     "f": "json",
     "resultRecordCount": 1000
   }
   
   

   (You’d tighten `where` once you know the real date field name from the dataset.)

6. **Check “Use Universal Engine for this source”**  
   So your params are wired for the engine pipeline.

7. **Field mapping (JSON)** — *left = API field name, right = **your** name*  
   Suppose the API returns attributes like `VAL_EST`, `SITE_ADDR`, `PERMIT_NO`:

   ```json
   {
     "VAL_EST": "project_value",
     "SITE_ADDR": "address",
     "PERMIT_NO": "permit_number"
   }
   ```

8. **Filters (only save leads that pass) JSON** — *this is door ②*  
   Use the names from the **right** side of the mapping (`project_value`, not `VAL_EST`):

   ```json
   [
     { "field": "project_value", "operator": ">", "value": 75000 }
   ]
   ```

9. **Include / Exclude keywords** (optional)  
   These are **notes** on the card today — they do **not** auto-filter in the backend. For real filtering, use **Filters JSON** above.

10. Click **Save Source**, then **Scrape** on the card.

**What happens in order:**  
Server returns rows → engine renames fields → **every** filter rule must pass → lead is saved.

---

## Scenario B — ArcGIS **Hub** page (explore URL), not the raw `/query` URL

**Story:** You only have the pretty **Hub “Explore”** link, e.g. `https://data.city.gov/datasets/building-permits/explore`.

### What you type where

1. **Source Name** — `City building permits (Hub)`
2. **Website URL** — paste the **Hub explore** URL (the long browser URL).
3. **Scraping Method** — **🗺️ ArcGIS Hub (Auto API)**.
4. **Navigation Instructions** — only if the page needs a click before data loads, e.g. “Table” tab:

   ```json
   [{"type": "click", "selector": ".nav-table", "waitAfter": 2000}]
   ```

5. **Universal Engine** (green box — appears for ArcGIS too):
   - **ArcGIS where clause** — door ①, server-side filter, e.g. `EST_COST > 50000 AND STATUS <> 'Withdrawn'`
   - **Field mapping** — same idea as Scenario A
   - **Filters JSON** — door ②, rules on **mapped** names

6. Save → Scrape.

The app discovers the real API behind the Hub; **where** + **filters** still follow the same mental model.

---

## Scenario C — Normal website (no public API): “AI Website Scraper”

**Story:** The data is only on a **searchable web table** — no JSON endpoint you trust.

### What you type where

1. **Scraping Method** — **🤖 AI Website Scraper (Default)**.
2. **Website URL** — the **page** where the table lives (search results URL if you have one).
3. **AI Instructions** — *this is your “filter” in plain language*:

   > Open the Building Permits search, set date range to the last 90 days, click Search, then extract every row from the results table across all pages. Skip cancelled permits.

4. **What fields do you want to extract?** — comma list:

   `permit number, address, owner, value, issue date, contractor`

5. **Universal Engine** (green box) is **hidden** for this mode in the UI — you’re not pasting JSON rules here; the **AI prompt** + field list drive extraction.

6. **Include / Exclude keywords** — optional notes only (not enforced server-side for this path).

7. Save → Scrape.

**Door ② (JSON filters)** in the engine sense usually **doesn’t** apply the same way here because the pipeline is Playwright + AI extraction, not the JSON/ArcGIS engine path—unless you’ve configured a source that still hits `runUniversalPipeline` (advanced). For most users, **filtering = writing a clear AI instruction**.

---

## Scenario D — “Only leads from the last 30 days” (two ways)

| Approach | Where | Example |
|----------|--------|--------|
| **A. API does the date work** | Query params / `where` | `where`: `IssueDate >= date '...'` or use `{{DAYS_AGO_30}}` in strings the API accepts |
| **B. You filter after fetch** | Filters JSON | `{ "field": "IssueDate", "operator": "days_ago", "value": 30 }` — **field** must exist after mapping, and must be a **parseable date** |

Use **A** when possible (less data over the wire). Use **B** when the API can’t express the rule.

---

## Cheat sheet — “I want … → I put it in …”

| I want… | I put it in… |
|---------|----------------|
| Fewer rows from the government API | **Query Parameters (JSON)** or **ArcGIS where clause** |
| Rename ugly column names to `budget`, `address` | **Field mapping (JSON)** |
| Only save rows where budget &gt; 50k | **Filters (JSON)** — and use the name `budget` after mapping |
| Only save rows whose address contains “Downtown” | **Filters** — `contains` on the mapped field |
| Rolling “last N days” in the **saved** lead | **Filters** — `days_ago` on a mapped date field |
| Tell the bot which table and date range on a **website** | **AI Instructions** + field list |
| Search my **already saved** leads | **Dashboard** — source, days, search box (not the source form) |

---

## Quick sanity checks before you Save

- [ ] **Filters** use names from the **right** side of **Field mapping**.
- [ ] Every filter rule must pass — add rules one at a time if something drops everything.
- [ ] **JSON** in Query Parameters / Field mapping / Filters is **valid JSON** (commas, quotes).
- [ ] For JSON API, **“Use Universal Engine”** is checked if you rely on engine wiring for `query_params`.

---

## Phoenix / ASP.NET `/_Get.../` URLs (e.g. `_GetIssuedPermitData`)

URLs like `https://apps-secure.phoenix.gov/.../_GetIssuedPermitData` are usually **not** plain REST GET APIs. They are **POST** endpoints built for the website’s table (DataTables-style): the browser sends a **JSON body** (`draw`, `start`, `length`, column filters, etc.) and often needs **cookies** or **anti-forgery** tokens.

The Universal Engine’s **REST adapter** does a simple **GET** (or a generic POST with your `body`) and expects a JSON **array** in the response (`data`, `Data`, `features`, …). That rarely matches these portals **as-is**.

**What to do instead:**

1. **Find an open ArcGIS or public API** for the same data (many cities mirror data on ArcGIS Hub or Socrata).
2. Or use **AI Website Scraper**: open the search page URL, and describe how to run the search and read the table.
3. Advanced: replicate the **exact POST body** from browser DevTools → Network (copy as cURL), then configure **HTTP Method: POST** and put the JSON body in source config (`body` / params) — fragile when the site changes.

**Timeouts:** If you still point the engine at a URL that waits forever, you’ll see `timeout of 60000ms exceeded` in logs — the endpoint isn’t responding like a simple API.

---

## Where to go next

- Full system layers: [FILTERING-ARCHITECTURE.md](./FILTERING-ARCHITECTURE.md)  
- Every operator + limits: [FILTERS-AND-LIMITS.md](./FILTERS-AND-LIMITS.md)  
- ArcGIS & engine design: [ENGINE-BLUEPRINT.md](./ENGINE-BLUEPRINT.md)

---

*Written for contributors and customers who configure sources in `my-sources.html`. Update this file when the Add Source form changes.*
