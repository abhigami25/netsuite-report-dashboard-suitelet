/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 * @NModuleScope SameAccount
 *
 * FILE: report_dashboard_scheduler.js
 * Report Dashboard — Email Subscription Scheduler
 * Runs nightly. Checks all active subscriptions and sends due emails (PDF / CSV / both).
 */
define([
  'N/search', 'N/record', 'N/email', 'N/render',
  'N/runtime', 'N/log', 'N/file'
], (search, record, email, render, runtime, log, file) => {

  const LOGO_URL = '';    // Replace with your logo URL (or leave blank)
  const SUB_REC  = 'customrecord_report_subscription';
  const SF = {
    search:     'custrecord_dds_search_id',
    name:       'custrecord_dds_name',
    recipients: 'custrecord_dds_recipients',
    frequency:  'custrecord_dds_frequency',
    day:        'custrecord_dds_day',
    time:       'custrecord_dds_time',
    format:     'custrecord_dds_format',
    config:     'custrecord_dds_config',
    active:     'custrecord_dds_active',
    user:       'custrecord_dds_user',
    last_sent:  'custrecord_dds_last_sent'
  };
  const GOV_STOP = 2000;

  const execute = ctx => {
    const now     = new Date();
    const dayOfWk = now.getDay();
    const dayOfMo = now.getDate();
    log.audit('scheduler', 'Starting — dayOfWeek=' + dayOfWk + ' dayOfMonth=' + dayOfMo);

    const subs = loadActiveSubs();
    log.audit('scheduler', 'Found ' + subs.length + ' active subscriptions');

    for (const sub of subs) {
      if (runtime.getCurrentScript().getRemainingUsage() < GOV_STOP) {
        log.audit('scheduler', 'Governance cap — stopping');
        break;
      }
      if (!isDue(sub, now, dayOfWk, dayOfMo)) continue;
      try {
        processSub(sub);
        record.submitFields({ type: SUB_REC, id: sub.id, values: { [SF.last_sent]: now } });
        log.audit('scheduler', 'Sent: ' + sub.name + ' → ' + sub.recipients);
      } catch(e) {
        log.error('scheduler_sub_' + sub.id, e.message);
      }
    }
    log.audit('scheduler', 'Done');
  };

  const loadActiveSubs = () => {
    const out = [];
    search.create({
      type: SUB_REC,
      filters: [[SF.active, 'is', 'T']],
      columns: [
        search.createColumn({ name: 'internalid' }),
        search.createColumn({ name: 'name' }),
        search.createColumn({ name: SF.search }),
        search.createColumn({ name: SF.recipients }),
        search.createColumn({ name: SF.frequency }),
        search.createColumn({ name: SF.day }),
        search.createColumn({ name: SF.time }),
        search.createColumn({ name: SF.format }),
        search.createColumn({ name: SF.config }),
        search.createColumn({ name: SF.user }),
        search.createColumn({ name: SF.last_sent })
      ]
    }).run().each(r => {
      out.push({
        id:         r.getValue('internalid'),
        name:       r.getValue('name') || '',
        searchId:   r.getValue(SF.search) || '',
        recipients: r.getValue(SF.recipients) || '',
        frequency:  r.getValue(SF.frequency) || 'weekly',
        day:        r.getValue(SF.day) || '1',
        time:       r.getValue(SF.time) || '07:00',
        format:     r.getValue(SF.format) || 'pdf',
        config:     r.getValue(SF.config) || '{}',
        userId:     r.getValue(SF.user),
        lastSent:   r.getValue(SF.last_sent) || ''
      });
      return true;
    });
    return out;
  };

  const isSameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate();

  const isDue = (sub, now, dayOfWk, dayOfMo) => {
    let dayMatches = false;
    if      (sub.frequency === 'daily')   dayMatches = true;
    else if (sub.frequency === 'weekly')  dayMatches = dayOfWk === parseInt(sub.day);
    else if (sub.frequency === 'monthly') dayMatches = dayOfMo === parseInt(sub.day);
    if (!dayMatches) return false;
    if (sub.lastSent) {
      const last = new Date(sub.lastSent);
      if (!isNaN(last) && isSameDay(last, now)) return false;
    }
    return true;
  };

  const processSub = sub => {
    if (!sub.searchId || !sub.recipients) return;
    const loaded = search.load({ id: sub.searchId });
    const label  = loaded.title || sub.name;

    let cfg = {};
    try { cfg = JSON.parse(sub.config || '{}'); } catch(e) {}

    if (cfg.overrides && cfg.overrides.length) applyFilterOverrides(loaded, cfg.overrides);

    const sortCol  = typeof cfg.sortCol  === 'number' ? cfg.sortCol  : -1;
    const sortDir  = cfg.sortDir || 'asc';
    const groupCol = typeof cfg.groupCol === 'number' ? cfg.groupCol : -1;

    const { columns: rawColumns, rows: raw } = runSearch(loaded);
    const sortedRows = applySort(raw, sortCol, sortDir, groupCol);
    const { columns, rows, groupCol: dispGroupCol } = applyColState(rawColumns, sortedRows, cfg.colOrder, cfg.colVisible, groupCol);

    const recipients = sub.recipients.split(',').map(r => r.trim()).filter(Boolean);
    const subject    = sub.name + ' — ' + formatDate(new Date());
    const body       = '<p>Attached: <strong>' + label + '</strong> ('
      + rows.length.toLocaleString() + ' rows).</p>'
      + '<p style="color:#999;font-size:11px">Auto-generated by NetSuite Report Dashboard.</p>';

    const attachments = [];
    const safeName = label.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/ /g, '_') || sub.searchId;

    if (sub.format === 'pdf' || sub.format === 'both') {
      const pdfFile = buildPdf({ title: label, columns, rows, groupCol: dispGroupCol, footerNote: 'Search ID: ' + sub.searchId });
      pdfFile.name = safeName + '.pdf';
      attachments.push(pdfFile);
    }
    if (sub.format === 'csv' || sub.format === 'both') {
      const lines = [columns.map(csvCell).join(',')];
      rows.forEach(r => lines.push(r.slice(0, columns.length).map(csvCell).join(',')));
      attachments.push(file.create({ name: safeName + '.csv', fileType: 'CSV', contents: lines.join('\n') }));
    }

    email.send({
      author: parseInt(sub.userId) || runtime.getCurrentUser().id,
      recipients, subject, body, attachments
    });
  };

  // ── HELPERS ───────────────────────────────────────────────────────────────

  const formatDate = d =>
    d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  const csvCell = v => {
    const s = String(v == null ? '' : v);
    return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const xmlEnc = s =>
    String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&apos;');

  const applySort = (rows, sortCol, sortDir, groupCol = -1) => {
    return [...rows].sort((a, b) => {
      if (groupCol >= 0 && groupCol !== sortCol) {
        const gc = smartCmp(a[groupCol], b[groupCol], 'asc');
        if (gc !== 0) return gc;
      }
      if (sortCol >= 0) {
        const sc = smartCmp(a[sortCol], b[sortCol], sortDir);
        if (sc !== 0) return sc;
      }
      return smartCmp(a[0], b[0], 'asc');
    });
  };

  const smartCmp = (av, bv, dir) => {
    const parseNum = val => {
      const s = String(val == null ? '' : val).trim();
      if (!s) return NaN;
      let clean = s.replace(/[$€£¥%\s]/g, '');
      if (/,\d{1,2}$/.test(clean)) { clean = clean.replace(/\./g,'').replace(',','.'); }
      else { clean = clean.replace(/,/g,''); }
      return Number(clean);
    };
    const as = String(av == null ? '' : av), bs = String(bv == null ? '' : bv);
    const an = parseNum(as), bn = parseNum(bs);
    const c  = (!isNaN(an) && !isNaN(bn)) ? (an - bn) : as.localeCompare(bs, undefined, { numeric: true });
    return dir === 'desc' ? -c : c;
  };

  const applyColState = (columns, rows, order, visible, groupCol) => {
    if (!Array.isArray(order)   || order.length   !== columns.length ||
        !Array.isArray(visible) || visible.length !== columns.length) {
      return { columns, rows, groupCol };
    }
    const visOrder = order.filter(ci => visible[ci]);
    if (!visOrder.length) return { columns, rows, groupCol };
    return {
      columns:  visOrder.map(ci => columns[ci]),
      rows:     rows.map(row => visOrder.map(ci => row[ci])),
      groupCol: groupCol >= 0 ? visOrder.indexOf(groupCol) : -1
    };
  };

  const applyFilterOverrides = (loaded, overrides) => {
    if (!overrides || !overrides.length) return;
    const overrideMap = {};
    overrides.forEach(ov => { overrideMap[ov.idx] = ov; });
    if (!loaded.filterExpression || !loaded.filterExpression.length) return;
    const NOVALUE = new Set(['isempty','isnotempty']);
    const ALL_OPS = new Set(['after','before','onorafter','onorbefore','within','notwithin','on','noton',
      'greaterthan','lessthan','equalto','notequalto','between','greaterthanorequalto','lessthanorequalto',
      'isempty','isnotempty','contains','doesnotcontain','is','isnot','startswith','endswith','anyof','notanyof']);
    const isOp = s => ALL_OPS.has((s||'').toLowerCase());
    let flatIdx = 0;
    const traverse = arr => {
      if (!Array.isArray(arr)) return arr;
      if (arr.length >= 2 && typeof arr[0] === 'string' && typeof arr[1] === 'string') {
        const isNode = isOp(arr[1]) || (arr.length >= 3 && isOp(arr[2]));
        if (isNode) {
          const ov = overrideMap[flatIdx++]; if (!ov) return arr;
          const name = arr[0], hasJoin = !isOp(arr[1]), join = hasJoin ? arr[1] : null;
          if (NOVALUE.has(ov.operator)) return join ? [name, join, ov.operator] : [name, ov.operator];
          return join ? [name, join, ov.operator, ...ov.values] : [name, ov.operator, ...ov.values];
        }
      }
      return arr.map(item => Array.isArray(item) ? traverse(item) : item);
    };
    loaded.filterExpression = traverse(loaded.filterExpression);
  };

  const runSearch = (savedSearch) => {
    const CHUNK_SIZE = 1000, MAX_ROWS = 10000, GOV_MIN = 2500;
    const rawCols = savedSearch.columns;
    const columns = rawCols.map(c => c.label || c.name || '');
    const rows = [];
    let capped = false;

    const extractRow = result => rawCols.map(c => {
      try {
        const t = result.getText(c), v = result.getValue(c);
        return (t !== null && t !== undefined && t !== '') ? t : (v !== null && v !== undefined ? v : '');
      } catch(e) { return ''; }
    });

    try {
      const paged = savedSearch.runPaged({ pageSize: CHUNK_SIZE });
      outer: for (const range of paged.pageRanges) {
        if (runtime.getCurrentScript().getRemainingUsage() < GOV_MIN) { capped = true; break; }
        if (rows.length >= MAX_ROWS) { capped = true; break; }
        const page = paged.fetch({ index: range.index });
        for (const result of page.data) {
          if (rows.length >= MAX_ROWS) { capped = true; break outer; }
          rows.push(extractRow(result));
        }
      }
    } catch(e) { log.error('scheduler_runSearch', e.message); }

    if (capped) log.audit('scheduler_runSearch', 'Capped at ' + rows.length + ' rows');
    return { columns, rows };
  };

  const buildPdf = ({ title, columns, rows, groupCol = -1, footerNote }) => {
    const date         = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const logoSrc      = LOGO_URL ? LOGO_URL.replace(/&/g, '&amp;') : '';
    const logoTag      = logoSrc ? `<img src="${logoSrc}" width="45" height="45" style="display:block;"/>` : '';
    const PAGE_WIDTH   = 734;
    const MIN_COL      = 45;
    const sampleN      = Math.min(rows.length, 50);
    const weights      = columns.map((c, ci) => {
      let maxLen = String(c || '').length;
      for (let i = 0; i < sampleN; i++) {
        const len = rows[i][ci] == null ? 0 : String(rows[i][ci]).length;
        if (len > maxLen) maxLen = len;
      }
      return Math.min(maxLen, 40);
    });
    const totalWeight  = weights.reduce((a, b) => a + b, 0) || 1;
    let colWidths      = weights.map(w => Math.max(MIN_COL, (w / totalWeight) * PAGE_WIDTH));
    const widthSum     = colWidths.reduce((a, b) => a + b, 0);
    colWidths          = colWidths.map(w => (w / widthSum) * PAGE_WIDTH);
    const colGroup     = '<colgroup>' + colWidths.map(w => `<col style="width:${w.toFixed(1)}pt;"/>`).join('') + '</colgroup>';
    const thStyle      = 'background-color:#2c3e6b;color:#fff;font-weight:bold;padding:5px 7px;border:1px solid #1a2a50;font-size:7pt;font-family:Arial,Helvetica,sans-serif;';
    const headerCells  = columns.map(c => `<td align="left" valign="middle" style="${thStyle}"><p align="left" style="margin:0;">${xmlEnc(c)}</p></td>`).join('');
    let lastGV         = null;
    const dataRows     = rows.map((row, i) => {
      const curGV      = groupCol >= 0 ? String(row[groupCol] == null ? '' : row[groupCol]) : null;
      const isNewGroup = groupCol >= 0 && curGV !== lastGV;
      if (groupCol >= 0) lastGV = curGV;
      const bg         = i % 2 === 0 ? '#f2f4fa' : '#ffffff';
      const cleanRow   = row.length > columns.length ? row.slice(0, columns.length) : row;
      const cells      = cleanRow.map((cell, ci) => {
        const bl = ci === 0 ? 'border-left:3px solid #2c3e6b;font-weight:bold;' : 'border-left:1px solid #dde0e8;';
        const bt = (isNewGroup && i > 0) ? 'border-top:2px solid #7a9cbf;' : '';
        const v  = (ci === groupCol && !isNewGroup) ? '' : String(cell != null ? cell : '');
        return `<td align="left" valign="top" style="background-color:${bg};padding:4px 7px;${bl}${bt}border-right:1px solid #dde0e8;border-bottom:1px solid #e8eaf0;font-size:7pt;font-family:Arial,Helvetica,sans-serif;"><p align="left" style="margin:0;">${xmlEnc(v)}</p></td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report//2.x//EN" "report-2-0-1.dtd">
<pdf><head><macrolist>
  <macro id="hdr">
    <table style="width:100%;border-bottom:2px solid #2c3e6b;padding-bottom:5px;margin-bottom:4px;">
      <tr>
        ${logoTag ? `<td style="width:55px;vertical-align:middle;padding-right:10px;">${logoTag}</td>` : ''}
        <td style="vertical-align:middle;text-align:right;">
          <p style="margin:0 0 2px;font-size:11pt;font-weight:bold;color:#2c3e6b;font-family:Arial,Helvetica,sans-serif;">${xmlEnc(title)}</p>
          <p style="margin:0;font-size:7.5pt;color:#555;font-family:Arial,Helvetica,sans-serif;">Generated: ${xmlEnc(date)}</p>
        </td>
      </tr>
    </table>
  </macro>
  <macro id="ftr">
    <table style="width:100%;border-top:1px solid #ccc;padding-top:3px;">
      <tr>
        <td style="font-size:7pt;color:#888;font-family:Arial,Helvetica,sans-serif;">${xmlEnc(footerNote||'')} &#160;|&#160; ${rows.length.toLocaleString()} rows</td>
        <td style="text-align:right;font-size:7pt;color:#888;font-family:Arial,Helvetica,sans-serif;">Page <pagenumber/> of <totalpages/></td>
      </tr>
    </table>
  </macro>
</macrolist></head>
<body header="hdr" header-height="0.7in" footer="ftr" footer-height="0.32in" size="letter-landscape" padding="0.5in 0.4in 0.4in 0.4in">
  <table style="width:${PAGE_WIDTH}pt;border-collapse:collapse;table-layout:fixed;">
    ${colGroup}
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${dataRows || `<tr><td colspan="${columns.length}" style="font-style:italic;color:#888;font-size:8pt;padding:8px;">No data.</td></tr>`}</tbody>
  </table>
</body></pdf>`;

    const renderer = render.create();
    renderer.templateContent = xml;
    return renderer.renderAsPdf();
  };

  return { execute };
});
