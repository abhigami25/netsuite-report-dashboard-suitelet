# NetSuite Report Dashboard Suitelet

A custom NetSuite Suitelet that renders any saved search as a full-featured interactive HTML dashboard — no native page limitations, no custom Advanced PDF per report, full data control.

Replaces the need to build separate report views for each saved search. One script, any search, configurable by any admin.

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
- Stored in a custom record (`customrecord_report_view`)

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

### Scheduled subscriptions
- Per-user scheduled email subscriptions stored in a custom record (`customrecord_report_subscription`)
- Daily / Weekly / Monthly; configurable day + time
- PDF / CSV / both formats
- Saves current view config with each subscription
- Scheduler: separate Scheduled Script (nightly runner)

---

## Architecture

```
Browser
  │
  ├── GET  ?searchId=XXXX  →  Suitelet (server-side)
  │                               │
  │                               ├── File Cabinet cache check (30 min TTL)
  │                               ├── SuiteQL saved search run (runPaged)
  │                               └── JSON → base64 → inline <script> block
  │
  ├── POST (filter override)  →  Suitelet re-runs with new filterExpression
  │
  └── Client-side JS
        ├── Table render, sort, filter, group, paginate
        ├── Column panel, named views, conditional formatting
        ├── Pivot mode (client-side aggregation)
        └── Period compare (two result sets merged client-side)
```

---

## Technical notes

**Rhino engine constraints** — NetSuite server scripts run on Rhino 2.1. No spread operator, no nullish coalescing (`??`), no optional chaining (`?.`). All regex uses `new RegExp(...)` syntax.

**Data transport** — all data passed server → client via `jsonB64()` (base64-encoded JSON inside `<script>` blocks). Never breaks HTML parsing regardless of data content.

**String safety** — `escJs()` for HTML-escaping client strings; `safeJson()` escapes `\u2028`, `\u2029`, and `</script` sequences in inline script JSON; `replaceAll()` used for placeholder substitution to avoid `$`-pattern issues in `.replace()`.

**Script/deploy ID extraction** — `getBase()` uses regex against `req.url` to reliably extract script and deploy IDs for use in AJAX POST targets (works correctly even on POST requests where `req.url` structure differs).

---

## Setup

### 1. Upload the script
Upload `report_dashboard_sl.js` to your NetSuite File Cabinet.

### 2. Create the Suitelet script record
- Script Type: `Suitelet`
- Script File: select the uploaded file
- Note the Script ID and Deployment ID

### 3. Create custom record types

**View storage** (`customrecord_report_view`):
| Field | Type |
|---|---|
| `custrecord_view_search_id` | Free-form text |
| `custrecord_view_name` | Free-form text |
| `custrecord_view_config` | Long text |
| `custrecord_view_owner` | Employee (lookup) |
| `custrecord_view_shared` | Checkbox |

**Subscription storage** (`customrecord_report_subscription`):
| Field | Type |
|---|---|
| `custrecord_sub_search_id` | Free-form text |
| `custrecord_sub_owner` | Employee (lookup) |
| `custrecord_sub_frequency` | List (daily/weekly/monthly) |
| `custrecord_sub_day` | Integer |
| `custrecord_sub_time` | Free-form text |
| `custrecord_sub_format` | List (pdf/csv/both) |
| `custrecord_sub_recipients` | Long text |
| `custrecord_sub_view_config` | Long text |

### 4. Create the Scheduler script record (for subscriptions)
- Script Type: `Scheduled`
- Script File: `report_dashboard_scheduler.js`
- Schedule: nightly

### 5. Deploy and use
Navigate to the Suitelet URL with your search ID:
```
/app/site/hosting/scriptlet.nl?script=YOUR_SCRIPT_ID&deploy=YOUR_DEPLOY_ID&searchId=YOUR_SAVED_SEARCH_ID
```

Optional params:
- `nocache=1` — bypass File Cabinet cache
- `mode=detail` — force detail view on summary searches

---

## Stack

| Component | Technology |
|---|---|
| Script type | SuiteScript 2.x Suitelet |
| Data query | SuiteQL (N/query) |
| Cache | NetSuite File Cabinet |
| PDF export | BFO Report Generator (NetSuite built-in) |
| Subscriptions | Custom record + Scheduled Script |
| Client UI | Vanilla JS (Rhino-safe ES5) |

---

## Skills Demonstrated

- Advanced SuiteScript 2.x development (Suitelet, Scheduled Script, SuiteQL)
- Client-side data pipeline: sort, filter, group, paginate, pivot — no page reload
- NetSuite File Cabinet caching strategy
- Custom record design for persistent user preferences
- Rhino engine constraints and ES5-compatible JavaScript patterns
- Supply chain reporting: period comparison, conditional alerting, KPI tracking
