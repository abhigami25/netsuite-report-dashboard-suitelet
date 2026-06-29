/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * FILE: report_dashboard_sl.js
 * Report Dashboard — Universal Saved Search Viewer
 * Features: Unlimited rows · Pivot · Period Compare · Conditional Formatting
 *           KPI Strip · Named Views · Scheduled Subscriptions · PDF/CSV Export
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

  const LOGO_URL  = '';       // Replace with your logo URL (or leave blank)
  const LOGO_W    = 45;
  const LOGO_H    = 45;
  const COMPANY   = '';       // Replace with your company name (or leave blank)

  const MAX_ROWS   = 50000;
  const GOV_MIN    = 500;
  const GOV_MIN_ROWS = 50;
  const CHUNK_SIZE = 1000;
  const QUICK_ROWS = 1000;

  // ── FILE CABINET CACHE ────────────────────────────────────────────────────
  const CACHE_FOLDER  = 0;              // Replace with your File Cabinet folder ID
  const CACHE_TTL_MS  = 30 * 60 * 1000;
  const CACHE_ENABLED = true;

  const _cacheKey = (id, view) => 'rptdash_' + id + (view ? '_' + view : '') + '.json';

  const readCache = (searchId, view) => {
    if (!CACHE_ENABLED) return null;
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
    if (!CACHE_ENABLED) return;
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
  const serveSelector = (req, resp, base) => {
    const flash = req.parameters.msg ? decodeURIComponent(req.parameters.msg) : '';
    const form  = serverWidget.createForm({ title: 'Report Dashboard' });

    if (flash) {
      form.addField({ id: 'custpage_flash', type: serverWidget.FieldType.INLINEHTML, label: ' ' })
        .defaultValue = `<div style="background:#eaffea;border:1px solid #4caf50;padding:8px 14px;border-radius:4px;font-family:Arial;font-size:13px;color:#256029;margin-bottom:8px">&#10003; ${esc(flash)}</div>`;
    }

    const ssField = form.addField({
      id:    'custpage_ss',
      type:  serverWidget.FieldType.SELECT,
      label: 'Saved Search'
    });
    ssField.addSelectOption({ value: '', text: '' });

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
  var root=document.getElementById('ss-root');
  var ssBase=root?root.getAttribute('data-base'):'';
  var ajaxUrl=root?root.getAttribute('data-ajax'):'';
  var inp=document.getElementById('ss-input');
  var drop=document.getElementById('ss-drop');
  var meta=document.getElementById('ss-meta');
  var icon=document.getElementById('ss-icon');
  var LIST=[],filtered=[],active=-1;
  fetch(ajaxUrl).then(function(r){return r.json();}).then(function(data){
    LIST=data;inp.disabled=false;
    inp.placeholder='Search '+LIST.length+' saved searches\u2026';
    icon.innerHTML='&#9660;';
    if(meta)meta.textContent=LIST.length+' saved searches available';
    drop.innerHTML='';drop.classList.remove('open');
  }).catch(function(){if(meta)meta.textContent='Failed to load. Refresh page.';});
  function hl(text,term){if(!term)return escH(text);var lo=text.toLowerCase(),tlo=term.toLowerCase(),idx=lo.indexOf(tlo);if(idx<0)return escH(text);return escH(text.slice(0,idx))+'<b>'+escH(text.slice(idx,idx+term.length))+'</b>'+escH(text.slice(idx+term.length));}
  function escH(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function render(term){active=-1;if(!LIST.length){drop.innerHTML='<div class="ss-loading">Loading\u2026</div>';return;}var lo=(term||'').toLowerCase().trim();filtered=lo?LIST.filter(function(s){return s.label.toLowerCase().includes(lo)||s.id.includes(lo);}).slice(0,60):LIST.slice(0,60);if(!filtered.length){drop.innerHTML='<div class="ss-empty">No matches for &ldquo;'+escH(term)+'&rdquo;</div>';}else{drop.innerHTML=filtered.map(function(s,i){return'<div class="ss-item" data-idx="'+i+'"><span style="font-size:13px;color:#2d6a9f;">&#128202;</span><span class="ss-name">'+hl(s.label,lo)+'</span><span class="ss-id">#'+escH(s.id)+'</span></div>';}).join('');drop.querySelectorAll('.ss-item').forEach(function(el){el.addEventListener('click',function(){go(filtered[parseInt(el.getAttribute('data-idx'))]);});el.addEventListener('mouseenter',function(){active=parseInt(el.getAttribute('data-idx'));setActive();});});}drop.classList.add('open');if(meta)meta.textContent=lo?(filtered.length+' result'+(filtered.length!==1?'s':'')+' \u2014 type to refine'):(LIST.length+' saved searches available');}
  function setActive(){drop.querySelectorAll('.ss-item').forEach(function(el,i){el.classList.toggle('hover',i===active);});}
  function go(s){drop.classList.remove('open');var sel=document.getElementById('custpage_ss');if(sel){for(var i=0;i<sel.options.length;i++){if(sel.options[i].value===s.id){sel.selectedIndex=i;break;}}}window.location.href=ssBase+'&id='+encodeURIComponent(s.id)+'&label='+encodeURIComponent(s.label);}
  inp.addEventListener('input',function(){render(inp.value);});
  inp.addEventListener('focus',function(){if(LIST.length)render(inp.value);});
  inp.addEventListener('keydown',function(e){if(!drop.classList.contains('open'))return;if(e.key==='ArrowDown'){e.preventDefault();active=Math.min(active+1,filtered.length-1);setActive();scrollAct();}else if(e.key==='ArrowUp'){e.preventDefault();active=Math.max(active-1,0);setActive();scrollAct();}else if(e.key==='Enter'){e.preventDefault();if(active>=0&&filtered[active])go(filtered[active]);}else if(e.key==='Escape'){drop.classList.remove('open');}});
  function scrollAct(){var items=drop.querySelectorAll('.ss-item');if(items[active])items[active].scrollIntoView({block:'nearest'});}
  document.addEventListener('click',function(e){var wrap=document.getElementById('ss-wrap');if(wrap&&!wrap.contains(e.target))drop.classList.remove('open');});
})();
</script>`;

    form.addSubmitButton({ label: '\u{1F4CA} Open Dashboard' });
    resp.writePage(form);
  };

  const serveSearchList = (req, resp) => {
    resp.setHeader({ name: 'Content-Type', value: 'application/json' });
    resp.write(JSON.stringify(loadSearches()));
  };

  // ── VIEWS ─────────────────────────────────────────────────────────────────
  const VIEW_REC = 'customrecord_report_view';
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
      resp.write(JSON.stringify({ ok:true, name: rec.getValue('name'), config: rec.getValue(VF.config) || '{}' }));
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
      if (!searchId || !name) { resp.write(JSON.stringify({ ok:false, error:'Missing search_id or view_name.' })); return; }
      if (shared && runtime.getCurrentUser().role != 3) { resp.write(JSON.stringify({ ok:false, error:'Only Administrators can save shared presets.' })); return; }
      if (!viewId) {
        const ownerFilter = shared ? [VF.shared,'is','T'] : [VF.user,'anyof',[uid]];
        search.create({ type: VIEW_REC, filters: [[VF.search,'is',String(searchId)],'AND',['name','is',name],'AND',ownerFilter], columns: [search.createColumn({ name:'internalid' })] }).run().each(r => { viewId = r.getValue('internalid'); return false; });
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
      if (String(owner) !== String(uid) && !(shared && runtime.getCurrentUser().role == 3)) { resp.write(JSON.stringify({ ok:false, error:'Not your view.' })); return; }
      record.delete({ type: VIEW_REC, id: viewId });
      resp.write(JSON.stringify({ ok:true }));
    } catch(e) { resp.write(JSON.stringify({ ok:false, error:e.message })); }
  };

  const safeJson = function(val) {
    return JSON.stringify(val)
      .split('\u2028').join('\\u2028')
      .split('\u2029').join('\\u2029')
      .split('</script').join('<\\/script')
      .split('</SCRIPT').join('<\\/SCRIPT');
  };

  const jsonB64 = function(val) {
    return encode.convert({
      string: JSON.stringify(val),
      inputEncoding: encode.Encoding.UTF_8,
      outputEncoding: encode.Encoding.BASE_64
    }).replace(/[\r\n]/g, '');
  };

  // ── SUBSCRIPTIONS ─────────────────────────────────────────────────────────
  const SUB_REC = 'customrecord_report_subscription';
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
        out.push({
          id: r.getValue('internalid'), name: r.getValue('name'),
          frequency: r.getValue(SF.frequency), day: r.getValue(SF.day),
          time: r.getValue(SF.time), format: r.getValue(SF.format),
          recipients: r.getValue(SF.recipients),
          active: r.getValue(SF.active) === true || r.getValue(SF.active) === 'T',
          last_sent: r.getValue(SF.last_sent) || ''
        });
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

  // ── DASHBOARD (serves HTML) ───────────────────────────────────────────────
  // NOTE: Full dashboard HTML, pivot, CF, KPI, views, compare panels are
  // identical to the production version. Only LOGO_URL, COMPANY, CACHE_FOLDER,
  // VIEW_REC, and SUB_REC have been genericised above.
  // The serveDashboard, serveRefresh, serveCompare, serveCsv, servePdf,
  // handlePost, runSearch, buildPdf, and all helper functions below are
  // identical to the original — omitted here for brevity.
  // See full implementation comments in the README.
  // ─────────────────────────────────────────────────────────────────────────

  const getBase = req => {
    const scriptId = req.parameters.script || '';
    const deployId = req.parameters.deploy || '';
    const b = req.url.split('?');
    return b[0] + '?script=' + scriptId + '&deploy=' + deployId;
  };

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

  const esc    = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const xmlEnc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  const csvCell = v => { const s = String(v==null?'':v); return /[,"\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };

  return { onRequest };
});
