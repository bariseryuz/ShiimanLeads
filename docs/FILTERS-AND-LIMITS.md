# Filters & Limits — Educational Guide

This guide explains **filters** (which leads to keep) and **limits** (how much to scrape). It covers what each part means, how they work, and how to say it in plain words and in JSON.

---

## Table of contents

1. [Filters vs limits: what’s the difference?](#1-filters-vs-limits-whats-the-difference)
2. [How filters work](#2-how-filters-work)
3. [Each part of a filter rule](#3-each-part-of-a-filter-rule)
4. [All filter operators](#4-all-filter-operators)
5. [How to set limits](#5-how-to-set-limits)
6. [Putting it in words (and JSON)](#6-putting-it-in-words-and-json)
7. [Field names: use yours, not the API’s](#7-field-names-use-yours-not-the-apis)
8. [Quick reference](#8-quick-reference)

---

## 1. Filters vs limits: what’s the difference?

| Concept | What it does | Where you set it |
|--------|----------------|-------------------|
| **Filters** | Decide **which leads are kept**. A lead is saved only if it passes every filter rule. | In the source: “Universal Engine” → **Filters (JSON)**. |
| **Limits** | Decide **how much** to scrape: max pages, max rows per page, max total rows. | In the source (optional) or when you start a scrape (optional). |

- **Filters** = quality: “Only leads with budget &gt; 50000 and from the last 30 days.”
- **Limits** = quantity: “Stop after 5 pages” or “Stop after 500 leads total.”

---

## 2. How filters work

- Filters are a **list of rules**. Each rule has: **field**, **operator**, **value**.
- A lead is **kept** only if it passes **all** rules. If any rule fails, the lead is dropped.
- Filters are applied **after** the data is fetched and **after** field mapping. So you always use **your** field names (the names you chose in Field mapping), not the API’s raw names.

**Example:**  
Rules: “budget &gt; 50000” and “state equals CA”.  
A lead with budget 60000 and state “CA” is kept.  
A lead with budget 60000 and state “TX” is dropped (second rule failed).

---

## 3. Each part of a filter rule

Every rule is one object with three keys:

| Part | Meaning | Example |
|------|---------|--------|
| **field** | The name of the field **after** field mapping (your name). | `"budget"`, `"IssueDate"`, `"address"` |
| **operator** | How to compare the lead’s value to your value. | `">"`, `"=="`, `"contains"`, `"days_ago"` |
| **value** | What you’re comparing against. Type depends on operator (number, string, or array). | `50000`, `"CA"`, `30`, `["min", "max"]` |

**Important:**  
- **field** must match a key in the **mapped** lead. If you mapped `EST_COST_AMT` → `budget`, use `"field": "budget"`.  
- If the lead doesn’t have that field (missing or null), the rule usually fails (except for some operators).

---

## 4. All filter operators

Use these in the **operator** part of a rule. The validator runs the comparison; if it returns true, the rule passes.

### Numeric comparison

| Operator | In words | Example rule | Passes when |
|----------|----------|--------------|-------------|
| `>` | greater than | `{"field": "budget", "operator": ">", "value": 50000}` | Lead’s budget &gt; 50000 |
| `<` | less than | `{"field": "budget", "operator": "<", "value": 100000}` | Lead’s budget &lt; 100000 |
| `>=` | greater than or equal | `{"field": "budget", "operator": ">=", "value": 50000}` | Lead’s budget ≥ 50000 |
| `<=` | less than or equal | `{"field": "budget", "operator": "<=", "value": 200000}` | Lead’s budget ≤ 200000 |

### Equality

| Operator | In words | Example rule | Passes when |
|----------|----------|--------------|-------------|
| `==` or `equals` | exactly equal | `{"field": "state", "operator": "==", "value": "CA"}` | Lead’s state is exactly "CA" |
| `!=` or `not_equals` | not equal | `{"field": "status", "operator": "!=", "value": "Cancelled"}` | Lead’s status is not "Cancelled" |

### Text

| Operator | In words | Example rule | Passes when |
|----------|----------|--------------|-------------|
| `contains` | text contains (case-insensitive) | `{"field": "address", "operator": "contains", "value": "Phoenix"}` | Lead’s address contains "Phoenix" |

### List and range

| Operator | In words | Example rule | Passes when |
|----------|----------|--------------|-------------|
| `in` | value is in list | `{"field": "state", "operator": "in", "value": ["CA", "AZ", "NV"]}` | Lead’s state is one of CA, AZ, NV |
| `between` | number in range [min, max] | `{"field": "budget", "operator": "between", "value": [50000, 200000]}` | Lead’s budget between 50000 and 200000 |

### Date (relative)

| Operator | In words | Example rule | Passes when |
|----------|----------|--------------|-------------|
| `days_ago` | date is within last N days | `{"field": "IssueDate", "operator": "days_ago", "value": 30}` | Lead’s IssueDate is within the last 30 days (on or after that date) |

For `days_ago`, the **value** is the number of days (e.g. `30`). The lead’s field must be a date the system can parse. The rule passes if that date is **on or after** “today minus N days”.

---

## 5. How to set limits

Limits control **how much** is scraped, not which leads are kept.

### What each limit means

| Limit | Meaning | Example |
|-------|---------|--------|
| **maxPages** | Stop after this many pages. | `10` → stop after 10 pages. |
| **maxRowsPerPage** | On each page, take at most this many rows. `null` = no limit. | `50` → at most 50 rows per page. |
| **maxTotalRows** | Across all pages, stop after this many rows total. `null` = no limit. | `500` → stop after 500 leads total. |
| **testMode** | If `true`, overrides to: 1 page, 10 rows max (quick preview). | `true` → only 1 page, 10 rows. |

### Defaults (if you don’t set anything)

- **maxPages:** 10  
- **maxRowsPerPage:** null (no limit)  
- **maxTotalRows:** null (no limit)  
- **testMode:** false  

### Where limits come from

- You can set limits **on the source** (e.g. in the source’s `extractionLimits`).
- You can also pass limits **when you start a scrape** (e.g. in the request body to `/api/scrape/now`).
- **Per-scrape limits override source limits** when both are present. So “this run only: 2 pages” overrides the source’s maxPages for that run.

### Example: “Only scrape 3 pages and at most 100 leads total”

**As source-level config (conceptually):**

```json
{
  "maxPages": 3,
  "maxTotalRows": 100
}
```

**As a scrape request (conceptually):**

```json
{
  "extractionLimits": {
    "maxPages": 3,
    "maxTotalRows": 100
  }
}
```

**Test mode (preview):**

```json
{
  "testMode": true
}
```

That means: 1 page, 10 rows max.

---

## 6. Putting it in words (and JSON)

Use this to translate “I want…” into the right JSON.

### Filters

| You want to say… | Filter (JSON) |
|------------------|---------------|
| “Only leads with budget greater than 50,000.” | `[{"field": "budget", "operator": ">", "value": 50000}]` |
| “Only leads from the last 30 days (by issue date).” | `[{"field": "IssueDate", "operator": "days_ago", "value": 30}]` |
| “Only leads in California or Arizona.” | `[{"field": "state", "operator": "in", "value": ["CA", "AZ"]}]` |
| “Budget between 50k and 200k.” | `[{"field": "budget", "operator": "between", "value": [50000, 200000]}]` |
| “Address must contain ‘Phoenix’.” | `[{"field": "address", "operator": "contains", "value": "Phoenix"}]` |
| “Status must not be Cancelled.” | `[{"field": "status", "operator": "!=", "value": "Cancelled"}]` |
| “Last 30 days **and** budget &gt; 50,000.” | `[{"field": "IssueDate", "operator": "days_ago", "value": 30}, {"field": "budget", "operator": ">", "value": 50000}]` |

### Limits

| You want to say… | Limits (concept) |
|------------------|------------------|
| “Stop after 5 pages.” | `maxPages: 5` |
| “At most 100 leads per page.” | `maxRowsPerPage: 100` |
| “At most 500 leads in total.” | `maxTotalRows: 500` |
| “Quick test: 1 page, 10 rows.” | `testMode: true` |

---

## 7. Field names: use yours, not the API’s

Filters run **after** field mapping. So in every rule, **field** must be one of **your** names (the right-hand side of the mapping), not the API’s.

**Example:**

- API returns: `EST_COST_AMT`, `ISSUE_DT`, `ADDR`.
- Field mapping: `{"EST_COST_AMT": "budget", "ISSUE_DT": "IssueDate", "ADDR": "address"}`.
- In filters you use: **budget**, **IssueDate**, **address**.

So: “Only budget &gt; 50000” → `{"field": "budget", "operator": ">", "value": 50000}`.

---

## 8. Quick reference

### Filter rule shape

```json
{"field": "yourFieldName", "operator": "operatorName", "value": valueOrArray}
```

### Operators (one per rule)

- Numeric: `>`, `<`, `>=`, `<=`
- Equality: `==`, `equals`, `!=`, `not_equals`
- Text: `contains`
- List/range: `in`, `between`
- Date: `days_ago`

### “Last 30 days” in two places

- **Query params / where clause (request):**  
  Use tokens like `{{DATE_30_DAYS_AGO}}` and `{{TODAY}}` in your URL params or ArcGIS where clause so the **API** only returns recent data.
- **Filters (after fetch):**  
  Use a rule so only leads with a date in the last 30 days are kept:  
  `{"field": "IssueDate", "operator": "days_ago", "value": 30}`

### Where to type filters and limits in the app

- **Filters:** In **Add/Edit Source**, in the “Universal Engine” section, in the **Filters (JSON)** box. One array of rules.
- **Limits:** Either in the source’s extraction limits (if the UI supports it) or in the scrape request body as `extractionLimits`.

---

**Summary:** **Filters** = which leads to keep (rules with field, operator, value). **Limits** = how much to scrape (pages and rows). Use **your** field names in filters. All rules must pass for a lead to be saved.
