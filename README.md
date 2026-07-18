# NetSuite Report Dashboard Suitelet

Universal dashboard for NetSuite saved searches. Point it at any saved search and get a modern, interactive report UI inside NetSuite — no per-report development.

![SuiteScript 2.1](https://img.shields.io/badge/SuiteScript-2.1-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-green)

## Features

- Searchable saved-search dropdown
- Unlimited rows (chunked fetch via `getRange`, governance-aware)
- Client-side column filters, sorting, grouping
- Pivot tables with aggregation
- Conditional formatting rules
- Period-over-period comparison
- Row drill-down (summary → detail)
- Saved views (per-user + shared)
- Email export (PDF + optional CSV attachment)
- Scheduled email subscription records
- File Cabinet result caching (30-min TTL, lazy, no scheduled script needed)
- Landscape PDF export with content-weighted column widths (BFO quirks handled)

## Requirements

- NetSuite account with SuiteScript 2.1 support (uses spread syntax, `??`, template literals)
- Administrator role or equivalent (for deploying scripts + custom records)

---

## Installation

### Option A: SDF Deploy (recommended — one command)

This repo includes a complete SDF Account Customization Project under `/sdf/`. It deploys the script, both custom records, and the deployment in one shot.

1. Install [SuiteCloud CLI](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_1558708800.html) (`npm install -g @oracle/suitecloud-cli`)
2. Clone this repo:
   ```bash
   git clone https://github.com/abhigami25/netsuite-report-dashboard-suitelet.git
   cd netsuite-report-dashboard-suitelet/sdf
   ```
3. Edit the CONFIG block in `FileCabinet/SuiteScripts/ReportDashboard/report_dashboard_sl.js` (see Configuration below)
4. Authenticate:
   ```bash
   suitecloud account:setup
   ```
5. Deploy:
   ```bash
   suitecloud project:deploy
   ```
6. Navigate to the Suitelet deployment URL in NetSuite. Done.

### Option B: Manual setup

1. **Create custom record: Dashboard View**

   Record ID: `customrecord_dashboard_view`

   | Field ID | Type |
   |---|---|
   | `custrecord_ddv_search` | Free-Form Text |
   | `custrecord_ddv_search_label` | Free-Form Text |
   | `custrecord_ddv_user` | Free-Form Text |
   | `custrecord_ddv_shared` | Checkbox |
   | `custrecord_ddv_config` | Long Text |

2. **Create custom record: Dashboard Subscription**

   Record ID: `customrecord_dashboard_subscription`

   | Field ID | Type |
   |---|---|
   | `custrecord_dds_search_id` | Free-Form Text |
   | `custrecord_dds_name` | Free-Form Text |
   | `custrecord_dds_recipients` | Long Text |
   | `custrecord_dds_frequency` | Free-Form Text |
   | `custrecord_dds_day` | Free-Form Text |
   | `custrecord_dds_time` | Free-Form Text |
   | `custrecord_dds_format` | Free-Form Text |
   | `custrecord_dds_config` | Long Text |
   | `custrecord_dds_active` | Checkbox |
   | `custrecord_dds_user` | Free-Form Text |
   | `custrecord_dds_last_sent` | Date/Time |

3. **Upload both scripts** — copy `report_dashboard_sl.js` and `report_dashboard_scheduler.js` to File Cabinet (e.g. `/SuiteScripts/ReportDashboard/`)
4. **Create Suitelet** — Customization → Scripting → Scripts → New → select `report_dashboard_sl.js` → Deploy, status **Released**, audience per your needs
5. **Create Scheduled Script** — Scripts → New → select `report_dashboard_scheduler.js` → Deploy with nightly schedule
6. Open the Suitelet deployment URL and pick a saved search

---

## Configuration

Edit the CONFIG block at the top of `report_dashboard_sl.js`:

| Constant | What to set |
|---|---|
| `LOGO_URL` | File Cabinet URL of your logo (`media.nl?id=...`). Leave `''` for no logo. |
| `COMPANY` | Your company name — appears in header, footer, PDF, and default email subject. |
| `CACHE_FOLDER` | Internal ID of a File Cabinet folder you own. Set to `-1` to disable caching. |
| `CACHE_ENABLED` | `false` to bypass caching entirely. |

---

## Project structure

```
├── .gitignore
├── LICENSE
├── README.md
├── report_dashboard_sl.js              ← Suitelet (standalone copy for manual install)
├── report_dashboard_scheduler.js       ← Scheduled Script (standalone copy)
└── sdf/                                ← SDF Account Customization Project
    ├── manifest.xml
    ├── deploy.xml
    ├── FileCabinet/
    │   └── SuiteScripts/
    │       └── ReportDashboard/
    │           ├── report_dashboard_sl.js
    │           └── report_dashboard_scheduler.js
    └── Objects/
        ├── customrecord_dashboard_view.xml
        ├── customrecord_dashboard_subscription.xml
        ├── customscript_report_dashboard.xml
        └── customscript_report_dash_scheduler.xml
```

---

## Known limitations

- Rows capped at 50,000. Fetch stops when remaining governance drops below 500 units — large searches may be truncated.
- Shared saved views can only be edited/deleted by their owner or an Administrator (role 3).
- Summary-grouped saved searches render a summary view with drill-down; detail is fetched on demand.
- PDF export uses BFO's report engine. Column widths are computed in absolute points (BFO ignores percentage `<col>` widths). Cell text uses `align` attributes to prevent BFO's forced line justification.
- Cache files (`rptdash_{id}.json`) expire after 30 min but are not auto-deleted — they're overwritten on next run.
- Email sends use the current logged-in user as author.
- **Scheduled email dispatch** requires a companion Scheduled or Map/Reduce script that reads `customrecord_dashboard_subscription` on a cron deployment. That script is not included — you must build it or trigger sends manually.

## Contributing

Issues and PRs welcome. If you add a feature, please keep the single-file Suitelet pattern — the whole point is zero dependencies.

## License

[MIT](LICENSE)
