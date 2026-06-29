# NetSuite Report Dashboard Suitelet

A custom NetSuite Suitelet that renders any saved search as a full-featured interactive HTML dashboard — no native page limitations, no custom Advanced PDF per report, full data control.

Replaces the need to build separate report views for each saved search. One script, any search, configurable by any admin.

---

## Files

| File | Type | Purpose |
|---|---|---|
| `report_dashboard_sl.js` | Suitelet | Main dashboard — renders saved searches as interactive HTML |
| `report_dashboard_scheduler.js` | Scheduled Script | Nightly runner — sends due email subscriptions |

---

## What It Does

### Data loading
- Renders any saved search by internal ID (passed as URL param)
- Loads first 1,000 rows instantly; background-loads all remaining rows automatically
- Supports up to 50,000 rows via `runPaged → getRange → run().each()` fallback chain
- 30-minute File Cabinet cache per search; `nocache=1` param forces a hard refresh

### Table features
- Sticky header + sticky filter row
- Per-column inline text filter (client-side, instant)
- Click-to-sort on any column (numeric-aware, currency-aware)
- Row grouping by any column
- Column resizing (drag), alternating row colors, hover highlight
- Pagination (100 rows/page)

### Columns panel
- Show/hide any column
- Drag to reorder
- Pin columns (sticky left)
- Reset to default

### Named views
- Save/load named view configs (sort, group, column order/visibility/pin, KPIs, conditional formatting rules, pivot config, filters, overrides)
- Per-user private views + admin-shared presets (admin role only)
- Stored in custom record `customrecord_report_view`

### Search filters panel
- Editable filters derived from the saved search's `filterExpression`
- Supports date, number, text, list, range, empty/notempty operators
- Sends override to server → re-runs search with new filters
- Active filter count badge

### Period compare
- Appears only on searches with a date filter
- Prior Period / Prior Year / Custom date range modes
- Two server-side search runs, client-side merge
- Variance (Δ) and Δ% columns with red/green badges

### Pivot mode
- Row dimension, column dimension, measure, aggregation (sum / avg / count / min / max / count distinct)
- Heatmap coloring, bar visualization inside cells
- Sort by row or column total
- Limit top N column values
- CSV export of pivot table

### Conditional formatting
- Add/remove rules per column
- Operators: contains, =, !=, >, >=, <, <=, between, is empty, not empty
- Row scope or cell scope
- Color presets (Red / Amber / Green / Blue / Purple) + custom color picker
- Bold option

### KPI strip
- Auto-detects numeric columns
- Per-column metrics: sum, avg, count, min, max
- Configurable; always reflects current filtered data

### Drilldown (summary searches)
- Click any summary row → POST to detail view with GROUP BY filters injected
- Back button returns to summary
- Drilldown-active badge in toolbar

### Export
- CSV download (respects column order/visibility)
- PDF via BFO renderer (proportional column widths, logo header, page footer)
- Email PDF and/or CSV to comma-separated recipients (modal)

### Scheduled subscriptions (`report_dashboard_scheduler.js`)
- Per-user scheduled email subscriptions stored in custom record `customrecord_report_subscription`
- Daily / Weekly / Monthly; configurable day + time
- PDF / CSV / both formats
- Saves current view config (filters, sort, column state) with each subscription
- Runs nightly via Scheduled Script; governance-aware, stops safely if limits approach

---

## Architecture

```
Browser
  │
  ├── GET  ?searchId=XXXX  →  report_dashboard_sl.js (Suitelet)
  │                               │
  │                               ├── File Cabinet cache check (30 min TTL)
  │                               ├── Saved search run (runPaged)
  │                               └── JSON → base64 → inline <script> block
  │
  ├── POST (filter override)  →  Suitelet re-runs with new filterExpression
  │
  └── Client-side JS
        ├── Table render, sort, filter, group, paginate
        ├── Column panel, named views, conditional formatting
        ├── Pivot mode (client-side aggregation)
        └── Period compare (two result sets merged client-side)

Nightly
  report_dashboard_scheduler.js
        ├── Loads all active subscriptions from customrecord_report_subscription
        ├── Checks frequency / day / last_sent to determine what's due
        ├── Runs saved search with saved view config (filters, sort, columns)
        └── Emails PDF and/or CSV to recipients
```

---

## Technical Notes

**Data transport** — all data passed server → client via `jsonB64()` (base64-encoded JSON inside `<script>` blocks). Raw JSON breaks the moment cell data contains quotes, `</script>` tags, or Unicode line terminators (`\u2028`, `\u2029`). Base64 encoding produces pure ASCII output — nothing can break the HTML parser regardless of cell content.

**String safety** — `safeJson()` escapes `\u2028`, `\u2029`, and `</script` sequences in inline script JSON. `escJs()` handles HTML-escaping of client-side strings.

**Search execution fallback chain** — `runPaged` is the primary path. If it fails mid-run, falls back to `getRange` loop (no row cap unlike `run().each()`). If both fail, `run().each()` is the last resort (capped at ~4,000 rows). Each stage logs governance usage.

**Script/deploy ID extraction** — `getBase()` parses `req.url` to extract script and deploy IDs for AJAX POST targets — works correctly on both GET and POST requests.

**Governance handling** — scheduler stops processing subscriptions when remaining script usage drops below threshold (`GOV_STOP = 2000`). Suitelet stops fetching rows when usage drops below `GOV_MIN = 500`.

**PDF column widths** — BFO renderer does not reliably honor percentage-based column widths. Column widths are calculated in points based on content length sampling (first 50 rows), distributed proportionally across the page width.

---

## Setup

### 1. Configure the Suitelet

Open `report_dashboard_sl.js` and set:

```js
const LOGO_URL     = '';   // Your logo URL, or leave blank
const COMPANY      = '';   // Your company name, or leave blank
const CACHE_FOLDER = 0;    // Internal ID of a File Cabinet folder you own
```

### 2. Upload both files to File Cabinet

Upload `report_dashboard_sl.js` and `report_dashboard_scheduler.js` to your NetSuite File Cabinet.

### 3. Create custom record types

**View storage** (`customrecord_report_view`):

| Field ID | Type |
|---|---|
| `custrecord_ddv_search` | Free-form text |
| `custrecord_ddv_search_label` | Free-form text |
| `custrecord_ddv_user` | Employee (lookup) |
| `custrecord_ddv_shared` | Checkbox |
| `custrecord_ddv_config` | Long text |

**Subscription storage** (`customrecord_report_subscription`):

| Field ID | Type |
|---|---|
| `custrecord_dds_search_id` | Free-form text |
| `custrecord_dds_name` | Free-form text |
| `custrecord_dds_recipients` | Long text |
| `custrecord_dds_frequency` | Free-form text |
| `custrecord_dds_day` | Free-form text |
| `custrecord_dds_time` | Free-form text |
| `custrecord_dds_format` | Free-form text |
| `custrecord_dds_config` | Long text |
| `custrecord_dds_active` | Checkbox |
| `custrecord_dds_user` | Employee (lookup) |
| `custrecord_dds_last_sent` | Date/Time |

### 4. Create Script records

**Suitelet:**
- Script Type: `Suitelet`
- API Version: `2.1`
- Script File: `report_dashboard_sl.js`
- Deploy and note Script ID + Deployment ID

**Scheduler:**
- Script Type: `Scheduled Script`
- API Version: `2.1`
- Script File: `report_dashboard_scheduler.js`
- Schedule: nightly

### 5. Use

Navigate to:
```
/app/site/hosting/scriptlet.nl?script=YOUR_SCRIPT_ID&deploy=YOUR_DEPLOY_ID&searchId=YOUR_SAVED_SEARCH_ID
```

Optional URL params:
- `nocache=1` — bypass File Cabinet cache, force fresh search run
- `mode=detail` — force detail view on summary searches

---

## Stack

| Component | Technology |
|---|---|
| Suitelet | SuiteScript 2.1 |
| Scheduler | SuiteScript 2.1 Scheduled Script |
| Data query | NetSuite Saved Search (N/search) |
| Cache | NetSuite File Cabinet |
| PDF export | BFO Report Generator (NetSuite built-in) |
| Client UI | Vanilla JS |

---

## Skills Demonstrated

- SuiteScript 2.1 (Suitelet + Scheduled Script)
- Client-side data pipeline: sort, filter, group, paginate, pivot — no page reload
- NetSuite File Cabinet caching strategy
- Safe server → client data transport (base64 JSON encoding)
- Custom record design for persistent user state
- Supply chain reporting: period comparison, KPI tracking, conditional alerting, scheduled delivery
