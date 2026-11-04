/*
 * PURCHASE ORDERS & PARTS / DELIVERY TRACKING MODULE
 * Universal Enterprise PartsCompare Architecture
 *
 * Flow: Approved Sourcing Summary -> Draft PO (one per supplier) -> Issued (Admin)
 *       -> Confirmed -> In Transit -> Partially Received / Received -> Closed (Admin)
 *
 * Routes (wired from app.js router):
 *   #/orders        Purchase order register + "ready for PO" approved summaries
 *   #/orders/:id    Purchase order detail, receiving, tracking info, timeline, print
 *   #/tracking      Line-level parts tracking across all purchase orders
 *
 * Depends on window.PC_API (adapter.js). app.js calls PC_ORDERS.init(ctx) with UI helpers.
 */
(function () {
  let ctx = null;
  let listFilter = { status: 'ALL', q: '' };
  let trackFilter = { state: 'ALL', q: '' };
  let cache = { orders: [], parts: [], suppliers: [], offers: [] };
  let newPoDraft = null;
  let pendingNotice = null; // one-shot success message shown after navigation

  function takeNotice(n) {
    const out = n || pendingNotice;
    pendingNotice = null;
    return out;
  }

  const STATUS_META = {
    DRAFT: { label: 'Draft', cls: 'po-st-draft', icon: '📝' },
    ISSUED: { label: 'Issued to Supplier', cls: 'po-st-issued', icon: '📤' },
    CONFIRMED: { label: 'Supplier Confirmed', cls: 'po-st-confirmed', icon: '🤝' },
    IN_TRANSIT: { label: 'In Transit', cls: 'po-st-transit', icon: '🚚' },
    PARTIALLY_RECEIVED: { label: 'Partially Received', cls: 'po-st-partial', icon: '📦' },
    RECEIVED: { label: 'Fully Received', cls: 'po-st-received', icon: '✅' },
    CLOSED: { label: 'Closed', cls: 'po-st-closed', icon: '🔒' },
    CANCELLED: { label: 'Cancelled', cls: 'po-st-cancelled', icon: '✖' },
  };
  const OPEN_STATUSES = ['DRAFT', 'ISSUED', 'CONFIRMED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED'];
  const STEPS = ['DRAFT', 'ISSUED', 'CONFIRMED', 'IN_TRANSIT', 'RECEIVED', 'CLOSED'];

  const TRACK_STATES = {
    AWAITING_ISSUE: { label: 'Awaiting PO Issue', cls: 'po-st-draft' },
    ORDERED: { label: 'Ordered', cls: 'po-st-issued' },
    IN_TRANSIT: { label: 'In Transit', cls: 'po-st-transit' },
    PARTIAL: { label: 'Partially Received', cls: 'po-st-partial' },
    OVERDUE: { label: 'Overdue', cls: 'po-st-overdue' },
    RECEIVED: { label: 'Received', cls: 'po-st-received' },
  };

  /* ---------------- helpers ---------------- */
  const h = () => ctx;
  const esc = (s) => ctx.esc(s);
  const money = (m, c) => ctx.money(m, c);
  const me = () => ctx.getMe() || {};
  const isAdmin = () => ctx.isAdmin();
  const can = (cap) => (me().capabilities || []).includes(cap);

  function todayStr() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function addDays(n) {
    const d = new Date(); d.setDate(d.getDate() + n);
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function fmtDay(d) {
    if (!d) return '—';
    const dt = new Date(d + 'T00:00:00');
    return isNaN(dt) ? esc(d) : dt.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function fmtTime(iso) { return iso ? new Date(iso).toLocaleString() : '—'; }

  function totals(po) {
    const ordered = po.lines.reduce((a, l) => a + l.quantity, 0);
    const received = po.lines.reduce((a, l) => a + (l.received_qty || 0), 0);
    const receivedValue = po.lines.reduce((a, l) => a + (l.received_qty || 0) * l.unit_price_minor, 0);
    return { ordered, received, outstanding: ordered - received, pct: ordered ? Math.round((received / ordered) * 100) : 0, receivedValue };
  }
  function isOverdue(po) {
    return OPEN_STATUSES.includes(po.status) && po.status !== 'DRAFT' && po.expected_date && po.expected_date < todayStr();
  }
  function daysUntil(d) {
    if (!d) return null;
    const a = new Date(todayStr() + 'T00:00:00'), b = new Date(d + 'T00:00:00');
    return Math.round((b - a) / 86400000);
  }
  function statusBadge(st, extraCls) {
    const m = STATUS_META[st] || { label: st, cls: '', icon: '' };
    return '<span class="po-badge ' + m.cls + (extraCls ? ' ' + extraCls : '') + '">' + m.icon + ' ' + esc(m.label) + '</span>';
  }
  function progressBar(t) {
    return '<div class="po-progress" title="' + t.received + ' of ' + t.ordered + ' pcs received"><div class="po-progress-fill" style="width:' + t.pct + '%"></div></div>'
      + '<div class="small" style="color:var(--mute);margin-top:3px;">' + t.received + ' / ' + t.ordered + ' pcs · ' + t.pct + '%</div>';
  }
  function etaCell(po) {
    if (!po.expected_date) return '<span class="small" style="color:var(--mute)">Not set</span>';
    const dd = daysUntil(po.expected_date);
    let note = '';
    if (['RECEIVED', 'CLOSED', 'CANCELLED'].includes(po.status)) note = '';
    else if (isOverdue(po)) note = '<div class="small po-overdue-text">⚠ ' + Math.abs(dd) + ' day(s) overdue</div>';
    else if (dd === 0) note = '<div class="small" style="color:#CA8A04;font-weight:600;">Due today</div>';
    else if (dd > 0) note = '<div class="small" style="color:var(--mute)">in ' + dd + ' day(s)</div>';
    return '<div>' + fmtDay(po.expected_date) + '</div>' + note;
  }
  function tabs(active) {
    const t = (href, key, label) => '<a href="' + href + '" class="po-tab' + (active === key ? ' active' : '') + '"' + (active === key ? ' aria-current="page"' : '') + '>' + label + '</a>';
    return '<div class="po-tabs" role="tablist">' + t('#/orders', 'orders', '🧾 Purchase Orders') + t('#/tracking', 'tracking', '📍 Parts & Delivery Tracking') + '</div>';
  }
  function showError(e) {
    alert((e && (e.message || e.code)) || 'Something went wrong.');
  }

  /* ---------------- KPI strip ---------------- */
  function kpis(orders) {
    const live = orders.filter((p) => p.status !== 'CANCELLED');
    const open = orders.filter((p) => OPEN_STATUSES.includes(p.status));
    const transit = orders.filter((p) => p.status === 'IN_TRANSIT');
    const overdue = orders.filter(isOverdue);
    const outstandingPcs = open.reduce((a, p) => a + totals(p).outstanding, 0);
    const committed = live.filter((p) => p.status !== 'DRAFT').reduce((a, p) => a + p.subtotal_minor, 0);
    const card = (icon, n, label, cls) => '<div class="metric-card po-kpi ' + (cls || '') + '"><div class="metric-icon">' + icon + '</div><div><div class="metric-number">' + n + '</div><div class="metric-label">' + label + '</div></div></div>';
    return '<div class="po-kpi-grid">'
      + card('🧾', open.length, 'Open Purchase Orders')
      + card('🚚', transit.length, 'In Transit')
      + card('⚠️', overdue.length, 'Overdue Deliveries', overdue.length ? 'po-kpi-alert' : '')
      + card('📦', outstandingPcs, 'Parts Outstanding (pcs)')
      + card('💰', '<span style="font-size:18px">' + money(committed) + '</span>', 'Committed Spend (Issued POs)')
      + '</div>';
  }

  /* ================= PAGE: PURCHASE ORDER REGISTER ================= */
  async function pageOrders(notice) {
    notice = takeNotice(notice);
    h().removeExistingModal();
    h().loading('Loading purchase orders...');
    try {
      const orders = await window.PC_API.listPurchaseOrders();
      cache.orders = orders;

      // Approved summaries that do not yet have purchase orders
      let ready = [];
      if (can('summaries')) {
        try {
          const sums = await window.PC_API.listSummaries();
          const withPO = new Set(orders.filter((p) => p.status !== 'CANCELLED').map((p) => p.summary_id));
          ready = sums.filter((x) => x.approval_status === 'APPROVED' && !withPO.has(x.id));
        } catch (e) { ready = []; }
      }

      const readyHtml = can('summaries')
        ? '<section class="card stack po-ready-card">'
          + '<div class="row between" style="align-items:center;flex-wrap:wrap;gap:8px;"><div><h2 style="margin:0;font-size:17px;">✍️ Approved Job Sheets Ready for Purchase Orders</h2>'
          + '<p class="small" style="color:var(--mute);margin:2px 0 0;">Administrator-approved sourcing summaries. Generating creates one draft PO per supplier using the frozen snapshot prices.</p></div></div>'
          + (ready.length
            ? '<div class="stack" style="gap:8px;">' + ready.map((x) => '<div class="po-ready-row">'
              + '<div><strong>' + esc(x.title) + '</strong><div class="small" style="color:var(--mute);">Approved by ' + esc(x.approved_by || 'Admin') + ' · ' + esc(fmtTime(x.approved_at)) + (x.unresolved_count ? ' · <span style="color:#CA8A04;">' + x.unresolved_count + ' unresolved line(s) will be skipped</span>' : '') + '</div></div>'
              + '<div class="row" style="gap:8px;align-items:center;"><span class="mono" style="font-weight:700;">' + money(x.subtotal_minor, x.currency) + '</span>'
              + '<a class="btn btn-sm" href="#/summaries/' + esc(x.id) + '">View</a>'
              + '<button type="button" class="btn primary btn-sm" data-action="po-generate" data-id="' + esc(x.id) + '" data-title="' + esc(x.title) + '">🧾 Generate POs</button></div>'
              + '</div>').join('') + '</div>'
            : '<p class="small" style="color:var(--mute);margin:0;">No approved summaries are waiting for purchase orders. Approve a saved summary first, or all approved summaries already have POs.</p>')
          + '</section>'
        : '';

      const statusOpts = [['ALL', 'All statuses'], ['OPEN', 'All open'], ['OVERDUE', 'Overdue only']]
        .concat(Object.keys(STATUS_META).map((k) => [k, STATUS_META[k].label]));

      h().setMain(
        '<div class="row between" style="align-items:flex-end;flex-wrap:wrap;gap:12px;"><div><h1 style="margin:0;">Purchase Orders</h1>'
        + '<p class="sub" style="margin-top:4px;">Issue supplier purchase orders from approved job sheets and track every part until it is received at ' + esc(h().getCompany().business_name) + '.</p></div>'
        + '<div class="row" style="gap:8px;flex-wrap:wrap;">'
        + '<button type="button" class="btn primary" data-action="po-open-new-modal">➕ Create Purchase Order</button>'
        + '<a class="btn" href="#/tracking">📍 Parts &amp; Delivery Tracking</a>'
        + '</div></div>'
        + tabs('orders')
        + (notice ? h().alertBox('ok', esc(notice), 'status') : '')
        + kpis(orders)
        + readyHtml
        + '<section class="card stack">'
        + '<div class="row between" style="align-items:center;flex-wrap:wrap;gap:10px;"><h2 style="margin:0;font-size:17px;">Purchase Order Register</h2>'
        + '<div class="row" style="gap:8px;flex-wrap:wrap;">'
        + '<input type="search" id="po-search" placeholder="Search PO #, supplier, job, part..." value="' + esc(listFilter.q) + '" style="min-width:240px;">'
        + '<select id="po-status-filter">' + statusOpts.map(([v, l]) => '<option value="' + v + '"' + (listFilter.status === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>'
        + '</div></div>'
        + '<div id="po-table-wrap">' + ordersTable(orders) + '</div>'
        + '</section>'
      );
    } catch (e) { h().errorPage(e); }
  }

  function filterOrders(orders) {
    const q = listFilter.q.trim().toLowerCase();
    return orders.filter((p) => {
      if (listFilter.status === 'OPEN' && !OPEN_STATUSES.includes(p.status)) return false;
      if (listFilter.status === 'OVERDUE' && !isOverdue(p)) return false;
      if (!['OPEN', 'ALL', 'OVERDUE'].includes(listFilter.status) && p.status !== listFilter.status) return false;
      if (!q) return true;
      const hay = [p.po_number, p.supplier_name, p.summary_title, p.tracking_ref, p.courier].concat(p.lines.map((l) => l.exact_id + ' ' + l.description)).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  function ordersTable(orders) {
    const rows = filterOrders(orders);
    if (!orders.length) {
      return '<div class="po-empty"><div style="font-size:34px;">🧾</div><strong>No purchase orders yet</strong><p class="small" style="color:var(--mute);">'
        + (can('summaries') ? 'Generate purchase orders from an approved sourcing summary above.' : 'Purchase orders created by BOM Preparers will appear here for delivery tracking and receiving.')
        + '</p></div>';
    }
    if (!rows.length) return '<p class="small" style="color:var(--mute);padding:10px 0;">No purchase orders match the current filter.</p>';
    return '<div class="tbl"><table><thead><tr><th>PO Number</th><th>Supplier</th><th>Job / Summary</th><th>Status</th><th style="min-width:140px;">Receiving Progress</th><th>Expected Delivery</th><th class="num">PO Total</th></tr></thead><tbody>'
      + rows.map((p) => {
        const t = totals(p);
        return '<tr class="po-row' + (isOverdue(p) ? ' po-row-overdue' : '') + '" data-action="po-open" data-id="' + esc(p.id) + '" style="cursor:pointer;">'
          + '<td><a href="#/orders/' + esc(p.id) + '" class="mono" style="font-weight:700;">' + esc(p.po_number) + '</a><div class="small" style="color:var(--mute);">' + esc(fmtTime(p.created_at)) + '</div></td>'
          + '<td><strong>' + esc(p.supplier_name) + '</strong>' + (p.tracking_ref ? '<div class="small" style="color:var(--mute);">🚚 ' + esc((p.courier ? p.courier + ' · ' : '') + p.tracking_ref) + '</div>' : '') + '</td>'
          + '<td>' + esc(p.summary_title) + '<div class="small" style="color:var(--mute);">' + p.lines.length + ' line(s)</div></td>'
          + '<td>' + statusBadge(p.status) + (isOverdue(p) ? '<div style="margin-top:4px;"><span class="po-badge po-st-overdue">⚠ Overdue</span></div>' : '') + '</td>'
          + '<td>' + progressBar(t) + '</td>'
          + '<td>' + etaCell(p) + '</td>'
          + '<td class="num mono" style="font-weight:700;">' + money(p.subtotal_minor, p.currency) + '</td>'
          + '</tr>';
      }).join('')
      + '</tbody></table></div>';
  }

  /* ================= PAGE: PARTS & DELIVERY TRACKING ================= */
  function trackRows(orders) {
    const out = [];
    orders.filter((p) => p.status !== 'CANCELLED').forEach((p) => {
      p.lines.forEach((l) => {
        const rec = l.received_qty || 0;
        const outstanding = l.quantity - rec;
        let state;
        if (outstanding === 0) state = 'RECEIVED';
        else if (p.status === 'DRAFT') state = 'AWAITING_ISSUE';
        else if (isOverdue(p)) state = 'OVERDUE';
        else if (rec > 0) state = 'PARTIAL';
        else if (p.status === 'IN_TRANSIT') state = 'IN_TRANSIT';
        else state = 'ORDERED';
        out.push({ po: p, line: l, received: rec, outstanding, state });
      });
    });
    return out;
  }

  async function pageTracking() {
    h().removeExistingModal();
    h().loading('Loading parts tracking...');
    try {
      const orders = await window.PC_API.listPurchaseOrders();
      cache.orders = orders;
      const rows = trackRows(orders);
      const count = (st) => rows.filter((r) => r.state === st).length;
      const chip = (key, label, n, cls) => '<button type="button" class="po-chip ' + (cls || '') + (trackFilter.state === key ? ' active' : '') + '" data-action="po-track-filter" data-state="' + key + '">' + label + ' <span class="po-chip-n">' + n + '</span></button>';

      h().setMain(
        '<div><h1 style="margin:0;">Parts & Delivery Tracking</h1><p class="sub" style="margin-top:4px;">Line-by-line status of every ordered component — what is still coming, from whom, and when.</p></div>'
        + tabs('tracking')
        + kpis(orders)
        + '<section class="card stack">'
        + '<div class="row between" style="align-items:center;flex-wrap:wrap;gap:10px;">'
        + '<div class="row" style="gap:6px;flex-wrap:wrap;">'
        + chip('ALL', 'All tracked parts', rows.length)
        + chip('OUTSTANDING', 'Outstanding', rows.filter((r) => r.outstanding > 0).length)
        + chip('AWAITING_ISSUE', 'Awaiting issue', count('AWAITING_ISSUE'))
        + chip('ORDERED', 'Ordered', count('ORDERED'))
        + chip('IN_TRANSIT', 'In transit', count('IN_TRANSIT'))
        + chip('PARTIAL', 'Partial', count('PARTIAL'))
        + chip('OVERDUE', 'Overdue', count('OVERDUE'), count('OVERDUE') ? 'po-chip-alert' : '')
        + chip('RECEIVED', 'Received', count('RECEIVED'))
        + '</div>'
        + '<input type="search" id="po-track-search" placeholder="Search part, job, supplier, PO #..." value="' + esc(trackFilter.q) + '" style="min-width:240px;">'
        + '</div>'
        + '<div id="po-track-wrap">' + trackTable(rows) + '</div>'
        + '</section>'
      );
    } catch (e) { h().errorPage(e); }
  }

  function trackTable(rows) {
    const q = trackFilter.q.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (trackFilter.state === 'OUTSTANDING' && r.outstanding === 0) return false;
      if (!['OUTSTANDING', 'ALL'].includes(trackFilter.state) && r.state !== trackFilter.state) return false;
      if (!q) return true;
      return [r.line.exact_id, r.line.description, r.po.po_number, r.po.supplier_name, r.po.summary_title, r.po.tracking_ref].join(' ').toLowerCase().includes(q);
    });
    if (!rows.length) return '<div class="po-empty"><div style="font-size:34px;">📍</div><strong>Nothing to track yet</strong><p class="small" style="color:var(--mute);">Parts appear here as soon as a purchase order is generated.</p></div>';
    if (!list.length) return '<p class="small" style="color:var(--mute);padding:10px 0;">No parts match the current filter.</p>';
    return '<div class="tbl"><table><thead><tr><th>Part</th><th>Job</th><th>PO / Supplier</th><th class="num">Ordered</th><th class="num">Received</th><th class="num">Outstanding</th><th>Expected</th><th>State</th></tr></thead><tbody>'
      + list.map((r) => {
        const st = TRACK_STATES[r.state];
        const lastReceipt = (r.line.receipts || []).slice(-1)[0];
        return '<tr' + (r.state === 'OVERDUE' ? ' class="po-row-overdue"' : '') + '>'
          + '<td><div class="mono" style="font-weight:700;">' + esc(r.line.exact_id) + '</div><div class="small" style="color:var(--mute);">' + esc(r.line.description) + '</div></td>'
          + '<td>' + esc(r.po.summary_title) + '</td>'
          + '<td><a href="#/orders/' + esc(r.po.id) + '" class="mono" style="font-weight:700;">' + esc(r.po.po_number) + '</a><div class="small" style="color:var(--mute);">' + esc(r.po.supplier_name) + '</div>'
          + (r.po.tracking_ref ? '<div class="small" style="color:var(--mute);">🚚 ' + esc((r.po.courier ? r.po.courier + ' · ' : '') + r.po.tracking_ref) + '</div>' : '') + '</td>'
          + '<td class="num mono">' + r.line.quantity + '</td>'
          + '<td class="num mono">' + r.received + (lastReceipt ? '<div class="small" style="color:var(--mute);font-family:inherit;">last ' + esc(new Date(lastReceipt.at).toLocaleDateString()) + '</div>' : '') + '</td>'
          + '<td class="num mono" style="font-weight:700;' + (r.outstanding ? '' : 'color:var(--mute);') + '">' + r.outstanding + '</td>'
          + '<td>' + (r.outstanding ? etaCell(r.po) : '<span class="small" style="color:var(--mute);">' + (r.line.received_at ? 'Done ' + esc(new Date(r.line.received_at).toLocaleDateString()) : '—') + '</span>') + '</td>'
          + '<td><span class="po-badge ' + st.cls + '">' + esc(st.label) + '</span></td>'
          + '</tr>';
      }).join('')
      + '</tbody></table></div>';
  }

  /* ================= PAGE: PURCHASE ORDER DETAIL ================= */
  function stepper(po) {
    if (po.status === 'CANCELLED') {
      return '<div class="alert bad" role="status"><div><strong>✖ Purchase order cancelled.</strong> ' + esc(((po.history || []).filter((x) => x.status === 'CANCELLED').slice(-1)[0] || {}).note || '') + '</div></div>';
    }
    const cur = po.status === 'PARTIALLY_RECEIVED' ? 'IN_TRANSIT' : po.status;
    const idx = STEPS.indexOf(cur);
    return '<ol class="po-stepper">' + STEPS.map((s, i) => {
      const state = i < idx ? 'done' : i === idx ? 'current' : '';
      let label = STATUS_META[s].label;
      if (s === 'IN_TRANSIT' && po.status === 'PARTIALLY_RECEIVED') label = 'Partially Received';
      return '<li class="po-step ' + state + '"><span class="po-step-dot">' + (i < idx ? '✓' : i + 1) + '</span><span class="po-step-label">' + esc(label) + '</span></li>';
    }).join('') + '</ol>';
  }

  function actionButtons(po) {
    const btns = [];
    const owner = po.owner_id === me().id;
    const t = totals(po);
    const b = (action, label, cls, extra) => '<button type="button" class="btn ' + (cls || '') + '" data-action="' + action + '" data-id="' + esc(po.id) + '"' + (extra || '') + '>' + label + '</button>';
    if (po.status === 'DRAFT') {
      if (isAdmin()) btns.push(b('po-status', '📤 Approve & Issue to Supplier', 'primary', ' data-next="ISSUED"'));
      else btns.push('<span class="po-badge po-st-draft" title="An Administrator must issue this PO">⏳ Awaiting Admin issue</span>');
      if (isAdmin() || owner) btns.push(b('po-delete', '🗑️ Delete Draft', 'po-btn-danger'));
    }
    if (po.status === 'ISSUED') btns.push(b('po-status', '🤝 Mark Supplier Confirmed', '', ' data-next="CONFIRMED"'));
    if (['ISSUED', 'CONFIRMED', 'PARTIALLY_RECEIVED'].includes(po.status)) btns.push(b('po-status', '🚚 Mark In Transit', '', ' data-next="IN_TRANSIT"'));
    if (po.status === 'RECEIVED' && isAdmin()) btns.push(b('po-status', '🔒 Close PO', 'primary', ' data-next="CLOSED"'));
    if (['ISSUED', 'CONFIRMED'].includes(po.status) && isAdmin() && t.received === 0) btns.push(b('po-status', '✖ Cancel PO', 'po-btn-danger', ' data-next="CANCELLED"'));
    if (po.status === 'DRAFT' && (isAdmin() || owner)) btns.push(b('po-status', '✖ Cancel', 'po-btn-danger', ' data-next="CANCELLED"'));
    btns.push('<button type="button" class="btn" data-action="po-print">🖨️ Print PO</button>');
    btns.push('<a class="btn" href="#/orders">All orders</a>');
    return btns.join('');
  }

  async function pageOrder(id, notice) {
    notice = takeNotice(notice);
    h().removeExistingModal();
    h().loading('Loading purchase order...');
    try {
      const po = await window.PC_API.getPurchaseOrder(id);
      const t = totals(po);
      const company = h().getCompany();
      const receivable = ['ISSUED', 'CONFIRMED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(po.status);
      const locked = ['CLOSED', 'CANCELLED'].includes(po.status);
      const draft = po.status === 'DRAFT';
      const vat = h().computeVat(po.subtotal_minor);

      const field = (label, key, value, type, editable, placeholder) => '<label class="po-field"><span class="small po-field-label">' + label + '</span>'
        + (editable
          ? (type === 'textarea'
            ? '<textarea data-po-field="' + key + '" rows="2" placeholder="' + esc(placeholder || '') + '">' + esc(value || '') + '</textarea>'
            : '<input type="' + (type || 'text') + '" data-po-field="' + key + '" value="' + esc(value || '') + '" placeholder="' + esc(placeholder || '') + '">')
          : '<div class="po-field-value">' + (value ? esc(value) : '<span style="color:var(--mute)">—</span>') + '</div>')
        + '</label>';

      const detailsCard = '<section class="card stack po-no-print">'
        + '<div class="row between" style="align-items:center;flex-wrap:wrap;gap:8px;"><h2 style="margin:0;font-size:17px;">📋 Order & Delivery Details</h2>'
        + (!locked ? '<button type="button" class="btn btn-sm primary" data-action="po-save-details" data-id="' + esc(po.id) + '">💾 Save Details</button>' : '') + '</div>'
        + (!draft && !locked ? '<p class="small" style="color:var(--mute);margin:0;">Commercial terms are frozen once issued. Delivery date and courier tracking can still be updated.</p>' : '')
        + '<div class="po-field-grid">'
        + field('Expected Delivery Date', 'expected_date', po.expected_date, 'date', !locked)
        + field('Courier / Delivery Method', 'courier', po.courier, 'text', !locked, 'e.g. Supplier truck, LBC, Lalamove')
        + field('Tracking / Waybill / DR No.', 'tracking_ref', po.tracking_ref, 'text', !locked, 'e.g. DR-004512')
        + field('Payment Terms', 'payment_terms', po.payment_terms, 'text', draft)
        + field('Deliver To', 'delivery_address', po.delivery_address, 'text', draft)
        + field('Notes to Supplier', 'notes', po.notes, 'textarea', draft, 'Special instructions...')
        + '</div></section>';

      const linesTable = '<section class="card stack">'
        + '<div class="row between" style="align-items:center;flex-wrap:wrap;gap:8px;"><h2 style="margin:0;font-size:17px;">📦 Line Items & Goods Receipt</h2>'
        + (receivable ? '<button type="button" class="btn btn-sm" data-action="po-fill-all">Fill all outstanding</button>' : '') + '</div>'
        + '<div class="tbl"><table><thead><tr><th>#</th><th>Part</th><th class="num">Ordered</th><th class="num">Unit Price</th><th class="num">Line Total</th><th class="num">Received</th><th class="num">Outstanding</th>' + (receivable ? '<th class="num" style="min-width:110px;">Receive Now</th>' : '') + '</tr></thead><tbody>'
        + po.lines.map((l, i) => {
          const rec = l.received_qty || 0, out = l.quantity - rec;
          return '<tr>'
            + '<td class="mono">' + (i + 1) + '</td>'
            + '<td><div class="mono" style="font-weight:700;">' + esc(l.exact_id) + '</div><div class="small" style="color:var(--mute);">' + esc(l.description) + '</div><div class="small" style="color:var(--mute);">Quote ref: ' + esc(l.source_reference || '—') + '</div></td>'
            + '<td class="num mono">' + l.quantity + '</td>'
            + '<td class="num mono">' + money(l.unit_price_minor, po.currency) + '</td>'
            + '<td class="num mono" style="font-weight:700;">' + money(l.line_total_minor, po.currency) + '</td>'
            + '<td class="num mono">' + rec + (out === 0 ? ' <span title="Fully received">✅</span>' : '') + '</td>'
            + '<td class="num mono" style="font-weight:700;' + (out ? '' : 'color:var(--mute);') + '">' + out + '</td>'
            + (receivable ? '<td class="num">' + (out > 0 ? '<input type="number" min="0" max="' + out + '" step="1" class="po-recv-input" data-line="' + esc(l.line_id) + '" data-max="' + out + '" placeholder="0" aria-label="Quantity received now for ' + esc(l.exact_id) + '"><div class="err po-recv-err" data-err-for="' + esc(l.line_id) + '"></div>' : '<span class="small" style="color:var(--mute);">Complete</span>') + '</td>' : '')
            + '</tr>';
        }).join('')
        + '</tbody><tfoot>'
        + '<tr><td colspan="4" class="num small" style="color:var(--mute);">Net of VAT</td><td class="num mono">' + money(vat.net, po.currency) + '</td><td colspan="' + (receivable ? 3 : 2) + '"></td></tr>'
        + '<tr><td colspan="4" class="num small" style="color:var(--mute);">12% VAT</td><td class="num mono">' + money(vat.vat, po.currency) + '</td><td colspan="' + (receivable ? 3 : 2) + '"></td></tr>'
        + '<tr><td colspan="4" class="num"><strong>PO Total (VAT-inclusive)</strong></td><td class="num mono"><strong>' + money(po.subtotal_minor, po.currency) + '</strong></td><td colspan="' + (receivable ? 3 : 2) + '" class="small" style="color:var(--mute);">Received value: ' + money(t.receivedValue, po.currency) + '</td></tr>'
        + '</tfoot></table></div>'
        + (receivable
          ? '<div class="po-receive-bar"><input type="text" id="po-recv-note" placeholder="Delivery receipt note (e.g. DR #, condition, received by)" style="flex:1;min-width:220px;">'
            + '<button type="button" class="btn primary" data-action="po-receive" data-id="' + esc(po.id) + '">📥 Record Delivery</button></div>'
          : (draft ? '<p class="small" style="color:var(--mute);margin:0;">Deliveries can be recorded once the PO has been issued to the supplier.</p>' : ''))
        + '</section>';

      const history = (po.history || []).slice().reverse();
      const timeline = '<section class="card stack"><h2 style="margin:0;font-size:17px;">🕓 Tracking Timeline</h2><ol class="po-timeline">'
        + history.map((ev) => '<li class="po-tl-item"><span class="po-tl-dot ' + ((STATUS_META[ev.status] || {}).cls || '') + '"></span><div>'
          + '<div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;">' + statusBadge(ev.status) + '<span class="small" style="color:var(--mute);">' + esc(fmtTime(ev.at)) + ' · ' + esc(ev.by) + ' (' + esc(ev.role) + ')</span></div>'
          + (ev.note ? '<div style="margin-top:4px;font-size:13.5px;">' + esc(ev.note) + '</div>' : '')
          + '</div></li>').join('')
        + '</ol></section>';

      const printHeader = '<div class="print-amgc-header">'
        + '<h1 style="font-size:22pt;margin:0 0 4px;">' + esc(company.business_name) + '</h1>'
        + '<div style="font-size:10pt;color:#444;">' + esc(company.business_type) + ' &bull; ' + esc(company.location) + ' &bull; Contact: ' + esc(company.contact_number || '') + '</div>'
        + '<div style="font-size:14pt;margin-top:10px;font-weight:bold;">PURCHASE ORDER ' + esc(po.po_number) + '</div>'
        + '<table style="width:100%;margin-top:8px;font-size:10pt;border:none;"><tr>'
        + '<td style="border:none;vertical-align:top;width:50%;"><strong>Supplier:</strong> ' + esc(po.supplier_name) + '<br>' + esc(po.supplier_location || '') + (po.supplier_contact ? '<br>' + esc(po.supplier_contact) : '') + '</td>'
        + '<td style="border:none;vertical-align:top;"><strong>PO Date:</strong> ' + esc(new Date(po.issued_at || po.created_at).toLocaleDateString()) + '<br><strong>Deliver To:</strong> ' + esc(po.delivery_address || '') + '<br><strong>Expected:</strong> ' + esc(po.expected_date || 'TBA') + '<br><strong>Terms:</strong> ' + esc(po.payment_terms || '') + '</td>'
        + '</tr></table>'
        + '<div style="font-size:9pt;color:#666;margin-top:4px;">Job: ' + esc(po.summary_title) + ' | Snapshot token: ' + esc(po.snapshot_token || '') + ' | Status: ' + esc((STATUS_META[po.status] || {}).label || po.status) + '</div>'
        + '</div>';

      const signatures = '<section class="card print-signature-section po-print-only"><div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;">'
        + '<div><div class="print-signature-line">Prepared by: ' + esc(po.created_by) + '</div></div>'
        + '<div><div class="print-signature-line">Authorized by: ' + esc(po.issued_by || '________________') + '</div></div>'
        + '<div><div class="print-signature-line">Supplier Conformé</div></div>'
        + '</div></section>';

      h().setMain(
        '<div class="row between" style="align-items:flex-start;flex-wrap:wrap;gap:12px;">'
        + '<div><div class="row" style="gap:10px;align-items:center;flex-wrap:wrap;"><h1 style="margin:0;" class="mono">' + esc(po.po_number) + '</h1>' + statusBadge(po.status) + (isOverdue(po) ? '<span class="po-badge po-st-overdue">⚠ Overdue</span>' : '') + '</div>'
        + '<p class="sub" style="margin-top:4px;"><strong>' + esc(po.supplier_name) + '</strong> · Job: <a href="#/summaries/' + esc(po.summary_id) + '">' + esc(po.summary_title) + '</a> · Created by ' + esc(po.created_by) + ' on ' + esc(fmtTime(po.created_at))
        + (po.issued_by ? ' · Issued by ' + esc(po.issued_by) + ' on ' + esc(fmtTime(po.issued_at)) : '') + '</p></div>'
        + '<div class="row" style="gap:8px;flex-wrap:wrap;align-items:center;">' + actionButtons(po) + '</div>'
        + '</div>'
        + (notice ? h().alertBox('ok', esc(notice), 'status') : '')
        + printHeader
        + stepper(po)
        + '<div class="po-summary-strip">'
        + '<div><span class="small">PO Total</span><strong class="mono">' + money(po.subtotal_minor, po.currency) + '</strong></div>'
        + '<div><span class="small">Lines</span><strong>' + po.lines.length + '</strong></div>'
        + '<div><span class="small">Received</span><strong>' + t.received + ' / ' + t.ordered + ' pcs</strong></div>'
        + '<div style="min-width:160px;"><span class="small">Progress</span>' + progressBar(t) + '</div>'
        + '<div><span class="small">Expected Delivery</span>' + etaCell(po) + '</div>'
        + '</div>'
        + linesTable
        + detailsCard
        + timeline
        + signatures
      );
    } catch (e) { h().errorPage(e); }
  }

  /* ================= MODAL: CREATE DIRECT PURCHASE ORDER ================= */
  function defaultOfferPriceMajor(partId, supplierId) {
    const off = (cache.offers || []).find((o) => o.part_id === partId && o.supplier_id === supplierId && o.active && o.price_minor != null);
    if (off) return (off.price_minor / 100).toFixed(2);
    const any = (cache.offers || []).find((o) => o.part_id === partId && o.active && o.price_minor != null);
    return any ? (any.price_minor / 100).toFixed(2) : '0.00';
  }

  async function openNewPoModal() {
    const API = window.PC_API;
    const [parts, sups, offers] = await Promise.all([API.listParts(), API.listSuppliers(), API.listOffers()]);
    cache.parts = parts.filter((p) => p.active);
    cache.suppliers = sups.filter((s) => s.accredited !== false);
    cache.offers = offers;
    const firstSup = (cache.suppliers[0] && cache.suppliers[0].id) || 's1';
    const firstPart = (cache.parts[0] && cache.parts[0].id) || 'p1';
    newPoDraft = {
      supplier_id: firstSup,
      summary_title: 'HVAC Field Service Material Requisition',
      expected_date: addDays(3),
      payment_terms: '30 days upon delivery',
      courier: '',
      notes: '',
      lines: [
        { part_id: firstPart, quantity: 2, unit_price_major: defaultOfferPriceMajor(firstPart, firstSup) }
      ]
    };
    renderNewPoModal();
  }

  function syncDraftFromDom() {
    if (!newPoDraft) return;
    const g = (id) => document.getElementById(id);
    if (g('npo-supplier')) newPoDraft.supplier_id = g('npo-supplier').value;
    if (g('npo-title')) newPoDraft.summary_title = g('npo-title').value;
    if (g('npo-date')) newPoDraft.expected_date = g('npo-date').value;
    if (g('npo-terms')) newPoDraft.payment_terms = g('npo-terms').value;
    if (g('npo-courier')) newPoDraft.courier = g('npo-courier').value;
    if (g('npo-notes')) newPoDraft.notes = g('npo-notes').value;
    document.querySelectorAll('[data-npo-idx]').forEach((row) => {
      const idx = Number(row.dataset.npoIdx);
      const ln = newPoDraft.lines[idx];
      if (!ln) return;
      const pEl = row.querySelector('[data-npo-part]');
      const qEl = row.querySelector('[data-npo-qty]');
      const prEl = row.querySelector('[data-npo-price]');
      if (pEl) ln.part_id = pEl.value;
      if (qEl) ln.quantity = Math.max(1, parseInt(qEl.value, 10) || 1);
      if (prEl) ln.unit_price_major = prEl.value;
    });
  }

  function renderNewPoModal(errMsg) {
    h().removeExistingModal();
    if (!newPoDraft) return;
    const overlay = document.createElement('div');
    overlay.id = 'newPoModalOverlay';
    overlay.className = 'catalog-modal-overlay';

    const totalMinor = newPoDraft.lines.reduce((acc, ln) => {
      const minor = Math.round((parseFloat(ln.unit_price_major) || 0) * 100);
      return acc + minor * (Number(ln.quantity) || 0);
    }, 0);

    overlay.innerHTML = '<div class="catalog-modal-card stack" style="max-width:740px;">'
      + '<div class="catalog-modal-header">'
      + '<div><h2 style="margin:0;font-size:19px;">➕ Create Purchase Order</h2>'
      + '<p class="small" style="color:var(--mute);margin:2px 0 0;">Create a draft purchase order for an accredited supplier with catalog pricing.</p></div>'
      + '<button type="button" class="catalog-modal-close-btn" data-action="po-close-new-modal" aria-label="Close modal">&times;</button>'
      + '</div>'
      + (errMsg ? h().alertBox('bad', esc(errMsg), 'alert') : '')
      + '<div class="po-field-grid">'
      + '<label class="po-field"><span class="small po-field-label">Accredited Supplier</span>'
      + '<select id="npo-supplier">' + cache.suppliers.map((s) => '<option value="' + esc(s.id) + '"' + (s.id === newPoDraft.supplier_id ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') + '</select></label>'
      + '<label class="po-field"><span class="small po-field-label">Job / Requisition Reference</span>'
      + '<input type="text" id="npo-title" value="' + esc(newPoDraft.summary_title) + '" placeholder="e.g. Split-Type AC Service (Job #AC-2026-091)"></label>'
      + '<label class="po-field"><span class="small po-field-label">Expected Delivery Date</span>'
      + '<input type="date" id="npo-date" value="' + esc(newPoDraft.expected_date) + '"></label>'
      + '<label class="po-field"><span class="small po-field-label">Payment Terms</span>'
      + '<input type="text" id="npo-terms" value="' + esc(newPoDraft.payment_terms) + '"></label>'
      + '<label class="po-field"><span class="small po-field-label">Preferred Courier / Delivery Mode</span>'
      + '<input type="text" id="npo-courier" value="' + esc(newPoDraft.courier) + '" placeholder="e.g. Supplier delivery truck, Lalamove"></label>'
      + '<label class="po-field"><span class="small po-field-label">Delivery / Supplier Notes</span>'
      + '<input type="text" id="npo-notes" value="' + esc(newPoDraft.notes) + '" placeholder="Include BIR VAT invoice..."></label>'
      + '</div>'
      + '<div class="row between" style="align-items:center;margin-top:4px;">'
      + '<strong style="font-size:14px;">Order Line Items</strong>'
      + '<button type="button" class="btn btn-sm" data-action="po-add-draft-line">+ Add Component Line</button>'
      + '</div>'
      + '<div class="tbl"><table><thead><tr><th>Component SKU</th><th class="num" style="width:95px;">Qty</th><th class="num" style="width:135px;">Unit Price (PHP)</th><th class="num" style="width:130px;">Line Subtotal</th><th style="width:50px;"></th></tr></thead><tbody>'
      + newPoDraft.lines.map((ln, idx) => {
        const lineMinor = Math.round((parseFloat(ln.unit_price_major) || 0) * 100) * (Number(ln.quantity) || 0);
        return '<tr data-npo-idx="' + idx + '">'
          + '<td><select data-npo-part style="width:100%;">' + cache.parts.map((p) => '<option value="' + esc(p.id) + '"' + (p.id === ln.part_id ? ' selected' : '') + '>' + esc(p.exact_id) + ' — ' + esc(p.description) + '</option>').join('') + '</select></td>'
          + '<td class="num"><input type="number" min="1" step="1" data-npo-qty value="' + esc(ln.quantity) + '" style="width:78px;text-align:right;"></td>'
          + '<td class="num"><input type="number" min="0.01" step="0.01" data-npo-price value="' + esc(ln.unit_price_major) + '" style="width:115px;text-align:right;"></td>'
          + '<td class="num mono" style="font-weight:700;">' + money(lineMinor) + '</td>'
          + '<td>' + (newPoDraft.lines.length > 1 ? '<button type="button" class="btn btn-sm po-btn-danger" data-action="po-remove-draft-line" data-idx="' + idx + '" title="Remove line">&times;</button>' : '') + '</td>'
          + '</tr>';
      }).join('')
      + '</tbody><tfoot><tr><td colspan="3" class="num"><strong>Estimated PO Total (VAT-Inclusive)</strong></td><td class="num mono"><strong>' + money(totalMinor) + '</strong></td><td></td></tr></tfoot></table></div>'
      + '<div class="row" style="justify-content:flex-end;gap:8px;margin-top:6px;">'
      + '<button type="button" class="btn" data-action="po-close-new-modal">Cancel</button>'
      + '<button type="button" class="btn primary" data-action="po-submit-new-modal">🧾 Create Draft PO</button>'
      + '</div></div>';

    document.body.appendChild(overlay);
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) h().removeExistingModal();
    });
  }

  /* ================= EVENT HANDLING ================= */
  async function onClick(ev) {
    const t = ev.target.closest('[data-action^="po-"]');
    if (!t || !ctx) return;
    const act = t.dataset.action;
    const API = window.PC_API;
    try {
      if (act === 'po-open') {
        if (ev.target.closest('a')) return;
        ctx.go('#/orders/' + t.dataset.id);
      }
      else if (act === 'po-generate') {
        const expected = prompt('Generate draft purchase orders for "' + t.dataset.title + '".\n\nOne PO will be created per supplier using the frozen, approved prices.\n\nRequested delivery date (YYYY-MM-DD):', addDays(3));
        if (expected === null) return;
        if (expected && !/^\d{4}-\d{2}-\d{2}$/.test(expected.trim())) { alert('Please use the YYYY-MM-DD date format.'); return; }
        t.disabled = true;
        const res = await API.createPurchaseOrdersFromSummary(t.dataset.id, { expected_date: expected.trim() || null });
        let msg = res.created.length
          ? 'Created ' + res.created.length + ' draft purchase order(s): ' + res.created.map((p) => p.po_number + ' (' + p.supplier_name + ')').join(', ') + '.'
          : 'No new purchase orders were created.';
        if (res.skipped_suppliers.length) msg += ' Skipped (already ordered): ' + res.skipped_suppliers.join(', ') + '.';
        if (res.skipped_unresolved) msg += ' ' + res.skipped_unresolved + ' unresolved line(s) were not ordered.';
        pendingNotice = msg;
        const target = res.created.length === 1 ? '#/orders/' + res.created[0].id : '#/orders';
        if (location.hash === target) ctx.route();
        else location.hash = target;
      }
      else if (act === 'po-status') {
        const next = t.dataset.next;
        const po = await API.getPurchaseOrder(t.dataset.id);
        let note = '';
        if (next === 'CANCELLED') {
          note = prompt('Reason for cancelling ' + po.po_number + ':', '');
          if (note === null) return;
          if (!note.trim()) { alert('A cancellation reason is required.'); return; }
        } else if (next === 'ISSUED') {
          if (!po.expected_date && !confirm('No expected delivery date is set. Issue anyway?')) return;
          note = prompt('Issue ' + po.po_number + ' to ' + po.supplier_name + ' (' + ctx.money(po.subtotal_minor, po.currency) + ').\n\nOptional note (e.g. sent via email/Viber):', 'PO sent to supplier');
          if (note === null) return;
        } else if (next === 'IN_TRANSIT') {
          const ref = prompt('Mark ' + po.po_number + ' as in transit.\n\nTracking / waybill / DR number (optional):', po.tracking_ref || '');
          if (ref === null) return;
          if (ref.trim() && ref.trim() !== (po.tracking_ref || '')) {
            await API.updatePurchaseOrderDetails(po.id, po.revision, { tracking_ref: ref.trim() });
          }
          note = 'Shipment dispatched by supplier' + (ref.trim() ? ' · Tracking: ' + ref.trim() : '');
        } else if (next === 'CONFIRMED') {
          note = prompt('Supplier confirmation note (e.g. confirmed by phone, ETA):', 'Supplier confirmed availability and delivery schedule');
          if (note === null) return;
        } else if (next === 'CLOSED') {
          if (!confirm('Close ' + po.po_number + '? A closed PO becomes read-only.')) return;
          note = 'All parts received and verified. Purchase order closed.';
        }
        const fresh = await API.getPurchaseOrder(po.id);
        await API.setPurchaseOrderStatus(fresh.id, fresh.revision, next, note);
        pageOrder(fresh.id, fresh.po_number + ' → ' + STATUS_META[next].label + '.');
      }
      else if (act === 'po-save-details') {
        const po = await API.getPurchaseOrder(t.dataset.id);
        const fields = {};
        document.querySelectorAll('[data-po-field]').forEach((el) => { fields[el.dataset.poField] = el.value; });
        await API.updatePurchaseOrderDetails(po.id, po.revision, fields);
        pageOrder(po.id, 'Order details saved.');
      }
      else if (act === 'po-fill-all') {
        document.querySelectorAll('.po-recv-input').forEach((el) => { el.value = el.dataset.max; });
      }
      else if (act === 'po-receive') {
        const po = await API.getPurchaseOrder(t.dataset.id);
        const receipts = {};
        document.querySelectorAll('.po-recv-input').forEach((el) => { if (el.value !== '') receipts[el.dataset.line] = el.value; });
        document.querySelectorAll('.po-recv-err').forEach((el) => { el.textContent = ''; });
        const noteEl = document.getElementById('po-recv-note');
        try {
          const updated = await API.receivePurchaseOrderItems(po.id, po.revision, receipts, noteEl ? noteEl.value : '');
          pageOrder(po.id, updated.status === 'RECEIVED' ? 'All parts received — ' + po.po_number + ' is fully delivered.' : 'Delivery recorded. Outstanding parts remain on order.');
        } catch (e) {
          if (e && e.field_errors) {
            Object.keys(e.field_errors).forEach((k) => {
              const el = document.querySelector('.po-recv-err[data-err-for="' + k + '"]');
              if (el) el.textContent = e.field_errors[k];
            });
          }
          showError(e);
        }
      }
      else if (act === 'po-delete') {
        const po = await API.getPurchaseOrder(t.dataset.id);
        if (!confirm('Delete draft ' + po.po_number + ' for ' + po.supplier_name + '?')) return;
        await API.deletePurchaseOrder(po.id);
        pendingNotice = 'Draft ' + po.po_number + ' deleted.';
        location.hash = '#/orders';
      }
      else if (act === 'po-print') {
        window.print();
      }
      else if (act === 'po-track-filter') {
        trackFilter.state = t.dataset.state;
        document.querySelectorAll('.po-chip').forEach((c) => c.classList.toggle('active', c.dataset.state === trackFilter.state));
        const wrap = document.getElementById('po-track-wrap');
        if (wrap) wrap.innerHTML = trackTable(trackRows(cache.orders));
      }
      else if (act === 'po-open-new-modal') {
        await openNewPoModal();
      }
      else if (act === 'po-close-new-modal') {
        newPoDraft = null;
        h().removeExistingModal();
      }
      else if (act === 'po-add-draft-line') {
        syncDraftFromDom();
        const used = new Set(newPoDraft.lines.map((l) => l.part_id));
        const nextPart = (cache.parts.find((p) => !used.has(p.id)) || cache.parts[0] || { id: 'p1' }).id;
        newPoDraft.lines.push({
          part_id: nextPart,
          quantity: 1,
          unit_price_major: defaultOfferPriceMajor(nextPart, newPoDraft.supplier_id)
        });
        renderNewPoModal();
      }
      else if (act === 'po-remove-draft-line') {
        syncDraftFromDom();
        const idx = Number(t.dataset.idx);
        if (newPoDraft.lines.length > 1) newPoDraft.lines.splice(idx, 1);
        renderNewPoModal();
      }
      else if (act === 'po-submit-new-modal') {
        syncDraftFromDom();
        try {
          const payload = {
            supplier_id: newPoDraft.supplier_id,
            summary_title: newPoDraft.summary_title,
            expected_date: newPoDraft.expected_date,
            payment_terms: newPoDraft.payment_terms,
            courier: newPoDraft.courier,
            notes: newPoDraft.notes,
            lines: newPoDraft.lines.map((l) => ({
              part_id: l.part_id,
              quantity: Number(l.quantity),
              unit_price_minor: Math.round((parseFloat(l.unit_price_major) || 0) * 100)
            }))
          };
          const created = await API.createDirectPurchaseOrder(payload);
          newPoDraft = null;
          h().removeExistingModal();
          pendingNotice = 'Created draft purchase order ' + created.po_number + ' for ' + created.supplier_name + '.';
          location.hash = '#/orders/' + created.id;
        } catch (err) {
          renderNewPoModal(err.message || 'Could not create purchase order.');
        }
      }
    } catch (e) {
      t.disabled = false;
      showError(e);
    }
  }

  function onInput(ev) {
    if (!ctx) return;
    if (ev.target.id === 'po-search') {
      listFilter.q = ev.target.value;
      const wrap = document.getElementById('po-table-wrap');
      if (wrap) wrap.innerHTML = ordersTable(cache.orders);
    } else if (ev.target.id === 'po-track-search') {
      trackFilter.q = ev.target.value;
      const wrap = document.getElementById('po-track-wrap');
      if (wrap) wrap.innerHTML = trackTable(trackRows(cache.orders));
    }
  }

  function onChange(ev) {
    if (!ctx) return;
    if (ev.target.id === 'po-status-filter') {
      listFilter.status = ev.target.value;
      const wrap = document.getElementById('po-table-wrap');
      if (wrap) wrap.innerHTML = ordersTable(cache.orders);
    } else if (ev.target.id === 'npo-supplier' && newPoDraft) {
      syncDraftFromDom();
      newPoDraft.lines.forEach((ln) => {
        ln.unit_price_major = defaultOfferPriceMajor(ln.part_id, newPoDraft.supplier_id);
      });
      renderNewPoModal();
    } else if (ev.target.hasAttribute('data-npo-part') && newPoDraft) {
      const row = ev.target.closest('[data-npo-idx]');
      const idx = row ? Number(row.dataset.npoIdx) : -1;
      syncDraftFromDom();
      if (idx >= 0 && newPoDraft.lines[idx]) {
        newPoDraft.lines[idx].unit_price_major = defaultOfferPriceMajor(newPoDraft.lines[idx].part_id, newPoDraft.supplier_id);
      }
      renderNewPoModal();
    } else if ((ev.target.hasAttribute('data-npo-qty') || ev.target.hasAttribute('data-npo-price')) && newPoDraft) {
      syncDraftFromDom();
      renderNewPoModal();
    }
  }

  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);

  window.PC_ORDERS = {
    init: (c) => { ctx = c; },
    pageOrders,
    pageOrder,
    pageTracking,
    // Renders a compact PO panel for the sourcing summary detail page
    summaryPanelHtml: (summary, orders, esc_, money_, canCreate) => {
      const isApproved = summary.approval_status === 'APPROVED';
      const live = orders.filter((p) => p.status !== 'CANCELLED');
      let body;
      if (live.length) {
        body = '<div class="stack" style="gap:6px;">' + live.map((p) => '<a class="po-ready-row" href="#/orders/' + esc_(p.id) + '" style="text-decoration:none;color:inherit;">'
          + '<div><strong class="mono">' + esc_(p.po_number) + '</strong> <span class="small" style="color:var(--mute);">' + esc_(p.supplier_name) + '</span></div>'
          + '<div class="row" style="gap:8px;align-items:center;">' + statusBadge(p.status) + '<span class="mono" style="font-weight:700;">' + money_(p.subtotal_minor, p.currency) + '</span></div></a>').join('') + '</div>';
      } else if (isApproved && canCreate) {
        body = '<p class="small" style="color:var(--mute);margin:0 0 8px;">This job sheet is approved. Generate one purchase order per supplier from the frozen prices.</p>'
          + '<button type="button" class="btn primary" data-action="po-generate" data-id="' + esc_(summary.id) + '" data-title="' + esc_(summary.title) + '">🧾 Generate Purchase Orders</button>';
      } else if (!isApproved) {
        body = '<p class="small" style="color:var(--mute);margin:0;">Purchase orders can be generated after an Administrator approves this job sheet.</p>';
      } else {
        body = '<p class="small" style="color:var(--mute);margin:0;">No purchase orders yet.</p>';
      }
      return '<section class="card stack po-no-print" style="border-left:4px solid var(--teal);"><div class="row between" style="align-items:center;"><h2 style="margin:0;font-size:17px;">🧾 Purchase Orders & Delivery Tracking</h2><a class="btn btn-sm" href="#/orders">Open PO register</a></div>' + body + '</section>';
    },
  };
})();
