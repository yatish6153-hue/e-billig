import { api, buildQuery } from '../lib/api.js';
import { html, setHtml, on, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { statusBadge, demoBadge, pager, loading } from '../lib/ui.js';
import { navigate } from '../lib/router.js';
import { formatDate } from '/shared/format.js';

const TABS = [
  ['all', 'All', {}],
  ['draft', 'Drafts', { status: 'draft' }],
  ['due', 'Unpaid', { payment: 'due' }],
  ['partial', 'Partly paid', { payment: 'partial' }],
  ['paid', 'Paid', { payment: 'paid' }],
  ['cancelled', 'Cancelled', { status: 'cancelled' }],
];

function tabFromQuery(q) {
  if (q.status === 'draft') return 'draft';
  if (q.status === 'cancelled') return 'cancelled';
  if (q.payment === 'paid') return 'paid';
  if (q.payment === 'partial') return 'partial';
  if (q.payment === 'due' || q.payment === 'unpaid') return 'due';
  return 'all';
}

export default async function bills(el, { app, query }) {
  app.setTitle('Bills');
  const state = { tab: tabFromQuery(query), q: query.q || '', from: query.from || '', to: query.to || '', offset: Number(query.offset) || 0, customer_id: query.customer_id || '' };
  const LIMIT = 25;

  setHtml(el, html`
    <div class="page-header">
      <div><h1>Bills</h1><div class="subtitle">Invoices, drafts and payments.</div></div>
      <div class="page-actions"><a class="btn btn-primary" href="/bills/new">${icon('plus')}New bill</a></div>
    </div>
    <div class="toolbar">
      <div class="segmented" data-tabs>${TABS.map(([k, label]) => html`<button type="button" data-tab="${k}" class="${k === state.tab ? 'active' : ''}">${label}</button>`)}</div>
    </div>
    <div class="toolbar">
      <div class="input-group grow">${icon('search')}<input class="input" type="search" data-search placeholder="Search bill number, name or mobile number" value="${state.q}"></div>
      <input class="input date-input" type="date" data-from value="${state.from}" aria-label="From date">
      <span class="muted">to</span>
      <input class="input date-input" type="date" data-to value="${state.to}" aria-label="To date">
      <button type="button" class="btn btn-ghost btn-sm" data-clear>Clear</button>
    </div>
    <div data-results></div>`);

  const results = el.querySelector('[data-results]');

  function syncUrl() {
    const t = TABS.find(([k]) => k === state.tab)[2];
    history.replaceState(null, '', `/bills${buildQuery({ ...t, q: state.q, from: state.from, to: state.to, offset: state.offset || '', customer_id: state.customer_id })}`);
  }

  let seq = 0;
  async function load() {
    const mySeq = ++seq;
    const t = TABS.find(([k]) => k === state.tab)[2];
    results.style.opacity = '0.6';
    if (!results.innerHTML) setHtml(results, loading());
    try {
      const data = await api('/bills', { query: { ...t, q: state.q, from: state.from, to: state.to, customer_id: state.customer_id, limit: LIMIT, offset: state.offset } });
      if (mySeq !== seq) return;
      render(data);
      syncUrl();
    } finally {
      results.style.opacity = '';
    }
  }

  function render(data) {
    const money = (v) => app.money(v);
    if (!data.bills.length) {
      const filtered = state.q || state.from || state.to || state.tab !== 'all';
      setHtml(results, html`<div class="card"><div class="empty">${icon('bill')}
        <h3>${filtered ? 'No bills match these filters' : 'No bills yet'}</h3>
        <p>${filtered ? 'Try a different search or date range.' : 'Bills you create will appear here.'}</p>
        ${filtered ? '' : html`<a class="btn btn-primary" href="/bills/new">${icon('plus')}Create your first bill</a>`}</div></div>`);
      return;
    }
    setHtml(results, html`
      <div class="filters-summary">${data.summary.count} bill${data.summary.count === 1 ? '' : 's'}
        · Billed ${money(data.summary.total)}${data.summary.outstanding > 0 ? html` · <span class="text-bad">${money(data.summary.outstanding)} outstanding</span>` : ''}</div>
      <div class="card">
        <div class="table-wrap"><table class="table stack-mobile">
          <thead><tr><th>Bill</th><th>Date</th><th>Customer</th><th>Mobile number</th><th>Status</th><th class="r">Total</th><th class="r">Balance</th></tr></thead>
          <tbody>${data.bills.map((b) => html`
            <tr class="clickable" data-href="/bills/${b.id}">
              <td class="td-main"><span class="cell-main">${b.invoice_no || `Draft #${b.id}`}</span> ${demoBadge(b.is_demo)}
                <div class="cell-sub">${b.items_count} item${b.items_count === 1 ? '' : 's'}</div></td>
              <td data-label="Date" class="nowrap">${formatDate(b.bill_date)}</td>
              <td data-label="Customer">${b.customer_name || html`<span class="muted">Walk-in customer</span>`}</td>
              <td data-label="Mobile" class="nowrap num">${b.customer_phone || html`<span class="muted">—</span>`}</td>
              <td data-label="Status">${statusBadge(b)}</td>
              <td data-label="Total" class="r strong">${money(b.total)}</td>
              <td data-label="Balance" class="r ${b.balance > 0 ? 'text-bad' : 'muted'}">${b.status === 'finalized' ? money(b.balance) : '—'}</td>
            </tr>`)}</tbody>
        </table></div>
        ${pager(data.total, data.limit, data.offset)}
      </div>`);
  }

  on(el, 'click', '[data-tab]', (e, b) => {
    state.tab = b.dataset.tab;
    state.offset = 0;
    el.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
    load();
  });
  const search = debounce(() => {
    state.offset = 0;
    load();
  }, 250);
  el.querySelector('[data-search]').addEventListener('input', (e) => {
    state.q = e.target.value.trim();
    search();
  });
  el.querySelector('[data-from]').addEventListener('change', (e) => {
    state.from = e.target.value;
    state.offset = 0;
    load();
  });
  el.querySelector('[data-to]').addEventListener('change', (e) => {
    state.to = e.target.value;
    state.offset = 0;
    load();
  });
  el.querySelector('[data-clear]').addEventListener('click', () => {
    Object.assign(state, { q: '', from: '', to: '', offset: 0, customer_id: '' });
    el.querySelector('[data-search]').value = '';
    el.querySelector('[data-from]').value = '';
    el.querySelector('[data-to]').value = '';
    load();
  });
  on(el, 'click', '[data-page]', (e, b) => {
    state.offset = Number(b.dataset.page);
    load().then(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  });
  on(el, 'click', 'tr[data-href]', (e, tr) => navigate(tr.dataset.href));

  await load();
  return () => search.cancel();
}
