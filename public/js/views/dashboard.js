// The dashboard: one simple home screen of boxes (widgets), each in the colour of its part of the app: quick actions,
// today's closing (Day book), a small calendar of shoots and day book days, today's and upcoming shoots, the sales
// summary, booking reminders, recent bills, jobs at work and low stock. Customize turns the page into an editor: drag a
// box to move it, drag its corner (or pick a size) to make it wider, narrower, taller or shorter, hide or add boxes, and
// choose the quick actions and the summary's numbers. The choice is saved per login (shared/dashboard.js).
import { api } from '../lib/api.js';
import { html, setHtml, on } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { statusBadge, demoBadge, qtyUnit, stockBadge, openModal, toast, toastError, busy, loading } from '../lib/ui.js';
import { navigate, setLeaveGuard } from '../lib/router.js';
import { openProductForm } from '../components/product-form.js';
import { openCustomerForm } from '../components/customer-form.js';
import { bookingApi, statusBadge as bookingBadge, reminderItem } from '../components/booking-ui.js';
import { miniCalendar, monthRange, addMonths, shootsByDate, moneyByDate, calendarLegend } from '../components/mini-calendar.js';
import { isoDate, addDays, formatDate } from '/shared/format.js';
import { WORK_STAGES } from '/shared/tracking.js';
import { timeRange, eventTitle } from '/shared/bookings.js';
import {
  QUICK_ACTIONS, SUMMARY_STATS, MAX_ACTIONS, COLUMNS, MIN_WIDTH, WIDTHS,
  dashboardPrefs, widgetInfo, widthLabel, layoutSpans, cleanHeight,
} from '/shared/dashboard.js';

const PERIODS = [
  ['today', 'Today'],
  ['7d', 'Last 7 days'],
  ['month', 'This month'],
  ['year', 'This year'],
  ['all', 'All time'],
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function periodRange(period) {
  const today = isoDate();
  const [y, m] = today.split('-');
  switch (period) {
    case 'today': return { from: today, to: today };
    case '7d': return { from: addDays(today, -6), to: today };
    case 'year': return { from: `${y}-01-01`, to: today };
    case 'all': return { from: '', to: '' };
    default: return { from: `${y}-${m}-01`, to: today };
  }
}

// The grid's own width decides the layout (see layoutSpans): box sizes apply on a computer-sized screen.
const modeFor = (width) => (width >= 900 ? 'wide' : width >= 560 ? 'medium' : 'narrow');
const HINTS = {
  wide: 'Drag a box to move it. Drag its corner to make it wider, narrower, taller or shorter.',
  small: 'Drag a box by its handle to move it. Box sizes can be changed on a computer screen.',
};
const HEIGHT_STEP = 40;

let savedPeriod = 'month';

export default async function dashboard(el, { app }) {
  app.setTitle('Dashboard');
  const money = (v) => app.money(v);
  const today = isoDate();
  let prefs = dashboardPrefs(app.me.user.preferences?.dashboard);
  let draft = null; // While customizing: the changes, saved or dropped at the end.
  let period = savedPeriod;
  let data = {};
  let mode = 'wide';
  const spans = new Map(); // Columns each box took in the last layout.
  const cal = { month: today.slice(0, 7), day: today, shoots: new Map(), money: new Map(), seq: 0 };

  const current = () => draft || prefs;
  const canShow = (key) => key !== 'demo' || app.me.has_demo_data;
  const visible = () => current().widgets.filter((w) => w.show && canShow(w.key));
  const item = (key) => current().widgets.find((w) => w.key === key);
  const changed = () => !!draft && JSON.stringify(draft) !== JSON.stringify(prefs);

  /** Fetch only what the boxes on show need. */
  async function load() {
    const show = new Set(visible().map((w) => w.key));
    const stats = current().stats;
    const needDash = ['summary', 'work', 'bills', 'stock'].some((k) => show.has(k));
    const needBookings = show.has('shoots') || show.has('reminders') || (show.has('summary') && stats.includes('booking_due'));
    const [dash, overview, book] = await Promise.all([
      needDash ? api('/dashboard', { query: { ...periodRange(period), today } }) : null,
      needBookings ? bookingApi('/bookings/overview') : null,
      show.has('today') ? api('/day-book/days', { query: { from: today, to: today } }) : null,
    ]);
    data = { dash, overview, day: book?.days[0] };
    render();
    if (show.has('calendar')) loadCalendar();
  }

  async function loadCalendar() {
    const seq = ++cal.seq;
    const { from, to } = monthRange(cal.month);
    try {
      const [res, book] = await Promise.all([
        bookingApi('/bookings', { query: { from, to, limit: 1000 } }),
        api('/day-book/days', { query: { from, to } }),
      ]);
      if (seq !== cal.seq) return;
      cal.shoots = shootsByDate(res.bookings);
      cal.money = moneyByDate(book.days);
      renderCalendar();
    } catch (err) {
      if (seq === cal.seq) toastError(err);
    }
  }

  // ---- Boxes ---------------------------------------------------------------------------
  // Each box is its header and a body; with a set height the body scrolls inside the box.
  const card = (key, title, extra, body) => html`<div class="card-header">
      <h2 class="dash-h"><span class="dash-ic">${icon(widgetInfo(key).icon)}</span>${title}</h2>${extra}</div>
    <div class="dw-body">${body}</div>`;

  const WIDGETS = {
    demo: () => html`<div class="dw-body"><div class="alert alert-demo">${icon('info')}
      <div class="alert-body"><strong>Demo data is loaded.</strong> Products, customers, bills and bookings marked
        <span class="badge badge-demo">Demo</span> are samples. Remove them from <a href="/settings#demo">Settings</a>,
        or hide this note with Customize.</div></div></div>`,

    actions: () => {
      const list = current().actions.map((k) => QUICK_ACTIONS.find((a) => a.key === k)).filter(Boolean);
      const n = list.length;
      // Columns on a narrower box: 4 → 2 × 2, 5 or 6 → 3 a row.
      const mid = n <= 3 ? n : n === 4 ? 2 : 3;
      const inner = (a) => html`<span class="qa-icon">${icon(a.icon)}</span><span><div class="qa-title">${a.label}</div><div class="qa-sub">${a.sub}</div></span>`;
      return html`<div class="dw-body"><div class="quick-actions dash-actions" style="--n:${n};--qa-m:${mid};--qa-s:${n <= 4 ? n : 3}">${list.map((a) => (a.href
        ? html`<a class="quick-action area-${a.area}" href="${a.href}">${inner(a)}</a>`
        : html`<button type="button" class="quick-action area-${a.area}" data-action="${a.action}">${inner(a)}</button>`))}</div></div>`;
    },

    today: () => {
      const d = data.day;
      if (!d) return '';
      const received = d.received_cash + d.received_online;
      const spent = d.spent_cash + d.spent_online;
      const net = d.received_cash - d.spent_cash;
      return card('today', 'Today', html`<a href="/day-book">Open day book</a>`, html`
        <div class="closing-grid">
          <div class="cl"><div class="cl-label">Sales</div><div class="cl-value">${money(d.sales)}</div>
            <div class="cl-sub">${d.bills} bill${d.bills === 1 ? '' : 's'}${d.sales_added ? ` + ${money(d.sales_added)} without a bill` : ''}</div></div>
          <div class="cl"><div class="cl-label">Money received</div><div class="cl-value text-good">${money(received)}</div>
            <div class="cl-sub">Cash ${money(d.received_cash)} · Online ${money(d.received_online)}</div></div>
          <div class="cl"><div class="cl-label">Expenses</div><div class="cl-value text-bad">${money(spent)}</div>
            <div class="cl-sub">Cash ${money(d.spent_cash)} · Online ${money(d.spent_online)}</div></div>
          <div class="cl cl-net"><div class="cl-label">Net cash</div><div class="cl-value ${net < 0 ? 'text-bad' : ''}">${money(net)}</div>
            <div class="cl-sub">Cash in − cash out</div></div>
        </div>`);
    },

    calendar: () => card('calendar', 'Calendar', html`<a href="/bookings?view=calendar">Full calendar</a>`,
      html`<div class="card-body dash-cal" data-dash-cal>${loading()}</div>`),

    shoots: () => {
      const o = data.overview;
      if (!o) return '';
      const rows = [...o.today_shoots, ...o.upcoming_shoots].slice(0, 6);
      return card('shoots', 'Shoots', html`<a href="/bookings">Bookings &amp; Shoots</a>`, rows.length ? html`<div class="dash-list">${rows.map((b) => {
        const d = b.day;
        const [, m, dd] = d.date.split('-');
        const when = [d.date === today ? 'Today' : '', timeRange(d), d.venue].filter(Boolean).join(' · ');
        return html`<a class="dash-row" href="/bookings/${b.id}">
          <span class="bk-cal-date"><b>${dd}</b>${MONTHS[Number(m) - 1]}</span>
          <span class="dash-row-main"><b>${b.client_name}</b><span class="muted small">${eventTitle(b)}</span>
            ${when ? html`<span class="small dash-when">${when}</span>` : ''}</span>
          ${bookingBadge(b.status)}</a>`;
      })}</div>` : html`<p class="muted dash-none">No shoots coming up. <a href="/bookings/new">New booking</a></p>`);
    },

    reminders: () => {
      const o = data.overview;
      if (!o) return '';
      const list = o.reminders.slice(0, 6);
      return card('reminders', 'Reminders', html`<a href="/bookings">See all</a>`, list.length
        ? html`<div class="bk-rems">${list.map((r) => reminderItem(r, money))}</div>`
        : html`<p class="muted dash-none">Nothing needs attention right now.</p>`);
    },

    summary: () => {
      const d = data.dash;
      if (!d) return '';
      const label = PERIODS.find(([k]) => k === period)[1].toLowerCase();
      const stat = (href, ic, title, value, sub) => html`<a class="stat" href="${href}">
        <div class="stat-label"><span class="stat-icon">${icon(ic)}</span>${title}</div>
        <div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></a>`;
      const STATS = {
        sales: () => stat('/reports', 'trending', 'Total sales', money(d.sales.total + d.sales.added),
          `${d.sales.count} bill${d.sales.count === 1 ? '' : 's'}${d.sales.added ? ` + ${money(d.sales.added)} without a bill` : ''} · ${label}`),
        paid: () => stat('/bills?payment=paid', 'checkCircle', 'Paid bills', d.paid.count, `${money(d.paid.amount)} received in full`),
        unpaid: () => stat('/bills?payment=due', 'clock', 'Unpaid bills', d.unpaid.count,
          `${money(d.unpaid.amount)} to collect${d.unpaid.partial_count ? ` · ${d.unpaid.partial_count} with advance` : ''}`),
        booking_due: () => (data.overview
          ? stat('/bookings?quick=payment', 'camera', 'Due on bookings', money(data.overview.summary.due),
            `${data.overview.summary.payment} booking${data.overview.summary.payment === 1 ? '' : 's'}`)
          : ''),
        stock_value: () => stat('/products?sort=value', 'box', 'Inventory value', money(d.inventory.cost_value),
          `At cost · ${money(d.inventory.retail_value)} at selling price`),
      };
      const stats = current().stats;
      return card('summary', 'Sales summary', html`<div class="segmented" role="tablist" aria-label="Period">
          ${PERIODS.map(([k, text]) => html`<button type="button" data-period="${k}" class="${k === period ? 'active' : ''}">${text}</button>`)}</div>`,
      html`<div class="dash-stats" style="--n:${stats.length};--m:${Math.min(stats.length, 2)}">${stats.map((k) => STATS[k]())}</div>`);
    },

    bills: () => {
      const d = data.dash;
      if (!d) return '';
      return card('bills', 'Recent bills', html`<a href="/bills">All bills</a>`, d.recent_bills.length
        ? html`<div class="dash-list">${d.recent_bills.map((b) => html`<a class="dash-row" href="/bills/${b.id}">
            <span class="dash-row-main"><b>${b.invoice_no || `Draft #${b.id}`} ${demoBadge(b.is_demo)}</b>
              <span class="muted small">${b.customer_name || 'Walk-in customer'} · ${formatDate(b.bill_date)}</span></span>
            <span class="dash-row-side"><span class="strong">${money(b.total)}</span>${statusBadge(b)}</span></a>`)}</div>`
        : html`<p class="muted dash-none">No bills yet. <a href="/bills/new">Create a bill</a></p>`);
    },

    work: () => {
      const d = data.dash;
      if (!d) return '';
      const total = WORK_STAGES.reduce((a, s) => a + d.work[s.key], 0);
      return card('work', 'Jobs at work', html`<a href="/tracking">Tracking</a>`, html`<div class="card-body">${total
        ? html`<div class="dash-work">${WORK_STAGES.map((s) => html`<a class="ws-chip" href="/tracking">${s.label}<b>${d.work[s.key]}</b></a>`)}</div>`
        : html`<span class="muted">No jobs are being tracked.</span>`}</div>`);
    },

    stock: () => {
      const d = data.dash;
      if (!d) return '';
      const low = d.low_stock;
      return card('stock', 'Low stock', low.count ? html`<span class="badge badge-low">${low.count}</span>` : '', low.count
        ? html`<ul class="list">${low.items.map((p) => html`<li><a class="list-item" href="/products/${p.id}">
            <div class="li-main"><div class="li-title">${p.name} ${demoBadge(p.is_demo)}</div><div class="li-sub">Alert at ${qtyUnit(p.low_stock_threshold, p.unit)}</div></div>
            <div class="right"><div class="strong ${p.quantity <= 0 ? 'text-bad' : 'text-warn'}">${qtyUnit(p.quantity, p.unit)}</div>${stockBadge(p)}</div></a></li>`)}</ul>
          ${low.count > low.items.length ? html`<div class="card-footer"><a href="/products?status=low">View all ${low.count}</a></div>` : ''}`
        : html`<p class="muted dash-none">All stocked up.</p>`);
    },
  };

  function widget(w) {
    const info = widgetInfo(w.key);
    const body = WIDGETS[w.key]();
    if (!body && !draft) return '';
    const plain = w.key === 'demo' || w.key === 'actions';
    return html`<section class="dw ${plain ? 'dash-plain' : 'card dash-card'} area-${info.area}" data-widget="${w.key}">
      ${body || html`<div class="dw-body">${loading()}</div>`}${draft ? editTools(info) : ''}</section>`;
  }

  function render() {
    const boxes = visible();
    setHtml(el, html`
      ${draft ? editBar() : html`<div class="page-header">
        <div><h1>Dashboard</h1><div class="subtitle">Welcome back, ${app.me.user.name.split(' ')[0]}. Here’s ${app.business.name} at a glance.</div></div>
        <div class="page-actions"><button type="button" class="btn" data-action="customize">${icon('settings')}Customize</button></div>
      </div>`}
      ${boxes.length ? html`<div class="dash-grid ${draft ? 'is-editing' : ''}" data-grid>${boxes.map(widget)}</div>`
        : html`<div class="card"><div class="empty">${icon('dashboard')}<h3>Your dashboard is empty</h3>
          ${draft ? html`<p>Use <strong>Add a box</strong> above to put something back.</p>` : html`<p>Everything is hidden. Choose what to show.</p>
          <button type="button" class="btn btn-primary" data-action="customize">${icon('settings')}Customize</button>`}</div></div>`}`);
    layout();
    renderCalendar();
  }

  /** Set each box's columns (and, on a computer, its height) for the grid's current width. */
  function layout() {
    const grid = el.querySelector('[data-grid]');
    if (!grid) return;
    mode = modeFor(grid.clientWidth);
    grid.dataset.mode = mode;
    const boxes = [...grid.children];
    const items = boxes.map((b) => item(b.dataset.widget));
    layoutSpans(items, mode).forEach((span, i) => {
      const box = boxes[i];
      const h = mode === 'wide' ? items[i].h : null;
      spans.set(items[i].key, span);
      box.style.setProperty('--span', span);
      box.classList.toggle('has-h', !!h);
      if (h) box.style.setProperty('--h', `${h}px`);
      else box.style.removeProperty('--h');
      const size = box.querySelector('[data-size]');
      if (size) size.textContent = mode === 'wide' ? `${widthLabel(span)}${items[i].h ? ` · ${items[i].h} px` : ''}` : '';
    });
    const hint = el.querySelector('[data-ed-hint]');
    if (hint) hint.textContent = HINTS[mode === 'wide' ? 'wide' : 'small'];
  }

  function renderCalendar() {
    const box = el.querySelector('[data-dash-cal]');
    if (!box) return;
    const list = cal.shoots.get(cal.day) || [];
    const day = cal.money.get(cal.day);
    // Shoots only: the green Day book dots stay on the Day book's own calendar.
    setHtml(box, html`${miniCalendar({ month: cal.month, selected: cal.day, today, shoots: cal.shoots })}${calendarLegend({ money: false })}
      <div class="mc-list">
        <div class="mc-list-head"><span class="label">${cal.day === today ? 'Today' : formatDate(cal.day)}</span>
          <a class="inline-link small mc-new" href="/bookings/new?date=${cal.day}">${icon('plus', 'sm')}New booking</a></div>
        ${list.map(({ b, day: d }) => html`<a class="mc-shoot" href="/bookings/${b.id}">
          <span class="mc-time">${timeRange(d) || 'All day'}</span>
          <span class="mc-main"><b>${b.client_name}</b><span class="muted small">${[eventTitle(b), d.venue].filter(Boolean).join(' · ')}</span></span>
          ${bookingBadge(b.status)}</a>`)}
        ${cal.day <= today ? html`<a class="mc-money" href="/day-book${cal.day === today ? '' : `?date=${cal.day}`}"><span>Day book</span>
          <span>${day ? html`In <b>${money(day.money_in)}</b> · Out ${money(day.money_out)}` : html`<span class="muted">Nothing yet</span>`}</span></a>`
          : !list.length ? html`<p class="muted small dash-none">No shoots booked.</p>` : ''}
      </div>`);
  }

  // ---- Customize: move, size, hide and add boxes right on the dashboard -------------------
  function editBar() {
    const hidden = current().widgets.filter((w) => !w.show && canShow(w.key));
    return html`<div class="page-header dash-editbar">
      <div><h1>Customize dashboard</h1><div class="subtitle" data-ed-hint>${HINTS.wide}</div></div>
      <div class="page-actions">
        <details class="menu dw-add"><summary class="btn">${icon('plus')}Add a box${hidden.length ? ` (${hidden.length})` : ''}</summary>
          <div class="menu-items">${hidden.length ? hidden.map((w) => {
            const info = widgetInfo(w.key);
            return html`<button type="button" class="area-${info.area}" data-add="${w.key}"><span class="dash-ic">${icon(info.icon)}</span>${info.label}</button>`;
          }) : html`<p class="dw-pop-note">Every box is already on your dashboard.</p>`}</div></details>
        <button type="button" class="btn btn-ghost" data-ed="reset" title="Back to default" aria-label="Back to default">${icon('refresh')}<span class="ed-wide">Back to default</span></button>
        <button type="button" class="btn" data-ed="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" data-ed="save">${icon('check')}Save</button>
      </div></div>`;
  }

  const editTools = (info) => html`<div class="dw-tools">
      <button type="button" class="dw-grip" data-drag title="Drag to move" aria-label="Move ${info.label}: drag it, or use the arrow keys">${icon('grip')}</button>
      <span class="dw-name">${info.label}</span><span class="dw-size" data-size></span>
      <details class="menu dw-menu"><summary class="btn btn-ghost btn-icon btn-sm" title="Size and more" aria-label="Size and more for ${info.label}">${icon('more')}</summary>
        <div class="menu-items dw-pop" data-pop></div></details>
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-hide title="Hide this box" aria-label="Hide ${info.label}">${icon('eyeOff')}</button>
    </div>
    <span class="dw-resize" data-resize title="Drag to change the size · double-click for the usual size">${icon('resize')}</span>`;

  /** What a box's menu offers: its width and height (on a computer), its own choices, and moving it. */
  function sizeMenu(w) {
    return html`${mode === 'wide' ? html`
        <div class="dw-pop-label">Width</div>
        <div class="dw-pop-row">
          <button type="button" data-set-w="auto" class="${w.w == null ? 'active' : ''}" title="Half the width, and fills its row">Auto</button>
          ${WIDTHS.map(([n, label]) => html`<button type="button" data-set-w="${n}" class="${w.w === n ? 'active' : ''}">${label}</button>`)}</div>
        <div class="dw-pop-label">Height</div>
        <div class="dw-pop-row">
          <button type="button" data-set-h="auto" class="${w.h == null ? 'active' : ''}" title="As tall as what's in it">Fit</button>
          <button type="button" data-step-h="-1">${icon('minus', 'sm')}Shorter</button>
          <button type="button" data-step-h="1">${icon('plus', 'sm')}Taller</button></div>`
      : html`<p class="dw-pop-note">Box sizes can be changed on a computer screen. Here every box fits the screen.</p>`}
      <hr>
      ${w.key === 'actions' ? html`<button type="button" data-pick="actions">${icon('plus', 'sm')}Choose quick actions</button>` : ''}
      ${w.key === 'summary' ? html`<button type="button" data-pick="stats">${icon('trending', 'sm')}Choose the numbers</button>` : ''}
      <button type="button" data-move="-1">${icon('arrowLeft', 'sm')}Move earlier</button>
      <button type="button" data-move="1">${icon('arrowRight', 'sm')}Move later</button>`;
  }

  function startEditing() {
    draft = dashboardPrefs(JSON.parse(JSON.stringify(prefs)));
    setLeaveGuard((opts) => !changed() || (!opts?.silent && window.confirm('Leave without saving your dashboard changes?')));
    render();
  }

  function stopEditing() {
    draft = null;
    setLeaveGuard(null);
  }

  const closeMenus = (except) => el.querySelectorAll('details.menu[open]').forEach((d) => d !== except && d.removeAttribute('open'));
  const boxOf = (target) => target.closest('.dash-grid > [data-widget]');

  /** Put the boxes' new order (as they are on screen) into the draft; hidden ones keep their places. */
  function syncOrder(grid) {
    const order = [...grid.children].map((b) => b.dataset.widget);
    const list = draft.widgets;
    const slots = list.flatMap((w, i) => (order.includes(w.key) ? [i] : []));
    const moved = order.map((k) => list.find((w) => w.key === k));
    slots.forEach((slot, n) => {
      list[slot] = moved[n];
    });
  }

  /** Move a box one place earlier or later (keyboard and menu). */
  function moveBox(key, dir) {
    const grid = el.querySelector('[data-grid]');
    const box = grid.querySelector(`[data-widget="${key}"]`);
    const other = dir < 0 ? box.previousElementSibling : box.nextElementSibling;
    if (!other) return;
    flip(grid, null, () => {
      grid.insertBefore(box, dir < 0 ? other : other.nextElementSibling);
      syncOrder(grid);
      layout();
    });
    box.querySelector('[data-drag]').focus();
  }

  /** Follow one pointer until it's let go: onMove(event) on every move, onEnd() at the end. */
  function track(e, box, onMove, onEnd) {
    try {
      box.setPointerCapture(e.pointerId);
    } catch {
      // Without capture the window still hears the pointer.
    }
    const move = (ev) => {
      if (ev.pointerId === e.pointerId) onMove(ev);
    };
    const end = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      onEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  /** Slide boxes from where they were to where they are now, so a change of place is easy to follow. */
  function flip(grid, except, change) {
    const boxes = [...grid.children].filter((b) => b !== except);
    const before = new Map(boxes.map((b) => [b, b.getBoundingClientRect()]));
    change();
    const moved = boxes.filter((b) => {
      const was = before.get(b);
      const now = b.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return false;
      b.style.transition = 'none';
      b.style.transform = `translate(${dx}px, ${dy}px)`;
      return true;
    });
    if (!moved.length) return;
    grid.getBoundingClientRect(); // Start from the old places, then let the transition take them home.
    for (const b of moved) {
      b.style.transition = '';
      b.style.transform = '';
    }
  }

  /** Drag a box to a new place: it follows the pointer and the others make room as it passes over them. */
  function startDrag(e, box) {
    const grid = box.parentElement;
    const r = box.getBoundingClientRect();
    const grab = { x: e.clientX - r.left, y: e.clientY - r.top };
    const start = { x: e.clientX, y: e.clientY };
    let point = start;
    let dragging = false;
    let raf = 0;

    const follow = () => {
      const g = grid.getBoundingClientRect();
      const x = point.x - g.left - Math.min(grab.x, box.offsetWidth - 20) - box.offsetLeft;
      const y = point.y - g.top - Math.min(grab.y, box.offsetHeight - 20) - box.offsetTop;
      box.style.transform = `translate(${x}px, ${y}px)`;
    };
    const reorder = () => {
      const target = [...grid.children].find((b) => {
        if (b === box) return false;
        const t = b.getBoundingClientRect();
        return point.x >= t.left && point.x <= t.right && point.y >= t.top && point.y <= t.bottom;
      });
      if (!target) return;
      const t = target.getBoundingClientRect();
      const before = spans.get(target.dataset.widget) === COLUMNS ? point.y < t.top + t.height / 2 : point.x < t.left + t.width / 2;
      const ref = before ? target : target.nextElementSibling;
      if (ref === box || box.nextElementSibling === ref) return;
      flip(grid, box, () => {
        grid.insertBefore(box, ref);
        syncOrder(grid);
        layout();
      });
      follow();
    };
    // Near the top or bottom of the screen the page scrolls, so a box can go anywhere.
    const scroll = () => {
      const edge = 90;
      const speed = point.y < edge ? -(edge - point.y) / 5 : point.y > innerHeight - edge ? (point.y - innerHeight + edge) / 5 : 0;
      if (dragging && speed) {
        window.scrollBy(0, speed);
        follow();
        reorder();
      }
      raf = requestAnimationFrame(scroll);
    };
    track(e, box, (ev) => {
      point = { x: ev.clientX, y: ev.clientY };
      if (!dragging) {
        if (Math.hypot(point.x - start.x, point.y - start.y) < 5) return;
        dragging = true;
        closeMenus();
        box.classList.add('is-dragging');
        grid.classList.add('is-sorting');
        raf = requestAnimationFrame(scroll);
      }
      follow();
      reorder();
    }, () => {
      cancelAnimationFrame(raf);
      if (!dragging) return;
      box.classList.remove('is-dragging');
      grid.classList.remove('is-sorting');
      box.style.transform = '';
    });
  }

  /** Drag a box's corner: its width snaps to the grid's columns and its height to steps of 20 px. */
  function startResize(e, box) {
    e.preventDefault();
    const grid = box.parentElement;
    const w = item(box.dataset.widget);
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 16;
    const col = (grid.clientWidth - gap * (COLUMNS - 1)) / COLUMNS;
    const start = { x: e.clientX, y: e.clientY, width: box.offsetWidth, height: box.offsetHeight, span: spans.get(w.key), w: w.w, h: w.h };
    let tall = start.h != null;
    box.classList.add('is-resizing');
    closeMenus();

    track(e, box, (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      const span = Math.min(COLUMNS, Math.max(MIN_WIDTH, Math.round((start.width + dx + gap) / (col + gap))));
      // Back at the width it had, a box without a set width keeps filling its row.
      w.w = span === start.span ? start.w : span;
      if (Math.abs(dy) >= 6) tall = true;
      if (tall) w.h = cleanHeight(start.height + dy);
      layout();
    }, () => box.classList.remove('is-resizing'));
  }

  /** Tick from a list (quick actions, summary numbers), in the list's own order, with at least one and at most max. */
  function chooseFrom({ title, hint, options, selected, max }) {
    return new Promise((resolve) => {
      let result = null;
      const modal = openModal({
        title,
        size: 'sm',
        body: html`<p class="muted small" style="margin-top:0">${hint}</p>
          <div class="cz-chips">${options.map((o) => html`<label class="check"><input type="checkbox" value="${o.key}" ${selected.includes(o.key) ? 'checked' : ''}>${o.label}</label>`)}</div>`,
        footer: html`<button type="button" class="btn" data-close>Cancel</button>
          <button type="button" class="btn btn-primary" data-ok>${icon('check')}Done</button>`,
        onClose: () => resolve(result),
      });
      const boxes = [...modal.el.querySelectorAll('input[type=checkbox]')];
      modal.el.addEventListener('change', (e) => {
        if (boxes.filter((b) => b.checked).length > max) {
          e.target.checked = false;
          toast(`Up to ${max}.`, 'info');
        }
      });
      modal.el.querySelector('[data-ok]').addEventListener('click', () => {
        const keys = boxes.filter((b) => b.checked).map((b) => b.value);
        if (!keys.length) {
          toast('Tick at least one.', 'info');
          return;
        }
        result = keys;
        modal.close();
      });
    });
  }

  // ---- Events --------------------------------------------------------------------------
  on(el, 'click', '[data-period]', async (e, b) => {
    period = b.dataset.period;
    savedPeriod = period;
    el.querySelector('[data-widget=summary]')?.style.setProperty('opacity', '0.6');
    try {
      data.dash = await api('/dashboard', { query: { ...periodRange(period), today } });
      render();
    } catch (err) {
      toastError(err);
    }
  });
  on(el, 'click', '[data-action=customize]', () => startEditing());
  on(el, 'click', '[data-action=add-product]', async () => {
    if (await openProductForm(app)) load();
  });
  on(el, 'click', '[data-action=add-customer]', async () => {
    const c = await openCustomerForm();
    if (c) navigate(`/customers/${c.id}`);
  });
  on(el, 'click', '[data-mc-day]', (e, b) => {
    cal.day = b.dataset.mcDay;
    if (cal.day.slice(0, 7) !== cal.month) {
      cal.month = cal.day.slice(0, 7);
      loadCalendar();
    }
    renderCalendar();
  });
  on(el, 'click', '[data-mc-step]', (e, b) => {
    cal.month = addMonths(cal.month, Number(b.dataset.mcStep));
    // The month shown is the one fetched, so its first day (or today) is the day shown underneath.
    cal.day = cal.month === today.slice(0, 7) ? today : `${cal.month}-01`;
    loadCalendar();
  });

  // Customizing: a mouse can drag a box from anywhere on it; a finger uses the handle, so the page still scrolls.
  el.addEventListener('pointerdown', (e) => {
    if (!draft || e.button !== 0) return;
    const box = boxOf(e.target);
    if (!box) return;
    if (e.target.closest('[data-resize]')) {
      startResize(e, box);
    } else if (e.target.closest('[data-drag]') || (e.pointerType === 'mouse' && !e.target.closest('.dw-tools'))) {
      if (e.pointerType === 'mouse') e.preventDefault();
      startDrag(e, box);
    }
  });
  on(el, 'dblclick', '[data-resize]', (e, handle) => {
    const w = item(boxOf(handle).dataset.widget);
    w.w = null;
    w.h = null;
    layout();
  });
  on(el, 'keydown', '[data-drag]', (e, grip) => {
    const dir = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    moveBox(boxOf(grip).dataset.widget, dir);
  });
  // A box's menu is filled when it opens, so it shows the box's size as it is now.
  el.addEventListener('toggle', (e) => {
    const menu = e.target;
    if (!menu.matches?.('details.menu')) return;
    boxOf(menu)?.classList.toggle('menu-open', menu.open);
    if (!menu.open) return;
    closeMenus(menu);
    const pop = menu.querySelector('[data-pop]');
    if (pop) setHtml(pop, sizeMenu(item(boxOf(menu).dataset.widget)));
    // Keep the menu on screen: moved sideways when it would run off an edge.
    const list = menu.querySelector('.menu-items');
    list.style.left = '';
    list.style.right = '';
    const r = list.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, document.documentElement.clientWidth - 8 - r.width));
    if (Math.abs(left - r.left) > 0.5) {
      list.style.left = `${left - list.offsetParent.getBoundingClientRect().left}px`;
      list.style.right = 'auto';
    }
  }, true);
  // The path is the one at the click, as a menu may have redrawn the button that was clicked.
  const outside = (e) => {
    if (!e.composedPath().some((n) => n instanceof Element && n.matches('details.menu'))) closeMenus();
  };
  document.addEventListener('click', outside);

  on(el, 'click', '[data-hide]', (e, b) => {
    item(boxOf(b).dataset.widget).show = false;
    render();
  });
  on(el, 'click', '[data-add]', async (e, b) => {
    const list = draft.widgets;
    const w = list.splice(list.findIndex((x) => x.key === b.dataset.add), 1)[0];
    w.show = true;
    list.push(w);
    try {
      await load();
      el.querySelector(`[data-widget="${w.key}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (err) {
      toastError(err);
    }
  });
  on(el, 'click', '[data-set-w]', (e, b) => {
    const w = item(boxOf(b).dataset.widget);
    w.w = b.dataset.setW === 'auto' ? null : Number(b.dataset.setW);
    layout();
    setHtml(b.closest('[data-pop]'), sizeMenu(w));
  });
  on(el, 'click', '[data-set-h]', (e, b) => {
    const w = item(boxOf(b).dataset.widget);
    w.h = null;
    layout();
    setHtml(b.closest('[data-pop]'), sizeMenu(w));
  });
  on(el, 'click', '[data-step-h]', (e, b) => {
    const box = boxOf(b);
    const w = item(box.dataset.widget);
    w.h = cleanHeight((w.h ?? box.offsetHeight) + Number(b.dataset.stepH) * HEIGHT_STEP);
    layout();
    setHtml(b.closest('[data-pop]'), sizeMenu(w));
  });
  on(el, 'click', '[data-move]', (e, b) => {
    const key = boxOf(b).dataset.widget;
    closeMenus();
    moveBox(key, Number(b.dataset.move));
  });
  on(el, 'click', '[data-pick]', async (e, b) => {
    closeMenus();
    const actions = b.dataset.pick === 'actions';
    const keys = await chooseFrom(actions
      ? { title: 'Quick actions', hint: `Tick the buttons you want, up to ${MAX_ACTIONS}.`, options: QUICK_ACTIONS, selected: draft.actions, max: MAX_ACTIONS }
      : { title: 'Numbers in the sales summary', hint: 'Tick the numbers to show.', options: SUMMARY_STATS, selected: draft.stats, max: SUMMARY_STATS.length });
    if (!keys || !draft) return;
    if (actions) draft.actions = keys;
    else draft.stats = keys;
    await load();
  });
  on(el, 'click', '[data-ed]', async (e, b) => {
    const what = b.dataset.ed;
    if (what === 'reset') {
      draft = dashboardPrefs({});
      await load();
    } else if (what === 'cancel') {
      stopEditing();
      await load();
    } else if (what === 'save') {
      await busy(b, async () => {
        try {
          const me = await api('/auth/preferences', { method: 'PUT', body: { dashboard: draft } });
          app.setMe(me);
          prefs = dashboardPrefs(me.user.preferences.dashboard);
          stopEditing();
          toast('Dashboard saved.');
          await load();
        } catch (err) {
          toastError(err);
        }
      });
    }
  });

  // The layout follows the screen's width (a phone turned sideways, a window made smaller).
  let width = 0;
  const resized = new ResizeObserver(() => {
    if (el.clientWidth === width) return;
    width = el.clientWidth;
    layout();
  });
  resized.observe(el);

  await load();
  return () => {
    resized.disconnect();
    document.removeEventListener('click', outside);
    if (draft) setLeaveGuard(null);
  };
}
