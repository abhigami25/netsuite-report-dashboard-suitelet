/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * FILE: report_dashboard_sl.js
 * NetSuite Report Dashboard — Universal Saved Search Dashboard Suitelet
 * Open source. Configure the CONFIG block below before deploying.
 * Features: searchable dropdown · unlimited rows · pivot tables · conditional
 * formatting · period-over-period comparison · saved views · row drill-down ·
 * scheduled email subscriptions · CSV/PDF export
 * ─────────────────────────────────────────────────────────────────────────
 */
define([
  'N/ui/serverWidget',
  'N/search',
  'N/render',
  'N/email',
  'N/runtime',
  'N/log',
  'N/file',
  'N/record',
  'N/encode'
], (serverWidget, search, render, email, runtime, log, file, record, encode) => {

  // ── CONFIG — EDIT BEFORE DEPLOYING ───────────────────────────────────────
  const LOGO_URL  = '';              // ← OPTIONAL: File Cabinet URL of your logo (media.nl?id=...). Leave '' for no logo.
  const LOGO_W    = 45;
  const LOGO_H    = 45;
  const COMPANY   = 'My Company';    // ← REPLACE with your company name (shown in header/footer/PDF)

  const MAX_ROWS   = 50000;   // Hard memory ceiling; governance is primary guard.
  const GOV_MIN    = 500;     // Stop fetching when units fall below this.
  const GOV_MIN_ROWS = 50;  
  const CHUNK_SIZE = 1000;    // Rows per chunk — NS getRange() hard limit is 1000.
  const QUICK_ROWS = 1000;    // Rows fetched for instant first render; rest load in background.

  // ── FILE CABINET CACHE ────────────────────────────────────────────────────
  // Lazy per-search cache. No scheduled script needed — only searches that are
  // actually opened ever get cached. TTL: 30 min by default.
  // CACHE_FOLDER: set to the internal ID of any File Cabinet folder you own
  // (e.g. SuiteScripts subfolder). The Suitelet creates/overwrites one JSON
  // file per search ID, named rptdash_{id}.json.
  const CACHE_FOLDER  = -1;              // ← REPLACE with your File Cabinet folder ID (-1 = cache disabled)
  const CACHE_TTL_MS  = 30 * 60 * 1000; // 30 minutes
  const CACHE_ENABLED = true;          // Set false to bypass entirely

  const _cacheKey = (id, view) => 'rptdash_' + id + (view ? '_' + view : '') + '.json';

const readCache = (searchId, view) => {
    if (!CACHE_ENABLED || CACHE_FOLDER <= 0) return null;
    if (!searchId) { log.audit('readCache', 'called with no searchId'); return null; }
    try {
      let fileId = null;
      search.create({
        type: 'file',
        filters: [['name','is',_cacheKey(searchId, view)],'AND',['folder','is',String(CACHE_FOLDER)]],
        columns: [search.createColumn({ name: 'internalid', sort: search.Sort.DESC })]
      }).run().each(r => { fileId = r.getValue('internalid'); return false; });
      if (!fileId) return null;
      const f   = file.load({ id: fileId });
      const obj = JSON.parse(f.getContents());
      if (!obj || (Date.now() - obj.ts) > CACHE_TTL_MS) return null;
      return obj;
    } catch(e) { log.audit('readCache', e.message); return null; }
  };

const writeCache = (searchId, columns, rows, view) => {
    if (!CACHE_ENABLED || CACHE_FOLDER <= 0) return;
    try {
      const key      = _cacheKey(searchId, view);
      const contents = JSON.stringify({ ts: Date.now(), columns, rows });
      let   fileId   = null;
      search.create({
        type: 'file',
        filters: [['name','is',key],'AND',['folder','is',String(CACHE_FOLDER)]],
        columns: [search.createColumn({ name: 'internalid', sort: search.Sort.DESC })]
      }).run().each(r => { fileId = r.getValue('internalid'); return false; });

      if (fileId) {
        const existing = file.load({ id: fileId });
        existing.contents = contents;
        existing.save();
      } else {
        file.create({ name: key, fileType: file.Type.PLAINTEXT, contents, folder: CACHE_FOLDER }).save();
      }
    } catch(e) { log.audit('writeCache', e.message); }
  };

  const DATE_OPS    = new Set(['after','before','onorafter','onorbefore','within','notwithin','on','noton']);
  const NUM_OPS     = new Set(['greaterthan','lessthan','equalto','notequalto','between','greaterthanorequalto','lessthanorequalto']);
  const NOVALUE_OPS = new Set(['isempty','isnotempty']);
  const RANGE_OPS   = new Set(['within','between','notwithin']);
  const ALL_OPS     = new Set([
    ...DATE_OPS, ...NUM_OPS, ...NOVALUE_OPS,
    'contains','doesnotcontain','is','isnot','startswith','endswith','anyof','notanyof'
  ]);
  const SKIP_FIELDS = new Set(['mainline','taxline','cogs','shipping','posting','closed','voided','isfrommeeting']);

  // ── ROUTER ────────────────────────────────────────────────────────────────
  const onRequest = ctx => {
    const { request: req, response: resp } = ctx;
    const mode        = req.parameters.mode   || '';
    const sid         = req.parameters.id     || '';
    const labelRaw    = req.parameters.label  ? decodeURIComponent(req.parameters.label) : '';
    const base        = getBase(req);
    const drilldownJson = req.parameters.custpage_drilldown || req.parameters.drilldown || '';

    const bodyStr = req.body || '{}';
    let isJsonBody = false, parsedBody = {};
    try { parsedBody = JSON.parse(bodyStr); isJsonBody = true; } catch(e) {}

    const view     = req.parameters.custpage_view || req.parameters.view || parsedBody.view || 'summary';
    const sortCol  = parseInt(req.parameters.custpage_sort_col  ?? req.parameters.sort_col  ?? parsedBody.sortCol  ?? '-1');
    const sortDir  = req.parameters.custpage_sort_dir || req.parameters.sort_dir || parsedBody.sortDir || 'asc';
    const groupCol = parseInt(req.parameters.custpage_group_col ?? req.parameters.group_col ?? parsedBody.groupCol ?? '-1');
    const ddJson   = drilldownJson || parsedBody.drilldown || '';

    let filtersJson   = req.parameters.custpage_filters   || req.parameters.filters   || '';
    let overridesJson = req.parameters.custpage_overrides || req.parameters.overrides || '[]';
    if (isJsonBody && parsedBody.filters)   filtersJson   = JSON.stringify(parsedBody.filters);
    if (isJsonBody && parsedBody.overrides) overridesJson = JSON.stringify(parsedBody.overrides);

    let colOrderJson   = req.parameters.custpage_col_order   || req.parameters.col_order   || '';
    let colVisibleJson = req.parameters.custpage_col_visible || req.parameters.col_visible || '';
    if (isJsonBody && parsedBody.colOrder)   colOrderJson   = JSON.stringify(parsedBody.colOrder);
    if (isJsonBody && parsedBody.colVisible) colVisibleJson = JSON.stringify(parsedBody.colVisible);

    if (mode === 'loadsearches') return serveSearchList(req, resp);
    if (mode === 'loadviews' && sid) return serveLoadViews(req, resp, sid);
    if (mode === 'loadview'  && req.parameters.vid) return serveLoadView(req, resp, req.parameters.vid);

    if (req.method === 'POST') {
      if (mode === 'saveview')   return serveSaveView(req, resp);
      if (mode === 'deleteview') return serveDeleteView(req, resp);
      if (mode === 'refresh'  && sid) return serveRefresh(req, resp, sid, view, overridesJson, ddJson);
      if (mode === 'compare'  && sid) return serveCompare(req, resp, sid, view, overridesJson, ddJson);
      if (mode === 'loadsubs' && sid) return serveLoadSubs(req, resp, sid);
      if (mode === 'savesub')         return serveSaveSub(req, resp);
      if (mode === 'deletesub')       return serveDeleteSub(req, resp);
      if (mode === 'togglesub')       return serveToggleSub(req, resp);
      if (mode === 'pdf'     && sid) return servePdf(req, resp, sid, labelRaw, view, sortCol, sortDir, groupCol, filtersJson, overridesJson, ddJson, colOrderJson, colVisibleJson);
      if (mode === 'csv'     && sid) return serveCsv(req, resp, sid, labelRaw, view, sortCol, sortDir, groupCol, filtersJson, overridesJson, ddJson, colOrderJson, colVisibleJson);
      if (req.parameters.custpage_email_to) return handlePost(req, resp, base, view, sortCol, sortDir, groupCol, filtersJson, overridesJson, ddJson, colOrderJson, colVisibleJson);
      // Selector form submit — custpage_ss holds the selected saved search internalid.
      const selectedSid = req.parameters.custpage_ss;
      if (selectedSid) {
        let selectedLabel = getSearchTitle(selectedSid);
        redirect(resp, base + '&id=' + encodeURIComponent(selectedSid) + '&label=' + encodeURIComponent(selectedLabel));
        return;
      }
    }

    if (sid) return serveDashboard(req, resp, sid, labelRaw, view, sortCol, sortDir, groupCol, base, ddJson, req.parameters.nocache === '1');
    return serveSelector(req, resp, base);
  };

  // ── SELECTOR ─────────────────────────────────────────────────────────────
  // Uses a native serverWidget SELECT field populated server-side via
  // addSelectOption(). Native SELECT hidden; typeahead drives navigation.
  const serveSelector = (req, resp, base) => {
    const flash = req.parameters.msg ? decodeURIComponent(req.parameters.msg) : '';
    const form  = serverWidget.createForm({ title: 'Report Dashboard' });

    if (flash) {
      form.addField({ id: 'custpage_flash', type: serverWidget.FieldType.INLINEHTML, label: ' ' })
        .defaultValue = `<div style="background:#eaffea;border:1px solid #4caf50;padding:8px 14px;border-radius:4px;font-family:Arial;font-size:13px;color:#256029;margin-bottom:8px">&#10003; ${esc(flash)}</div>`;
    }

    // ── Favorites panel ──────────────────────────────────────────────────
    // Hidden native SELECT — fallback for form POST if JS fails.
    const ssField = form.addField({
      id:    'custpage_ss',
      type:  serverWidget.FieldType.SELECT,
      label: 'Saved Search'
    });
    ssField.addSelectOption({ value: '', text: '' });

    // Populate SELECT server-side (needed for form fallback).
    try {
      search.create({
        type:    'savedsearch',
        filters: [['isinactive', 'is', 'F']],
        columns: [
          search.createColumn({ name: 'internalid' }),
          search.createColumn({ name: 'title', sort: search.Sort.ASC })
        ]
      }).run().each(r => {
        const id    = r.getValue('internalid');
        const title = r.getValue('title') || id;
        if (id) ssField.addSelectOption({ value: String(id), text: String(title) });
        return true;
      });
    } catch(e) { log.error('serveSelector', e.message); }

    // Store base URL in a data attribute — avoids all JS string escaping issues.
    const baseEnc = encodeURIComponent(base);

    form.addField({ id: 'custpage_typeahead', type: serverWidget.FieldType.INLINEHTML, label: ' ' })
      .defaultValue = `<div id="ss-root" data-base="${esc(base)}" data-ajax="${esc(base)}&amp;mode=loadsearches">
<style>
#ss-wrap{font-family:Arial,sans-serif;max-width:620px;position:relative;margin:0 0 6px 0;}
#ss-input{width:100%;padding:11px 44px 11px 16px;font-size:14px;border:2px solid #2d6a9f;border-radius:6px;box-sizing:border-box;outline:none;color:#1a1a2e;background:#fff;}
#ss-input:focus{border-color:#1f3a5f;box-shadow:0 0 0 3px rgba(45,106,159,.15);}
#ss-input:disabled{background:#f4f6f8;color:#aaa;}
#ss-icon{position:absolute;right:14px;top:50%;transform:translateY(-50%);font-size:16px;color:#2d6a9f;pointer-events:none;user-select:none;}
#ss-drop{display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;border:1px solid #c8d8ee;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.13);z-index:9999;max-height:360px;overflow-y:auto;}
#ss-drop.open{display:block;}
.ss-item{padding:9px 14px;cursor:pointer;border-bottom:1px solid #f0f4fa;display:flex;align-items:center;gap:10px;}
.ss-item:last-child{border-bottom:none;}
.ss-item.hover{background:#eaf2fb;}
.ss-name{font-size:13px;color:#1a1a2e;flex-grow:1;}
.ss-name b{color:#1f3a5f;font-weight:700;}
.ss-id{font-size:10px;color:#bbb;flex-shrink:0;}
.ss-empty,.ss-loading{padding:14px;font-size:13px;color:#888;text-align:center;}
#ss-meta{margin-top:4px;font-size:11px;color:#999;min-height:15px;}
</style>
<div id="ss-wrap">
  <input id="ss-input" type="text" placeholder="Search saved searches..." autocomplete="off" disabled/>
  <span id="ss-icon">&#8987;</span>
  <div id="ss-drop"><div class="ss-loading">Loading searches&#8230;</div></div>
</div>
<div id="ss-meta">Loading&#8230;</div>
</div>
<script>
(function(){
  var root     = document.getElementById('ss-root');
  var ssBase   = root ? root.getAttribute('data-base')  : '';
  var ajaxUrl  = root ? root.getAttribute('data-ajax')  : '';
  var inp      = document.getElementById('ss-input');
  var drop     = document.getElementById('ss-drop');
  var meta     = document.getElementById('ss-meta');
  var icon     = document.getElementById('ss-icon');
  var LIST     = [];
  var filtered = [];
  var active   = -1;

  // Load searches via AJAX — avoids all server-side string escaping issues.
  fetch(ajaxUrl)
    .then(function(r){ return r.json(); })
    .then(function(data){
      LIST = data;
      inp.disabled = false;
      inp.placeholder = 'Search ' + LIST.length + ' saved searches\u2026';
      icon.innerHTML = '&#9660;';
      if(meta) meta.textContent = LIST.length + ' saved searches available';
      drop.innerHTML = '';
      drop.classList.remove('open');
    })
    .catch(function(e){
      if(meta) meta.textContent = 'Failed to load searches. Refresh page.';
      if(inp) inp.placeholder = 'Load failed \u2014 refresh page';
    });

  function hl(text, term){
    if(!term) return escH(text);
    var lo = text.toLowerCase(), tlo = term.toLowerCase(), idx = lo.indexOf(tlo);
    if(idx < 0) return escH(text);
    return escH(text.slice(0,idx)) + '<b>' + escH(text.slice(idx, idx+term.length)) + '</b>' + escH(text.slice(idx+term.length));
  }
  function escH(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function render(term){
    active = -1;
    if(!LIST.length){ drop.innerHTML='<div class="ss-loading">Loading\u2026</div>'; return; }
    var lo = (term||'').toLowerCase().trim();
    filtered = lo
      ? LIST.filter(function(s){ return s.label.toLowerCase().includes(lo) || s.id.includes(lo); }).slice(0,60)
      : LIST.slice(0,60);
    if(!filtered.length){
      drop.innerHTML = '<div class="ss-empty">No matches for &ldquo;' + escH(term) + '&rdquo;</div>';
    } else {
      drop.innerHTML = filtered.map(function(s,i){
        return '<div class="ss-item" data-idx="'+i+'">'
          + '<span style="font-size:13px;color:#2d6a9f;">&#128202;</span>'
          + '<span class="ss-name">'+hl(s.label, lo)+'</span>'
          + '<span class="ss-id">#'+escH(s.id)+'</span>'
          + '</div>';
      }).join('');
      // Attach click handlers after rendering.
      drop.querySelectorAll('.ss-item').forEach(function(el){
        el.addEventListener('click', function(){
          var idx = parseInt(el.getAttribute('data-idx'));
          go(filtered[idx]);
        });
        el.addEventListener('mouseenter', function(){
          active = parseInt(el.getAttribute('data-idx'));
          setActive();
        });
      });
    }
    drop.classList.add('open');
    if(meta) meta.textContent = lo
      ? (filtered.length + ' result' + (filtered.length!==1?'s':'') + ' \u2014 type to refine')
      : (LIST.length + ' saved searches available');
  }

  function setActive(){
    drop.querySelectorAll('.ss-item').forEach(function(el,i){
      el.classList.toggle('hover', i === active);
    });
  }

  function go(s){
    drop.classList.remove('open');
    // Set hidden SELECT value for form fallback.
    var sel = document.getElementById('custpage_ss');
    if(sel){ for(var i=0;i<sel.options.length;i++){ if(sel.options[i].value===s.id){ sel.selectedIndex=i; break; } } }
    window.location.href = ssBase + '&id=' + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label);
  }

  inp.addEventListener('input', function(){ render(inp.value); });
  inp.addEventListener('focus', function(){ if(LIST.length) render(inp.value); });
  inp.addEventListener('keydown', function(e){
    if(!drop.classList.contains('open')) return;
    if(e.key==='ArrowDown'){ e.preventDefault(); active=Math.min(active+1, filtered.length-1); setActive(); scrollAct(); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); active=Math.max(active-1, 0); setActive(); scrollAct(); }
    else if(e.key==='Enter'){ e.preventDefault(); if(active>=0&&filtered[active]) go(filtered[active]); }
    else if(e.key==='Escape'){ drop.classList.remove('open'); }
  });
  function scrollAct(){
    var items = drop.querySelectorAll('.ss-item');
    if(items[active]) items[active].scrollIntoView({block:'nearest'});
  }
  document.addEventListener('click', function(e){
    var wrap = document.getElementById('ss-wrap');
    if(wrap && !wrap.contains(e.target)) drop.classList.remove('open');
  });
})();
</script>`;

    form.addSubmitButton({ label: '\u{1F4CA} Open Dashboard' });
    resp.writePage(form);
  };

  // ── SEARCH LIST (AJAX) ───────────────────────────────────────────────────────
  const serveSearchList = (req, resp) => {
    resp.setHeader({ name: 'Content-Type', value: 'application/json' });
    resp.write(JSON.stringify(loadSearches()));
  };

  // ── DASHBOARD VIEWS (saved configs) ───────────────────────────────────────
  const VIEW_REC = 'customrecord_dashboard_view';
  const VF = {
    search: 'custrecord_ddv_search', label: 'custrecord_ddv_search_label',
    user: 'custrecord_ddv_user', shared: 'custrecord_ddv_shared',
    config: 'custrecord_ddv_config'
  };

  const serveLoadViews = (req, resp, searchId) => {
    resp.setHeader({ name: 'Content-Type', value: 'application/json' });
    try {
      const uid = runtime.getCurrentUser().id;
      const out = [];
      search.create({
        type: VIEW_REC,
        filters: [
          [VF.search, 'is', String(searchId)], 'AND',
          [[VF.user,'anyof',[uid]],'OR',[VF.shared,'is','T']]
        ],
        columns: [
          search.createColumn({ name: 'internalid' }),
          search.createColumn({ name: 'name' }),
          search.createColumn({ name: VF.shared }),
          search.createColumn({ name: VF.user })
        ]
      }).run().each(r => {
        out.push({
          id: r.getValue('internalid'), name: r.getValue('name'),
          shared: r.getValue(VF.shared) === true || r.getValue(VF.shared) === 'T',
          mine: String(r.getValue(VF.user)) === String(uid)
        });
        return true;
      });
      resp.write(JSON.stringify({ ok:true, views: out }));
    } catch(e) { resp.write(JSON.stringify({ ok:false, error:e.message })); }
  };

  const serveLoadView = (req, resp, viewId) => {
    resp.setHeader({ name: 'Content-Type', value: 'application/json' });
    try {
      const rec = record.load({ type: VIEW_REC, id: viewId });
      resp.write(JSON.stringify({ ok:true, name: rec.getValue('name'),
        config: rec.getValue(VF.config) || '{}' }));
    } catch(e) { resp.write(JSON.stringify({ ok:false, error:e.message })); }
  };

  const serveSaveView = (req, resp) => {
    resp.setHeader({ name: 'Content-Type', value: 'application/json' });
    try {
      const uid      = runtime.getCurrentUser().id;
      const searchId = req.parameters.search_id;
      const name     = (req.parameters.view_name || '').trim();
      const cfgJson  = req.parameters.config || '{}';
      const shared   = req.parameters.shared === '1';
      let   viewId   = req.parameters.view_id || '';

      if (!searchId || !name) {
        resp.write(JSON.stringify({ ok:false, error:'Missing search_id or view_name.' })); return;
      }
      if (shared && runtime.getCurrentUser().role != 3) {
        resp.write(JSON.stringify({ ok:false, error:'Only Administrators can save shared presets.' })); return;
      }

      if (!viewId) {
        const ownerFilter = shared ? [VF.shared,'is','T'] : [VF.user,'anyof',[uid]];
        search.create({
          type: VIEW_REC,
          filters: [[VF.search,'is',String(searchId)],'AND',['name','is',name],'AND',ownerFilter],
          columns: [search.createColumn({ name:'internalid' })]
        }).run().each(r => { viewId = r.getValue('internalid'); return false; });
      }

      if (viewId) {
        record.submitFields({ type: VIEW_REC, id: viewId, values: { [VF.config]: cfgJson, name } });
      } else {
        const rec = record.create({ type: VIEW_REC });
        rec.setValue({ fieldId:'name', value: name });
        rec.setValue({ fieldId: VF.search, value: String(searchId) });
        rec.setValue({ fieldId: VF.label, value: req.parameters.search_label || '' });
        rec.setValue({ fieldId: VF.user, value: uid });
        rec.setValue({ fieldId: VF.shared, value: shared });
        rec.setValue({ fieldId: VF.config, value: cfgJson });
        viewId = rec.save();
      }
      resp.write(JSON.stringify({ ok:true, id: viewId }));
    } catch(e) { resp.write(JSON.stringify({ ok:false, error:e.message })); }
  };

  const serveDeleteView = (req, resp) => {
    resp.setHeader({ name: 'Content-Type', value: 'application/json' });
    try {
      const uid    = runtime.getCurrentUser().id;
      const viewId = req.parameters.view_id;
      const rec    = record.load({ type: VIEW_REC, id: viewId });
      const owner  = rec.getValue(VF.user);
      const shared = rec.getValue(VF.shared);
      if (String(owner) !== String(uid) && !(shared && runtime.getCurrentUser().role == 3)) {
        resp.write(JSON.stringify({ ok:false, error:'Not your view.' })); return;
      }
      record.delete({ type: VIEW_REC, id: viewId });
      resp.write(JSON.stringify({ ok:true }));
    } catch(e) { resp.write(JSON.stringify({ ok:false, error:e.message })); }
  };

// Safe JSON for inline <script> blocks.
  // JSON.stringify is safe for all chars EXCEPT \u2028, \u2029 (JS line terminators)
  // and </script (terminates the script block). Escape both.
  const safeJson = function(val) {
    return JSON.stringify(val)
      .split('\u2028').join('\\u2028')
      .split('\u2029').join('\\u2029')
      .split('</script').join('<\\/script')
      .split('</SCRIPT').join('<\\/SCRIPT');
  };

  // Bulletproof JSON transport: UTF-8 JSON -> base64. Output is pure [A-Za-z0-9+/=],
  // so it can NEVER break the <script> block regardless of cell/label content
  // (quotes, </script>, $ patterns, U+2028/9, backslashes all become safe base64).
  // Client decodes via atob + UTF-8 percent-decode.
 const jsonB64 = function(val) {
  const result = encode.convert({
    string: JSON.stringify(val),
    inputEncoding: encode.Encoding.UTF_8,
    outputEncoding: encode.Encoding.BASE_64
  }).replace(/[\r\n]/g, '');
  return result;
};
  
  // ── DASHBOARD ─────────────────────────────────────────────────────────────
  const serveDashboard = (req, resp, searchId, labelRaw, view, sortCol, sortDir, groupCol, base, ddJson, noCache = false) => {
    const forceDetail = (view === 'detail');
    let columns, rows, label, isSummary, editableFilters, capWarning = '', hasMore = false;

    try {
      const loaded    = search.load({ id: searchId });
      label           = loaded.title || getSearchTitle(searchId) || labelRaw || searchId;
      isSummary       = loaded.columns.some(c => c.summary && c.summary !== 'NONE');
      editableFilters = parseEditableFilters(loaded);

      // Try cache first (skip if filter overrides are active or drilldown or forced refresh)
      const cacheView = forceDetail ? 'detail' : 'summary';
      const cached = (!ddJson && !noCache) ? readCache(searchId, cacheView) : null;
      let r;
      if (cached) {
        r = { columns: cached.columns, rows: cached.rows, capped: false };
        hasMore = false;
      } else {
        r = runSearch(loaded, forceDetail, ddJson, QUICK_ROWS);
        // Only cache full loads with no drilldown
        if (!ddJson && !r.capped) writeCache(searchId, r.columns, r.rows, cacheView);
      }
      columns         = r.columns;
      rows            = applySort(r.rows, sortCol, sortDir, groupCol);
      hasMore         = r.capped && r.rows.length >= QUICK_ROWS;
      capWarning      = r.capped && !hasMore
        ? '<div style="background:#fff3cd;border:1px solid #ffc107;padding:8px 16px;font-size:12px;font-family:Arial;color:#856404;">&#9888; Results capped at ' + rows.length.toLocaleString() + ' rows (governance limit or row ceiling). Add filters to narrow the dataset.</div>'
        : '';
    } catch(e) {
      log.error('serveDashboard_catch', e.message + ' | stack: ' + (e.stack||''));
     resp.write(`<div style="font-family:Arial;padding:20px;color:red"><b>Error:</b> ${esc(e.message)}<br><br><b>Search:</b> ${esc(searchId)}<br><pre style="font-size:11px;color:#555">${esc(e.stack||'')}</pre></div>`);
      return;
    }

    
    const date         = new Date().toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
    const labelEnc     = encodeURIComponent(label);
    const dashBase = base + '&id=' + encodeURIComponent(searchId) + '&label=' + labelEnc + (forceDetail ? '&view=detail' : '');
    const logoImg      = LOGO_URL ? '<img src="' + LOGO_URL + '" style="height:44px;margin-right:14px;vertical-align:middle;" alt="">' : '';
    const isSummaryView = isSummary && !forceDetail;
    // visColCount = columns.length always. Rows in summary view have one extra element
    // (the drilldown payload) at row[columns.length]. row.slice(0, visColCount) strips it.
    const visColCount  = columns.length;
    const visColumns   = columns.slice(0, visColCount);

    const thCells = visColumns.map((c, i) => {
      const active = (i === sortCol);
      const arrow  = active ? (sortDir === 'asc' ? '&#9650;' : '&#9660;') : '&#8597;';
      const bg     = active ? '#162d4a' : '#1f3a5f';
      const op     = active ? '1' : '0.35';
      return '<th data-col="' + i + '" data-label="' + esc(c) + '" style="background:' + bg + ';color:#fff;padding:0;text-align:left;font-weight:600;font-size:11.5px;white-space:nowrap;position:sticky;top:0;z-index:2;user-select:none;">'
        + '<div style="display:flex;align-items:stretch;height:100%;">'
                + '<div class="th-content" onclick="clickSort(' + i + ')" style="padding:8px 10px;cursor:pointer;flex-grow:1;">' + esc(c) + '&nbsp;<span class="sort-ind" style="opacity:' + op + '">' + arrow + '</span></div>'
        + '<div class="resizer"></div>'
        + '</div></th>';
    }).join('');

    const filterCells = visColumns.map(function(_, i) {
      return '<th style="background:#16304e;padding:4px 5px;position:sticky;top:0;z-index:2;" class="filter-th">'
        + '<input type="text" data-fcol="' + i + '" placeholder="Filter..." oninput="applyFiltersAndRender()"'
        + ' style="width:100%;padding:1px 6px;font-size:10px;border:1px solid #4a7ba7;border-radius:3px;background:#1f3a5f;color:#fff;box-sizing:border-box"/>'
        + '</th>';
    }).join('');

    const groupOpts = '<option value="-1">None</option>' + visColumns.map(function(c, i) {
      return '<option value="' + i + '"' + (i === groupCol ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    const viewBadge      = isSummary ? (forceDetail
      ? '<span style="background:#e8f4e8;border:1px solid #4caf50;border-radius:12px;padding:3px 12px;font-size:11px;font-weight:700;color:#1b5e20;">&#9783; Detail</span>'
      : '<span style="background:#fff3cd;border:1px solid #ffc107;border-radius:12px;padding:3px 12px;font-size:11px;font-weight:700;color:#856404;">&#8721; Summary</span>') : '';
    const drilldownBadge = ddJson ? '<span style="background:#e8f4e8;border:1px solid #4caf50;border-radius:12px;padding:3px 12px;font-size:11px;font-weight:700;color:#1b5e20;">&#128269; Drill-Down Active</span>' : '';
    const toggleHref     = forceDetail
      ? (base + '&id=' + encodeURIComponent(searchId) + '&label=' + labelEnc)
      : (base + '&id=' + encodeURIComponent(searchId) + '&label=' + labelEnc + '&view=detail');
    const toggleBtn      = isSummary ? '<a style="padding:6px 14px;background:#fff;color:#2d6a9f;border:1px solid #2d6a9f;border-radius:4px;font-size:12px;font-weight:600;text-decoration:none;" href="' + esc(toggleHref) + '">' + (forceDetail ? '&#8721; Summary' : '&#9783; Detail') + '</a>' : '';
    const flashMsg       = req.parameters.msg ? decodeURIComponent(req.parameters.msg) : '';
    const flashBanner    = flashMsg ? '<div style="background:#eaffea;border:1px solid #4caf50;padding:8px 14px;font-weight:bold;text-align:center;font-size:13px;color:#256029;">&#10003; ' + esc(flashMsg) + '</div>' : '';
    

    const filterBarHtml       = buildFilterBarHtml(editableFilters);
    const hasFilters          = editableFilters.length > 0;
    const dateFilters         = editableFilters.filter(function(f) { return f.type === 'date'; });
    const hasDateFilter       = dateFilters.length > 0;
    const firstDateFilterIdx  = hasDateFilter ? dateFilters[0].idx : -1;
    const firstDateFilterVals = hasDateFilter ? dateFilters[0].values : [];
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${esc(label)} &#8212; ${COMPANY}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;font-size:12px;background:#f4f6f8;color:#1a1a2e}
.top{background:linear-gradient(135deg,#1f3a5f,#2d6a9f);color:#fff;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.top h1{font-size:16px;font-weight:700;margin:0}
.top .sub{font-size:11px;opacity:.75;margin-top:4px}
.bar{background:#fff;border-bottom:1px solid #dde3ea;padding:10px 20px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.btn{padding:6px 14px;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:4px}
.btn:disabled{opacity:0.6;cursor:not-allowed}
.btn-dark{background:#2c3e6b;color:#fff}   .btn-dark:hover:not(:disabled){background:#1a2a50}
.btn-green{background:#27ae60;color:#fff}  .btn-green:hover:not(:disabled){background:#1e8449}
.btn-blue{background:#2980b9;color:#fff}   .btn-blue:hover:not(:disabled){background:#1f6391}
.btn-out{background:#fff;color:#2d6a9f;border:1px solid #2d6a9f} .btn-out:hover:not(:disabled){background:#eaf2fb}
.btn-out:disabled{color:#ccc;border-color:#ccc;cursor:not-allowed;background:#fff}
.btn-orange{background:#e67e22;color:#fff} .btn-orange:hover:not(:disabled){background:#ca6f1e}
.ctrl-label{font-size:11px;font-weight:600;color:#555;white-space:nowrap}
.ctrl-sel{padding:4px 8px;border:1px solid #bbb;border-radius:4px;font-size:12px;background:#fafafa;cursor:pointer}
.row-badge{background:#eaf2fb;border:1px solid #aac9e8;border-radius:12px;padding:3px 12px;font-size:11px;font-weight:700;color:#1f3a5f}
.sep{width:1px;height:22px;background:#dde3ea;margin:0 2px}
.wrap{overflow-x:auto;background:#fff;border:1px solid #dde3ea}
table{width:100%;border-collapse:collapse}
tbody tr:hover td{background:#eaf2fb!important}
th[data-col]:hover{background:#243f6e!important}
.drilldown-row{cursor:pointer}
.drilldown-row:hover td{background:#dce5f2!important}
.resizer{width:5px;cursor:col-resize;z-index:10;border-right:1px solid rgba(255,255,255,0.1)}
.resizer:hover,.resizing{background:#4caf50!important;border-color:#4caf50!important}
.footer{text-align:center;padding:10px;color:#95a5a6;font-size:11px;margin-top:8px}
.fbar{background:#f0f4fa;border-bottom:2px solid #c8d8ee;padding:0}
.fbar-head{display:flex;align-items:center;gap:8px;padding:8px 20px;cursor:pointer;user-select:none;border-bottom:1px solid transparent}
.fbar-head:hover{background:#e4ecf7}
.fbar-head.open{border-bottom:1px solid #c8d8ee}
.fbar-body{padding:10px 20px 14px 20px;display:none;flex-wrap:wrap;gap:14px;align-items:flex-end}
.fbar-body.open{display:flex}
.fi-wrap{display:flex;flex-direction:column;gap:3px}
.fi-label{font-size:10px;font-weight:700;color:#2c3e6b;text-transform:uppercase;letter-spacing:.3px}
.fi-row{display:flex;align-items:center;gap:4px}
.fi-sel,.fi-inp{padding:5px 7px;border:1px solid #bbb;border-radius:3px;font-size:11px;background:#fff;color:#222}
.fi-inp{min-width:120px} .fi-inp-sm{width:80px}
.fi-changed{border-color:#e67e22!important;background:#fff8f0!important}
.active-badge{background:#e67e22;color:#fff;border-radius:10px;padding:1px 7px;font-size:10px;font-weight:700;margin-left:4px}
.modal-overlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;align-items:center;justify-content:center}
.modal-box{background:#fff;width:450px;padding:24px;border-radius:6px;box-shadow:0 10px 25px rgba(0,0,0,0.3)}
.modal-box h2{margin-bottom:15px;color:#1f3a5f;font-size:18px}
.form-grp{margin-bottom:15px}
.form-grp label{display:block;font-weight:bold;margin-bottom:5px;font-size:12px}
.form-grp input[type=text]{width:100%;padding:8px 10px;border:1px solid #bbb;border-radius:4px;font-size:13px;box-sizing:border-box}
.modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
.pv-table{border-collapse:collapse;font-size:11px;font-family:Arial,sans-serif;white-space:nowrap;}
.pv-table th,.pv-th{background:#1f3a5f;color:#fff;padding:5px 10px;border:1px solid #162d4a;font-weight:600;position:sticky;top:0;z-index:2;cursor:pointer;}
.pv-table th:hover,.pv-th:hover{background:#162d4a;}
.pv-row-header{position:sticky;left:0;z-index:3;min-width:160px;text-align:left;}
.pv-table td{padding:4px 10px;border:1px solid #e0e4ea;text-align:right;vertical-align:middle;}
.pv-table td.pv-row-label{background:#f4f6f8;font-weight:600;text-align:left;position:sticky;left:0;z-index:1;border-right:2px solid #c8d8ee;}
.pv-table td.pv-total{background:#eaf2fb;font-weight:700;border-left:2px solid #2d6a9f;}
.pv-table th.pv-total-hdr{background:#162d4a;border-left:2px solid #7fb3d3;}
.pv-table tr:hover td{background:#f0f7ff!important;}
.pv-table tr:hover td.pv-row-label{background:#e0ecf8!important;}
.pv-heatmap-lo{background:#fff!important;}
.pv-heatmap-hi{background:#1565c0!important;color:#fff!important;}
.pv-bar-wrap{display:flex;align-items:center;gap:4px;justify-content:flex-end;}
.pv-bar{height:8px;border-radius:2px;background:#2d6a9f;min-width:2px;display:inline-block;}
#pivotBtn.active{background:#2c3e6b;color:#fff;}
.cf-rule{display:flex;align-items:center;gap:6px;background:#1f3a5f;border:1px solid #2d6a9f;border-radius:4px;padding:6px 10px;flex-wrap:wrap;}
.cf-sel,.cf-inp{padding:4px 6px;border:1px solid #4a7ba7;border-radius:3px;font-size:11px;background:#16304e;color:#e0eaf5;}
.cf-inp{min-width:90px;}
.cf-color-swatch{width:22px;height:22px;border-radius:3px;border:2px solid #4a7ba7;cursor:pointer;padding:0;outline:none;}
.cf-remove{background:transparent;border:none;color:#e74c3c;font-size:14px;cursor:pointer;padding:0 4px;line-height:1;}
.cf-scope-sel{padding:4px 6px;border:1px solid #4a7ba7;border-radius:3px;font-size:11px;background:#16304e;color:#e0eaf5;}
.kpi-card{display:inline-flex;flex-direction:column;align-items:center;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:5px;padding:5px 12px;min-width:90px;cursor:default;}
.kpi-card:hover{background:rgba(255,255,255,.14);}
.kpi-label{font-size:9px;color:#7fb3d3;font-weight:700;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis;}
.kpi-metric{font-size:9px;color:#aac8e0;margin-top:1px;text-transform:uppercase;letter-spacing:.2px;}
.kpi-value{font-size:14px;font-weight:700;color:#fff;margin-top:2px;white-space:nowrap;}
.kpi-edit-col{background:#1f3a5f;border:1px solid #2d6a9f;border-radius:4px;padding:8px 10px;min-width:160px;}
.kpi-edit-col label{font-size:10px;color:#7fb3d3;font-weight:700;display:block;margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;}
.kpi-edit-col .kpi-chk-row{display:flex;align-items:center;gap:5px;font-size:10px;color:#cde;margin-top:3px;cursor:pointer;}
.kpi-edit-col .kpi-chk-row input{cursor:pointer;accent-color:#27ae60;}
.col-item{display:flex;align-items:center;padding:6px 10px;gap:7px;border-bottom:1px solid #f0f4fa;font-size:11px;cursor:grab;user-select:none;}
.col-item:last-child{border-bottom:none;}
.col-item:hover{background:#f4f8fc;}
.col-item.dragging{opacity:0.4;}
.col-item.drag-over{border-top:2px solid #2d6a9f;}
.col-item input[type=checkbox]{cursor:pointer;accent-color:#2d6a9f;}
.col-pin{font-size:12px;cursor:pointer;opacity:0.35;transition:opacity .15s;}
.col-pin.pinned{opacity:1;color:#e67e22;}
.col-name{flex-grow:1;color:#1a1a2e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.col-drag-handle{color:#ccc;font-size:13px;cursor:grab;}
.view-item{display:flex;align-items:center;padding:7px 14px;cursor:pointer;gap:6px;border-bottom:1px solid #f0f4fa;font-size:11px;}
.view-item:last-child{border-bottom:none;}
.view-item:hover{background:#eaf2fb;}
.view-item.active{background:#dce5f2;font-weight:700;}
.view-item .vi-name{flex-grow:1;color:#1a1a2e;}
.view-item .vi-badge{font-size:9px;padding:1px 5px;border-radius:8px;background:#f0e6ff;color:#6c3483;font-weight:700;}
.view-item .vi-mine{font-size:9px;padding:1px 5px;border-radius:8px;background:#eaf2fb;color:#2d6a9f;font-weight:700;}
#viewsBtn.has-view{background:#1f3a5f;color:#fff;border-color:#1f3a5f;}
@media print{
  @page{size:landscape;margin:10mm}
  .bar,.footer,.modal-overlay,.fbar{display:none!important}
  tr[data-filter-row]{display:none!important}
  body{background:#fff;font-size:9px} table{font-size:9px}
  .top{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  th{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  td{background:#fff!important}
}
</style></head><body>
${flashBanner}
${capWarning}
<div id="bgLoadBanner" style="display:none;background:#fff8e1;border-bottom:2px solid #f39c12;padding:8px 20px;font-family:Arial;font-size:12px;color:#7d5a00;align-items:center;gap:12px;">
  <span id="bgLoadSpinner" style="font-size:15px;display:inline-block;animation:spin 1s linear infinite;">&#8635;</span>
  <span id="bgLoadMsg" style="font-weight:600;">Loading all rows in background&hellip;</span>
  <span id="bgLoadCount" style="font-weight:bold;color:#2c3e6b;"></span>
  <button id="bgRetryBtn" onclick="backgroundLoadAll()" style="display:none;padding:3px 10px;font-size:11px;background:#e67e22;color:#fff;border:none;border-radius:3px;cursor:pointer;font-weight:600;">Retry</button>
  <span id="bgDoneMsg" style="display:none;color:#1e8449;font-weight:700;">&#10003; All rows loaded</span>
</div>
<style>@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}</style>
<div class="top">
  <div style="display:flex;align-items:center">
    ${logoImg}
    <div>
      <div style="font-size:9px;opacity:.65;text-transform:uppercase;letter-spacing:.8px;margin-bottom:2px;font-family:Arial,sans-serif;">Saved Search</div>
      <h1>&#128202; ${esc(label)}</h1>
      <div class="sub">${COMPANY} &bull; ${date}</div>
    </div>
  </div>
  <div style="text-align:right;font-size:11px;opacity:.85"><span id="rowCountTop">${rows.length.toLocaleString()} rows</span></div>
</div>
<div class="bar">
  <a class="btn btn-dark" href="${esc(base)}">&#8592; Back</a>
  <button class="btn btn-out" style="font-size:11px;" onclick="forceRefresh()" title="Bypass cache and re-run search">&#8635; Refresh</button>
  <button class="btn btn-out" id="cfBtn" style="font-size:11px;" onclick="toggleCfPanel()">&#127912; Format</button>
  HAS_DATE_FILTER_PLACEHOLDER
  <button class="btn btn-out" id="subBtn" style="font-size:11px;" onclick="toggleSubPanel()">&#9203; Subscribe</button>
  <button class="btn btn-out" id="pivotBtn" style="font-size:11px;" onclick="togglePivotMode()">&#9783; Pivot</button>
  <button class="btn btn-out" id="kpiToggleBtn" style="font-size:11px;" onclick="toggleKpiStrip()">&#8721; KPIs</button>
  ${viewBadge}${drilldownBadge}${toggleBtn}
  <div class="sep"></div>
  <span class="ctrl-label">Group&nbsp;by:</span>
  <select id="groupSel" class="ctrl-sel" onchange="setGroup(parseInt(this.value))">${groupOpts}</select>
  <span class="row-badge" id="rowCountBadge">${rows.length.toLocaleString()} rows</span>
  <button id="loadAllBtn" onclick="triggerLoadAll()" class="btn btn-orange" style="font-size:11px;padding:4px 10px;display:${hasMore ? 'inline-flex' : 'none'};">&#8635; Loading all rows&hellip;</button>
  <div style="display:flex;align-items:center;gap:4px;margin-left:10px;">
    <button id="btnPrev" class="btn btn-out" style="padding:4px 8px;" onclick="prevPage()">&#9664;</button>
    <span id="pageInfo" style="font-size:11px;font-weight:bold;color:#1f3a5f;min-width:80px;text-align:center;"></span>
    <button id="btnNext" class="btn btn-out" style="padding:4px 8px;" onclick="nextPage()">&#9654;</button>
  </div>
  <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
   <div style="position:relative;display:inline-block;">
      <button class="btn btn-out" onclick="toggleColPanel()" id="colBtn" style="font-size:11px;">&#9638; Columns</button>
      <div id="colPanel" style="display:none;position:absolute;right:0;top:calc(100% + 4px);width:260px;background:#fff;border:1px solid #c8d8ee;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.13);z-index:9998;font-family:Arial,sans-serif;">
        <div style="padding:8px 14px;border-bottom:1px solid #eee;font-size:12px;font-weight:700;color:#1f3a5f;display:flex;align-items:center;justify-content:space-between;">
          <span>&#9638; Columns</span>
          <div style="display:flex;gap:6px;">
            <button onclick="setAllCols(true)"  style="font-size:10px;padding:2px 7px;border:1px solid #2d6a9f;border-radius:3px;background:#eaf2fb;color:#2d6a9f;cursor:pointer;">All</button>
            <button onclick="setAllCols(false)" style="font-size:10px;padding:2px 7px;border:1px solid #bbb;border-radius:3px;background:#f4f6f8;color:#555;cursor:pointer;">None</button>
            <button onclick="resetColState()"   style="font-size:10px;padding:2px 7px;border:1px solid #bbb;border-radius:3px;background:#f4f6f8;color:#555;cursor:pointer;">Reset</button>
          </div>
        </div>
        <div id="colList" style="max-height:320px;overflow-y:auto;padding:4px 0;"></div>
        <div style="padding:6px 14px;border-top:1px solid #eee;font-size:10px;color:#aaa;">Drag to reorder &bull; &#128204; to pin</div>
      </div>
    </div> 
    <div style="position:relative;display:inline-block;">
      <button class="btn btn-out" onclick="toggleViewsPanel()" id="viewsBtn" style="font-size:11px;">&#9733; Views</button>
      <div id="viewsPanel" style="display:none;position:absolute;right:0;top:calc(100% + 4px);width:280px;background:#fff;border:1px solid #c8d8ee;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.13);z-index:9999;font-family:Arial,sans-serif;">
        <div style="padding:10px 14px;border-bottom:1px solid #eee;font-size:12px;font-weight:700;color:#1f3a5f;">&#9733; My Views</div>
        <div id="viewsList" style="max-height:220px;overflow-y:auto;padding:6px 0;"></div>
        <div style="padding:8px 14px;border-top:1px solid #eee;display:flex;flex-direction:column;gap:6px;">
          <input id="viewNameInp" type="text" placeholder="View name..." style="width:100%;padding:5px 8px;font-size:11px;border:1px solid #bbb;border-radius:3px;box-sizing:border-box;"/>
          <div style="display:flex;gap:6px;align-items:center;">
            <button class="btn btn-green" style="font-size:11px;flex:1;" onclick="saveCurrentView(false)">&#10003; Save</button>
            <label style="font-size:10px;color:#555;display:flex;align-items:center;gap:3px;cursor:pointer;">
              <input type="checkbox" id="sharedChk"> Shared
            </label>
            <button class="btn btn-out" style="font-size:10px;padding:4px 8px;color:#c0392b;border-color:#c0392b;" onclick="deleteActiveView()" id="deleteViewBtn" disabled title="Delete selected view">&#128465;</button>
          </div>
          <div id="viewMsg" style="font-size:10px;min-height:14px;color:#27ae60;"></div>
        </div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:6px;background:#eaf2fb;border:1px solid #2980b9;border-radius:4px;padding:4px 10px;">
      <button id="emailBtn" class="btn btn-blue" style="padding:5px 10px;" onclick="openEmailModal()">&#9993; Email PDF</button>
      <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#1f3a5f;cursor:pointer;white-space:nowrap;margin:0;">
        <input type="checkbox" id="emailCsvToggle" style="cursor:pointer;"> +CSV
      </label>
    </div>
    <button id="csvBtn"  class="btn btn-green" onclick="downloadReport('csv')">&#8595; CSV</button>
    <button id="pdfBtn"  class="btn btn-out"   onclick="downloadReport('pdf')">&#128196; PDF</button>
    <button class="btn btn-out" onclick="window.print()">&#128424; Print</button>
  </div>
</div>
${filterBarHtml}
<div id="comparePanel" style="display:none;background:#16304e;border-bottom:2px solid #2d6a9f;padding:10px 20px;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
    <span style="font-size:12px;font-weight:700;color:#7fb3d3;">&#128197; Period Compare</span>
    <div style="display:flex;gap:6px;">
      <button onclick="runCompare()" class="btn btn-green" style="font-size:11px;">&#9654; Run</button>
      <button onclick="clearCompare()" class="btn btn-out" style="font-size:11px;">&#10005; Clear</button>
      <button onclick="toggleComparePanel()" style="font-size:10px;padding:4px 8px;border:1px solid #bbb;border-radius:3px;background:transparent;color:#aaa;cursor:pointer;">&#10005;</button>
    </div>
  </div>
  <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-end;">
    <div style="display:flex;flex-direction:column;gap:4px;">
      <label style="font-size:10px;font-weight:700;color:#7fb3d3;text-transform:uppercase;">Mode</label>
      <select id="cmpModeSel" class="ctrl-sel" onchange="onCompareModeChange()" style="min-width:140px;">
        <option value="prior_period">Prior Period</option>
        <option value="prior_year">Prior Year</option>
        <option value="custom">Custom</option>
      </select>
    </div>
    <div style="display:flex;flex-direction:column;gap:4px;">
      <label style="font-size:10px;font-weight:700;color:#7fb3d3;text-transform:uppercase;">Current From</label>
      <input type="date" id="cmpCurrFrom" class="ctrl-sel" style="min-width:130px;" oninput="onCmpDateChange()"/>
    </div>
    <div style="display:flex;flex-direction:column;gap:4px;">
      <label style="font-size:10px;font-weight:700;color:#7fb3d3;text-transform:uppercase;">Current To</label>
      <input type="date" id="cmpCurrTo" class="ctrl-sel" style="min-width:130px;" oninput="onCmpDateChange()"/>
    </div>
    <div style="display:flex;flex-direction:column;gap:4px;">
      <label style="font-size:10px;font-weight:700;color:#7fb3d3;text-transform:uppercase;">Compare From</label>
      <input type="date" id="cmpPriorFrom" class="ctrl-sel" style="min-width:130px;"/>
    </div>
    <div style="display:flex;flex-direction:column;gap:4px;">
      <label style="font-size:10px;font-weight:700;color:#7fb3d3;text-transform:uppercase;">Compare To</label>
      <input type="date" id="cmpPriorTo" class="ctrl-sel" style="min-width:130px;"/>
    </div>
  </div>
  <div id="cmpStatus" style="font-size:10px;color:#7fb3d3;margin-top:8px;min-height:14px;"></div>
</div>
<div id="subPanel" style="display:none;background:#16304e;border-bottom:2px solid #2d6a9f;padding:10px 20px;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
    <span style="font-size:12px;font-weight:700;color:#7fb3d3;">&#9203; Email Subscriptions</span>
    <button onclick="toggleSubPanel()" style="font-size:10px;padding:4px 8px;border:1px solid #bbb;border-radius:3px;background:transparent;color:#aaa;cursor:pointer;">&#10005;</button>
  </div>
  <div style="display:flex;gap:20px;flex-wrap:wrap;">
    <div style="flex:1;min-width:260px;">
      <div style="font-size:10px;font-weight:700;color:#7fb3d3;margin-bottom:6px;text-transform:uppercase;">Active Subscriptions</div>
      <div id="subList" style="max-height:200px;overflow-y:auto;margin-bottom:8px;"></div>
      <button onclick="showNewSubForm()" class="btn btn-green" style="font-size:10px;width:100%;">+ New Subscription</button>
    </div>
    <div id="subForm" style="flex:2;min-width:320px;display:none;background:rgba(0,0,0,0.2);border-radius:4px;padding:12px;">
      <div style="font-size:11px;font-weight:700;color:#7fb3d3;margin-bottom:10px;" id="subFormTitle">New Subscription</div>
      <input type="hidden" id="subEditId" value=""/>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;gap:8px;">
          <div style="flex:2;">
            <div style="font-size:9px;font-weight:700;color:#7fb3d3;text-transform:uppercase;margin-bottom:3px;">Name</div>
            <input id="subName" type="text" placeholder="Weekly Inventory Report" style="width:100%;padding:5px 8px;font-size:11px;border:1px solid #4a7ba7;border-radius:3px;background:#1f3a5f;color:#e0eaf5;box-sizing:border-box;"/>
          </div>
          <div style="flex:1;">
            <div style="font-size:9px;font-weight:700;color:#7fb3d3;text-transform:uppercase;margin-bottom:3px;">Format</div>
            <select id="subFormat" style="width:100%;padding:5px;font-size:11px;border:1px solid #4a7ba7;border-radius:3px;background:#1f3a5f;color:#e0eaf5;">
              <option value="pdf">PDF</option>
              <option value="csv">CSV</option>
              <option value="both">PDF + CSV</option>
            </select>
          </div>
        </div>
        <div style="display:flex;gap:8px;">
          <div style="flex:1;">
            <div style="font-size:9px;font-weight:700;color:#7fb3d3;text-transform:uppercase;margin-bottom:3px;">Frequency</div>
            <select id="subFreq" onchange="onSubFreqChange()" style="width:100%;padding:5px;font-size:11px;border:1px solid #4a7ba7;border-radius:3px;background:#1f3a5f;color:#e0eaf5;">
              <option value="daily">Daily</option>
              <option value="weekly" selected>Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div style="flex:1;" id="subDayWrap">
            <div style="font-size:9px;font-weight:700;color:#7fb3d3;text-transform:uppercase;margin-bottom:3px;">Day</div>
            <select id="subDay" style="width:100%;padding:5px;font-size:11px;border:1px solid #4a7ba7;border-radius:3px;background:#1f3a5f;color:#e0eaf5;">
              <option value="0">Sunday</option><option value="1" selected>Monday</option><option value="2">Tuesday</option>
              <option value="3">Wednesday</option><option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option>
            </select>
          </div>
          <div style="flex:1;">
            <div style="font-size:9px;font-weight:700;color:#7fb3d3;text-transform:uppercase;margin-bottom:3px;">Send At</div>
            <input type="time" id="subTime" value="07:00" style="width:100%;padding:5px;font-size:11px;border:1px solid #4a7ba7;border-radius:3px;background:#1f3a5f;color:#e0eaf5;box-sizing:border-box;"/>
          </div>
        </div>
        <div>
          <div style="font-size:9px;font-weight:700;color:#7fb3d3;text-transform:uppercase;margin-bottom:3px;">Recipients</div>
          <input id="subRecipients" type="text" placeholder="user1@company.com, user2@company.com" style="width:100%;padding:5px 8px;font-size:11px;border:1px solid #4a7ba7;border-radius:3px;background:#1f3a5f;color:#e0eaf5;box-sizing:border-box;"/>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <label style="font-size:10px;color:#cde;display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input type="checkbox" id="subUseView" checked> Use current view filters &amp; sort
          </label>
        </div>
        <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:4px;">
          <button onclick="cancelSubForm()" class="btn btn-out" style="font-size:10px;">Cancel</button>
          <button onclick="saveSubscription()" class="btn btn-green" style="font-size:10px;">&#10003; Save</button>
        </div>
        <div id="subMsg" style="font-size:10px;min-height:14px;color:#27ae60;"></div>
      </div>
    </div>
  </div>
</div>
<div id="pivotConfigPanel" style="display:none;background:#16304e;border-bottom:2px solid #2d6a9f;padding:12px 20px;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
    <span style="font-size:12px;font-weight:700;color:#7fb3d3;">&#9783; Pivot Configuration</span>
    <div style="display:flex;gap:6px;">
      <button onclick="buildPivot()" class="btn btn-green"  style="font-size:11px;">&#9654; Build Pivot</button>
      <button onclick="exportPivotCsv()" class="btn btn-out" style="font-size:11px;">&#8595; CSV</button>
      <button onclick="closePivot()"  class="btn btn-out"   style="font-size:11px;">&#10005; Close</button>
    </div>
  </div>
  <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-end;">
    <div style="display:flex;flex-direction:column;gap:4px;">
      <label style="font-size:10px;font-weight:700;color:#7fb3d3;text-transform:uppercase;">Row Dimension</label>
      <select id="pvRowSel" class="ctrl-sel" style="min-width:160px;"></select>
    </div>
    <div style="display:flex;flex-direction:column;gap:4px;">
      <label style="font-size:10px;font-weight:700;color:#7fb3d3;text-transform:uppercase;">Column Dimension</label>
      <select id="pvColSel" class="ctrl-sel" style="min-width:160px;"></select>
      <label style="font-size:10px;color:#aaa;display:flex;align-items:center;gap:4px;margin-top:2px;">
        <input type="checkbox" id="pvColLimitChk" checked> Limit to top
        <input type="number" id="pvColLimit" value="20" min="1" max="200" style="width:45px;padding:2px 4px;font-size:10px;border:1px solid #4a7ba7;border-radius:3px;background:#1f3a5f;color:#fff;">
        values
      </label>
    </div>
    <div style="display:flex;flex-direction:column;gap:4px;">
      <label style="font-size:10px;font-weight:700;color:#7fb3d3;text-transform:uppercase;">Measure</label>
      <select id="pvMeasSel" class="ctrl-sel" style="min-width:160px;"></select>
    </div>
    <div style="display:flex;flex-direction:column;gap:4px;">
      <label style="font-size:10px;font-weight:700;color:#7fb3d3;text-transform:uppercase;">Aggregation</label>
      <select id="pvAggSel" class="ctrl-sel">
        <option value="sum">Sum</option>
        <option value="avg">Avg</option>
        <option value="count">Count</option>
        <option value="min">Min</option>
        <option value="max">Max</option>
        <option value="countd">Count Distinct</option>
      </select>
    </div>
    <div style="display:flex;flex-direction:column;gap:4px;">
      <label style="font-size:10px;font-weight:700;color:#7fb3d3;text-transform:uppercase;">Sort Pivot By</label>
      <select id="pvSortSel" class="ctrl-sel">
        <option value="row_asc">Row A→Z</option>
        <option value="row_desc">Row Z→A</option>
        <option value="total_desc">Total ↓</option>
        <option value="total_asc">Total ↑</option>
      </select>
    </div>
  </div>
</div>
<div id="pivotWrap" style="display:none;background:#fff;border-bottom:2px solid #dde3ea;padding:0;">
  <div id="pivotTableWrap" style="overflow-x:auto;max-height:60vh;overflow-y:auto;"></div>
  <div id="pivotStatus" style="font-size:10px;color:#888;padding:4px 16px;border-top:1px solid #eee;"></div>
</div>
<div id="cfPanel" style="display:none;background:#16304e;border-bottom:2px solid #2d6a9f;padding:10px 20px;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
    <span style="font-size:12px;font-weight:700;color:#7fb3d3;">&#127912; Conditional Formatting Rules</span>
    <div style="display:flex;gap:6px;">
      <button onclick="addCfRule()"   class="btn btn-green"  style="font-size:11px;">+ Add Rule</button>
      <button onclick="applyCfRules()" class="btn btn-orange" style="font-size:11px;">&#9654; Apply</button>
      <button onclick="clearCfRules()" style="font-size:10px;padding:4px 8px;border:1px solid #bbb;border-radius:3px;background:transparent;color:#aaa;cursor:pointer;">Clear All</button>
      <button onclick="toggleCfPanel()" style="font-size:10px;padding:4px 8px;border:1px solid #bbb;border-radius:3px;background:transparent;color:#aaa;cursor:pointer;">&#10005;</button>
    </div>
  </div>
  <div id="cfRuleList" style="display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto;"></div>
  <div id="cfMsg" style="font-size:10px;color:#7fb3d3;margin-top:6px;min-height:14px;"></div>
</div>
<div id="kpiStrip" style="display:none;background:#1f3a5f;border-bottom:2px solid #2d6a9f;padding:8px 20px;overflow-x:auto;white-space:nowrap;">
  <div style="display:inline-flex;gap:16px;align-items:center;">
    <span style="font-size:10px;font-weight:700;color:#7fb3d3;text-transform:uppercase;letter-spacing:.5px;flex-shrink:0;">&#8721; KPIs</span>
    <div id="kpiCards" style="display:inline-flex;gap:10px;flex-wrap:nowrap;"></div>
    <button onclick="toggleKpiEdit()" id="kpiEditBtn" style="font-size:10px;padding:2px 8px;border:1px solid #4a7ba7;border-radius:3px;background:transparent;color:#7fb3d3;cursor:pointer;flex-shrink:0;">&#9998; Edit</button>
  </div>
</div>
<div id="kpiEditPanel" style="display:none;background:#16304e;border-bottom:2px solid #2d6a9f;padding:10px 20px;">
  <div style="font-size:11px;font-weight:700;color:#7fb3d3;margin-bottom:8px;">Configure KPIs — select columns + metrics</div>
  <div id="kpiEditList" style="display:flex;flex-wrap:wrap;gap:10px;"></div>
  <div style="margin-top:10px;display:flex;gap:8px;">
    <button onclick="applyKpiConfig()" class="btn btn-green" style="font-size:11px;">&#10003; Apply</button>
    <button onclick="closeKpiEdit()"  class="btn btn-out"   style="font-size:11px;">Cancel</button>
    <button onclick="resetKpiConfig()" style="font-size:10px;padding:4px 8px;border:1px solid #bbb;border-radius:3px;background:transparent;color:#aaa;cursor:pointer;">Reset</button>
  </div>
</div>
<div class="wrap">
  <table>
    <thead>
      <tr id="headerRow">${thCells}</tr>
      <tr data-filter-row>${filterCells}</tr>
    </thead>
    <tbody id="tBody"></tbody>
  </table>
</div>
<div class="footer">${COMPANY} &bull; Report Dashboard &bull; ${esc(label)}</div>
<div id="emailModal" class="modal-overlay">
  <div class="modal-box">
    <h2>Email Report</h2>
    <form method="POST" action="" onsubmit="return syncAndSubmit(this)">
      <input type="hidden" name="custpage_search_id"  value="${esc(searchId)}">
      <input type="hidden" name="custpage_label"      value="${esc(label)}">
      <input type="hidden" name="custpage_view"       value="${esc(view)}">
      <input type="hidden" name="custpage_sort_col"   id="m_sort_col"  value="">
      <input type="hidden" name="custpage_sort_dir"   id="m_sort_dir"  value="">
      <input type="hidden" name="custpage_group_col"  id="m_group_col" value="">
      <input type="hidden" name="custpage_filters"    id="m_filters"   value="">
      <input type="hidden" name="custpage_overrides"  id="m_overrides" value="">
      <input type="hidden" name="custpage_drilldown"  id="m_drilldown" value="">
      <input type="hidden" name="custpage_col_order"   id="m_col_order"   value="">
      <input type="hidden" name="custpage_col_visible" id="m_col_visible" value="">
      <input type="hidden" name="custpage_email_csv"  id="m_email_csv" value="">
      <div class="form-grp"><label>To (comma separated):</label><input type="text" name="custpage_email_to" placeholder="user@company.com" required></div>
      <div class="form-grp"><label>Subject:</label><input type="text" name="custpage_email_subject" value="${esc(label)} Report" required></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-out" onclick="closeEmailModal()">Cancel</button>
        <button type="submit" id="sendEmailBtn" class="btn btn-dark">&#10148; Send</button>
      </div>
    </form>
  </div>
</div>
<script>
var sortCol               = SORT_COL_PLACEHOLDER;
var sortDir               = SORT_DIR_PLACEHOLDER;
var groupCol              = GROUP_COL_PLACEHOLDER;
var dashBase              = _b64json(DASH_BASE_PLACEHOLDER);
var rawData               = _b64json(RAW_DATA_PLACEHOLDER);
var totalRows             = rawData.length;
var searchFilterOverrides = [];
var filteredData          = [];
var currentPage           = 1;
var pageSize              = 100;
var isSummaryView         = IS_SUMMARY_PLACEHOLDER;
var visColCount           = VIS_COL_COUNT_PLACEHOLDER;
var ddPayloadEncoded      = _b64json(DD_PAYLOAD_PLACEHOLDER);
var hasMoreData           = HAS_MORE_PLACEHOLDER;
var compareActive         = false;
var compareData           = null;
var DATE_FILTER_IDX       = DATE_FILTER_IDX_PLACEHOLDER;
var DATE_FILTER_VALS      = _b64json(DATE_FILTER_VALS_PLACEHOLDER);
var SEARCH_ID             = _b64json(SEARCH_ID_PLACEHOLDER);
var SEARCH_LABEL          = _b64json(SEARCH_LABEL_PLACEHOLDER);
var VIEWS_BASE            = _b64json(VIEWS_BASE_PLACEHOLDER);
var COL_LABELS            = _b64json(COL_LABELS_PLACEHOLDER);
var activeViewId          = null;
var activeViewName        = null;
var colVisible            = [];
var colOrder              = [];
var colPinned             = [];

// Decode base64-encoded JSON payloads. Mirrors server jsonB64().
// atob -> binary -> UTF-8 percent-decode -> JSON.parse. Browser-safe.
function _b64json(b64){
  try{
    var bin = atob(b64), pct = '';
    for (var i = 0; i < bin.length; i++) {
      pct += '%' + ('00' + bin.charCodeAt(i).toString(16)).slice(-2);
    }
    return JSON.parse(decodeURIComponent(pct));
  } catch(e){ return JSON.parse(atob(b64)); }
}
function escJs(s){return String(s||'').split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;');}

var NOVALUE_OPS_JS = new Set(['isempty','isnotempty']);
var RANGE_OPS_JS   = new Set(['within','between','notwithin']);

document.addEventListener('DOMContentLoaded', function() {
  initColState();
  applyFiltersAndRender();
  setupResizers();
  HAS_FILTERS_PLACEHOLDER
  if (hasMoreData) setTimeout(backgroundLoadAll, 200);
});

function initColState(cfg) {
  var n = visColCount;
  if (cfg && cfg.colVisible && cfg.colVisible.length === n) {
    colVisible = cfg.colVisible.slice();
  } else {
    colVisible = [];
    for (var i = 0; i < n; i++) colVisible.push(true);
  }
  if (cfg && cfg.colOrder && cfg.colOrder.length === n) {
    colOrder = cfg.colOrder.slice();
  } else {
    colOrder = [];
    for (var i = 0; i < n; i++) colOrder.push(i);
  }
  if (cfg && cfg.colPinned && cfg.colPinned.length === n) {
    colPinned = cfg.colPinned.slice();
  } else {
    colPinned = [];
    for (var i = 0; i < n; i++) colPinned.push(false);
  }
  rebuildHeaderFromColState();
}

// triggerLoadAll: called by the Load All toolbar button.
function triggerLoadAll() {
  var btn = document.getElementById('loadAllBtn');
  if (btn) btn.disabled = true;
  backgroundLoadAll();
}

// Background-load all remaining rows via mode=refresh.
// Shows a banner + disables the Load All button while running.
// On success: replaces rawData and re-renders. On failure: shows Retry button.
var bgLoadInProgress = false;
function backgroundLoadAll() {
  if (bgLoadInProgress) return;
  bgLoadInProgress = true;

  var banner   = document.getElementById('bgLoadBanner');
  var spinner  = document.getElementById('bgLoadSpinner');
  var msgEl    = document.getElementById('bgLoadMsg');
  var countEl  = document.getElementById('bgLoadCount');
  var retryBtn = document.getElementById('bgRetryBtn');
  var doneMsg  = document.getElementById('bgDoneMsg');
  var loadBtn  = document.getElementById('loadAllBtn');

  if (banner)   { banner.style.display = 'flex'; }
  if (spinner)  { spinner.style.display = 'inline-block'; }
  if (msgEl)    { msgEl.textContent = 'Loading all rows\u2026'; msgEl.style.display = ''; }
  if (retryBtn) { retryBtn.style.display = 'none'; }
  if (doneMsg)  { doneMsg.style.display = 'none'; }
  if (countEl)  { countEl.textContent = ''; }
  if (loadBtn)  { loadBtn.disabled = true; loadBtn.innerHTML = '&#8635; Loading\u2026'; }

  fetch(dashBase + '&mode=refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ view: isSummaryView ? 'summary' : 'detail', overrides: searchFilterOverrides, drilldown: decodeURIComponent(ddPayloadEncoded) })
  })
  .then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  })
  .then(function(data) {
    bgLoadInProgress = false;
    if (!data.ok) throw new Error(data.error || 'Search error');
    var prevPage = currentPage;
    rawData    = data.rows;
    totalRows  = rawData.length;
    applyFiltersAndRender();
    var tp = Math.ceil(filteredData.length / pageSize);
    if (prevPage > 1 && prevPage <= tp) { currentPage = prevPage; renderCurrentPage(); }
    // Update UI to show success.
    if (spinner)  spinner.style.display = 'none';
    if (msgEl)    msgEl.style.display = 'none';
    if (doneMsg)  { doneMsg.textContent = '\u2713 All ' + totalRows.toLocaleString() + ' rows loaded'; doneMsg.style.display = 'inline'; }
    if (loadBtn)  { loadBtn.style.display = 'none'; }
    setTimeout(function() { if (banner) banner.style.display = 'none'; }, 3000);
  })
  .catch(function(e) {
    bgLoadInProgress = false;
    if (spinner)  spinner.style.display = 'none';
    if (msgEl)    { msgEl.textContent = 'Load failed: ' + e.message; }
    if (retryBtn) { retryBtn.style.display = 'inline-block'; }
    if (loadBtn)  { loadBtn.disabled = false; loadBtn.innerHTML = '&#8635; Load All Rows'; }
  });
}

// Drill-down: payload stored as data-dd attribute (URI-encoded JSON).
// Using a data attribute avoids all quote-nesting issues with inline onclick strings.
function doDrilldown(ddEncoded) {
  var form = document.createElement('form');
  form.method = 'POST'; form.action = dashBase; form.style.display = 'none';
  function a(n,v){var i=document.createElement('input');i.type='hidden';i.name=n;i.value=v;form.appendChild(i);}
  a('view','detail');
  a('drilldown', decodeURIComponent(ddEncoded));
  a('overrides', JSON.stringify(searchFilterOverrides));
  document.body.appendChild(form); form.submit();
}

function initFilterBar() {
  var head=document.getElementById('fbarHead'), body=document.getElementById('fbarBody');
  if(!head||!body) return;
  head.addEventListener('click',function(){
    var open=body.classList.toggle('open'); head.classList.toggle('open',open);
    head.querySelector('#fbarArrow').textContent=open?'▲':'▼';
  });
}

function toggleBetween(idx) {
  var opEl=document.querySelector('[data-fop="'+idx+'"]'), toEl=document.getElementById('between_to_'+idx);
  if(opEl&&toEl) toEl.style.display=(opEl.value==='between')?'flex':'none';
}

function buildOverrides() {
  var overrides=[];
  document.querySelectorAll('[data-filter-idx]').forEach(function(container) {
    var idx=parseInt(container.dataset.filterIdx);
    var opEl=container.querySelector('[data-fop="'+idx+'"]'); if(!opEl) return;
    var operator=opEl.value, values=[];
    if(!NOVALUE_OPS_JS.has(operator)){
      var val0El=container.querySelector('[data-fval0="'+idx+'"]');
      var v0=val0El?val0El.value.trim():'';
      if(val0El&&val0El.type==='date'&&v0) v0=htmlDateToNs(v0);
      if(v0) values.push(v0);
      if(RANGE_OPS_JS.has(operator)){
        var val1El=container.querySelector('[data-fval1="'+idx+'"]');
        var v1=val1El?val1El.value.trim():'';
        if(val1El&&val1El.type==='date'&&v1) v1=htmlDateToNs(v1);
        if(v1) values.push(v1);
      }
      if(operator==='anyof'||operator==='notanyof') values=v0.split(',').map(function(s){return s.trim();}).filter(Boolean);
    }
    overrides.push({idx:idx,operator:operator,values:values});
  });
  return overrides;
}

function applySearchFilters() {
  searchFilterOverrides=buildOverrides(); markFilterChanges();
  var spinner=document.getElementById('fbarSpinner'), btn=document.getElementById('fbarApplyBtn');
  if(spinner) spinner.style.display='inline'; if(btn) btn.disabled=true;
  fetch(dashBase+'&mode=refresh',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ view: isSummaryView ? 'summary' : 'detail', overrides:searchFilterOverrides,drilldown:decodeURIComponent(ddPayloadEncoded)})})
  .then(function(r){return r.json();})
  .then(function(data){
    if(!data.ok){alert('Filter error: '+(data.error||'Unknown'));return;}
    rawData=data.rows; totalRows=rawData.length;
    document.querySelectorAll('[data-fcol]').forEach(function(el){el.value='';});
    applyFiltersAndRender(); updateActiveBadge();
  })
  .catch(function(e){alert('Network error: '+e.message);})
  .finally(function(){if(spinner)spinner.style.display='none';if(btn)btn.disabled=false;});
}

function resetSearchFilters(){searchFilterOverrides=[];window.location.href=dashBase;}

function markFilterChanges(){
  document.querySelectorAll('[data-filter-idx]').forEach(function(c){
    c.querySelectorAll('input').forEach(function(el){el.classList.toggle('fi-changed',!!el.value.trim());});
  });
}

function updateActiveBadge(){
  var badge=document.getElementById('fbarActiveBadge'); if(!badge) return;
  var active=searchFilterOverrides.filter(function(o){return o.values&&o.values.length>0;}).length;
  badge.textContent=active>0?active+' active':''; badge.style.display=active>0?'inline':'none';
}

function htmlDateToNs(s){
  if(!s) return '';
  var parts=s.split('-'); if(parts.length!==3) return s;
  return parseInt(parts[1])+'/'+parseInt(parts[2])+'/'+parts[0];
}

function openEmailModal(){document.getElementById('emailModal').style.display='flex';}
function closeEmailModal(){document.getElementById('emailModal').style.display='none';}

function getActiveColFilters(){
  return Array.from(document.querySelectorAll('[data-fcol]'))
    .map(function(inp){return{col:parseInt(inp.dataset.fcol),val:inp.value.toLowerCase().trim()};})
    .filter(function(f){return f.val!=='';});
}

function syncAndSubmit(form){
  document.getElementById('m_sort_col').value  = sortCol;
  document.getElementById('m_sort_dir').value  = sortDir;
  document.getElementById('m_group_col').value = groupCol;
  document.getElementById('m_filters').value   = JSON.stringify(getActiveColFilters());
  document.getElementById('m_overrides').value = JSON.stringify(searchFilterOverrides);
  document.getElementById('m_drilldown').value = decodeURIComponent(ddPayloadEncoded);
  document.getElementById('m_col_order').value   = JSON.stringify(colOrder);
  document.getElementById('m_col_visible').value = JSON.stringify(colVisible);
  document.getElementById('m_email_csv').value = document.getElementById('emailCsvToggle').checked?'yes':'';
  var btn=document.getElementById('sendEmailBtn');
  btn.innerHTML='&#8635; Sending...'; btn.style.opacity='0.7'; btn.style.pointerEvents='none';
  return true;
}

function downloadReport(mode){
  var btn=document.getElementById(mode+'Btn');
  if(btn){var orig=btn.innerHTML;btn.innerHTML='&#8635; '+(mode==='csv'?'Downloading...':'Generating...');btn.disabled=true;
    setTimeout(function(){btn.innerHTML=orig;btn.disabled=false;},4000);}
  var form=document.createElement('form');
  form.method='POST'; form.action=dashBase+'&mode='+mode;
  if(mode==='pdf') form.target='_blank'; form.style.display='none';
  function a(n,v){var i=document.createElement('input');i.type='hidden';i.name=n;i.value=v;form.appendChild(i);}
  a('view', isSummaryView ? 'summary' : 'detail');
  a('sort_col',sortCol); a('sort_dir',sortDir); a('group_col',groupCol);
  a('filters',JSON.stringify(getActiveColFilters())); a('overrides',JSON.stringify(searchFilterOverrides));
  a('drilldown',decodeURIComponent(ddPayloadEncoded));
  a('col_order',JSON.stringify(colOrder)); a('col_visible',JSON.stringify(colVisible));
  document.body.appendChild(form); form.submit(); document.body.removeChild(form);
}

function forceRefresh(){window.location.href=dashBase+'&nocache=1';}
function clickSort(col){
  if(sortCol===col){sortDir=sortDir==='asc'?'desc':'asc';}else{sortCol=col;sortDir='asc';}
  applyFiltersAndRender();
}
function setGroup(col){groupCol=col;applyFiltersAndRender();}

function applyFiltersAndRender(){
  var colFilters=getActiveColFilters();
  filteredData=rawData.filter(function(row){
    return colFilters.every(function(f){
      if(f.col>=visColCount) return true;
      return String(row[f.col]==null?'':row[f.col]).toLowerCase().includes(f.val);
    });
  });
  filteredData.sort(function(a,b){
    if(groupCol>=0&&groupCol!==sortCol){var gc=smartCmp(a[groupCol],b[groupCol],'asc');if(gc!==0)return gc;}
    if(sortCol>=0){var sc=smartCmp(a[sortCol],b[sortCol],sortDir);if(sc!==0)return sc;}
    return smartCmp(a[0],b[0],'asc');
  });
  currentPage=1; renderCurrentPage();
  if(kpiVisible) computeAndRenderKpis();
}

function renderCurrentPage(){
  var tbody=document.getElementById('tBody');
  var start=(currentPage-1)*pageSize, end=Math.min(start+pageSize,filteredData.length);
  var pageData=filteredData.slice(start,end), html='', lastGV=null;

  if(pageData.length===0){
    html='<tr><td colspan="'+visColCount+'" style="padding:20px;text-align:center;color:#888;font-style:italic;">No data returned.</td></tr>';
  } else {
    pageData.forEach(function(row,ri){
      var isNewGroup=false;
      if(groupCol>=0){var cgv=String(row[groupCol]==null?'':row[groupCol]);isNewGroup=cgv!==lastGV;lastGV=cgv;}
      var bg=ri%2===0?'#ffffff':'#f2f4fa';
      // Always slice to visColCount — strips the payload for summary rows,
      // no-op for detail rows (row.length === visColCount already).
      var ddEnc=isSummaryView?encodeURIComponent(row[row.length-1]||''):'';
      var cfStyle=cfRules.length?_getCfStyles(row):{rowBg:null,rowColor:null,rowBold:false,cellStyles:{}};
      var rowBg=cfStyle.rowBg||bg;
      var firstVis=true;
      var cells=colOrder.map(function(ci){
        if(!colVisible[ci]) return '';
        var cell=row[ci]; var v=String(cell!=null?cell:'');
        var cellCf=cfStyle.cellStyles[ci]||null;
        var cellBg=cellCf?cellCf.bg:rowBg;
        var cellColor=cellCf?cellCf.color:(cfStyle.rowColor||'');
        var cellBold=(cfStyle.rowBold||(cellCf&&cellCf.bold))?'font-weight:700;':'';
        var colorStyle=cellColor?'color:'+cellColor+';':'';
        var bl=firstVis?'border-left:3px solid #2c3e6b;':'border-left:1px solid #dde0e8;';
        firstVis=false;
        var bt=(groupCol>=0&&isNewGroup&&ri>0)?'border-top:2px solid #b0c4de;':'';
        var disp=(groupCol>=0&&ci===groupCol&&!isNewGroup)?'':v;
        var pin=colPinned[ci]?'position:sticky;left:0;z-index:1;':'';
        return '<td style="padding:5px 10px;border-bottom:1px solid #ecf0f1;vertical-align:top;background:'+cellBg+';'+bl+bt+'border-right:1px solid #dde0e8;word-break:break-word;max-width:300px;font-size:11.5px;font-family:Arial;'+pin+colorStyle+cellBold+'">'+escJs(disp)+'</td>';
      }).join('');
      if(isSummaryView){
        html+='<tr class="drilldown-row" data-dd="'+ddEnc+'" onclick="doDrilldown(this.dataset.dd)" title="Click to drill down">'+cells+'</tr>';
      } else {
        html+='<tr>'+cells+'</tr>';
      }
    });
  }
  tbody.innerHTML=html;

  document.querySelectorAll('#headerRow th[data-col]').forEach(function(th){
    var idx=parseInt(th.dataset.col),lbl=th.dataset.label||'',active=idx===sortCol;
    var arrow=active?(sortDir==='asc'?'&#9650;':'&#9660;'):'&#8597;';
    var content=th.querySelector('.th-content');
    if(content) content.innerHTML=lbl+'&nbsp;<span class="sort-ind" style="opacity:'+(active?'1':'0.35')+'">'+arrow+'</span>';
    th.style.background=active?'#162d4a':'#1f3a5f';
  });

  var totalPages=Math.ceil(filteredData.length/pageSize)||1;
  document.getElementById('pageInfo').innerHTML='Page '+currentPage+' of '+totalPages;
  document.getElementById('btnPrev').disabled=currentPage===1;
  document.getElementById('btnNext').disabled=currentPage===totalPages;
  var b=document.getElementById('rowCountBadge');
  if(b) b.textContent=(filteredData.length<totalRows?filteredData.length.toLocaleString()+' / ':'')+totalRows.toLocaleString()+' rows';
}

function prevPage(){if(currentPage>1){currentPage--;renderCurrentPage();}}
function nextPage(){var tp=Math.ceil(filteredData.length/pageSize);if(currentPage<tp){currentPage++;renderCurrentPage();}}

function smartCmp(av,bv,dir){
  function parseNum(val){
    var s=String(val==null?'':val).trim(); if(!s) return NaN;
    var clean=s.replace(new RegExp('[^0-9.,-]','g'),'');
    if(new RegExp(',[0-9]{1,2}$').test(clean)){clean=clean.split('.').join('').replace(',','.');}else{clean=clean.split(',').join('');}
    return Number(clean);
  }
  var as=String(av==null?'':av),bs=String(bv==null?'':bv);
  var an=parseNum(as),bn=parseNum(bs);
  var c=(!isNaN(an)&&!isNaN(bn))?(an-bn):as.localeCompare(bs,undefined,{numeric:true});
  return dir==='desc'?-c:c;
}

function _pvCsvCell(v){ var s=String(v==null?'':v); return new RegExp('[,"'+String.fromCharCode(10)+']').test(s)?'"'+s.split('"').join('""')+'"':s; }

function setupResizers(){
  var table=document.querySelector('table');
  document.querySelectorAll('#headerRow th').forEach(function(col){
    var resizer=col.querySelector('.resizer'); if(!resizer) return;
    var x=0,w=0,isResizing=false;
    resizer.addEventListener('mousedown',function(e){
      e.preventDefault(); x=e.clientX; w=col.offsetWidth;
      if(table.style.tableLayout!=='fixed'){
        document.querySelectorAll('#headerRow th').forEach(function(c){c.style.width=c.offsetWidth+'px';});
        table.style.tableLayout='fixed';
      }
      document.addEventListener('mousemove',onMove); document.addEventListener('mouseup',onUp);
      resizer.classList.add('resizing');
    });
    function onMove(e){if(!isResizing){isResizing=true;window.requestAnimationFrame(function(){col.style.width=Math.max(30,w+(e.clientX-x))+'px';isResizing=false;});}}
    function onUp(){resizer.classList.remove('resizing');document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);}
  });
}
// ── SUBSCRIPTIONS ─────────────────────────────────────────────────────────
function toggleSubPanel(){var p=document.getElementById('subPanel');if(!p)return;var open=p.style.display==='block';p.style.display=open?'none':'block';if(!open)loadSubList();}
function loadSubList(){var list=document.getElementById('subList');if(!list)return;list.innerHTML='<div style="font-size:10px;color:#888;padding:6px;">Loading&#8230;</div>';fetch(VIEWS_BASE+'&mode=loadsubs&id='+encodeURIComponent(SEARCH_ID),{method:'POST'}).then(function(r){return r.text();}).then(function(txt){var data;try{data=JSON.parse(txt);}catch(e){console.error('loadsubs raw response:',txt.slice(0,500));throw new Error('Server returned non-JSON (likely session/auth issue)');}return data;}).then(function(data){if(!data.ok||!data.subs.length){list.innerHTML='<div style="font-size:10px;color:#aaa;font-style:italic;padding:6px;">No subscriptions yet.</div>';return;}list.innerHTML=data.subs.map(function(s){var fl=s.frequency==='daily'?'Daily':s.frequency==='weekly'?'Weekly':'Monthly';return'<div style="background:rgba(255,255,255,0.06);border-radius:4px;padding:7px 10px;margin-bottom:6px;border:1px solid rgba(255,255,255,0.1);"><div style="display:flex;justify-content:space-between;align-items:center;gap:6px;"><div style="font-size:11px;color:#e0eaf5;font-weight:600;">'+escJs(s.name)+'</div><div style="display:flex;gap:4px;"><button class="sub-toggle-btn" data-sid="'+escJs(s.id)+'" data-newactive="'+(s.active?'false':'true')+'" style="font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer;background:transparent;border:1px solid '+(s.active?'#27ae60':'#aaa')+';color:'+(s.active?'#27ae60':'#aaa')+';">'+(s.active?'ACTIVE':'PAUSED')+'</button><button class="sub-delete-btn" data-sid="'+escJs(s.id)+'" style="font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer;background:transparent;border:1px solid #e74c3c;color:#e74c3c;">&#128465;</button></div></div><div style="font-size:9px;color:#7fb3d3;margin-top:3px;">'+fl+' &bull; '+escJs(s.format.toUpperCase())+' &bull; '+escJs(s.recipients)+'</div>'+(s.last_sent?'<div style="font-size:9px;color:#555;margin-top:2px;">Last sent: '+escJs(s.last_sent)+'</div>':'')+'</div>';}).join('');list.querySelectorAll('.sub-toggle-btn').forEach(function(btn){btn.addEventListener('click',function(){toggleSubActive(btn.dataset.sid,btn.dataset.newactive==='true');});});list.querySelectorAll('.sub-delete-btn').forEach(function(btn){btn.addEventListener('click',function(){deleteSub(btn.dataset.sid);});});}).catch(function(e){list.innerHTML='<div style="font-size:10px;color:#e74c3c;padding:6px;">Load failed: '+escJs(e.message)+'</div>';});}
function showNewSubForm(){document.getElementById('subEditId').value='';document.getElementById('subName').value=SEARCH_LABEL+' Report';document.getElementById('subRecipients').value='';document.getElementById('subFreq').value='weekly';document.getElementById('subFormat').value='pdf';document.getElementById('subDay').value='1';document.getElementById('subTime').value='07:00';document.getElementById('subUseView').checked=true;document.getElementById('subFormTitle').textContent='New Subscription';document.getElementById('subMsg').textContent='';document.getElementById('subForm').style.display='block';onSubFreqChange();}
function cancelSubForm(){document.getElementById('subForm').style.display='none';}
function onSubFreqChange(){var freq=document.getElementById('subFreq').value;var dw=document.getElementById('subDayWrap');var dl=document.getElementById('subDay');if(!dw)return;if(freq==='daily'){dw.style.display='none';}else if(freq==='weekly'){dw.style.display='';if(dl)dl.innerHTML='<option value="0">Sunday</option><option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option><option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option>';if(dl)dl.value='1';}else{dw.style.display='';if(dl){var o='';for(var d=1;d<=28;d++)o+='<option value="'+d+'">'+d+'</option>';dl.innerHTML=o;dl.value='1';}}}
function saveSubscription(){var name=(document.getElementById('subName').value||'').trim();var recip=(document.getElementById('subRecipients').value||'').trim();if(!name||!recip){setSubMsg('Name and recipients required.','#e74c3c');return;}var params=new URLSearchParams();params.set('search_id',SEARCH_ID);params.set('sub_name',name);params.set('recipients',recip);params.set('frequency',document.getElementById('subFreq').value);var d=document.getElementById('subDay');params.set('day',d?d.value:'1');params.set('time',document.getElementById('subTime').value);params.set('format',document.getElementById('subFormat').value);params.set('config',document.getElementById('subUseView').checked?_captureConfig():'{}');var eid=document.getElementById('subEditId').value;if(eid)params.set('sub_id',eid);fetch(VIEWS_BASE+'&mode=savesub',{method:'POST',body:params}).then(function(r){return r.json();}).then(function(data){if(!data.ok){setSubMsg('Error: '+data.error,'#e74c3c');return;}setSubMsg('Saved!','#27ae60');document.getElementById('subForm').style.display='none';loadSubList();}).catch(function(e){setSubMsg('Network error: '+e.message,'#e74c3c');});}
function deleteSub(id){if(!confirm('Delete this subscription?'))return;var params=new URLSearchParams();params.set('sub_id',id);fetch(VIEWS_BASE+'&mode=deletesub',{method:'POST',body:params}).then(function(r){return r.json();}).then(function(data){if(data.ok)loadSubList();else setSubMsg('Error: '+data.error,'#e74c3c');}).catch(function(){});}
function toggleSubActive(id,active){var params=new URLSearchParams();params.set('sub_id',id);params.set('active',active?'1':'0');fetch(VIEWS_BASE+'&mode=togglesub',{method:'POST',body:params}).then(function(r){return r.json();}).then(function(data){if(data.ok)loadSubList();}).catch(function(){});}
function setSubMsg(msg,color){var el=document.getElementById('subMsg');if(!el)return;el.textContent=msg;el.style.color=color||'#27ae60';}

// ── PERIOD COMPARE ────────────────────────────────────────────────────────
function toggleComparePanel(){var p=document.getElementById('comparePanel');if(!p)return;var open=p.style.display==='block';p.style.display=open?'none':'block';if(!open)initCompareDates();var btn=document.getElementById('compareBtn');if(btn){btn.style.background=open?'':'#2c3e6b';btn.style.color=open?'':'#fff';}}
function initCompareDates(){var from=document.getElementById('cmpCurrFrom');var to=document.getElementById('cmpCurrTo');if(DATE_FILTER_VALS&&DATE_FILTER_VALS.length>=2){if(from&&!from.value)from.value=nsDateToIso(DATE_FILTER_VALS[0]);if(to&&!to.value)to.value=nsDateToIso(DATE_FILTER_VALS[1]);}onCmpDateChange();}
function nsDateToIso(ns){if(!ns)return'';var p=ns.split('/');if(p.length!==3)return'';return p[2]+'-'+('0'+p[0]).slice(-2)+'-'+('0'+p[1]).slice(-2);}
function onCmpDateChange(){var mode=document.getElementById('cmpModeSel');if(mode&&mode.value!=='custom')onCompareModeChange();}
function onCompareModeChange(){var mode=document.getElementById('cmpModeSel').value;var from=document.getElementById('cmpCurrFrom').value;var to=document.getElementById('cmpCurrTo').value;var pf=document.getElementById('cmpPriorFrom');var pt=document.getElementById('cmpPriorTo');if(!from||!to||!pf||!pt)return;if(mode==='prior_period'){var d1=new Date(from),d2=new Date(to);var range=Math.round((d2-d1)/86400000)+1;pf.value=cmpOffsetDate(from,-range);pt.value=cmpOffsetDate(to,-range);}else if(mode==='prior_year'){pf.value=from.replace(/^(\\d{4})/,function(y){return String(parseInt(y)-1);});pt.value=to.replace(/^(\\d{4})/,function(y){return String(parseInt(y)-1);});}}
function cmpOffsetDate(iso,days){var d=new Date(iso);d.setDate(d.getDate()+days);return d.toISOString().slice(0,10);}
function runCompare(){var currFrom=document.getElementById('cmpCurrFrom').value;var currTo=document.getElementById('cmpCurrTo').value;var priorFrom=document.getElementById('cmpPriorFrom').value;var priorTo=document.getElementById('cmpPriorTo').value;var status=document.getElementById('cmpStatus');if(!currFrom||!currTo||!priorFrom||!priorTo){if(status){status.textContent='Fill in all four dates.';status.style.color='#e74c3c';}return;}if(status){status.textContent='Running compare\u2026';status.style.color='#7fb3d3';}fetch(dashBase+'&mode=compare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({view:isSummaryView?'summary':'detail',overrides:searchFilterOverrides,dateFilterIdx:DATE_FILTER_IDX,currentFrom:currFrom,currentTo:currTo,priorFrom:priorFrom,priorTo:priorTo,drilldown:decodeURIComponent(ddPayloadEncoded)})}).then(function(r){return r.json();}).then(function(data){if(!data.ok){if(status){status.textContent='Error: '+data.error;status.style.color='#e74c3c';}return;}compareData=data;compareActive=true;renderCompare(data,currFrom,currTo,priorFrom,priorTo);if(status){status.textContent=data.current.length+' current rows vs '+data.prior.length+' prior rows.';status.style.color='#27ae60';}}).catch(function(e){if(status){status.textContent='Network error: '+e.message;status.style.color='#e74c3c';}});}
function renderCompare(data,cf,ct,pf,pt){var cols=data.columns;var currRows=data.current;var priorRows=data.prior;var numColIdx=-1;for(var ci=0;ci<cols.length;ci++){var sample=currRows.slice(0,20).filter(function(r){return r[ci]!==''&&r[ci]!==null;});var numCount=sample.filter(function(r){return!isNaN(parseFloat(String(r[ci]).replace(new RegExp('[^0-9.-]','g'),'')));}).length;if(numCount>sample.length*0.5){numColIdx=ci;break;}}var priorMap={};priorRows.forEach(function(row){var k=String(row[0]==null?'':row[0]);priorMap[k]=row;});var merged=currRows.map(function(row){var key=String(row[0]==null?'':row[0]);var priorRow=priorMap[key];var cv=numColIdx>=0?parseFloat(String(row[numColIdx]||'0').replace(new RegExp('[^0-9.-]','g'),''))||0:0;var pv=priorRow&&numColIdx>=0?parseFloat(String(priorRow[numColIdx]||'0').replace(new RegExp('[^0-9.-]','g'),''))||0:0;var delta=cv-pv;var pct=pv!==0?((delta/Math.abs(pv))*100):(cv!==0?100:0);return{row:row,currVal:cv,priorVal:pv,delta:delta,deltaPct:pct};});var thH=cols.map(function(c,i){return'<th style="background:#1f3a5f;color:#fff;padding:6px 10px;font-size:10px;font-weight:700;white-space:nowrap;border-right:1px solid #2d4a6e;text-align:left;">'+escJs(c)+'</th>';}).join('');if(numColIdx>=0){thH+='<th style="background:#162d4a;color:#fff;padding:6px 10px;font-size:10px;font-weight:700;white-space:nowrap;border-left:2px solid #7fb3d3;">Prior</th><th style="background:#162d4a;color:#fff;padding:6px 10px;font-size:10px;font-weight:700;">&#916;</th><th style="background:#162d4a;color:#fff;padding:6px 10px;font-size:10px;font-weight:700;">&#916; %</th>';}var rows2=merged.map(function(m,ri){var bg=ri%2===0?'#fff':'#f8f9fc';var cells=m.row.map(function(cell){return'<td style="padding:4px 10px;font-size:10px;border-bottom:1px solid #ecf0f1;border-right:1px solid #dde0e8;background:'+bg+';">'+escJs(String(cell==null?'':cell))+'</td>';}).join('');if(numColIdx>=0){var pos=m.delta>=0;var pctStr=(pos?'+':'')+m.deltaPct.toFixed(1)+'%';var dStr=(pos?'+':'')+_fmtNum(m.delta);cells+='<td style="padding:4px 10px;font-size:10px;border-bottom:1px solid #ecf0f1;border-left:2px solid #c8d8ee;color:#888;background:'+bg+';">'+_fmtNum(m.priorVal)+'</td>';cells+='<td style="padding:4px 10px;font-size:10px;border-bottom:1px solid #ecf0f1;font-weight:700;color:'+(pos?'#27ae60':'#e74c3c')+';background:'+bg+';">'+dStr+'</td>';cells+='<td style="padding:4px 10px;font-size:10px;border-bottom:1px solid #ecf0f1;background:'+bg+';"><span style="background:'+(pos?'#e8f5e9':'#fdecea')+';color:'+(pos?'#1b5e20':'#c0392b')+';border-radius:10px;padding:1px 7px;font-size:9px;font-weight:700;">'+pctStr+'</span></td>';}return'<tr>'+cells+'</tr>';}).join('');var tbody=document.getElementById('tBody');var headerRow=document.getElementById('headerRow');if(headerRow)headerRow.innerHTML=thH;if(tbody)tbody.innerHTML=rows2||'<tr><td colspan="'+(cols.length+3)+'" style="padding:20px;text-align:center;color:#888;">No data.</td></tr>';var b=document.getElementById('rowCountBadge');if(b)b.textContent=merged.length+' rows (compare mode)';}
function clearCompare(){compareActive=false;compareData=null;var p=document.getElementById('comparePanel');if(p)p.style.display='none';var btn=document.getElementById('compareBtn');if(btn){btn.style.background='';btn.style.color='';}initColState();applyFiltersAndRender();}

// ── PIVOT MODE ────────────────────────────────────────────────────────────

var pivotOpen    = false;
var pivotData    = null;   // last built pivot result
var pvSortColIdx = null;   // which col-dim value user clicked to sort by

function togglePivotMode(){
  pivotOpen=!pivotOpen;
  var cfgPanel=document.getElementById('pivotConfigPanel');
  var wrap=document.getElementById('pivotWrap');
  var btn=document.getElementById('pivotBtn');
  var mainWrap=document.querySelector('.wrap');
  if(pivotOpen){
    _populatePivotSelectors();
    if(cfgPanel) cfgPanel.style.display='block';
    if(btn) btn.classList.add('active');
    if(mainWrap) mainWrap.style.display='none';
  } else {
    closePivot();
  }
}

function closePivot(){
  pivotOpen=false;
  var cfgPanel=document.getElementById('pivotConfigPanel');
  var wrap=document.getElementById('pivotWrap');
  var btn=document.getElementById('pivotBtn');
  var mainWrap=document.querySelector('.wrap');
  if(cfgPanel) cfgPanel.style.display='none';
  if(wrap) wrap.style.display='none';
  if(btn) btn.classList.remove('active');
  if(mainWrap) mainWrap.style.display='';
}

function _populatePivotSelectors(){
  var rowSel=document.getElementById('pvRowSel');
  var colSel=document.getElementById('pvColSel');
  var measSel=document.getElementById('pvMeasSel');
  if(!rowSel||!colSel||!measSel) return;

  // Build options using DOM API — no string concatenation, no quote issues.
  [rowSel,colSel,measSel].forEach(function(sel){
    sel.innerHTML='';
    colOrder.filter(function(ci){return colVisible[ci];}).forEach(function(ci){
      var opt=document.createElement('option');
      opt.value=String(ci);
      opt.textContent=COL_LABELS[ci]||('Col '+ci);
      sel.appendChild(opt);
    });
  });

  // Defaults
  var vis=colOrder.filter(function(ci){return colVisible[ci];});
  if(vis.length>0) rowSel.value=String(vis[0]);
  if(vis.length>1) colSel.value=String(vis[1]);
  var numCols=_detectNumericCols();
  if(numCols.length) measSel.value=String(numCols[numCols.length-1]);
  else if(vis.length>0) measSel.value=String(vis[vis.length-1]);
}

function buildPivot(){
  var rowCi=parseInt(document.getElementById('pvRowSel').value);
  var colCi=parseInt(document.getElementById('pvColSel').value);
  var measCi=parseInt(document.getElementById('pvMeasSel').value);
  var agg=document.getElementById('pvAggSel').value;
  var sortBy=document.getElementById('pvSortSel').value;
  var limitChk=document.getElementById('pvColLimitChk').checked;
  var colLimit=parseInt(document.getElementById('pvColLimit').value)||20;

  if(rowCi===colCi){ alert('Row and Column dimensions must be different columns.'); return; }

  var data=filteredData;
  if(!data.length){ alert('No data in current view.'); return; }

  // Aggregate: map[rowVal][colVal] = [values...]
  var map={}, rowOrder=[], colSet={};
  data.forEach(function(row){
    var rv=String(row[rowCi]==null?'':row[rowCi]);
    var cv=String(row[colCi]==null?'':row[colCi]);
    var mv=row[measCi]; var mn=parseFloat(String(mv==null?'':mv).replace(new RegExp('[^0-9.-]','g'),''));
    if(!map[rv]){ map[rv]={}; rowOrder.push(rv); }
    if(!map[rv][cv]) map[rv][cv]=[];
    map[rv][cv].push(isNaN(mn)?null:mn);
    colSet[cv]=true;
  });

  // Column dimension values — limit to top N by total measure
  var allCols=Object.keys(colSet);
  if(limitChk&&allCols.length>colLimit){
    // Score each col-dim value by sum across all rows
    var colScores={};
    allCols.forEach(function(cv){
      var total=0;
      rowOrder.forEach(function(rv){ (map[rv][cv]||[]).forEach(function(v){ if(v!=null) total+=v; }); });
      colScores[cv]=total;
    });
    allCols.sort(function(a,b){ return colScores[b]-colScores[a]; });
    allCols=allCols.slice(0,colLimit);
  } else {
    allCols.sort();
  }

  // Compute aggregated cell values
  var _agg=function(vals,aggType){
    var nums=vals.filter(function(v){return v!=null;});
    if(!nums.length) return null;
    switch(aggType){
      case 'sum':    return nums.reduce(function(a,b){return a+b;},0);
      case 'avg':    return nums.reduce(function(a,b){return a+b;},0)/nums.length;
      case 'count':  return vals.length;
      case 'countd': return (function(){ var s={}; vals.forEach(function(v){s[v]=1;}); return Object.keys(s).length; })();
      case 'min':    return Math.min.apply(null,nums);
      case 'max':    return Math.max.apply(null,nums);
      default:       return nums.reduce(function(a,b){return a+b;},0);
    }
  };

  // Build result grid: rows × cols
  var grid=[];
  rowOrder.forEach(function(rv){
    var cells={}, rowTotal=0, rowTotalVals=[];
    allCols.forEach(function(cv){
      var vals=map[rv][cv]||[];
      var agged=_agg(vals,agg);
      cells[cv]=agged;
      if(agged!=null) rowTotalVals.push(agged);
    });
    var rowAgg=_agg(rowTotalVals,agg==='count'||agg==='countd'?'sum':agg);
    grid.push({ rv:rv, cells:cells, total:rowAgg });
  });

  // Sort rows
  if(sortBy==='row_asc')   grid.sort(function(a,b){ return String(a.rv).localeCompare(String(b.rv)); });
  if(sortBy==='row_desc')  grid.sort(function(a,b){ return String(b.rv).localeCompare(String(a.rv)); });
  if(sortBy==='total_desc') grid.sort(function(a,b){ return (b.total||0)-(a.total||0); });
  if(sortBy==='total_asc')  grid.sort(function(a,b){ return (a.total||0)-(b.total||0); });

  // Column totals
  var colTotals={}, grandTotalVals=[];
  allCols.forEach(function(cv){
    var vals=grid.map(function(r){return r.cells[cv];}).filter(function(v){return v!=null;});
    colTotals[cv]=_agg(vals,agg==='count'||agg==='countd'?'sum':agg);
    if(colTotals[cv]!=null) grandTotalVals.push(colTotals[cv]);
  });
  var grandTotal=_agg(grandTotalVals,agg==='count'||agg==='countd'?'sum':agg);

  // Heatmap: find max non-total cell value
  var allVals=[];
  grid.forEach(function(r){ allCols.forEach(function(cv){ if(r.cells[cv]!=null) allVals.push(r.cells[cv]); }); });
  var maxVal=allVals.length?Math.max.apply(null,allVals):1;
  var minVal=allVals.length?Math.min.apply(null,allVals):0;
  var range=maxVal-minVal||1;

  pivotData={ grid:grid, allCols:allCols, colTotals:colTotals, grandTotal:grandTotal,
    rowCi:rowCi, colCi:colCi, measCi:measCi, agg:agg,
    maxVal:maxVal, minVal:minVal, range:range };

  _renderPivotTable();
}

function _renderPivotTable(){
  if(!pivotData) return;
  var d=pivotData;
  var rowLabel=COL_LABELS[d.rowCi]||'Row';
  var colLabel=COL_LABELS[d.colCi]||'Col';
  var measLabel=COL_LABELS[d.measCi]||'Measure';

  // Header row
  var thCells='<th class="pv-row-header" style="position:sticky;left:0;top:0;z-index:4;background:#162d4a;color:#fff;padding:5px 10px;font-weight:600;">'+escJs(rowLabel)+'</th>';
  d.allCols.forEach(function(cv,ci){
    thCells+='<th class="pv-th" data-pvcol="'+escJs(cv)+'">'+escJs(cv||'(blank)')+'</th>';
  });
  thCells+='<th class="pv-th pv-total-hdr">Total</th>';

  // Data rows
  var dataRows=d.grid.map(function(row){
    var tds='<td class="pv-row-label">'+escJs(row.rv||'(blank)')+'</td>';
    d.allCols.forEach(function(cv){
      var v=row.cells[cv];
      var disp=v!=null?_fmtNum(v):'';
      // Heatmap intensity
      var intensity=v!=null?(v-d.minVal)/d.range:0;
      var r2=Math.round(255-(255-21)*intensity);
      var g2=Math.round(255-(255-101)*intensity);
      var b2=Math.round(255-(255-192)*intensity);
      var bg=v!=null?'rgb('+r2+','+g2+','+b2+')':'#fff';
      var textColor=intensity>0.6?'#fff':'#1a1a2e';
      var barW=v!=null?Math.max(2,Math.round(intensity*40)):0;
      var bar=v!=null?'<span class="pv-bar" style="width:'+barW+'px;opacity:0.5;"></span>':'';
      tds+='<td style="background:'+bg+';color:'+textColor+';">'
        +'<div class="pv-bar-wrap">'+bar+'<span>'+escJs(disp)+'</span></div></td>';
    });
    var tot=row.total!=null?_fmtNum(row.total):'';
    tds+='<td class="pv-total">'+escJs(tot)+'</td>';
    return '<tr>'+tds+'</tr>';
  }).join('');

  // Totals row
  var totRow='<td class="pv-row-label" style="background:#dce5f2;font-weight:700;">Grand Total</td>';
  d.allCols.forEach(function(cv){
    var v=d.colTotals[cv];
    totRow+='<td style="background:#dce5f2;font-weight:700;text-align:right;">'+escJs(v!=null?_fmtNum(v):'')+'</td>';
  });
  totRow+='<td class="pv-total" style="background:#2d6a9f;color:#fff;">'+escJs(d.grandTotal!=null?_fmtNum(d.grandTotal):'')+'</td>';

  var html='<table class="pv-table">'
    +'<thead><tr>'+thCells+'</tr></thead>'
    +'<tbody>'+dataRows+'<tr>'+totRow+'</tr></tbody>'
    +'</table>';

  var wrap=document.getElementById('pivotWrap');
  var tWrap=document.getElementById('pivotTableWrap');
  var status=document.getElementById('pivotStatus');
  if(tWrap){
    tWrap.innerHTML=html;
    // Attach sort handlers via DOM — avoids inline string/quote issues entirely.
    tWrap.querySelectorAll('th[data-pvcol]').forEach(function(th){
      th.addEventListener('click',function(){ pvSortByCol(th.dataset.pvcol); });
    });
  }
  if(wrap)  wrap.style.display='block';
  if(status) status.textContent=d.grid.length+' rows x '+d.allCols.length+' columns | '+d.agg.toUpperCase()+' of '+(COL_LABELS[d.measCi]||'Measure');
}

function pvSortByCol(cv){
  if(!pivotData) return;
  // Sort grid by specific column value desc, then asc on second click
  var cur=pvSortColIdx;
  if(cur===cv){
    // Already sorted by this col desc → sort asc
    pivotData.grid.sort(function(a,b){ return (a.cells[cv]||0)-(b.cells[cv]||0); });
    pvSortColIdx=null;
  } else {
    pivotData.grid.sort(function(a,b){ return (b.cells[cv]||0)-(a.cells[cv]||0); });
    pvSortColIdx=cv;
  }
  _renderPivotTable();
}

function exportPivotCsv(){
  if(!pivotData){ alert('Build pivot first.'); return; }
  var d=pivotData;
  var lines=[];
  var header=[COL_LABELS[d.rowCi]||'Row'].concat(d.allCols).concat(['Total']);
  lines.push(header.map(_pvCsvCell).join(','));
  d.grid.forEach(function(row){
    var cells=[row.rv];
    d.allCols.forEach(function(cv){ cells.push(row.cells[cv]!=null?row.cells[cv]:''); });
    cells.push(row.total!=null?row.total:'');
    lines.push(cells.map(_pvCsvCell).join(','));
  });
  var totRow=['Grand Total'];
  d.allCols.forEach(function(cv){ totRow.push(d.colTotals[cv]!=null?d.colTotals[cv]:''); });
  totRow.push(d.grandTotal!=null?d.grandTotal:'');
  lines.push(totRow.map(_pvCsvCell).join(','));
  var blob=new Blob([lines.join(String.fromCharCode(10))],{type:'text/csv'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='pivot_export.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function _pvCsvCell(v){ var s=String(v==null?'':v); return new RegExp('[,"'+String.fromCharCode(10)+']').test(s)?'"'+s.split('"').join('""')+'"':s; }
// ── CONDITIONAL FORMATTING ────────────────────────────────────────────────

var cfRules   = [];   // [{col, op, val, val2, bg, color, bold, scope}]
var CF_OPS    = ['contains','not contains','=','!=','>','>=','<','<=','is empty','is not empty','between'];
var CF_SCOPES = ['row','cell'];   // row = highlight entire row, cell = highlight matched cell only

var CF_PRESETS = [
  { label:'Red',    bg:'#fdecea', color:'#c0392b' },
  { label:'Amber',  bg:'#fff8e1', color:'#e65100' },
  { label:'Green',  bg:'#e8f5e9', color:'#1b5e20' },
  { label:'Blue',   bg:'#e3f2fd', color:'#1565c0' },
  { label:'Purple', bg:'#f3e5f5', color:'#6a1b9a' },
  { label:'Custom', bg:'#ffffff', color:'#000000' }
];

function toggleCfPanel(){
  var p=document.getElementById('cfPanel');
  if(!p) return;
  var open=p.style.display==='block';
  p.style.display=open?'none':'block';
  if(!open) renderCfRules();
}

function addCfRule(){
  cfRules.push({ col:colOrder[0]||0, op:'>', val:'', val2:'', bg:'#fff8e1', color:'#e65100', bold:false, scope:'row' });
  renderCfRules();
}

function removeCfRule(idx){
  cfRules.splice(idx,1);
  renderCfRules();
}

function renderCfRules(){
  var list=document.getElementById('cfRuleList');
  if(!list) return;
  if(!cfRules.length){
    list.innerHTML='<div style="font-size:11px;color:#7fb3d3;font-style:italic;padding:4px 0;">No rules yet. Click + Add Rule.</div>';
    return;
  }
  list.innerHTML=cfRules.map(function(r,idx){
    var colOpts=colOrder.filter(function(ci){return colVisible[ci];}).map(function(ci){
      return '<option value="'+ci+'"'+(r.col===ci?' selected':'')+'>'+escJs(COL_LABELS[ci]||'Col '+ci)+'</option>';
    }).join('');
    var opOpts=CF_OPS.map(function(op){
      return '<option value="'+escJs(op)+'"'+(r.op===op?' selected':'')+'>'+escJs(op)+'</option>';
    }).join('');
    var scopeOpts=CF_SCOPES.map(function(s){
      return '<option value="'+s+'"'+(r.scope===s?' selected':'')+'>'+s.charAt(0).toUpperCase()+s.slice(1)+'</option>';
    }).join('');
    var presetBtns=CF_PRESETS.map(function(p,pi){
      var active=(r.bg===p.bg&&r.color===p.color)?'border:2px solid #fff;':'border:1px solid #4a7ba7;';
      return '<button class="cf-color-swatch" title="'+escJs(p.label)+'" data-ridx="'+idx+'" data-pi="'+pi+'" style="background:'+escJs(p.bg)+';'+active+'"></button>';
    }).join('');
    var isBetween=r.op==='between';
    var noVal=r.op==='is empty'||r.op==='is not empty';
    var valInp=noVal?'':'<input class="cf-inp cf-val0" type="text" placeholder="value" value="'+escJs(r.val)+'"/>';
    var val2Inp=isBetween?'<span style="font-size:10px;color:#aaa;">and</span><input class="cf-inp cf-val1" type="text" placeholder="value2" value="'+escJs(r.val2)+'"/>':'';
    return '<div class="cf-rule" id="cfRule'+idx+'" data-idx="'+idx+'">'
      +'<select class="cf-sel cf-col-sel">'+colOpts+'</select>'
      +'<select class="cf-sel cf-op-sel">'+opOpts+'</select>'
      +valInp+val2Inp
      +'<span style="font-size:10px;color:#aaa;margin-left:4px;">Color:</span>'
      +presetBtns
      +'<input type="color" class="cf-bg-inp" value="'+escJs(r.bg)+'" title="BG" style="width:22px;height:22px;border:none;padding:0;cursor:pointer;border-radius:3px;">'
      +'<input type="color" class="cf-color-inp" value="'+escJs(r.color)+'" title="Text" style="width:22px;height:22px;border:none;padding:0;cursor:pointer;border-radius:3px;">'
      +'<label style="font-size:10px;color:#cde;display:flex;align-items:center;gap:3px;cursor:pointer;"><input type="checkbox" class="cf-bold-chk" '+(r.bold?'checked':'')+' > Bold</label>'
      +'<select class="cf-scope-sel">'+scopeOpts+'</select>'
      +'<button class="cf-remove cf-del-btn" title="Remove rule">&#10005;</button>'
      +'</div>';
  }).join('');

  // Attach all event listeners after render — no inline JS strings, no quote issues.
  list.querySelectorAll('.cf-rule').forEach(function(ruleEl){
    var idx=parseInt(ruleEl.dataset.idx);
    ruleEl.querySelector('.cf-col-sel').addEventListener('change',function(){ updateCfRule(idx,'col',parseInt(this.value)); });
    ruleEl.querySelector('.cf-op-sel').addEventListener('change',function(){ updateCfRuleOp(idx,this.value); });
    var v0=ruleEl.querySelector('.cf-val0'); if(v0) v0.addEventListener('change',function(){ updateCfRule(idx,'val',this.value); });
    var v1=ruleEl.querySelector('.cf-val1'); if(v1) v1.addEventListener('change',function(){ updateCfRule(idx,'val2',this.value); });
    ruleEl.querySelectorAll('.cf-color-swatch').forEach(function(btn){
      btn.addEventListener('click',function(){
        var pi=parseInt(this.dataset.pi);
        setCfPreset(idx, CF_PRESETS[pi].bg, CF_PRESETS[pi].color);
      });
    });
    ruleEl.querySelector('.cf-bg-inp').addEventListener('change',function(){ updateCfRule(idx,'bg',this.value); });
    ruleEl.querySelector('.cf-color-inp').addEventListener('change',function(){ updateCfRule(idx,'color',this.value); });
    ruleEl.querySelector('.cf-bold-chk').addEventListener('change',function(){ updateCfRule(idx,'bold',this.checked); });
    ruleEl.querySelector('.cf-scope-sel').addEventListener('change',function(){ updateCfRule(idx,'scope',this.value); });
    ruleEl.querySelector('.cf-del-btn').addEventListener('click',function(){ removeCfRule(idx); });
  });
}

function updateCfRule(idx, key, val){
  if(cfRules[idx]) cfRules[idx][key]=val;
}

function updateCfRuleOp(idx, val){
  cfRules[idx].op=val;
  renderCfRules();  // re-render to show/hide between + noVal inputs
}

function setCfPreset(idx, bg, color){
  cfRules[idx].bg=bg; cfRules[idx].color=color;
  renderCfRules();
}

function applyCfRules(){
  var panel=document.getElementById('cfPanel');
  if(panel) panel.style.display='none';
  renderCurrentPage();
  var msg=document.getElementById('cfMsg');
  if(msg){ msg.textContent=cfRules.length+' rule'+(cfRules.length!==1?'s':'')+' active.'; }
}

function clearCfRules(){
  cfRules=[];
  renderCfRules();
  renderCurrentPage();
}

function _evalCfRule(rule, row){
  var ci=rule.col;
  if(ci>=visColCount) return false;
  var raw=String(row[ci]==null?'':row[ci]);
  var lo=raw.toLowerCase();
  var rv=(rule.val||'').toLowerCase();
  var rv2=(rule.val2||'').toLowerCase();
  var rn=Number(raw.replace(new RegExp('[^0-9.-]','g'),'')), rvn=Number(rv), rv2n=Number(rv2);
  switch(rule.op){
    case 'contains':      return lo.includes(rv);
    case 'not contains':  return !lo.includes(rv);
    case '=':             return (!isNaN(rn)&&!isNaN(rvn))?(rn===rvn):(lo===rv);
    case '!=':            return (!isNaN(rn)&&!isNaN(rvn))?(rn!==rvn):(lo!==rv);
    case '>':             return !isNaN(rn)&&!isNaN(rvn)&&rn>rvn;
    case '>=':            return !isNaN(rn)&&!isNaN(rvn)&&rn>=rvn;
    case '<':             return !isNaN(rn)&&!isNaN(rvn)&&rn<rvn;
    case '<=':            return !isNaN(rn)&&!isNaN(rvn)&&rn<=rvn;
    case 'between':       return !isNaN(rn)&&!isNaN(rvn)&&!isNaN(rv2n)&&rn>=rvn&&rn<=rv2n;
    case 'is empty':      return raw.trim()==='';
    case 'is not empty':  return raw.trim()!=='';
    default:              return false;
  }
}

// Returns {rowBg, rowColor, rowBold, cellStyles:{ci:{bg,color,bold}}}
function _getCfStyles(row){
  var rowBg=null, rowColor=null, rowBold=false;
  var cellStyles={};
  cfRules.forEach(function(rule){
    if(!_evalCfRule(rule,row)) return;
    if(rule.scope==='row'){
      rowBg=rule.bg; rowColor=rule.color;
      if(rule.bold) rowBold=true;
    } else {
      var ci=rule.col;
      cellStyles[ci]={ bg:rule.bg, color:rule.color, bold:rule.bold };
    }
  });
  return { rowBg:rowBg, rowColor:rowColor, rowBold:rowBold, cellStyles:cellStyles };
}
// ── KPI STRIP ─────────────────────────────────────────────────────────────

var kpiVisible  = false;
var kpiConfig   = [];   // [{ci, metrics:[]}]  — ci = column index, metrics = subset of METRICS
var METRICS     = ['sum','avg','count','min','max'];

function _detectNumericCols(){
  // Scan first 200 filtered rows — mark cols where >50% values are numeric
  var sample = filteredData.slice(0,200);
  if(!sample.length) return [];
  var counts = [];
  for(var i=0;i<visColCount;i++) counts.push({num:0,total:0});
  sample.forEach(function(row){
    colOrder.forEach(function(ci){
      if(!colVisible[ci]) return;
      var v=String(row[ci]==null?'':row[ci]).trim().replace(new RegExp('[^0-9.-]','g'),'');
      counts[ci].total++;
      if(v!==''&&!isNaN(Number(v))) counts[ci].num++;
    });
  });
  var numeric=[];
  for(var i=0;i<visColCount;i++){
    if(counts[i].total>0 && counts[i].num/counts[i].total > 0.5) numeric.push(i);
  }
  return numeric;
}

function _defaultKpiConfig(){
  var numCols=_detectNumericCols();
  // Default: first 4 numeric cols, metrics = sum + avg
  return numCols.slice(0,4).map(function(ci){
    return { ci:ci, metrics:['sum','avg'] };
  });
}

function toggleKpiStrip(){
  kpiVisible=!kpiVisible;
  var strip=document.getElementById('kpiStrip');
  var btn=document.getElementById('kpiToggleBtn');
  if(!strip) return;
  if(kpiVisible){
    if(!kpiConfig.length) kpiConfig=_defaultKpiConfig();
    strip.style.display='block';
    if(btn){ btn.style.background='#2c3e6b'; btn.style.color='#fff'; }
    computeAndRenderKpis();
  } else {
    strip.style.display='none';
    document.getElementById('kpiEditPanel').style.display='none';
    if(btn){ btn.style.background=''; btn.style.color=''; }
  }
}

function computeAndRenderKpis(){
  if(!kpiVisible||!kpiConfig.length) return;
  var cards=document.getElementById('kpiCards');
  if(!cards) return;

  var data=filteredData;   // always uses current filtered+sorted dataset

  var html='';
  kpiConfig.forEach(function(cfg){
    var ci=cfg.ci;
    if(ci>=visColCount||!colVisible[ci]) return;
    var lbl=COL_LABELS[ci]||('Col '+ci);

    // Extract numeric values for this col
    var vals=[];
    data.forEach(function(row){
      var v=String(row[ci]==null?'':row[ci]).trim().replace(new RegExp('[^0-9.-]','g'),'');
      var n=Number(v);
      if(v!==''&&!isNaN(n)) vals.push(n);
    });

    cfg.metrics.forEach(function(metric){
      var result='—';
      if(vals.length){
        switch(metric){
          case 'sum':
            var s=vals.reduce(function(a,b){return a+b;},0);
            result=_fmtNum(s); break;
          case 'avg':
            result=_fmtNum(vals.reduce(function(a,b){return a+b;},0)/vals.length); break;
          case 'count':
            result=vals.length.toLocaleString(); break;
          case 'min':
            result=_fmtNum(Math.min.apply(null,vals)); break;
          case 'max':
            result=_fmtNum(Math.max.apply(null,vals)); break;
        }
      }
      html+='<div class="kpi-card" title="'+escJs(lbl)+' — '+metric+'">'
        +'<span class="kpi-label">'+escJs(lbl.length>14?lbl.slice(0,13)+'…':lbl)+'</span>'
        +'<span class="kpi-metric">'+metric.toUpperCase()+'</span>'
        +'<span class="kpi-value">'+escJs(result)+'</span>'
        +'</div>';
    });
  });

  cards.innerHTML=html||'<span style="font-size:11px;color:#7fb3d3;font-style:italic;">No numeric columns configured.</span>';
}

function _fmtNum(n){
  if(isNaN(n)||n===null||n===undefined) return '—';
  // Show up to 2 decimal places, strip trailing zeros, add thousands comma
  var fixed=Math.round(n*100)/100;
  return fixed.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:2});
}

function toggleKpiEdit(){
  var panel=document.getElementById('kpiEditPanel');
  if(!panel) return;
  var open=panel.style.display==='block';
  if(open){ panel.style.display='none'; return; }
  renderKpiEditList();
  panel.style.display='block';
}

function closeKpiEdit(){
  var panel=document.getElementById('kpiEditPanel');
  if(panel) panel.style.display='none';
}

function renderKpiEditList(){
  var list=document.getElementById('kpiEditList');
  if(!list) return;

  // Build map of current config
  var cfgMap={};
  kpiConfig.forEach(function(c){ cfgMap[c.ci]={ metrics: c.metrics.slice() }; });

  // Show all visible numeric-candidate cols
  var numCols=_detectNumericCols();
  if(!numCols.length){
    list.innerHTML='<div style="font-size:11px;color:#aaa;font-style:italic;">No numeric columns detected in current data.</div>';
    return;
  }

  list.innerHTML=numCols.map(function(ci){
    var lbl=COL_LABELS[ci]||('Col '+ci);
    var cur=cfgMap[ci]||{metrics:[]};
    var chks=METRICS.map(function(m){
      var chk=cur.metrics.indexOf(m)>=0?'checked':'';
      return '<label class="kpi-chk-row"><input type="checkbox" data-ci="'+ci+'" data-metric="'+m+'" '+chk+'> '+m.toUpperCase()+'</label>';
    }).join('');
    return '<div class="kpi-edit-col"><label title="'+escJs(lbl)+'">'+escJs(lbl.length>18?lbl.slice(0,17)+'…':lbl)+'</label>'+chks+'</div>';
  }).join('');
}

function applyKpiConfig(){
  var newCfg=[];
  var seen={};
  document.querySelectorAll('#kpiEditList input[type=checkbox]:checked').forEach(function(inp){
    var ci=parseInt(inp.dataset.ci), metric=inp.dataset.metric;
    if(!seen[ci]){ seen[ci]={ci:ci,metrics:[]}; newCfg.push(seen[ci]); }
    seen[ci].metrics.push(metric);
  });
  kpiConfig=newCfg;
  closeKpiEdit();
  computeAndRenderKpis();
}

function resetKpiConfig(){
  kpiConfig=_defaultKpiConfig();
  renderKpiEditList();
  computeAndRenderKpis();
}
// ── COLUMNS ───────────────────────────────────────────────────────────────

var COL_LABELS = _b64json(COL_LABELS_PLACEHOLDER);

function toggleColPanel(){
  var p=document.getElementById('colPanel');
  if(!p) return;
  var open=p.style.display==='block';
  p.style.display=open?'none':'block';
  if(!open) renderColList();
}

document.addEventListener('click',function(e){
  var btn=document.getElementById('colBtn'), panel=document.getElementById('colPanel');
  if(!btn||!panel) return;
  if(!btn.contains(e.target)&&!panel.contains(e.target)) panel.style.display='none';
});

function renderColList(){
  var list=document.getElementById('colList');
  if(!list) return;
  list.innerHTML=colOrder.map(function(ci,pos){
    var vis=colVisible[ci], pin=colPinned[ci], lbl=COL_LABELS[ci]||('Col '+ci);
    return '<div class="col-item" draggable="true" data-pos="'+pos+'" data-ci="'+ci+'">'
      +'<span class="col-drag-handle">&#8942;&#8942;</span>'
      +'<input type="checkbox" '+(vis?'checked':'')+ ' onchange="toggleColVis('+ci+',this.checked)">'
      +'<span class="col-name" title="'+escJs(lbl)+'">'+escJs(lbl)+'</span>'
      +'<span class="col-pin'+(pin?' pinned':'') +'" title="Pin column" onclick="toggleColPin('+ci+')">&#128204;</span>'
      +'</div>';
  }).join('');
  setupColDrag();
}

function toggleColVis(ci, checked){
  colVisible[ci]=checked;
  rebuildHeaderFromColState();
  applyFiltersAndRender();
}

function toggleColPin(ci){
  colPinned[ci]=!colPinned[ci];
  // Pinned cols move to front of colOrder
  colOrder.sort(function(a,b){
    if(colPinned[a]&&!colPinned[b]) return -1;
    if(!colPinned[a]&&colPinned[b]) return 1;
    return 0;
  });
  renderColList();
  rebuildHeaderFromColState();
  applyFiltersAndRender();
}

function setAllCols(show){
  for(var i=0;i<visColCount;i++) colVisible[i]=show;
  renderColList();
  rebuildHeaderFromColState();
  applyFiltersAndRender();
}

function resetColState(){
  initColState();
  renderColList();
  applyFiltersAndRender();
}

function setupColDrag(){
  var items=document.querySelectorAll('#colList .col-item');
  var dragPos=null;
  items.forEach(function(el){
    el.addEventListener('dragstart',function(e){
      dragPos=parseInt(el.dataset.pos);
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed='move';
    });
    el.addEventListener('dragend',function(){ el.classList.remove('dragging'); document.querySelectorAll('.col-item').forEach(function(i){i.classList.remove('drag-over');}); });
    el.addEventListener('dragover',function(e){
      e.preventDefault(); e.dataTransfer.dropEffect='move';
      document.querySelectorAll('.col-item').forEach(function(i){i.classList.remove('drag-over');});
      el.classList.add('drag-over');
    });
    el.addEventListener('drop',function(e){
      e.preventDefault();
      var toPos=parseInt(el.dataset.pos);
      if(dragPos===null||dragPos===toPos) return;
      var moved=colOrder.splice(dragPos,1)[0];
      colOrder.splice(toPos,0,moved);
      dragPos=null;
      renderColList();
      rebuildHeaderFromColState();
      applyFiltersAndRender();
    });
  });
}

// Rebuild <thead> to match colOrder + colVisible + colPinned
function rebuildHeaderFromColState(){
  var headerRow=document.getElementById('headerRow');
  var filterRow=document.querySelector('[data-filter-row]');
  if(!headerRow||!filterRow) return;

  var thHtml='', filterHtml='';
  colOrder.forEach(function(ci){
    if(!colVisible[ci]) return;
    var lbl=COL_LABELS[ci]||('Col '+ci);
    var active=(ci===sortCol);
    var arrow=active?(sortDir==='asc'?'&#9650;':'&#9660;'):'&#8597;';
    var pin=colPinned[ci]?'position:sticky;left:0;z-index:3;':'';
    thHtml+='<th data-col="'+ci+'" data-label="'+escJs(lbl)+'" style="background:'+(active?'#162d4a':'#1f3a5f')+';color:#fff;padding:0;text-align:left;font-weight:600;font-size:11.5px;white-space:nowrap;position:sticky;top:0;z-index:2;user-select:none;'+pin+'">'
      +'<div style="display:flex;align-items:stretch;height:100%;">'
      +'<div class="th-content" onclick="clickSort('+ci+')" style="padding:8px 10px;cursor:pointer;flex-grow:1;">'+escJs(lbl)+'&nbsp;<span class="sort-ind" style="opacity:'+(active?'1':'0.35')+'">'+arrow+'</span></div>'
      +'<div class="resizer"></div>'
      +'</div></th>';
    var pinStyle=colPinned[ci]?'position:sticky;left:0;z-index:3;background:#16304e;':'';
    filterHtml+='<th style="background:#16304e;padding:4px 5px;position:sticky;top:0;z-index:2;'+pinStyle+'" class="filter-th">'
      +'<input type="text" data-fcol="'+ci+'" placeholder="Filter..." oninput="applyFiltersAndRender()" style="width:100%;padding:1px 6px;font-size:10px;border:1px solid #4a7ba7;border-radius:3px;background:#1f3a5f;color:#fff;box-sizing:border-box"/>'
      +'</th>';
  });

  headerRow.innerHTML=thHtml;
  filterRow.innerHTML=filterHtml;
  setupResizers();
}
// ── VIEWS ─────────────────────────────────────────────────────────────────

function toggleViewsPanel(){
  var p=document.getElementById('viewsPanel');
  if(!p) return;
  var open=p.style.display==='block';
  p.style.display=open?'none':'block';
  if(!open) loadViewsList();
}

document.addEventListener('click',function(e){
  var btn=document.getElementById('viewsBtn'), panel=document.getElementById('viewsPanel');
  if(!btn||!panel) return;
  if(!btn.contains(e.target)&&!panel.contains(e.target)) panel.style.display='none';
});

function loadViewsList(){
  var list=document.getElementById('viewsList');
  if(!list) return;
  list.innerHTML='<div style="padding:10px 14px;font-size:11px;color:#888;">Loading&#8230;</div>';
  fetch(VIEWS_BASE+'&mode=loadviews&id='+encodeURIComponent(SEARCH_ID))
    .then(function(r){return r.json();})
    .then(function(data){
      if(!data.ok||!data.views.length){
        list.innerHTML='<div style="padding:10px 14px;font-size:11px;color:#aaa;font-style:italic;">No saved views yet.</div>'; return;
      }
      list.innerHTML=data.views.map(function(v){
        var badge=v.shared?'<span class="vi-badge">Shared</span>':'<span class="vi-mine">Mine</span>';
        var active=v.id==activeViewId?' active':'';
        return '<div class="view-item'+active+'" data-vid="'+escJs(v.id)+'" data-vname="'+escJs(v.name)+'" data-mine="'+(v.mine?'1':'0')+'" onclick="applyView(this)">'
          +'<span class="vi-name">'+escJs(v.name)+'</span>'+badge+'</div>';
      }).join('');
    })
    .catch(function(e){list.innerHTML='<div style="padding:10px 14px;font-size:11px;color:#c0392b;">Load failed: '+escJs(e.message)+'</div>';});
}

function applyView(el){
  var vid=el.dataset.vid, vname=el.dataset.vname, mine=el.dataset.mine==='1';
  activeViewId=vid; activeViewName=vname;
  document.querySelectorAll('.view-item').forEach(function(i){i.classList.toggle('active',i.dataset.vid===vid);});
  var inp=document.getElementById('viewNameInp'), delBtn=document.getElementById('deleteViewBtn'), viewsBtn=document.getElementById('viewsBtn');
  if(inp) inp.value=vname;
  if(delBtn) delBtn.disabled=!mine;
  if(viewsBtn){ viewsBtn.textContent='\u2605 '+vname; viewsBtn.classList.add('has-view'); }
  fetch(VIEWS_BASE+'&mode=loadview&vid='+encodeURIComponent(vid))
    .then(function(r){return r.json();})
    .then(function(data){
      if(!data.ok){ setViewMsg('Load failed: '+data.error,'#c0392b'); return; }
      try{ var cfg=JSON.parse(data.config||'{}'); _applyConfig(cfg); }
      catch(e){ setViewMsg('Bad config JSON','#c0392b'); }
      document.getElementById('viewsPanel').style.display='none';
    })
    .catch(function(e){ setViewMsg('Network error: '+e.message,'#c0392b'); });
}

function _applyConfig(cfg){
  // Sort
  if(typeof cfg.sortCol==='number') sortCol=cfg.sortCol;
  if(cfg.sortDir) sortDir=cfg.sortDir;
  // Group
  if(typeof cfg.groupCol==='number'){
    groupCol=cfg.groupCol;
    var gs=document.getElementById('groupSel');
    if(gs) gs.value=String(groupCol);
  }
  // Column state
  if(cfg.colVisible||cfg.colOrder||cfg.colPinned){
    initColState({ colVisible: cfg.colVisible, colOrder: cfg.colOrder, colPinned: cfg.colPinned });
  }
  /// KPI state
  if(cfg.kpiConfig) kpiConfig=cfg.kpiConfig;
  if(cfg.kpiVisible){
    kpiVisible=false;
    toggleKpiStrip();
  }
  // CF rules
  if(cfg.cfRules&&Array.isArray(cfg.cfRules)){
    cfRules=cfg.cfRules;
    renderCurrentPage();
  }
  // Pivot
  if(cfg.pivotCfg){
    togglePivotMode();
    setTimeout(function(){
      var p=cfg.pivotCfg;
      var rs=document.getElementById('pvRowSel');
      var cs=document.getElementById('pvColSel');
      var ms=document.getElementById('pvMeasSel');
      var as=document.getElementById('pvAggSel');
      var ss=document.getElementById('pvSortSel');
      var cl=document.getElementById('pvColLimit');
      var lc=document.getElementById('pvColLimitChk');
      if(rs&&p.rowCi>=0) rs.value=p.rowCi;
      if(cs&&p.colCi>=0) cs.value=p.colCi;
      if(ms&&p.measCi>=0) ms.value=p.measCi;
      if(as) as.value=p.agg||'sum';
      if(ss) ss.value=p.sortBy||'row_asc';
      if(cl) cl.value=p.colLimit||20;
      if(lc) lc.checked=p.limitChk!==false;
      buildPivot();
    },100);
  }
  // Column filters — rebuild after col state so data-fcol inputs exist
  if(cfg.colFilters&&Array.isArray(cfg.colFilters)){
    document.querySelectorAll('[data-fcol]').forEach(function(inp){ inp.value=''; });
    cfg.colFilters.forEach(function(f){
      var el=document.querySelector('[data-fcol="'+f.col+'"]');
      if(el) el.value=f.val;
    });
  }
  // Search filter overrides
  if(cfg.overrides&&Array.isArray(cfg.overrides)){
    searchFilterOverrides=cfg.overrides;
    // Re-run server-side refresh with restored overrides
    if(cfg.overrides.length){
      fetch(VIEWS_BASE+'&mode=refresh',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({view:isSummaryView?'summary':'detail',overrides:cfg.overrides,drilldown:decodeURIComponent(ddPayloadEncoded)})})
      .then(function(r){return r.json();})
      .then(function(d){
        if(d.ok){ rawData=d.rows; totalRows=rawData.length; applyFiltersAndRender(); }
      });
      return; // applyFiltersAndRender called inside then()
    }
  }
  applyFiltersAndRender();
}

function _captureConfig(){
  var pvCfg=null;
  if(pivotOpen){
    pvCfg={
      rowCi: parseInt(document.getElementById('pvRowSel').value||'-1'),
      colCi: parseInt(document.getElementById('pvColSel').value||'-1'),
      measCi: parseInt(document.getElementById('pvMeasSel').value||'-1'),
      agg: document.getElementById('pvAggSel').value,
      sortBy: document.getElementById('pvSortSel').value,
      colLimit: parseInt(document.getElementById('pvColLimit').value||'20'),
      limitChk: document.getElementById('pvColLimitChk').checked
    };
  }
  return JSON.stringify({
    sortCol: sortCol,
    sortDir: sortDir,
    groupCol: groupCol,
    colFilters: getActiveColFilters(),
    overrides: searchFilterOverrides,
    colVisible: colVisible.slice(),
    colOrder: colOrder.slice(),
    colPinned: colPinned.slice(),
    kpiConfig: kpiConfig.slice(),
    kpiVisible: kpiVisible,
    cfRules: cfRules.slice(),
    pivotCfg: pvCfg
  });
}

function saveCurrentView(forceNew){
  var name=(document.getElementById('viewNameInp').value||'').trim();
  var shared=document.getElementById('sharedChk').checked;
  if(!name){ setViewMsg('Enter a view name.','#c0392b'); return; }
  var params=new URLSearchParams();
  params.set('search_id', SEARCH_ID);
  params.set('search_label', SEARCH_LABEL);
  params.set('view_name', name);
  params.set('config', _captureConfig());
  params.set('shared', shared?'1':'0');
  if(activeViewId&&!forceNew&&activeViewName===name) params.set('view_id', activeViewId);
  fetch(VIEWS_BASE+'&mode=saveview',{method:'POST',body:params})
    .then(function(r){return r.json();})
    .then(function(data){
      if(!data.ok){ setViewMsg('Error: '+data.error,'#c0392b'); return; }
      activeViewId=data.id; activeViewName=name;
      var viewsBtn=document.getElementById('viewsBtn');
      if(viewsBtn){ viewsBtn.textContent='\u2605 '+name; viewsBtn.classList.add('has-view'); }
      var delBtn=document.getElementById('deleteViewBtn');
      if(delBtn) delBtn.disabled=false;
      setViewMsg(shared?'Shared preset saved.':'View saved.','#27ae60');
      loadViewsList();
    })
    .catch(function(e){ setViewMsg('Network error: '+e.message,'#c0392b'); });
}

function deleteActiveView(){
  if(!activeViewId) return;
  if(!confirm('Delete view "'+activeViewName+'"?')) return;
  var params=new URLSearchParams();
  params.set('view_id', activeViewId);
  fetch(VIEWS_BASE+'&mode=deleteview',{method:'POST',body:params})
    .then(function(r){return r.json();})
    .then(function(data){
      if(!data.ok){ setViewMsg('Error: '+data.error,'#c0392b'); return; }
      activeViewId=null; activeViewName=null;
      var inp=document.getElementById('viewNameInp'), delBtn=document.getElementById('deleteViewBtn'), viewsBtn=document.getElementById('viewsBtn');
      if(inp) inp.value='';
      if(delBtn) delBtn.disabled=true;
      if(viewsBtn){ viewsBtn.textContent='\u2605 Views'; viewsBtn.classList.remove('has-view'); }
      setViewMsg('View deleted.','#e67e22');
      loadViewsList();
    })
    .catch(function(e){ setViewMsg('Network error: '+e.message,'#c0392b'); });
}

function setViewMsg(msg,color){
  var el=document.getElementById('viewMsg');
  if(!el) return;
  el.textContent=msg; el.style.color=color||'#27ae60';
  setTimeout(function(){ el.textContent=''; },3500);
}
</script></body></html>`;

    const finalHtml = html
  .replaceAll('SORT_COL_PLACEHOLDER',      () => String(sortCol))
  .replaceAll('SORT_DIR_PLACEHOLDER',      () => safeJson(sortDir))
  .replaceAll('GROUP_COL_PLACEHOLDER',     () => String(groupCol))
  .replaceAll('DASH_BASE_PLACEHOLDER',     () => "'" + jsonB64(dashBase) + "'")
  .replaceAll('RAW_DATA_PLACEHOLDER',      () => "'" + jsonB64(rows) + "'")
  .replaceAll('IS_SUMMARY_PLACEHOLDER',    () => isSummaryView ? 'true' : 'false')
  .replaceAll('VIS_COL_COUNT_PLACEHOLDER', () => String(visColCount))
  .replaceAll('DD_PAYLOAD_PLACEHOLDER',    () => "'" + jsonB64(encodeURIComponent(ddJson || '')) + "'")
  .replaceAll('HAS_MORE_PLACEHOLDER',      () => hasMore ? 'true' : 'false')
  .replaceAll('SEARCH_ID_PLACEHOLDER',     () => "'" + jsonB64(searchId) + "'")
  .replaceAll('SEARCH_LABEL_PLACEHOLDER',  () => "'" + jsonB64(label) + "'")
  .replaceAll('VIEWS_BASE_PLACEHOLDER',    () => "'" + jsonB64(dashBase) + "'")
  .replaceAll('COL_LABELS_PLACEHOLDER',    () => "'" + jsonB64(visColumns) + "'")
  .replaceAll('HAS_FILTERS_PLACEHOLDER',      function() { return hasFilters ? 'initFilterBar();' : ''; })
  .replaceAll('HAS_DATE_FILTER_PLACEHOLDER',  function() { return hasDateFilter ? '<button class="btn btn-out" id="compareBtn" style="font-size:11px;" onclick="toggleComparePanel()">&#128197; Compare</button>' : ''; })
  .replaceAll('DATE_FILTER_IDX_PLACEHOLDER',  function() { return String(firstDateFilterIdx); })
  .replaceAll('DATE_FILTER_VALS_PLACEHOLDER', function() { return "'" + jsonB64(firstDateFilterVals) + "'"; });

    
    resp.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });
    const leftover = finalHtml.match(/[A-Z_]+_PLACEHOLDER/g);
if (leftover) log.error('PLACEHOLDER_LEAK', JSON.stringify(leftover));
    resp.write(finalHtml);
  };

  // ── REFRESH (AJAX) ────────────────────────────────────────────────────────
  const serveRefresh = (req, resp, searchId, view, overridesJson, ddJson) => {
    try {
      const overrides = JSON.parse(overridesJson || '[]');
      const loaded    = search.load({ id: searchId });
      applyFilterOverrides(loaded, overrides);
      const noOverrides = !overrides.length;
      // If no overrides and no drilldown, try cache first
      const cached = (noOverrides && !ddJson) ? readCache(searchId, view) : null;
      let columns, rows;
      if (cached) {
        columns = cached.columns; rows = cached.rows;
      } else {
        const result = runSearch(loaded, view === 'detail', ddJson);
        columns = result.columns; rows = result.rows;
        if (noOverrides && !ddJson && !result.capped) writeCache(searchId, columns, rows, view);
      }
      resp.setHeader({ name: 'Content-Type', value: 'application/json' });
      resp.write(JSON.stringify({ ok: true, columns, rows }));
    } catch(e) {
      log.error('serveRefresh', e.message);
      resp.setHeader({ name: 'Content-Type', value: 'application/json' });
      resp.write(JSON.stringify({ ok: false, error: e.message }));
    }
  };

  // ── PERIOD COMPARE ────────────────────────────────────────────────────────
  const serveCompare = (req, resp, searchId, view, overridesJson, ddJson) => {
    resp.setHeader({ name: 'Content-Type', value: 'application/json' });
    try {
      const body        = JSON.parse(req.body || '{}');
      const overrides   = body.overrides || [];
      const dateIdx     = parseInt(body.dateFilterIdx);
      const currentFrom = body.currentFrom;
      const currentTo   = body.currentTo;
      const priorFrom   = body.priorFrom;
      const priorTo     = body.priorTo;
      const forceDetail = (view === 'detail');
      if (!currentFrom || !currentTo || !priorFrom || !priorTo) {
        resp.write(JSON.stringify({ ok: false, error: 'Missing date range.' })); return;
      }
      const nsDateStr = function(iso) {
        const p = iso.split('-');
        return parseInt(p[1]) + '/' + parseInt(p[2]) + '/' + p[0];
      };
      const makeOverrides = function(from, to) {
        const base = JSON.parse(JSON.stringify(overrides));
        const filtered = base.filter(function(ov) { return ov.idx !== dateIdx; });
        filtered.push({ idx: dateIdx, operator: 'within', values: [nsDateStr(from), nsDateStr(to)] });
        return filtered;
      };
      const loadedA = search.load({ id: searchId });
      applyFilterOverrides(loadedA, makeOverrides(currentFrom, currentTo));
      const resA = runSearch(loadedA, forceDetail, ddJson);
      const loadedB = search.load({ id: searchId });
      applyFilterOverrides(loadedB, makeOverrides(priorFrom, priorTo));
      const resB = runSearch(loadedB, forceDetail, ddJson);
      resp.write(JSON.stringify({ ok: true, columns: resA.columns, current: resA.rows, prior: resB.rows }));
    } catch(e) {
      log.error('serveCompare', e.message);
      resp.write(JSON.stringify({ ok: false, error: e.message }));
    }
  };

  // ── SUBSCRIPTION CRUD ────────────────────────────────────────────────────
  const SUB_REC = 'customrecord_dashboard_subscription';
  const SF = {
    search:'custrecord_dds_search_id', name:'custrecord_dds_name',
    recipients:'custrecord_dds_recipients', frequency:'custrecord_dds_frequency',
    day:'custrecord_dds_day', time:'custrecord_dds_time', format:'custrecord_dds_format',
    config:'custrecord_dds_config', active:'custrecord_dds_active',
    user:'custrecord_dds_user', last_sent:'custrecord_dds_last_sent'
  };
  const serveLoadSubs = (req, resp, searchId) => {
    resp.setHeader({ name: 'Content-Type', value: 'application/json' });
    try {
      const uid = runtime.getCurrentUser().id;
      const out = [];
      search.create({
        type: SUB_REC,
        filters: [[SF.search,'is',String(searchId)],'AND',[SF.user,'anyof',[uid]]],
        columns: ['internalid','name',SF.frequency,SF.day,SF.time,SF.format,SF.recipients,SF.active,SF.last_sent].map(n => search.createColumn({ name: n }))
      }).run().each(r => {
        out.push({ id: r.getValue('internalid'), name: r.getValue('name'),
          frequency: r.getValue(SF.frequency), day: r.getValue(SF.day),
          time: r.getValue(SF.time), format: r.getValue(SF.format),
          recipients: r.getValue(SF.recipients),
          active: r.getValue(SF.active) === true || r.getValue(SF.active) === 'T',
          last_sent: r.getValue(SF.last_sent) || '' });
        return true;
      });
      resp.write(JSON.stringify({ ok: true, subs: out }));
    } catch(e) { resp.write(JSON.stringify({ ok: false, error: e.message })); }
  };
  const serveSaveSub = (req, resp) => {
    resp.setHeader({ name: 'Content-Type', value: 'application/json' });
    try {
      const uid = runtime.getCurrentUser().id;
      const searchId = req.parameters.search_id;
      const name = (req.parameters.sub_name || '').trim();
      if (!searchId || !name) { resp.write(JSON.stringify({ ok:false, error:'Missing fields.' })); return; }
      const vals = { name, [SF.search]:String(searchId), [SF.recipients]:req.parameters.recipients||'',
        [SF.frequency]:req.parameters.frequency||'weekly', [SF.day]:req.parameters.day||'1',
        [SF.time]:req.parameters.time||'07:00', [SF.format]:req.parameters.format||'pdf',
        [SF.config]:req.parameters.config||'{}', [SF.active]:true, [SF.user]:uid };
      let id = req.parameters.sub_id || '';
      if (id) { record.submitFields({ type: SUB_REC, id, values: vals }); }
      else { const rec = record.create({ type: SUB_REC }); Object.keys(vals).forEach(k => rec.setValue({ fieldId:k, value:vals[k] })); id = rec.save(); }
      resp.write(JSON.stringify({ ok: true, id }));
    } catch(e) { resp.write(JSON.stringify({ ok: false, error: e.message })); }
  };
  const serveDeleteSub = (req, resp) => {
    resp.setHeader({ name: 'Content-Type', value: 'application/json' });
    try {
      const uid = runtime.getCurrentUser().id;
      const subId = req.parameters.sub_id;
      const rec = record.load({ type: SUB_REC, id: subId });
      if (String(rec.getValue(SF.user)) !== String(uid)) { resp.write(JSON.stringify({ ok:false, error:'Not yours.' })); return; }
      record.delete({ type: SUB_REC, id: subId });
      resp.write(JSON.stringify({ ok: true }));
    } catch(e) { resp.write(JSON.stringify({ ok: false, error: e.message })); }
  };
  const serveToggleSub = (req, resp) => {
    resp.setHeader({ name: 'Content-Type', value: 'application/json' });
    try {
      record.submitFields({ type: SUB_REC, id: req.parameters.sub_id, values: { [SF.active]: req.parameters.active === '1' } });
      resp.write(JSON.stringify({ ok: true }));
    } catch(e) { resp.write(JSON.stringify({ ok: false, error: e.message })); }
  };
  // ── CSV ───────────────────────────────────────────────────────────────────
  const serveCsv = (req, resp, searchId, labelRaw, view, sortCol, sortDir, groupCol, filtersJson, overridesJson, ddJson, colOrderJson, colVisibleJson) => {
    try {
      const loaded   = search.load({ id: searchId });
      const label    = loaded.title || labelRaw || searchId;
      applyFilterOverrides(loaded, JSON.parse(overridesJson || '[]'));
      const { columns: rawColumns, rows: raw } = runSearch(loaded, view === 'detail', ddJson);
      const sortedRows = applySort(applyFiltersSrv(raw, filtersJson, rawColumns.length), sortCol, sortDir, groupCol);
      const { columns, rows } = applyColState(rawColumns, sortedRows, colOrderJson, colVisibleJson, groupCol);
      const safeName = label.replace(/[^a-zA-Z0-9_\- ]/g,'').replace(/ /g,'_') || searchId;
      const lines    = [columns.map(csvCell).join(',')];
      rows.forEach(r => lines.push(r.slice(0, columns.length).map(csvCell).join(',')));
      resp.setHeader({ name: 'Content-Type',        value: 'text/csv' });
      resp.setHeader({ name: 'Content-Disposition', value: `attachment; filename="${safeName}.csv"` });
      resp.write(lines.join('\n'));
    } catch(e) { resp.write('CSV error: ' + e.message); }
  };

  // ── PDF ───────────────────────────────────────────────────────────────────
  const servePdf = (req, resp, searchId, labelRaw, view, sortCol, sortDir, groupCol, filtersJson, overridesJson, ddJson, colOrderJson, colVisibleJson) => {
    try {
      const loaded      = search.load({ id: searchId });
      const label       = loaded.title || labelRaw || searchId;
      const forceDetail = (view === 'detail');
      applyFilterOverrides(loaded, JSON.parse(overridesJson || '[]'));
      const { columns: rawColumns, rows: raw } = runSearch(loaded, forceDetail, ddJson);
      const sortedRows = applySort(applyFiltersSrv(raw, filtersJson, rawColumns.length), sortCol, sortDir, groupCol);
      const { columns, rows, groupCol: dispGroupCol } = applyColState(rawColumns, sortedRows, colOrderJson, colVisibleJson, groupCol);
      const safeName = label.replace(/[^a-zA-Z0-9_\- ]/g,'').replace(/ /g,'_') || searchId;
      const pdfFile  = buildPdf({ title: label + (forceDetail ? ' (Detail)' : ''), columns, rows, groupCol: dispGroupCol, footerNote: 'Search ID: ' + searchId });
      resp.setHeader({ name: 'Content-Type',        value: 'application/pdf' });
      resp.setHeader({ name: 'Content-Disposition', value: `inline; filename="${safeName}.pdf"` });
      resp.writeFile({ file: pdfFile, isInline: true });
    } catch(e) { log.error('servePdf', e.message); resp.write('PDF error: ' + e.message); }
  };

  // ── EMAIL POST ────────────────────────────────────────────────────────────
  const handlePost = (req, resp, base, view, sortCol, sortDir, groupCol, filtersJson, overridesJson, ddJson, colOrderJson, colVisibleJson) => {
    const searchId    = req.parameters.custpage_search_id;
    const label       = req.parameters.custpage_label || searchId;
    const emailTo     = (req.parameters.custpage_email_to || '').trim();
    const subject     = req.parameters.custpage_email_subject || ('Report from ' + COMPANY);
    const attachCSV   = req.parameters.custpage_email_csv === 'yes';
    const forceDetail = (view === 'detail');

    if (!searchId) return redirect(resp, base, 'No search selected.');
    if (!emailTo)  return redirect(resp, base, 'Enter at least one recipient.');

    try {
      const loaded   = search.load({ id: searchId });
      applyFilterOverrides(loaded, JSON.parse(overridesJson || '[]'));
      const { columns: rawColumns, rows: raw } = runSearch(loaded, forceDetail, ddJson);
      const sortedRows = applySort(applyFiltersSrv(raw, filtersJson, rawColumns.length), sortCol, sortDir, groupCol);
      const { columns, rows, groupCol: dispGroupCol } = applyColState(rawColumns, sortedRows, colOrderJson, colVisibleJson, groupCol);
      const safeName = label.replace(/[^a-zA-Z0-9_\- ]/g,'').replace(/ /g,'_') || searchId;
      const pdfFile  = buildPdf({ title: label, columns, rows, groupCol: dispGroupCol, footerNote: 'Search ID: ' + searchId });
      pdfFile.name   = safeName + '.pdf';
      const attachments = [pdfFile];

      if (attachCSV) {
        const lines = [columns.map(csvCell).join(',')];
        rows.forEach(r => lines.push(r.slice(0, columns.length).map(csvCell).join(',')));
        attachments.push(file.create({ name: safeName + '.csv', fileType: 'CSV', contents: lines.join('\n') }));
      }

      const recipients = emailTo.split(',').map(e => e.trim()).filter(Boolean);
      email.send({
        author: runtime.getCurrentUser().id, recipients, subject,
        body: `<p>Attached: <strong>${label}</strong> (${rows.length.toLocaleString()} rows).</p><p style="color:#999;font-size:11px">Auto-generated by NetSuite Report Dashboard.</p>`,
        attachments
      });

      log.audit('ReportDashboard', `Emailed "${label}" (PDF${attachCSV?' + CSV':''}) to ${recipients.join(', ')}`);
      const returnUrl = base + '&id=' + encodeURIComponent(searchId) + '&label=' + encodeURIComponent(label) + (forceDetail && !ddJson ? '&view=detail' : '');
      redirect(resp, returnUrl, `Emailed to: ${recipients.join(', ')}${attachCSV?' (PDF + CSV)':''}`);
    } catch(e) {
      log.error('handlePost', e.message);
      redirect(resp, base, 'Error: ' + e.message);
    }
  };

  const ddOpFor = (name, join) => {
    const fn = (name||'').toLowerCase();
    if (join || ['entity','item','class','department','location','partner','employee','customer'].includes(fn)) return 'anyof';
    if (fn.includes('date')) return 'on';
    if (['amount','total','quantity','rate','price','cost'].some(s=>fn.includes(s))) return 'equalto';
    return 'is';
  };

  // ── RUN SEARCH ────────────────────────────────────────────────────────────
  // Primary:  runPaged({ pageSize: CHUNK_SIZE }) — works for most searches.
  // Fallback: run().getRange() loop — does NOT share the ~4000-row cap of
  //           run().each(); tested to 35 000+ rows in production.
  //
  // Drilldown filters are injected into saved.filterExpression BEFORE the
  // summary→detail search reconstruction, so they survive the search.create().
  //
  // Hidden payload: summary rows get a trailing array element containing JSON
  // of GROUP BY column values. Stripped before CSV/PDF export and not shown
  // in the visible column count.
  const runSearch = (savedOrId, forceDetail = false, ddJson = '', quickRows = 0) => {
    const saved     = typeof savedOrId === 'string' ? search.load({ id: savedOrId }) : savedOrId;
    const rawCols   = saved.columns;
    const isSummary = rawCols.some(c => c.summary && c.summary !== 'NONE');
    const groupCols = rawCols.filter(c => c.summary === 'GROUP');

    // Inject drilldown filters into filterExpression before detail reconstruction.
    let ddFilters = [];
    if (ddJson && forceDetail) {
      try { ddFilters = JSON.parse(ddJson); } catch(e) { log.error('runSearch', 'Bad ddJson: ' + e.message); }
      if (ddFilters.length > 0) {
        let expr = Array.isArray(saved.filterExpression) ? [...saved.filterExpression] : [];
        ddFilters.forEach(f => {
          if (!f.name || f.value === null || f.value === undefined || f.value === '') return;
          const val      = String(f.value);
          // Dot notation (join.field) is more universally accepted than the 4-element
          // [field, join, op, value] array format — works on appliedToTransaction and similar joins.
          const fieldStr = f.join ? (f.join + '.' + f.name) : f.name;

          const node = [fieldStr, ddOpFor(f.name, f.join), val];
          expr = expr.length > 0 ? [...expr, 'AND', node] : [node];
        });
        saved.filterExpression = expr;
      }
    }

    let searchToRun = saved, cols = rawCols;

    if (isSummary && forceDetail) {
      const detailCols = rawCols.map(c => search.createColumn({
        name: c.name,
        ...(c.join  ? { join:  c.join  } : {}),
        ...(c.label ? { label: c.label } : {})
      }));
      searchToRun = search.create({ type: saved.searchType, filterExpression: saved.filterExpression, columns: detailCols });
      cols = detailCols;
    }

    const columns  = cols.map(c => c.label || c.name || '');
    const rows     = [];
    let   capped   = false;
    const rowLimit = (quickRows > 0) ? Math.min(quickRows, MAX_ROWS) : MAX_ROWS;

    const extractRow = result => cols.map(c => {
      try {
        const t = result.getText(c), v = result.getValue(c);
        let val = (t !== null && t !== undefined && t !== '') ? t : (v !== null && v !== undefined ? v : '');
        
        // Fallback to the initial summary data if NetSuite returns a blank detail line
        if (val === '' && forceDetail && ddFilters.length > 0) {
          const match = ddFilters.find(f => f.name === c.name && (f.join || null) === (c.join || null));
          if (match) val = match.text || match.value || '';
        }
        
        return val;
      } catch(e) { try { return result.getValue(c) || ''; } catch(e2) { return ''; } }
    });

    const maybeAppendPayload = (rowData, result) => {
      if (isSummary && !forceDetail) {
        rowData.push(JSON.stringify(
          groupCols.map(c => ({ name: c.name, join: c.join || null, value: result.getValue(c), text: result.getText(c) }))
        ));
      }
    };

    // ── PRIMARY: runPaged ─────────────────────────────────────────────────
    let pagedOk = false;
    try {
      const paged = searchToRun.runPaged({ pageSize: CHUNK_SIZE });
      // runPaged() itself doesn't throw — test pageRanges access to confirm it works.
      const rangeCount = paged.pageRanges.length;
      log.audit('runSearch', 'runPaged OK — ' + rangeCount + ' pages, searchType=' + saved.searchType);
      if (rangeCount > 100 && quickRows === 0) {
        log.audit('runSearch', 'Large search warning: ' + rangeCount + ' pages. Capping at MAX_ROWS=' + MAX_ROWS + '.');
      }
      pagedOk = true;
      outer:
      for (const range of paged.pageRanges) {
        if (rows.length >= GOV_MIN_ROWS && runtime.getCurrentScript().getRemainingUsage() < GOV_MIN) {
          log.audit('runSearch', 'Governance cap (paged) at ' + rows.length + ' rows.');
          capped = true; break outer;
        }
        let page;
        try { page = paged.fetch({ index: range.index }); }
        catch(fe) {
          // Retry once before abandoning paged path — transient NS errors are common on large searches.
          log.audit('runSearch', 'paged.fetch retry page=' + range.index + ': ' + fe.message);
          try { page = paged.fetch({ index: range.index }); }
          catch(fe2) {
            log.error('runSearch', 'paged.fetch failed twice page=' + range.index + ': ' + fe2.message + ' — switching to getRange');
            pagedOk = false; break outer;
          }
        }
        for (const result of page.data) {
          if (rows.length >= rowLimit) { capped = true; break outer; }
          if (rows.length >= GOV_MIN_ROWS && rows.length % 100 === 0 && runtime.getCurrentScript().getRemainingUsage() < GOV_MIN) {
            log.audit('runSearch', 'Governance cap (paged mid-page) at ' + rows.length + ' rows.');
            capped = true; break outer;
          }
          const r = extractRow(result);
          maybeAppendPayload(r, result);
          rows.push(r);
        }
      }
    } catch(pe) {
      log.audit('runSearch', 'runPaged failed: ' + pe.message + ' — falling back to getRange');
      pagedOk = false;
    }

    // ── FALLBACK: getRange() loop ─────────────────────────────────────────
    // Triggered when runPaged throws OR when paged.fetch fails mid-run.
    // Rows already collected in paged path are discarded — getRange restarts from 0
    // to avoid partial/duplicate data.
    if (!pagedOk) {
      rows.length = 0;  // discard any partial paged rows
      log.audit('runSearch', 'getRange fallback starting — searchType=' + saved.searchType);
      let grOk = false;
      try {
        const resultSet = searchToRun.run();
        grOk = true;
        let start = 0;
        let chunkNum = 0;
        while (true) {
          if (rows.length >= GOV_MIN_ROWS && runtime.getCurrentScript().getRemainingUsage() < GOV_MIN) {
            log.audit('runSearch', 'Governance cap (getRange) at ' + rows.length + ' rows.');
            capped = true; break;
          }
          if (rows.length >= rowLimit) { capped = true; break; }
          let chunk;
          try {
            chunk = resultSet.getRange({ start: start, end: start + CHUNK_SIZE });
          } catch(re) {
            log.error('runSearch', 'getRange failed chunk=' + chunkNum + ' start=' + start + ': ' + re.message);
            break;
          }
          if (!chunk || chunk.length === 0) {
            log.audit('runSearch', 'getRange complete — ' + rows.length + ' rows in ' + chunkNum + ' chunks.');
            break;
          }
          for (const result of chunk) {
            const r = extractRow(result);
            maybeAppendPayload(r, result);
            rows.push(r);
          }
          chunkNum++;
          if (chunk.length < CHUNK_SIZE) {
            log.audit('runSearch', 'getRange last chunk (' + chunk.length + ' rows) — total ' + rows.length + '.');
            break;
          }
          start += CHUNK_SIZE;
        }
      } catch(fe) {
        log.error('runSearch', 'getRange outer error: ' + fe.message + (grOk ? ' (after run() succeeded)' : ' (run() itself failed)'));
        // Return whatever was collected — may be 0 rows.
      }

      // If getRange also fully failed (0 rows, no governance cap) — last resort: run().each()
      // each() caps at ~4000 rows but handles edge-case search types that break both above.
      if (!capped && rows.length === 0) {
        log.audit('runSearch', 'Both runPaged and getRange failed — trying run().each() last resort');
        try {
          searchToRun.run().each(result => {
            if (rows.length >= Math.min(rowLimit, 4000)) { capped = true; return false; }
            const r = extractRow(result);
            maybeAppendPayload(r, result);
            rows.push(r);
            return true;
          });
          log.audit('runSearch', 'run().each() last resort returned ' + rows.length + ' rows');
        } catch(ee) {
          log.error('runSearch', 'run().each() last resort failed: ' + ee.message);
        }
      }
    }

    return { columns, rows, isSummary, capped };
  };

  // ── PARSE EDITABLE FILTERS ────────────────────────────────────────────────
  const parseEditableFilters = (loaded) => {
    const result = [];
    let flatIdx = 0;
    const traverse = (arr) => {
      if (!Array.isArray(arr)) return;
      if (arr.length >= 2 && typeof arr[0] === 'string' && typeof arr[1] === 'string') {
        const name = arr[0];
        let join = null, operator, values;
        if (isOperatorStr(arr[1])) { operator = arr[1]; values = arr.slice(2); }
        else if (arr.length >= 3 && isOperatorStr(arr[2])) { join = arr[1]; operator = arr[2]; values = arr.slice(3); }
        else { return; }
        const skip = !name || !operator || SKIP_FIELDS.has((name||'').toLowerCase()) || (name||'').toLowerCase().startsWith('formula');
        if (!skip) {
          result.push({
            idx: flatIdx, name, join: join||null,
            operator: (operator||'').toLowerCase(),
            values: (values||[]).filter(v => v !== null && v !== undefined && v !== '').map(String),
            type:  detectFilterType(name, operator),
            label: prettifyFieldName(name, join)
          });
        }
        flatIdx++;
      } else { arr.forEach(item => { if (Array.isArray(item)) traverse(item); }); }
    };
    if (loaded.filterExpression && loaded.filterExpression.length > 0) { traverse(loaded.filterExpression); }
    else if (loaded.filters && loaded.filters.length > 0) {
      loaded.filters.forEach((f, idx) => {
        if (f.formula || SKIP_FIELDS.has((f.name||'').toLowerCase())) return;
        result.push({ idx, name: f.name, join: f.join||null, operator: (f.operator||'').toLowerCase(),
          values: (f.values||[]).filter(v => v !== null && v !== undefined && v !== '').map(String),
          type: detectFilterType(f.name, f.operator), label: prettifyFieldName(f.name, f.join) });
      });
    }
    return result;
  };

  const isOperatorStr    = s => ALL_OPS.has((s||'').toLowerCase());
  const detectFilterType = (n, op) => {
    const o = (op||'').toLowerCase(), fn = (n||'').toLowerCase();
    if (DATE_OPS.has(o) || NOVALUE_OPS.has(o)) return 'date';
    if (NUM_OPS.has(o)) return 'number';
    if (o === 'anyof' || o === 'notanyof') return 'list';
    if (['trandate','closedate','duedate','shipdate','createddate','lastmodifieddate','expectedclosedate','projecteddate'].includes(fn) || fn.includes('date')) return 'date';
    if (['amount','total','quantity','rate','price','cost','grossamount','netamount'].includes(fn)) return 'number';
    return 'text';
  };
  const prettifyFieldName = (name, join) => {
    const clean = (name||'').replace(/^cust(body|item|col|rec|entity|trans|line)?_/,'').replace(/_/g,' ');
    const words = clean.split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1) : '').join(' ');
    return join ? `${join[0].toUpperCase()+join.slice(1).toLowerCase()}: ${words}` : words;
  };

  // ── APPLY FILTER OVERRIDES ────────────────────────────────────────────────
  const applyFilterOverrides = (loaded, overrides) => {
    if (!overrides || !overrides.length) return;
    const overrideMap = {};
    overrides.forEach(ov => { overrideMap[ov.idx] = ov; });
    if (loaded.filterExpression && loaded.filterExpression.length > 0) {
      let flatIdx = 0;
      const traverseAndReplace = (arr) => {
        if (!Array.isArray(arr)) return arr;
        if (arr.length >= 2 && typeof arr[0] === 'string' && typeof arr[1] === 'string') {
          const isNode = isOperatorStr(arr[1]) || (arr.length >= 3 && isOperatorStr(arr[2]));
          if (isNode) {
            const ov = overrideMap[flatIdx++]; if (!ov) return arr;
            const name = arr[0], hasJoin = !isOperatorStr(arr[1]), join = hasJoin ? arr[1] : null;
            if (NOVALUE_OPS.has(ov.operator)) return join ? [name, join, ov.operator] : [name, ov.operator];
            return join ? [name, join, ov.operator, ...ov.values] : [name, ov.operator, ...ov.values];
          }
        }
        return arr.map(item => Array.isArray(item) ? traverseAndReplace(item) : item);
      };
      loaded.filterExpression = traverseAndReplace(loaded.filterExpression);
    } else if (loaded.filters && loaded.filters.length > 0) {
      overrides.forEach(ov => {
        if (ov.idx < loaded.filters.length) { loaded.filters[ov.idx].operator = ov.operator; loaded.filters[ov.idx].values = ov.values; }
      });
    }
  };

  // ── FILTER BAR HTML ───────────────────────────────────────────────────────
  const buildFilterBarHtml = (editableFilters) => {
    if (!editableFilters.length) return '';
    let inputs = '';
    editableFilters.forEach(f => {
      const lbl  = `<div class="fi-label">${esc(f.label)}</div>`;
      const wrap = inner => `<div class="fi-wrap" data-filter-idx="${f.idx}">${lbl}<div class="fi-row">${inner}</div></div>`;
      if (NOVALUE_OPS.has(f.operator)) {
        inputs += wrap(`<select class="fi-sel" data-fop="${f.idx}">
          <option value="isempty" ${f.operator==='isempty'?'selected':''}>Is Empty</option>
          <option value="isnotempty" ${f.operator==='isnotempty'?'selected':''}>Is Not Empty</option></select>`);
      } else if (f.type === 'date') {
        if (RANGE_OPS.has(f.operator)) {
          inputs += wrap(`<input type="date" class="fi-inp" data-fval0="${f.idx}" value="${esc(nsDateToHtml(f.values[0]||''))}"/>
            <span style="font-size:11px;color:#888;padding:0 2px">to</span>
            <input type="date" class="fi-inp" data-fval1="${f.idx}" value="${esc(nsDateToHtml(f.values[1]||''))}"/>`);
        } else {
          const opts = [['onorafter','On or After'],['after','After'],['onorbefore','On or Before'],['before','Before'],['on','On'],['noton','Not On'],['isempty','Is Empty'],['isnotempty','Is Not Empty']]
            .map(([v,l]) => `<option value="${v}" ${f.operator===v?'selected':''}>${l}</option>`).join('');
          inputs += wrap(`<select class="fi-sel" data-fop="${f.idx}">${opts}</select>
            <input type="date" class="fi-inp" data-fval0="${f.idx}" value="${esc(nsDateToHtml(f.values[0]||''))}"/>`);
        }
      } else if (f.type === 'number') {
        const opts = [['equalto','='],['notequalto','≠'],['greaterthan','>'],['greaterthanorequalto','≥'],['lessthan','<'],['lessthanorequalto','≤'],['between','Between']]
          .map(([v,l]) => `<option value="${v}" ${f.operator===v?'selected':''}>${l}</option>`).join('');
        inputs += wrap(`<select class="fi-sel" data-fop="${f.idx}" onchange="toggleBetween(${f.idx})">${opts}</select>
          <input type="number" class="fi-inp fi-inp-sm" data-fval0="${f.idx}" value="${esc(f.values[0]||'')}"/>
          <span id="between_to_${f.idx}" style="display:${f.operator==='between'?'flex':'none'};align-items:center;gap:4px">
            <span style="font-size:11px;color:#888">to</span>
            <input type="number" class="fi-inp fi-inp-sm" data-fval1="${f.idx}" value="${esc(f.values[1]||'')}"/>
          </span>`);
      } else if (f.type === 'list') {
        const opts = [['anyof','Any Of'],['notanyof','None Of']].map(([v,l]) => `<option value="${v}" ${f.operator===v?'selected':''}>${l}</option>`).join('');
        inputs += wrap(`<select class="fi-sel" data-fop="${f.idx}">${opts}</select>
          <input type="text" class="fi-inp" data-fval0="${f.idx}" value="${esc((f.values||[]).join(', '))}" placeholder="IDs, comma-sep" style="width:150px"/>`);
      } else {
        const opts = [['contains','Contains'],['doesnotcontain','Not Contains'],['is','Is'],['isnot','Is Not'],['startswith','Starts With'],['isempty','Is Empty'],['isnotempty','Not Empty']]
          .map(([v,l]) => `<option value="${v}" ${f.operator===v?'selected':''}>${l}</option>`).join('');
        inputs += wrap(`<select class="fi-sel" data-fop="${f.idx}">${opts}</select>
          <input type="text" class="fi-inp" data-fval0="${f.idx}" value="${esc(f.values[0]||'')}" style="width:150px"/>`);
      }
    });
    return `<div class="fbar">
  <div class="fbar-head" id="fbarHead">
    <span style="font-size:12px;font-weight:700;color:#2c3e6b;">&#128269; Search Filters</span>
    <span style="font-size:11px;color:#888">${editableFilters.length} criteria</span>
    <span class="active-badge" id="fbarActiveBadge" style="display:none"></span>
    <span id="fbarArrow" style="margin-left:auto;font-size:10px;color:#888">&#9660;</span>
  </div>
  <div class="fbar-body" id="fbarBody">
    ${inputs}
    <div class="fi-wrap" style="justify-content:flex-end;margin-left:auto;padding-top:16px">
      <div class="fi-row" style="gap:8px">
        <span id="fbarSpinner" style="display:none;font-size:11px;color:#888">&#8635; Running...</span>
        <button type="button" id="fbarApplyBtn" onclick="applySearchFilters()" class="btn btn-orange">&#9654; Apply</button>
        <button type="button" onclick="resetSearchFilters()" class="btn btn-out" style="font-size:11px">Reset</button>
      </div>
    </div>
  </div>
</div>`;
  };

  const nsDateToHtml = (s) => {
    if (!s || !/^\d/.test(s)) return '';
    const parts = s.split('/');
    if (parts.length !== 3) return '';
    const [m, d, y] = parts;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  };

  // ── SERVER-SIDE FILTER / SORT ─────────────────────────────────────────────
  // colCount: skip the hidden drilldown payload column during text filtering.
  const applyFiltersSrv = (rows, filtersJson, colCount) => {
    if (!filtersJson) return rows;
    try {
      const filters = JSON.parse(filtersJson);
      if (!filters.length) return rows;
      return rows.filter(row => filters.every(f => {
        if (f.col >= colCount) return true;
        return String(row[f.col] == null ? '' : row[f.col]).toLowerCase().includes(f.val);
      }));
    } catch(e) { return rows; }
  };

  // Reorders/trims columns + row cells to match the dashboard's Columns-panel
  // state (colOrder/colVisible) so exports reflect the view the user is looking
  // at, not the raw search column order. groupCol is remapped to its new
  // position since buildPdf/csv indexing is positional within the trimmed row.
  const applyColState = (columns, rows, colOrderJson, colVisibleJson, groupCol) => {
    let order, visible;
    try { order   = JSON.parse(colOrderJson   || 'null'); } catch(e) { order   = null; }
    try { visible = JSON.parse(colVisibleJson || 'null'); } catch(e) { visible = null; }
    if (!Array.isArray(order) || order.length !== columns.length ||
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

  const applySort = (rows, sortCol, sortDir, groupCol = -1) => {
    return [...rows].sort((a, b) => {
      if (groupCol >= 0 && groupCol !== sortCol) { const gc = smartCmpSrv(a[groupCol], b[groupCol], 'asc'); if (gc !== 0) return gc; }
      if (sortCol >= 0) { const sc = smartCmpSrv(a[sortCol], b[sortCol], sortDir); if (sc !== 0) return sc; }
      return smartCmpSrv(a[0], b[0], 'asc');
    });
  };

  // Currency + European-decimal-aware sort (mirrors client smartCmp exactly).
  const smartCmpSrv = (av, bv, dir) => {
    const parseNum = val => {
      const s = String(val == null ? '' : val).trim(); if (!s) return NaN;
      let clean = s.replace(/[$€£¥%\s]/g, '');
      if (/,\d{1,2}$/.test(clean)) { clean = clean.replace(/\./g,'').replace(',','.'); } else { clean = clean.replace(/,/g,''); }
      return Number(clean);
    };
    const as = String(av == null ? '' : av), bs = String(bv == null ? '' : bv);
    const an = parseNum(as), bn = parseNum(bs);
    const c  = (!isNaN(an) && !isNaN(bn)) ? (an - bn) : as.localeCompare(bs, undefined, { numeric: true });
    return dir === 'desc' ? -c : c;
  };

  // ── BUILD PDF ─────────────────────────────────────────────────────────────
  const buildPdf = ({ title, columns, rows, groupCol = -1, footerNote }) => {
    const date    = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
    const logoSrc  = LOGO_URL.replace(/&/g,'&amp;');
    const logoCell = LOGO_URL
      ? `<td style="width:${LOGO_W+20}px;vertical-align:middle;padding-right:10px;"><img src="${logoSrc}" width="${LOGO_W}" height="${LOGO_H}" style="display:block;"/></td>`
      : '';
    // BFO's report engine doesn't honor percentage <col> widths reliably — columns
    // end up far narrower than the rendered table, so long words wrap one character
    // per line and get stretched edge-to-edge by forced justification (the
    // "F R A M E L E S S" effect). Give each column an explicit point width sized
    // to its content instead; BFO does respect absolute units.
    const PAGE_WIDTH_PT = 734; // letter-landscape minus 0.4in left/right margins
    const MIN_COL_PT    = 45;
    const sampleN = Math.min(rows.length, 50);
    const weights = columns.map((c, ci) => {
      let maxLen = String(c || '').length;
      for (let i = 0; i < sampleN; i++) {
        const len = rows[i][ci] == null ? 0 : String(rows[i][ci]).length;
        if (len > maxLen) maxLen = len;
      }
      return Math.min(maxLen, 40);
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
    let colWidths = weights.map(w => Math.max(MIN_COL_PT, (w / totalWeight) * PAGE_WIDTH_PT));
    const widthSum = colWidths.reduce((a, b) => a + b, 0);
    colWidths = colWidths.map(w => (w / widthSum) * PAGE_WIDTH_PT);
    const colGroup = '<colgroup>' + colWidths.map(w => `<col style="width:${w.toFixed(1)}pt;"/>`).join('') + '</colgroup>';
    const thStyle = 'background-color:#2c3e6b;color:#ffffff;font-weight:bold;padding:5px 7px;border:1px solid #1a2a50;font-size:7pt;font-family:Arial,Helvetica,sans-serif;word-wrap:break-word;';
    // BFO's table-cell text flow doesn't reliably honor text-align in the <td> style —
    // it still force-justifies wrapped lines, which stretches single-word lines into
    // letter-by-letter spacing (no inter-word gaps to absorb the justification). The
    // align attribute + an explicit <p align="left"> block around the text is what
    // actually overrides BFO's default justify behavior.
    const headerCells = columns.map(c => `<td align="left" valign="middle" style="${thStyle}"><p align="left" style="margin:0;padding:0;">${xmlEnc(c)}</p></td>`).join('');
    let lastGroupVal = null;
    const dataRows = rows.map((row, i) => {
      const currentGV  = groupCol >= 0 ? String(row[groupCol] == null ? '' : row[groupCol]) : null;
      const isNewGroup = groupCol >= 0 && currentGV !== lastGroupVal;
      if (groupCol >= 0) lastGroupVal = currentGV;
      const groupBorder = (isNewGroup && i > 0) ? 'border-top:2px solid #7a9cbf;' : '';
      const bg = i % 2 === 0 ? '#f2f4fa' : '#ffffff';
      // Strip hidden drilldown payload if present (summary exports).
      const cleanRow = row.length > columns.length ? row.slice(0, columns.length) : row;
      const cells = cleanRow.map((cell, ci) => {
        const bl = ci === 0 ? 'border-left:3px solid #2c3e6b;font-weight:bold;' : 'border-left:1px solid #dde0e8;';
        const v  = (ci === groupCol && !isNewGroup) ? '' : String(cell != null ? cell : '');
        return `<td align="left" valign="top" style="background-color:${bg};padding:4px 7px;${bl}${groupBorder}border-right:1px solid #dde0e8;border-bottom:1px solid #e8eaf0;font-size:7pt;font-family:Arial,Helvetica,sans-serif;word-wrap:break-word;"><p align="left" style="margin:0;padding:0;">${xmlEnc(v)}</p></td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('\n');
    const emptyRow = `<tr><td colspan="${columns.length}" style="font-style:italic;color:#888888;font-size:8pt;padding:8px 6px;font-family:Arial,Helvetica,sans-serif;">No data returned.</td></tr>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report//2.x//EN" "report-2-0-1.dtd">
<pdf><head><macrolist>
  <macro id="rpt_header">
    <table style="width:100%;border-bottom:2.5px solid #2c3e6b;padding-bottom:6px;margin-bottom:4px;table-layout:fixed;">
      <tr>
        ${logoCell}
        <td style="vertical-align:middle;text-align:right;">
          <p style="margin:0 0 3px 0;font-size:11pt;font-weight:bold;color:#2c3e6b;font-family:Arial,Helvetica,sans-serif;line-height:1.2;">${xmlEnc(title)}</p>
          <p style="margin:0;font-size:7.5pt;color:#555555;font-family:Arial,Helvetica,sans-serif;line-height:1.2;">Generated: ${xmlEnc(date)}</p>
        </td>
      </tr>
    </table>
  </macro>
  <macro id="rpt_footer">
    <table style="width:100%;border-top:1px solid #cccccc;padding-top:3px;margin-top:2px;">
      <tr>
        <td style="font-size:7pt;color:#888888;font-family:Arial,Helvetica,sans-serif;vertical-align:middle;">${xmlEnc(footerNote||'')} &#160;|&#160; ${rows.length.toLocaleString()} rows</td>
        <td style="text-align:right;font-size:7pt;color:#888888;white-space:nowrap;font-family:Arial,Helvetica,sans-serif;vertical-align:middle;">Page <pagenumber/> of <totalpages/></td>
      </tr>
    </table>
  </macro>
</macrolist></head>
<body header="rpt_header" header-height="0.7in" footer="rpt_footer" footer-height="0.32in" size="letter-landscape" padding="0.5in 0.4in 0.4in 0.4in">
  <table style="width:${PAGE_WIDTH_PT}pt;border-collapse:collapse;table-layout:fixed;">
    ${colGroup}
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${dataRows || emptyRow}</tbody>
  </table>
</body></pdf>`;
    const renderer = render.create();
    renderer.templateContent = xml;
    return renderer.renderAsPdf();
  };

  // ── HELPERS ───────────────────────────────────────────────────────────────
  const getBase = req => {
  const scriptId = req.parameters.script || '';
  const deployId = req.parameters.deploy || '';
  const b = req.url.split('?');
  let basePath = b[0];
  // Strip any session token segments NetSuite may inject
  return basePath + '?script=' + scriptId + '&deploy=' + deployId;
};

  // Queries the savedsearch record type directly — more reliable than search.load().title
  // which returns null for some saved searches.
  const getSearchTitle = (searchId) => {
    try {
      let title = null;
      search.create({
        type: 'savedsearch',
        filters: [['internalid', 'is', String(searchId)]],
        columns: [search.createColumn({ name: 'title' })]
      }).run().each(r => { title = r.getValue('title'); return false; });
      return title || String(searchId);
    } catch(e) { return String(searchId); }
  };

  // NOTE: 'ispublic' and 'owner' are not valid column names on the savedsearch
  // record type — querying them crashes loadSearches and returns an empty list,
  // which causes the fallback plain-text input to render instead of the dropdown.
  // Solution: load only internalid + title (always valid), return all active searches.
  const loadSearches = () => {
    try {
      const list = [];
      search.create({
        type: 'savedsearch',
        filters: [['isinactive', 'is', 'F']],
        columns: [
          search.createColumn({ name: 'internalid' }),
          search.createColumn({ name: 'title', sort: search.Sort.ASC })
        ]
      }).run().each(r => {
        const id    = r.getValue('internalid');
        const label = r.getValue('title') || id;
        if (id) list.push({ id: String(id), label: String(label) });
        return true;
      });
      return list;
    } catch(e) { log.error('loadSearches', e.message); return []; }
  };

  const redirect = (resp, url, msg) => {
    const fullUrl = url + (msg ? '&msg=' + encodeURIComponent(msg) : '');
    resp.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });
    resp.write(`<html><head><meta http-equiv="refresh" content="0;url=${esc(fullUrl)}"></head><body></body></html>`);
  };

  const esc     = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const xmlEnc  = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  const csvCell = v => { const s = String(v==null?'':v); return /[,"\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };

  return { onRequest };
});
