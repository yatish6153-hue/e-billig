// Bookings & Shoots, three views on one page (/bookings?view=…):
// - Overview: summary cards, quick filters, today's and upcoming shoots, and reminders.
// - List: every booking with search and filters (date, event type, status, payment, delivery, team member).
// - Calendar: month, week or day; tap a booking to open it.
import { api, buildQuery } from '../lib/api.js';
import { html, setHtml, on, onDateCommit, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toastError, demoBadge, loading } from '../lib/ui.js';
import { navigate } from '../lib/router.js';
import { formatDate, isoDate, addDays } from '/shared/format.js';
import {
  QUICK_FILTERS, BOOKING_STATUSES, BOOKING_PAYMENT_LABELS, DELIVERY_STATES, CALENDAR_TONES, timeRange, formatTime, eventTitle,
  weekStart, shootDone,
} from '/shared/bookings.js';
import {
  bookingApi, statusBadge, shootBadge, deliveryBadge, teamLine, reminderItem, openTeamManager, openBookingPayment, openLinkForm,
  markShootDone, deleteBookingFlow,
} from '../components/booking-ui.js';

const VIEWS = [['overview', 'Overview', 'dashboard'], ['list', 'List', 'list'], ['calendar', 'Calendar', 'calendar']];
const DATE_OPTIONS = [
  ['', 'All dates'], ['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['next30', 'Next 30 days'],
  ['past', 'Past'], ['pick', 'Choose dates…'],
];
const MODES = [['month', 'Month'], ['week', 'Week'], ['day', 'Day']];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FILTER_KEYS = ['q', 'quick', 'date', 'from', 'to', 'type', 'status', 'payment', 'delivery', 'member'];
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** Event dates for a date option ("pick" uses the chosen from / to). */
function dateRange(option, from, to) {
  const today = isoDate();
  const [y, m] = today.split('-').map(Number);
  switch (option) {
    case 'today': return { from: today, to: today };
    case 'week': return { from: weekStart(today), to: addDays(weekStart(today), 6) };
    case 'month': return { from: `${today.slice(0, 8)}01`, to: isoDate(new Date(y, m, 0)) };
    case 'next30': return { from: today, to: addDays(today, 30) };
    case 'past': return { to: addDays(today, -1) };
    case 'pick': return { from, to };
    default: return {};
  }
}

function addMonths(day, n) {
  const [y, m] = day.split('-').map(Number);
  return isoDate(new Date(y, m - 1 + n, 1));
}

/** "Hotel Clarks Amer +1": the venues of a booking's dates. */
function venuesText(b) {
  const venues = [...new Set(b.schedule.map((d) => d.venue).filter(Boolean))];
  return venues.length ? `${venues[0]}${venues.length > 1 ? ` +${venues.length - 1}` : ''}` : '';
}

/** "Ravi, Karan +2" */
function teamShort(team) {
  if (!team.length) return html`<span class="muted">—</span>`;
  const names = team.map((t) => t.name.split(' ')[0]);
  return html`<span title="${team.map((t) => `${t.name}${t.role ? ` (${t.role})` : ''}`).join(', ')}">${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}</span>`;
}

export default async function bookings(el, { app, query }) {
  app.setTitle('Bookings & Shoots');
  const money = (v) => app.money(v);
  const currency = app.business.currency;
  const state = {
    view: VIEWS.some(([k]) => k === query.view) ? query.view : 'overview',
    mode: MODES.some(([k]) => k === query.mode) ? query.mode : 'month',
    day: isDay(query.day) ? query.day : isoDate(),
  };
  for (const k of FILTER_KEYS) state[k] = String(query[k] || '');
  // A filter from a link (a summary card, quick filter) opens the list.
  if (query.view === undefined && FILTER_KEYS.some((k) => state[k])) state.view = 'list';
  let list = null;
  let members = null;
  let quickCounts = null;
  let seq = 0;

  setHtml(el, html`
    <div class="page-header">
      <div><h1>Bookings &amp; Shoots</h1><div class="subtitle">Weddings, birthdays, events and shoots, from the booking to the final delivery.</div></div>
      <div class="page-actions">
        <button type="button" class="btn" data-action="team">${icon('users')}Team</button>
        <a class="btn btn-primary" href="/bookings/new">${icon('plus')}New booking</a>
      </div>
    </div>
    <div class="bk-bar">
      <div class="segmented" role="tablist" aria-label="View">${VIEWS.map(([k, label, ic]) => html`
        <button type="button" role="tab" data-view="${k}" class="${k === state.view ? 'active' : ''}" aria-selected="${k === state.view}">${icon(ic, 'sm')}${label}</button>`)}</div>
      <div class="input-group bk-search">${icon('search')}
        <input class="input" type="search" data-search value="${state.q}" placeholder="Search client, phone, booking ID, event or venue" aria-label="Search bookings"></div>
    </div>
    <div data-body>${loading()}</div>`);
  const body = el.querySelector('[data-body]');

  function syncUrl() {
    const q = { view: state.view === 'overview' ? '' : state.view };
    if (state.view === 'list') for (const k of FILTER_KEYS) q[k] = state[k];
    if (state.view === 'calendar') Object.assign(q, { mode: state.mode === 'month' ? '' : state.mode, day: state.day === isoDate() ? '' : state.day });
    history.replaceState(null, '', `/bookings${buildQuery(q)}`);
  }

  async function load() {
    const mySeq = ++seq;
    body.style.opacity = '0.6';
    try {
      if (state.view === 'overview') {
        const d = await bookingApi('/bookings/overview');
        if (mySeq !== seq) return;
        quickCounts = d.quick;
        renderOverview(d);
      } else if (state.view === 'list') {
        const [res, team, overview] = await Promise.all([
          bookingApi('/bookings', { query: { ...listQuery(), limit: 500 } }),
          members ? null : api('/team'),
          quickCounts ? null : bookingApi('/bookings/overview'),
        ]);
        if (mySeq !== seq) return;
        if (team) members = team.members;
        if (overview) quickCounts = overview.quick;
        list = res;
        renderList();
      } else {
        const { from, to } = calendarRange();
        const res = await bookingApi('/bookings', { query: { from, to, limit: 1000 } });
        if (mySeq !== seq) return;
        renderCalendar(res.bookings, from, to);
      }
      syncUrl();
    } catch (err) {
      if (mySeq === seq) toastError(err);
    } finally {
      if (mySeq === seq) body.style.opacity = '';
    }
  }

  // ---- Overview ------------------------------------------------------------------
  /** A shoot on one of its dates (`day`: today's, the next one, or the calendar's), with that date's time and venue. */
  function shootItem(b, day = b.day || b.schedule[0]) {
    const [, m, d] = day.date.split('-');
    const n = b.schedule.length;
    const which = b.schedule.findIndex((x) => x.date === day.date && x.start === day.start) + 1;
    return html`<a class="bk-shoot bk-tone-${b.tone}" href="/bookings/${b.id}">
      <span class="bk-cal-date"><b>${d}</b>${MONTHS[Number(m) - 1].slice(0, 3)}</span>
      <span class="bk-shoot-main">
        <span class="bk-shoot-title">${b.client_name} ${statusBadge(b.status)}${demoBadge(b.is_demo)}</span>
        <span class="bk-shoot-event">${eventTitle(b)}${n > 1 ? ` · date ${which || 1} of ${n}` : ''}</span>
        <span class="bk-shoot-meta">${day.start ? html`<span>${icon('clock', 'sm')}${timeRange(day)}</span>` : ''}
          ${day.venue ? html`<span>${icon('mapPin', 'sm')}${day.venue}</span>` : ''}</span>
        <span class="bk-shoot-team">${icon('users', 'sm')}${teamLine(b.team)}</span>
      </span></a>`;
  }

  function renderOverview(d) {
    const s = d.summary;
    const card = (href, ic, label, value, sub, cls = '') => html`<a class="card stat bk-stat ${cls}" href="${href}">
      <div class="stat-label"><span class="stat-icon">${icon(ic)}</span>${label}</div>
      <div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></a>`;
    const nothing = s.total + s.cancelled === 0;
    setHtml(body, html`
      <div class="bk-stats">
        ${card('/bookings?view=list', 'book', 'Total bookings', s.total, s.cancelled ? `+ ${s.cancelled} cancelled` : 'All bookings')}
        ${card('/bookings?quick=upcoming', 'calendar', 'Upcoming shoots', s.upcoming, 'Today and later')}
        ${card('/bookings?quick=shot', 'camera', 'Shoots completed', s.shot, 'Shoot done')}
        ${card('/bookings?quick=editing', 'image', 'Editing pending', s.editing, 'Shot, not edited')}
        ${card('/bookings?status=ready', 'package', 'Ready for delivery', s.ready, 'To hand over')}
        ${card('/bookings?quick=completed', 'checkCircle', 'Delivered', s.delivered, 'Delivered or closed')}
        ${card('/bookings?quick=payment', 'wallet', 'Payment pending', s.payment, `${money(s.due)} due`, s.due ? 'is-due' : '')}
      </div>
      <div class="bk-quick" role="group" aria-label="Quick filters">${QUICK_FILTERS.map(([k, label]) => html`
        <a class="stage-chip" href="/bookings?quick=${k}">${label}<b>${d.quick[k]}</b></a>`)}</div>
      ${nothing ? html`
        <section class="card"><div class="empty">${icon('camera')}<h3>No bookings yet</h3>
          <p>Add a booking for every wedding, birthday, event or shoot. Add your team first to put them on shoots.</p>
          <div class="row" style="justify-content:center"><button type="button" class="btn" data-action="team">${icon('users')}Add your team</button>
            <a class="btn btn-primary" href="/bookings/new">${icon('plus')}New booking</a></div></div></section>` : html`
      <div class="split-wide">
        <div class="stack">
          <section class="card"><div class="card-header"><h2>Today’s shoots</h2><span class="hint">${formatDate(d.today)}</span></div>
            ${d.today_shoots.length ? html`<div class="bk-shoots">${d.today_shoots.map((b) => shootItem(b))}</div>` : html`<p class="muted bk-none">No shoots today.</p>`}</section>
          <section class="card"><div class="card-header"><h2>Upcoming shoots</h2>
            <a class="btn btn-sm" href="/bookings?view=calendar">${icon('calendar', 'sm')}Calendar</a></div>
            ${d.upcoming_shoots.length ? html`<div class="bk-shoots">${d.upcoming_shoots.map((b) => shootItem(b))}</div>
              <div class="card-footer"><a href="/bookings?quick=upcoming">All upcoming shoots</a></div>` : html`<p class="muted bk-none">Nothing booked after today yet.</p>`}</section>
        </div>
        <section class="card"><div class="card-header"><h2 class="bk-h-icon">${icon('bell')}Reminders</h2>
          ${d.reminders.length ? html`<span class="badge badge-plain">${d.reminders.length}</span>` : ''}</div>
          ${d.reminders.length ? html`<div class="bk-rems">${d.reminders.map((r) => reminderItem(r, money))}</div>`
            : html`<div class="empty">${icon('checkCircle')}<h3>All caught up</h3><p>Nothing needs attention right now.</p></div>`}</section>
      </div>`}`);
  }

  // ---- List ----------------------------------------------------------------------
  function listQuery() {
    const range = dateRange(state.date, state.from, state.to);
    return {
      q: state.q, quick: state.quick, type: state.type, status: state.status, payment: state.payment, delivery: state.delivery,
      member: state.member, from: range.from, to: range.to,
    };
  }
  const filtering = () => FILTER_KEYS.some((k) => state[k]);

  function actionsMenu(b) {
    const canShoot = !shootDone(b) && b.status !== 'cancelled' && b.status !== 'on_hold';
    return html`<details class="menu bk-menu"><summary class="btn btn-ghost btn-icon btn-sm" aria-label="Actions for ${b.number}">${icon('more')}</summary>
      <div class="menu-items">
        <a href="/bookings/${b.id}">${icon('eye')}View</a>
        <a href="/bookings/${b.id}/edit">${icon('edit')}Edit</a>
        <a href="/bookings/new?from=${b.id}">${icon('copy')}Duplicate</a>
        ${canShoot ? html`<button type="button" data-act="shot">${icon('camera')}Mark shoot complete</button>` : ''}
        ${b.balance > 0 ? html`<button type="button" data-act="pay">${icon('wallet')}Add payment</button>` : ''}
        <button type="button" data-act="link">${icon('link')}Add Drive link</button>
        <hr><button type="button" class="danger" data-act="delete">${icon('trash')}Delete</button>
      </div></details>`;
  }

  function renderList() {
    const select = (key, label, options) => html`<select class="input" data-f="${key}" aria-label="${label}">${options.map(([v, text]) => html`
      <option value="${v}" ${String(v) === state[key] ? 'selected' : ''}>${text}</option>`)}</select>`;
    const types = list.event_types.includes(state.type) || !state.type ? list.event_types : [...list.event_types, state.type];
    setHtml(body, html`
      <div class="bk-quick" role="group" aria-label="Quick filters">${QUICK_FILTERS.map(([k, label]) => html`
        <button type="button" class="stage-chip ${state.quick === k ? 'active' : ''}" data-quick="${k}" aria-pressed="${state.quick === k}">
          ${label}${quickCounts ? html`<b>${quickCounts[k]}</b>` : ''}</button>`)}</div>
      <div class="bk-filters">
        <div class="input-group bf-date">${icon('calendar')}${select('date', 'Date', DATE_OPTIONS)}</div>
        ${state.date === 'pick' ? html`<input class="input bf-day" type="date" data-f="from" value="${state.from}" aria-label="From">
          <input class="input bf-day" type="date" data-f="to" value="${state.to}" aria-label="To">` : ''}
        ${select('type', 'Event type', [['', 'All event types'], ...types.map((t) => [t, t])])}
        ${select('status', 'Booking status', [['', 'All statuses'], ...Object.entries(BOOKING_STATUSES)])}
        ${select('payment', 'Payment status', [['', 'Any payment'], ...Object.entries(BOOKING_PAYMENT_LABELS)])}
        ${select('delivery', 'Delivery status', [['', 'Any delivery'], ...Object.entries(DELIVERY_STATES).filter(([k]) => k !== 'none')])}
        ${select('member', 'Team member', [['', 'Whole team'], ...(members || []).map((m) => [m.id, m.name])])}
        ${filtering() ? html`<button type="button" class="inline-link small tf-clear" data-clear>${icon('x', 'sm')}Clear</button>` : ''}
      </div>
      <div data-results></div>`);
    renderRows();
  }

  function renderRows() {
    const box = body.querySelector('[data-results]');
    const rows = list.bookings;
    if (!rows.length) {
      setHtml(box, html`<div class="card"><div class="empty">${icon('camera')}
        <h3>${filtering() ? 'No bookings match' : 'No bookings yet'}</h3>
        <p>${filtering() ? 'Try another search or filter.' : 'Add a booking for every wedding, birthday, event or shoot.'}</p>
        ${filtering() ? html`<button type="button" class="btn" data-clear>Clear filters</button>` : html`<a class="btn btn-primary" href="/bookings/new">${icon('plus')}New booking</a>`}
      </div></div>`);
      return;
    }
    const due = rows.reduce((a, b) => a + b.balance, 0);
    setHtml(box, html`
      <div class="filters-summary">${list.total} booking${list.total === 1 ? '' : 's'} · ${money(rows.reduce((a, b) => a + (b.status === 'cancelled' ? 0 : b.total), 0))} booked
        ${due ? html` · <span class="text-bad">${money(due)} due</span>` : ''}</div>
      <div class="card"><div class="table-wrap"><table class="table stack-mobile bk-table">
        <thead><tr><th>Booking</th><th>Event date</th><th>Client</th><th>Event &amp; venue</th><th>Package &amp; total</th><th>Team</th>
          <th class="r">Balance due</th><th>Shoot &amp; delivery</th><th aria-label="Actions"></th></tr></thead>
        <tbody>${rows.map((b) => html`
          <tr class="clickable ${b.status === 'cancelled' ? 'is-cancelled' : ''}" data-href="/bookings/${b.id}" data-id="${b.id}">
            <td class="td-main"><span class="cell-main">${b.number}</span> ${demoBadge(b.is_demo)}<div class="bk-td-status">${statusBadge(b.status)}</div></td>
            <td data-label="Event date"><div class="bk-cell"><span class="nowrap">${formatDate(b.schedule[0].date)}</span>
              <div class="cell-sub">${[timeRange(b.schedule[0]), b.schedule.length > 1 ? `+${b.schedule.length - 1} more date${b.schedule.length > 2 ? 's' : ''}` : '']
                .filter(Boolean).join(' · ')}</div></div></td>
            <td data-label="Client"><div class="bk-cell"><span class="strong">${b.client_name}</span><div class="cell-sub nowrap">${b.client_whatsapp || b.client_phone}</div></div></td>
            <td data-label="Event"><div class="bk-cell">${b.event_type || html`<span class="muted">—</span>`}${b.event_name ? html`<div class="cell-sub">${b.event_name}</div>` : ''}
              ${venuesText(b) ? html`<div class="cell-sub bk-venue">${icon('mapPin', 'sm')}${venuesText(b)}</div>` : ''}</div></td>
            <td data-label="Package"><div class="bk-cell">${b.package_name || html`<span class="muted">No package name</span>`}<div class="cell-sub num">${money(b.total)}</div></div></td>
            <td data-label="Team"><div class="bk-cell">${teamShort(b.team)}</div></td>
            <td data-label="Balance due" class="r ${b.balance > 0 ? 'text-bad strong' : 'muted'}">${money(b.balance)}</td>
            <td data-label="Shoot · delivery"><div class="bk-td-badges">${shootBadge(b.shoot_state)}${deliveryBadge(b.delivery_state)}</div></td>
            <td class="bk-td-actions">${actionsMenu(b)}</td>
          </tr>`)}</tbody>
      </table></div></div>
      ${list.total > rows.length ? html`<p class="muted small track-more">Showing the first ${rows.length} of ${list.total}. Choose dates or a filter to see the rest.</p>` : ''}`);
  }

  // ---- Calendar --------------------------------------------------------------------
  function calendarRange() {
    const d = state.day;
    if (state.mode === 'day') return { from: d, to: d };
    if (state.mode === 'week') return { from: weekStart(d), to: addDays(weekStart(d), 6) };
    const [y, m] = d.split('-').map(Number);
    return { from: weekStart(`${d.slice(0, 8)}01`), to: addDays(weekStart(isoDate(new Date(y, m, 0))), 6) };
  }

  function calendarTitle() {
    const [y, m, d] = state.day.split('-').map(Number);
    if (state.mode === 'month') return `${MONTHS[m - 1]} ${y}`;
    if (state.mode === 'day') return `${WEEKDAYS[(new Date(y, m - 1, d).getDay() + 6) % 7]}, ${formatDate(state.day)}`;
    const from = weekStart(state.day);
    return `${formatDate(from)} – ${formatDate(addDays(from, 6))}`;
  }

  function renderCalendar(items, from, to) {
    const today = isoDate();
    // Each date of a booking shows on its own day, with that date's time and venue.
    const byDay = new Map();
    for (const b of items) {
      for (const day of b.schedule) {
        if (day.date < from || day.date > to) continue;
        if (!byDay.has(day.date)) byDay.set(day.date, []);
        byDay.get(day.date).push({ b, day });
      }
    }
    for (const evs of byDay.values()) evs.sort((x, y) => (x.day.start || '').localeCompare(y.day.start || ''));
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const tip = ({ b, day }) => [eventTitle(b), b.client_name, timeRange(day), day.venue, CALENDAR_TONES[b.tone]].filter(Boolean).join(' · ');
    const month = state.day.slice(0, 7);

    let grid;
    if (state.mode === 'month') {
      grid = html`<div class="card bk-month">
        <div class="bk-month-head">${WEEKDAYS.map((w) => html`<div>${w}</div>`)}</div>
        <div class="bk-month-grid">${days.map((d) => {
          const evs = byDay.get(d) || [];
          return html`<div class="bk-day ${d.slice(0, 7) !== month ? 'is-out' : ''} ${d === today ? 'is-today' : ''}">
            <button type="button" class="bk-day-no" data-cal-day="${d}" aria-label="${formatDate(d)}">${Number(d.slice(8))}</button>
            ${evs.slice(0, 3).map((ev) => html`<a class="bk-ev bk-tone-${ev.b.tone}" href="/bookings/${ev.b.id}" title="${tip(ev)}">
              ${ev.day.start ? html`<b>${formatTime(ev.day.start).replace(':00', '')}</b> ` : ''}${ev.b.client_name}</a>`)}
            ${evs.length > 3 ? html`<button type="button" class="bk-more" data-cal-day="${d}">+${evs.length - 3} more</button>` : ''}
          </div>`;
        })}</div></div>`;
    } else if (state.mode === 'week') {
      grid = html`<div class="bk-week">${days.map((d, i) => {
        const evs = byDay.get(d) || [];
        return html`<div class="card bk-wday ${d === today ? 'is-today' : ''}">
          <button type="button" class="bk-wday-head" data-cal-day="${d}"><span>${WEEKDAYS[i]}</span><b>${Number(d.slice(8))}</b></button>
          <div class="bk-wday-body">${evs.length ? evs.map((ev) => html`<a class="bk-wev bk-tone-${ev.b.tone}" href="/bookings/${ev.b.id}" title="${tip(ev)}">
            <span class="bk-wev-time">${timeRange(ev.day) || 'All day'}</span><span class="bk-wev-name">${ev.b.client_name}</span>
            <span class="bk-wev-sub">${[eventTitle(ev.b), ev.day.venue].filter(Boolean).join(' · ')}</span></a>`) : html`<span class="bk-wday-none">—</span>`}</div>
        </div>`;
      })}</div>`;
    } else {
      const evs = byDay.get(state.day) || [];
      grid = html`<section class="card">${evs.length ? html`<div class="bk-shoots">${evs.map((ev) => shootItem(ev.b, ev.day))}</div>`
        : html`<div class="empty">${icon('calendar')}<h3>No shoots on this day</h3>
          <a class="btn btn-primary" href="/bookings/new?date=${state.day}">${icon('plus')}New booking on ${formatDate(state.day)}</a></div>`}</section>`;
    }

    setHtml(body, html`
      <div class="bk-cal-bar">
        <div class="segmented" role="tablist" aria-label="Calendar view">${MODES.map(([k, label]) => html`
          <button type="button" role="tab" data-mode="${k}" class="${k === state.mode ? 'active' : ''}" aria-selected="${k === state.mode}">${label}</button>`)}</div>
        <div class="bk-cal-nav">
          <button type="button" class="btn btn-icon btn-sm" data-cal-step="-1" aria-label="Previous">${icon('chevronLeft')}</button>
          <button type="button" class="btn btn-sm" data-cal-today>Today</button>
          <button type="button" class="btn btn-icon btn-sm" data-cal-step="1" aria-label="Next">${icon('chevronRight')}</button>
          <h2 class="bk-cal-title">${calendarTitle()}</h2>
        </div>
        <div class="bk-legend">${Object.entries(CALENDAR_TONES).map(([k, label]) => html`<span class="bk-tone-${k}"><i></i>${label}</span>`)}</div>
      </div>
      ${grid}`);
  }

  // ---- Events ----------------------------------------------------------------------
  function setView(view) {
    state.view = view;
    el.querySelectorAll('[data-view]').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === view);
      b.setAttribute('aria-selected', String(b.dataset.view === view));
    });
    setHtml(body, loading());
    load();
  }

  on(el, 'click', '[data-view]', (e, b) => setView(b.dataset.view));
  const search = debounce(() => (state.view === 'list' ? load() : setView('list')), 250);
  el.querySelector('[data-search]').addEventListener('input', (e) => {
    state.q = e.target.value.trim();
    search();
  });
  on(el, 'click', '[data-action=team]', async () => {
    if (await openTeamManager()) {
      members = null;
      load();
    }
  });

  on(el, 'click', '[data-quick]', (e, b) => {
    state.quick = state.quick === b.dataset.quick ? '' : b.dataset.quick;
    load();
  });
  // The From and To dates count once they're settled (a typed date when the field is left); the lists right away.
  onDateCommit(el, 'input[type=date][data-f]', (input) => {
    state[input.dataset.f] = input.value;
    load();
  });
  on(el, 'change', 'select[data-f]', (e, input) => {
    state[input.dataset.f] = input.value;
    if (input.dataset.f === 'date' && input.value === 'pick' && !state.from) {
      state.from = isoDate();
      state.to = addDays(isoDate(), 30);
    }
    if (input.dataset.f === 'date' && input.value !== 'pick') {
      state.from = '';
      state.to = '';
    }
    load();
  });
  on(el, 'click', '[data-clear]', () => {
    for (const k of FILTER_KEYS) state[k] = '';
    el.querySelector('[data-search]').value = '';
    load();
  });

  // Row actions. Menus sit in a scrolling table, so they open as a fixed layer next to their button.
  el.addEventListener('toggle', (e) => {
    const menu = e.target;
    if (!menu.matches?.('details.bk-menu') || !menu.open) return;
    el.querySelectorAll('details.bk-menu[open]').forEach((d) => d !== menu && d.removeAttribute('open'));
    const r = menu.querySelector('summary').getBoundingClientRect();
    const items = menu.querySelector('.menu-items');
    items.style.position = 'fixed';
    items.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    items.style.left = 'auto';
    items.style.top = `${r.bottom + 6}px`;
    const h = items.offsetHeight;
    if (r.bottom + 6 + h > window.innerHeight - 8) items.style.top = `${Math.max(8, r.top - h - 6)}px`;
  }, true);
  const closeMenus = (e) => {
    el.querySelectorAll('details.menu[open]').forEach((d) => {
      if (!d.contains(e?.target)) d.removeAttribute('open');
    });
  };
  document.addEventListener('click', closeMenus);
  const closeOnScroll = () => closeMenus();
  window.addEventListener('scroll', closeOnScroll, true);

  const bookingFor = (node) => list?.bookings.find((b) => String(b.id) === node.closest('[data-id]')?.dataset.id);
  on(el, 'click', '[data-act]', async (e, btn) => {
    btn.closest('details')?.removeAttribute('open');
    const b = bookingFor(btn);
    if (!b) return;
    try {
      const act = btn.dataset.act;
      if (act === 'shot') await markShootDone(b);
      if (act === 'pay' && !(await openBookingPayment(b, currency))) return;
      if (act === 'link' && !(await openLinkForm(b))) return;
      if (act === 'delete' && !(await deleteBookingFlow(b, currency))) return;
      quickCounts = null;
      load();
    } catch (err) {
      toastError(err);
    }
  });
  on(el, 'click', 'tr[data-href]', (e, tr) => {
    if (e.target.closest('details, a, button')) return;
    navigate(tr.dataset.href);
  });

  on(el, 'click', '[data-mode]', (e, b) => {
    state.mode = b.dataset.mode;
    load();
  });
  on(el, 'click', '[data-cal-step]', (e, b) => {
    const n = Number(b.dataset.calStep);
    state.day = state.mode === 'month' ? addMonths(state.day, n) : addDays(state.day, state.mode === 'week' ? 7 * n : n);
    load();
  });
  on(el, 'click', '[data-cal-today]', () => {
    state.day = isoDate();
    load();
  });
  on(el, 'click', '[data-cal-day]', (e, b) => {
    state.day = b.dataset.calDay;
    state.mode = 'day';
    load();
  });

  await load();
  return () => {
    search.cancel();
    document.removeEventListener('click', closeMenus);
    window.removeEventListener('scroll', closeOnScroll, true);
  };
}
